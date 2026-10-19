// hls.js - téléchargement HLS dans le navigateur (sans dépendance, hors mux.js pour TS -> MP4).
// Utilisable dans une page d'extension (global `HLS`) et sous Node (module.exports) pour les tests.
(function (root) {
  "use strict";

  const Mp4Builder =
    typeof module !== "undefined" && module.exports ? require("./mp4build.js").Mp4Builder : root.Mp4Builder;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const abs = (u, base) => new URL(u, base).href;

  // ---------- Parsing ----------

  function parseAttrs(line) {
    const out = {};
    const s = line.slice(line.indexOf(":") + 1);
    for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
      out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    return out;
  }

  function isMaster(text) {
    return text.includes("#EXT-X-STREAM-INF");
  }

  function parseMaster(text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const variants = [];
    const media = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith("#EXT-X-STREAM-INF:")) {
        const a = parseAttrs(l);
        let j = i + 1;
        while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
        if (j >= lines.length) break;
        variants.push({
          url: abs(lines[j], base),
          bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
          resolution: a.RESOLUTION || "",
          codecs: a.CODECS || "",
          audioGroup: a.AUDIO || "",
        });
        i = j;
      } else if (l.startsWith("#EXT-X-MEDIA:")) {
        media.push(parseAttrs(l));
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    for (const v of variants) {
      v.separateAudio =
        !!v.audioGroup &&
        media.some((m) => m.TYPE === "AUDIO" && m["GROUP-ID"] === v.audioGroup && m.URI);
    }
    return { variants, media };
  }

  function parseMedia(text, base) {
    const lines = text.split(/\r?\n/);
    let seq = 0;
    let key = null;
    let map = null;
    let dur = 0;
    let br = null;
    let endlist = false;
    const lastEnd = {};
    const segments = [];

    // "longueur@offset" ; sans offset, on enchaîne après le dernier octet lu de la même URL
    const toRange = (spec, url) => {
      const [len, off] = spec.split("@").map(Number);
      const start = Number.isFinite(off) ? off : lastEnd[url] || 0;
      lastEnd[url] = start + len;
      return { start, end: start + len - 1 };
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        seq = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = parseAttrs(line);
        if (a.METHOD === "NONE") key = null;
        else {
          const identity = !a.KEYFORMAT || a.KEYFORMAT === "identity";
          key = {
            method: a.METHOD,
            supported: a.METHOD === "AES-128" && identity && !!a.URI,
            uri: a.URI ? abs(a.URI, base) : null,
            iv: a.IV || null,
          };
        }
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const a = parseAttrs(line);
        const url = abs(a.URI, base);
        map = { url, range: a.BYTERANGE ? toRange(a.BYTERANGE, url) : null };
      } else if (line.startsWith("#EXTINF:")) {
        dur = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        br = line.slice(17);
      } else if (line === "#EXT-X-ENDLIST") {
        endlist = true;
      } else if (!line.startsWith("#")) {
        const url = abs(line, base);
        segments.push({
          url,
          duration: dur,
          seq: seq + segments.length,
          key,
          map,
          range: br ? toRange(br, url) : null,
        });
        dur = 0;
        br = null;
      }
    }
    return {
      segments,
      endlist,
      totalDuration: segments.reduce((s, x) => s + x.duration, 0),
    };
  }

  // ---------- Détection du type de conteneur ----------

  function sniff(b) {
    if (b.length > 188 && b[0] === 0x47 && b[188] === 0x47) return "ts";
    if (b.length > 3 && b.length <= 188 && b[0] === 0x47) return "ts";
    if (b.length > 8) {
      const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
      if (/^(ftyp|styp|moof|moov)$/.test(t)) return "fmp4";
    }
    let o = 0;
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      o = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    }
    if (b[o] === 0xff) {
      if ((b[o + 1] & 0xf6) === 0xf0) return "aac";
      if ((b[o + 1] & 0xe0) === 0xe0) return "mp3";
    }
    return "unknown";
  }

  // format : "mp4"  = MP4 classique (index complet, recommandé)
  //          "fmp4" = MP4 fragmenté (ancien comportement)
  //          "raw"  = concaténation brute des segments
  function extFor(kind, format) {
    if (kind === "ts") return format === "raw" ? "ts" : "mp4";
    if (kind === "fmp4") return "mp4";
    if (kind === "aac") return "aac";
    if (kind === "mp3") return "mp3";
    return "bin";
  }

  // ---------- Réseau ----------

  async function fetchBytes(url, { range, signal, retries = 3, fetchImpl } = {}) {
    const doFetch = fetchImpl || fetch;
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await doFetch(url, { headers, signal, credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
        let bytes = new Uint8Array(await r.arrayBuffer());
        // Serveur qui ignore Range et renvoie tout le fichier
        if (range && r.status === 200) bytes = bytes.subarray(range.start, range.end + 1);
        return bytes;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (attempt >= retries) throw e;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  async function fetchText(url, opts) {
    return new TextDecoder().decode(await fetchBytes(url, opts));
  }

  // ---------- AES-128 (HLS "classique", pas du DRM) ----------

  function ivBytes(key, seq) {
    const iv = new Uint8Array(16);
    if (key.iv) {
      const hex = key.iv.replace(/^0x/i, "").padStart(32, "0");
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      const dv = new DataView(iv.buffer);
      dv.setUint32(8, Math.floor(seq / 2 ** 32));
      dv.setUint32(12, seq >>> 0);
    }
    return iv;
  }

  function makeSegmentFetcher(netOpts) {
    const keys = new Map();
    const getKey = (uri) => {
      if (!keys.has(uri)) {
        keys.set(
          uri,
          (async () => {
            const raw = await fetchBytes(uri, netOpts);
            if (raw.length !== 16) throw new Error(`Clé AES invalide (${raw.length} octets)`);
            return crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
          })()
        );
      }
      return keys.get(uri);
    };
    return async function fetchSegment(seg) {
      let bytes = await fetchBytes(seg.url, { ...netOpts, range: seg.range });
      if (seg.key) {
        const k = await getKey(seg.key.uri);
        bytes = new Uint8Array(
          await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes(seg.key, seg.seq) }, k, bytes)
        );
      }
      return bytes;
    };
  }

  // ---------- Préparation (analyse d'une media playlist) ----------

  async function prepare(mediaUrl, { signal, text, fetchImpl } = {}) {
    const netOpts = { signal, fetchImpl };
    const txt = text != null ? text : await fetchText(mediaUrl, netOpts);
    if (!txt.trimStart().startsWith("#EXTM3U")) throw new Error("Ce n'est pas une playlist HLS valide.");
    const pl = parseMedia(txt, mediaUrl);
    if (!pl.segments.length) throw new Error("La playlist ne contient aucun segment.");
    if (!pl.endlist) {
      throw new Error("Flux en direct (pas de EXT-X-ENDLIST) : non pris en charge dans cette version.");
    }
    const bad = pl.segments.find((s) => s.key && !s.key.supported);
    if (bad) {
      throw new Error(
        `Flux protégé (${bad.key.method}) : seul le chiffrement AES-128 standard est pris en charge. ` +
          "Les flux sous DRM ne peuvent pas être téléchargés."
      );
    }
    pl.encrypted = pl.segments.some((s) => s.key);
    pl.fetchSegment = makeSegmentFetcher(netOpts);
    pl.first = await pl.fetchSegment(pl.segments[0]); // mis en cache : sert à détecter le type
    pl.kind = pl.segments[0].map ? "fmp4" : sniff(pl.first);
    return pl;
  }

  // ---------- Correctif de durée ----------
  // mux.js écrit 0xFFFFFFFF ("inconnue") comme durée dans mvhd/tkhd/mdhd : certains lecteurs
  // affichent alors ~13 h et une barre de lecture inutilisable. On écrit la vraie durée
  // (somme des EXTINF de la playlist). Ne touche que les boîtes en version 0 (32 bits).
  function patchInitDuration(init, seconds) {
    if (!(seconds > 0)) return init;
    const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
    let movieTs = 0;
    const set = (off, ts) => {
      const v = Math.round(seconds * ts);
      if (ts > 0 && v <= 0xffffffff) dv.setUint32(off, v);
    };
    const walk = (start, end) => {
      for (let p = start; p + 8 <= end; ) {
        const size = dv.getUint32(p);
        if (size < 8) break;
        const type = String.fromCharCode(init[p + 4], init[p + 5], init[p + 6], init[p + 7]);
        if (type === "moov" || type === "trak" || type === "mdia") {
          walk(p + 8, Math.min(p + size, end));
        } else if (init[p + 8] === 0) {
          if (type === "mvhd") { movieTs = dv.getUint32(p + 20); set(p + 24, movieTs); }
          else if (type === "tkhd") set(p + 28, movieTs);
          else if (type === "mdhd") set(p + 24, dv.getUint32(p + 20));
        }
        p += size;
      }
    };
    walk(0, init.byteLength);
    return init;
  }

  // ---------- Téléchargement ----------

  async function download(
    pl,
    { format = "mp4", write, patchHead, onProgress, signal, concurrency = 6, muxjs, fetchImpl, mp4Options } = {}
  ) {
    const segs = pl.segments;
    const n = segs.length;
    // MP4 classique : reconstruit un moov complet (TS converti par mux.js, ou fMP4 source)
    const classic = format === "mp4" && (pl.kind === "ts" || pl.kind === "fmp4");
    const convert = pl.kind === "ts" && (format === "mp4" || format === "fmp4");
    if (classic && typeof patchHead !== "function") {
      throw new Error("Le MP4 classique exige une fonction patchHead (réécriture de l'en-tête).");
    }
    const ac = new AbortController();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    // Nouveau fetcher lié au signal interne (annule les téléchargements en vol en cas d'erreur)
    const fetchSegment = makeSegmentFetcher({ signal: ac.signal, fetchImpl });

    const builder = classic ? new Mp4Builder(mp4Options) : null;
    let tx = null;
    const pending = [];
    let initDone = false;
    if (convert) {
      const M = muxjs || root.muxjs;
      if (!M) throw new Error("mux.js n'est pas chargé.");
      const T = (M.mp4 && M.mp4.Transmuxer) || M.Transmuxer;
      tx = new T({ keepOriginalTimestamps: false });
      tx.on("data", (s) => {
        if (!s.data || !s.data.byteLength) return;
        if (!initDone) {
          initDone = true;
          if (classic) builder.setInit(s.initSegment);
          else pending.push(patchInitDuration(s.initSegment, pl.totalDuration));
        }
        pending.push(s.data);
      });
    }

    let bytesOut = 0;
    const emit = async (chunk) => {
      bytesOut += chunk.byteLength;
      await write(chunk);
    };

    // MP4 classique : zone d'en-tête réservée au début, puis contenu des mdat, puis moov écrit dans la réserve.
    // L'estimation de la réserve attend le premier lot complet (mux.js émet un fragment par piste).
    let started = false;
    const feedClassic = async (frags) => {
      const payloads = [];
      for (const f of frags) payloads.push(...builder.addFragment(f));
      if (!started) {
        started = true;
        await emit(new Uint8Array(builder.reserveSize(pl.totalDuration, n)));
      }
      for (const p of payloads) await emit(p);
    };

    try {
      if (pl.kind === "fmp4" && segs[0].map) {
        const init = await fetchBytes(segs[0].map.url, {
          range: segs[0].map.range,
          signal: ac.signal,
          fetchImpl,
        });
        if (classic) builder.setInit(init);
        else await emit(init);
      }

      const inflight = new Map();
      const start = (i) => {
        if (i >= n || inflight.has(i)) return;
        const p = i === 0 && pl.first ? Promise.resolve(pl.first) : fetchSegment(segs[i]);
        p.catch(() => {}); // évite les "unhandled rejection" ; l'erreur est relancée au await
        inflight.set(i, p);
      };

      const t0 = Date.now();
      let bytesIn = 0;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < concurrency; k++) start(i + k);
        const data = await inflight.get(i);
        inflight.delete(i);
        if (ac.signal.aborted) throw new DOMException("Annulé", "AbortError");
        bytesIn += data.byteLength;

        if (tx) {
          tx.push(data);
          tx.flush();
          const batch = pending.splice(0);
          if (classic) await feedClassic(batch);
          else for (const c of batch) await emit(c);
        } else if (classic) {
          await feedClassic([data]);
        } else {
          await emit(data);
        }
        if (onProgress) {
          onProgress({ done: i + 1, total: n, bytes: bytesIn, elapsed: (Date.now() - t0) / 1000 });
        }
      }

      if (convert && !initDone) {
        throw new Error(
          "Conversion MP4 impossible (codec non pris en charge par mux.js, ex. HEVC). " +
            "Choisis le format TS brut."
        );
      }
      let faststart = null;
      if (classic) {
        if (!started || !builder.hasData()) {
          throw new Error("Aucun échantillon exploitable dans ce flux (fMP4 non pris en charge).");
        }
        const { head, tail, faststart: fs } = builder.finalize();
        faststart = fs;
        if (tail) await emit(tail); // réserve insuffisante : moov à la fin (fichier valide)
        await patchHead(head);
      }
      return { bytesOut, faststart };
    } finally {
      ac.abort(); // coupe tout ce qui serait encore en vol
    }
  }

  const API = { patchInitDuration, parseMaster, parseMedia, isMaster, prepare, download, sniff, extFor, fetchText, fetchBytes };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.HLS = API;
})(typeof globalThis !== "undefined" ? globalThis : self);
