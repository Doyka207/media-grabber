// mp4build.js - convertit un flux MP4 fragmenté (init + moof/mdat) en MP4 classique "faststart".
//
// Principe (une seule passe, mémoire = tables d'échantillons uniquement) :
//   1. on lit l'init (moov) pour connaître les pistes ;
//   2. à chaque fragment, on recopie tel quel le contenu du mdat dans le fichier et on note,
//      pour chaque échantillon, sa durée / taille / décalage de composition / image clé ;
//   3. à la fin, on construit un vrai moov (stts, ctts, stss, stsc, stsz, stco/co64) et on
//      l'écrit dans la zone réservée au début du fichier (ftyp | moov | free | mdat).
//      Si la réserve est trop petite, le moov est écrit à la fin (fichier valide, non "faststart").
//
// Aucune dépendance. Utilisable dans une page d'extension (global `Mp4Builder`) et sous Node.
(function (root) {
  "use strict";

  // ---------- Lecture binaire ----------
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function* boxes(b, start, end) {
    for (let p = start; p + 8 <= end; ) {
      let size = u32(b, p);
      let hdr = 8;
      const type = fourcc(b, p + 4);
      if (size === 1) {
        if (p + 16 > end) return;
        size = u64(b, p + 8);
        hdr = 16;
      } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;
      yield { type, start: p, hdr, end: p + size };
      p += size;
    }
  }
  const child = (b, box, t) => {
    for (const c of boxes(b, box.start + box.hdr, box.end)) if (c.type === t) return c;
    return null;
  };
  const kids = (b, box, t) => [...boxes(b, box.start + box.hdr, box.end)].filter((c) => c.type === t);
  const copyOf = (b, box) => b.slice(box.start, box.end);

  // ---------- Écriture binaire ----------
  const ascii = (s) => Uint8Array.of(s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3));
  const be = (n, bytes = 4) => {
    const o = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) {
      o[i] = n % 256;
      n = Math.floor(n / 256);
    }
    return o;
  };
  const concat = (parts) => {
    let n = 0;
    for (const p of parts) n += p.length;
    const o = new Uint8Array(n);
    let k = 0;
    for (const p of parts) {
      o.set(p, k);
      k += p.length;
    }
    return o;
  };
  const mk = (t, ...parts) => {
    const body = concat(parts);
    return concat([be(body.length + 8), ascii(t), body]);
  };
  const full = (t, ver, flags, ...parts) =>
    mk(t, Uint8Array.of(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
  const freeBox = (n) => concat([be(n), ascii("free"), new Uint8Array(n - 8)]);
  function u32s(arr) {
    const o = new Uint8Array(arr.length * 4);
    const dv = new DataView(o.buffer);
    for (let i = 0; i < arr.length; i++) dv.setUint32(i * 4, arr[i] >>> 0);
    return o;
  }
  function u64s(arr) {
    const o = new Uint8Array(arr.length * 8);
    const dv = new DataView(o.buffer);
    for (let i = 0; i < arr.length; i++) {
      dv.setUint32(i * 8, Math.floor(arr[i] / 4294967296));
      dv.setUint32(i * 8 + 4, arr[i] >>> 0);
    }
    return o;
  }
  function rle(arr) {
    const runs = [];
    if (!arr.length) return runs;
    let prev = arr[0];
    let n = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === prev) n++;
      else {
        runs.push([n, prev]);
        prev = arr[i];
        n = 1;
      }
    }
    runs.push([n, prev]);
    return runs;
  }
  // Écrit une durée dans une copie de boîte (mvhd/tkhd/mdhd) ; `off` est relatif au début de la boîte.
  function setDuration(bytes, off, version, value) {
    if (version === 1) bytes.set(be(value, 8), off);
    else bytes.set(be(Math.min(value, 0xffffffff)), off);
  }

  const DEFAULT_DINF = mk("dinf", full("dref", 0, 0, be(1), full("url ", 0, 1)));

  class Mp4Builder {
    // opts (tests / débogage) : { reserveSize, forceCo64 }
    constructor(opts = {}) {
      this.opts = opts || {};
      this.tracks = new Map();
      this.payloadBytes = 0; // octets de mdat recopiés
      this.reserve = 0; // taille de la zone d'en-tête réservée au début du fichier
      this.movieTs = 1000;
      this.mvhd = null;
    }

    hasData() {
      return [...this.tracks.values()].some((t) => t.dur.length);
    }

    // ----- init segment -----
    setInit(init) {
      if (this.tracks.size) return;
      let moov = null;
      for (const b of boxes(init, 0, init.length)) if (b.type === "moov") moov = b;
      if (!moov) throw new Error("Segment d'initialisation sans 'moov'.");

      const mvhd = child(init, moov, "mvhd");
      if (!mvhd) throw new Error("'mvhd' introuvable.");
      const mc = mvhd.start + mvhd.hdr;
      this.mvhdVersion = init[mc];
      this.movieTs = u32(init, this.mvhdVersion === 1 ? mc + 20 : mc + 12);
      this.mvhd = copyOf(init, mvhd);

      const trex = {};
      const mvex = child(init, moov, "mvex");
      if (mvex) {
        for (const t of kids(init, mvex, "trex")) {
          const c = t.start + t.hdr;
          trex[u32(init, c + 4)] = { dur: u32(init, c + 12), size: u32(init, c + 16), flags: u32(init, c + 20) };
        }
      }

      for (const trak of kids(init, moov, "trak")) {
        const tkhd = child(init, trak, "tkhd");
        const mdia = child(init, trak, "mdia");
        const mdhd = child(init, mdia, "mdhd");
        const hdlr = child(init, mdia, "hdlr");
        const minf = child(init, mdia, "minf");
        const stbl = child(init, minf, "stbl");
        const stsd = child(init, stbl, "stsd");
        const tc = tkhd.start + tkhd.hdr;
        const tv = init[tc];
        const id = u32(init, tv === 1 ? tc + 20 : tc + 12);
        const mdc = mdhd.start + mdhd.hdr;
        const mv = init[mdc];
        const ts = u32(init, mv === 1 ? mdc + 20 : mdc + 12);

        let mediaHdr = null;
        let dinf = null;
        for (const k of boxes(init, minf.start + minf.hdr, minf.end)) {
          if (["vmhd", "smhd", "nmhd", "hmhd", "sthd"].includes(k.type)) mediaHdr = copyOf(init, k);
          else if (k.type === "dinf") dinf = copyOf(init, k);
        }
        this.tracks.set(id, {
          id,
          ts,
          handler: fourcc(init, hdlr.start + hdlr.hdr + 8),
          tkhd: copyOf(init, tkhd), tkhdVersion: tv, tkhdHdr: tkhd.hdr,
          mdhd: copyOf(init, mdhd), mdhdVersion: mv, mdhdHdr: mdhd.hdr,
          hdlr: copyOf(init, hdlr),
          mediaHdr,
          dinf: dinf || DEFAULT_DINF,
          stsd: copyOf(init, stsd),
          def: trex[id] || { dur: 0, size: 0, flags: 0 },
          dur: [], size: [], cto: [], sync: [], chunks: [],
          firstDts: null, nextDts: 0, hasCto: false, hasNonSync: false, adjusted: 0,
        });
      }
      if (!this.tracks.size) throw new Error("Aucune piste dans le segment d'initialisation.");
    }

    // ----- fragments -----
    _parseMoof(buf, moof) {
      const runs = [];
      let implicit = moof.start;
      for (const traf of kids(buf, moof, "traf")) {
        const tfhd = child(buf, traf, "tfhd");
        if (!tfhd) continue;
        const c = tfhd.start + tfhd.hdr;
        const flags = u24(buf, c + 1);
        const trackId = u32(buf, c + 4);
        const tr = this.tracks.get(trackId);
        if (!tr) throw new Error(`Piste ${trackId} absente de l'init.`);
        let p = c + 8;
        let base = null;
        if (flags & 0x1) { base = u64(buf, p); p += 8; }
        if (flags & 0x2) p += 4;
        const def = { ...tr.def };
        if (flags & 0x8) { def.dur = u32(buf, p); p += 4; }
        if (flags & 0x10) { def.size = u32(buf, p); p += 4; }
        if (flags & 0x20) { def.flags = u32(buf, p); p += 4; }
        if (base === null) base = flags & 0x20000 ? moof.start : implicit;

        const tfdt = child(buf, traf, "tfdt");
        let baseDecode = null;
        if (tfdt) {
          const tc = tfdt.start + tfdt.hdr;
          baseDecode = buf[tc] === 1 ? u64(buf, tc + 4) : u32(buf, tc + 4);
        }

        let cursor = base;
        let first = true;
        for (const trun of kids(buf, traf, "trun")) {
          const rc = trun.start + trun.hdr;
          const version = buf[rc];
          const tf = u24(buf, rc + 1);
          const count = u32(buf, rc + 4);
          let q = rc + 8;
          if (tf & 0x1) { cursor = base + s32(buf, q); q += 4; }
          let firstFlags = null;
          if (tf & 0x4) { firstFlags = u32(buf, q); q += 4; }
          const samples = [];
          const start = cursor;
          for (let i = 0; i < count; i++) {
            let dur = def.dur, size = def.size, fl = def.flags, cto = 0;
            if (tf & 0x100) { dur = u32(buf, q); q += 4; }
            if (tf & 0x200) { size = u32(buf, q); q += 4; }
            if (tf & 0x400) { fl = u32(buf, q); q += 4; }
            else if (i === 0 && firstFlags !== null) fl = firstFlags;
            if (tf & 0x800) { cto = version === 0 ? u32(buf, q) : s32(buf, q); q += 4; }
            samples.push({ dur, size, fl, cto });
            cursor += size;
          }
          runs.push({ tr, dataStart: start, size: cursor - start, samples, baseDecode: first ? baseDecode : null });
          first = false;
        }
        implicit = cursor;
      }
      return runs;
    }

    // Reçoit un ou plusieurs couples moof+mdat ; renvoie les morceaux de mdat à écrire dans le fichier.
    addFragment(buf) {
      const out = [];
      let runs = null;
      for (const b of boxes(buf, 0, buf.length)) {
        if (b.type === "moov" && !this.tracks.size) {
          this.setInit(buf.subarray(b.start, b.end));
        } else if (b.type === "moof") {
          if (!this.tracks.size) throw new Error("Fragment reçu avant le segment d'initialisation.");
          runs = this._parseMoof(buf, b);
        } else if (b.type === "mdat" && runs) {
          const ps = b.start + b.hdr;
          const pe = b.end;
          for (const run of runs) {
            if (run.dataStart < ps || run.dataStart + run.size > pe) {
              throw new Error("Données d'un 'trun' hors du 'mdat' (fragment non pris en charge).");
            }
            this._addRun(run, this.payloadBytes + (run.dataStart - ps));
          }
          out.push(buf.subarray(ps, pe));
          this.payloadBytes += pe - ps;
          runs = null;
        }
      }
      return out;
    }

    _addRun(run, relOffset) {
      const tr = run.tr;
      if (run.baseDecode !== null) {
        if (tr.firstDts === null) {
          tr.firstDts = run.baseDecode;
          tr.nextDts = run.baseDecode;
        } else if (run.baseDecode !== tr.nextDts && tr.dur.length) {
          // trou ou chevauchement entre deux fragments : on absorbe l'écart dans le dernier échantillon
          const d = run.baseDecode - tr.nextDts;
          const last = tr.dur.length - 1;
          if (tr.dur[last] + d > 0) {
            tr.dur[last] += d;
            tr.nextDts = run.baseDecode;
            tr.adjusted++;
          }
        }
      } else if (tr.firstDts === null) {
        tr.firstDts = 0;
        tr.nextDts = 0;
      }
      for (const s of run.samples) {
        tr.dur.push(s.dur);
        tr.size.push(s.size);
        tr.cto.push(s.cto);
        const sync = ((s.fl >> 16) & 1) === 0;
        tr.sync.push(sync);
        if (s.cto !== 0) tr.hasCto = true;
        if (!sync) tr.hasNonSync = true;
        tr.nextDts += s.dur;
      }
      tr.chunks.push({ off: relOffset, count: run.samples.length });
    }

    // ----- réserve d'en-tête -----
    _ftyp() {
      return mk("ftyp", ascii("isom"), be(512), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
    }

    // À appeler après le premier lot de fragments : estime la taille du moov final (marge de 30 %).
    // Une piste qui n'a encore aucun échantillon est comptée avec des hypothèses prudentes.
    reserveSize(totalSeconds, segmentCount) {
      const ftyp = this._ftyp().length;
      if (this.opts.reserveSize) return (this.reserve = this.opts.reserveSize);
      let bytes = 2048;
      for (const t of this.tracks.values()) {
        let n, hasCto, hasNonSync;
        if (t.dur.length) {
          const avg = t.dur.reduce((a, b) => a + b, 0) / t.dur.length;
          n = avg > 0 && totalSeconds > 0 ? Math.ceil((totalSeconds * t.ts) / avg) : t.dur.length;
          hasCto = t.hasCto;
          hasNonSync = t.hasNonSync;
        } else if (t.handler === "soun") {
          n = Math.ceil((totalSeconds * t.ts) / 1024);
          hasCto = false;
          hasNonSync = false;
        } else {
          n = Math.ceil(totalSeconds * 60); // vidéo : 60 images/s au pire
          hasCto = true;
          hasNonSync = true;
        }
        // stsz 4 o + stts/stsc (marge) ; ctts : jusqu'à 8 o par échantillon ; stss : 4 o par image clé
        const per = 4.5 + (hasCto ? 8 : 0) + (hasNonSync ? 1.5 : 0);
        bytes += n * per + (segmentCount || 64) * 24;
        bytes += t.stsd.length + t.tkhd.length + t.mdhd.length + t.hdlr.length + t.dinf.length + 512;
      }
      bytes = Math.ceil(bytes * 1.3) + 4096;
      return (this.reserve = ftyp + bytes + 16);
    }

    // ----- construction du moov -----
    _trak(t, minFirst, co64, movieTs) {
      const n = t.dur.length;
      const sum = t.dur.reduce((a, b) => a + b, 0);
      const delay = Math.round((t.firstDts / t.ts - minFirst) * movieTs);
      // Fin de présentation réelle = max(dts + décalage de composition + durée) : sans ça, la durée
      // déclarée est trop courte du délai des images B et un lecteur strict peut couper la fin.
      let dts = 0;
      let presEnd = sum;
      for (let i = 0; i < n; i++) {
        const e = dts + t.cto[i] + t.dur[i];
        if (e > presEnd) presEnd = e;
        dts += t.dur[i];
      }
      const durMovie = Math.round((presEnd * movieTs) / t.ts);

      const tkhd = t.tkhd.slice();
      setDuration(tkhd, t.tkhdHdr + (t.tkhdVersion === 1 ? 28 : 20), t.tkhdVersion, delay + durMovie);
      const mdhd = t.mdhd.slice();
      setDuration(mdhd, t.mdhdHdr + (t.mdhdVersion === 1 ? 24 : 16), t.mdhdVersion, sum);

      // décalage de début de piste (rare) : édition vide devant la piste
      let edts = new Uint8Array(0);
      if (delay > 0) {
        edts = mk("edts", full("elst", 0, 0, be(2),
          be(delay), be(0xffffffff), be(0x00010000),
          be(durMovie), be(0), be(0x00010000)));
      }

      const durRuns = rle(t.dur);
      const stts = full("stts", 0, 0, be(durRuns.length), u32s(durRuns.flat()));
      const parts = [t.stsd, stts];

      const syncIdx = [];
      if (t.hasNonSync) t.sync.forEach((s, i) => s && syncIdx.push(i + 1));
      if (t.hasNonSync) parts.push(full("stss", 0, 0, be(syncIdx.length), u32s(syncIdx)));

      if (t.hasCto) {
        const runs = rle(t.cto);
        const neg = t.cto.some((x) => x < 0);
        parts.push(full("ctts", neg ? 1 : 0, 0, be(runs.length), u32s(runs.flat())));
      }

      // stsc : regroupement des chunks de même taille
      const stscRows = [];
      let prevCount = -1;
      t.chunks.forEach((c, i) => {
        if (c.count !== prevCount) {
          stscRows.push(i + 1, c.count, 1);
          prevCount = c.count;
        }
      });
      parts.push(full("stsc", 0, 0, be(stscRows.length / 3), u32s(stscRows)));

      const sameSize = t.size.every((x) => x === t.size[0]);
      parts.push(
        sameSize
          ? full("stsz", 0, 0, be(t.size[0]), be(n))
          : full("stsz", 0, 0, be(0), be(n), u32s(t.size))
      );

      const offs = t.chunks.map((c) => this.reserve + c.off);
      parts.push(
        co64
          ? full("co64", 0, 0, be(offs.length), u64s(offs))
          : full("stco", 0, 0, be(offs.length), u32s(offs))
      );

      const stbl = mk("stbl", ...parts);
      const minf = mk("minf", ...(t.mediaHdr ? [t.mediaHdr] : []), t.dinf, stbl);
      const mdia = mk("mdia", mdhd, t.hdlr, minf);
      return { box: mk("trak", tkhd, edts, mdia), movieDur: delay + durMovie };
    }

    // Renvoie { head, tail } : `head` (taille exacte = réserve) à écrire au début du fichier,
    // `tail` (moov) à ajouter à la fin si la réserve était insuffisante.
    finalize() {
      if (!this.hasData()) throw new Error("Aucun échantillon.");
      const tracks = [...this.tracks.values()].filter((t) => t.dur.length);
      const minFirst = Math.min(...tracks.map((t) => t.firstDts / t.ts));
      const co64 = !!this.opts.forceCo64 || this.reserve + this.payloadBytes > 0xffffffff;

      const traks = [];
      let movieDur = 0;
      for (const t of tracks) {
        const r = this._trak(t, minFirst, co64, this.movieTs);
        traks.push(r.box);
        movieDur = Math.max(movieDur, r.movieDur);
      }
      const mvhd = this.mvhd.slice();
      setDuration(mvhd, 8 + (this.mvhdVersion === 1 ? 24 : 16), this.mvhdVersion, movieDur);
      const moov = mk("moov", mvhd, ...traks);

      const ftyp = this._ftyp();
      const M = this.reserve - ftyp.length - 16; // place disponible entre ftyp et le mdat
      // en-tête du mdat (16 octets) : 'free' de 8 octets + mdat 32 bits, ou mdat 64 bits si > 4 Go
      const mdatHdr =
        this.payloadBytes + 8 <= 0xffffffff
          ? concat([be(8), ascii("free"), be(this.payloadBytes + 8), ascii("mdat")])
          : concat([be(1), ascii("mdat"), be(this.payloadBytes + 16, 8)]);

      const pad = M - moov.length;
      if (M >= 8 && (pad === 0 || pad >= 8)) {
        return { head: concat([ftyp, moov, pad ? freeBox(pad) : new Uint8Array(0), mdatHdr]), tail: null, faststart: true };
      }
      if (M < 8) throw new Error("Réserve d'en-tête invalide.");
      return { head: concat([ftyp, freeBox(M), mdatHdr]), tail: moov, faststart: false };
    }
  }

  const API = { Mp4Builder };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Mp4Builder = Mp4Builder;
})(typeof globalThis !== "undefined" ? globalThis : self);
