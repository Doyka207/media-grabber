// Page de téléchargement HLS : analyse, choix de la qualité, assemblage dans le navigateur.

// Firefox expose `browser` (promesses), Chrome expose `chrome` (promesses aussi en MV3)
const api = typeof browser !== "undefined" ? browser : chrome;
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const srcUrl = q.get("u");
const pageUrl = q.get("p") || "";
const pageTitle = q.get("t") || "video";

let pl = null;            // playlist préparée
let controller = null;    // AbortController du téléchargement en cours
let running = false;
let ruleId = null;

const fmtSize = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + " Go" : n > 1e6 ? (n / 1e6).toFixed(1) + " Mo" : Math.round(n / 1e3) + " Ko");
const fmtTime = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(r).padStart(2, "0");
};
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "video";

function setInfo(text, cls = "", warnings = []) {
  const el = $("info");
  el.textContent = text;
  el.className = "info " + cls;
  for (const w of warnings) {
    const d = document.createElement("div");
    d.className = "warn";
    d.textContent = "⚠ " + w;
    el.append(d);
  }
}

// Certains serveurs exigent le bon Referer/Origin : on les impose aux requêtes de CET onglet.
async function installHeaderRule() {
  if (!pageUrl) return;
  const tab = await api.tabs.getCurrent();
  if (!tab) return;
  ruleId = (tab.id % 1000000) + 1;
  const mk = (withOrigin) => ({
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "referer", operation: "set", value: pageUrl },
        ...(withOrigin ? [{ header: "origin", operation: "set", value: new URL(pageUrl).origin }] : []),
      ],
    },
    condition: { tabIds: [tab.id], resourceTypes: ["xmlhttprequest", "other"] },
  });
  const apply = (rule) =>
    api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules: [rule] });
  try {
    await apply(mk(true));
  } catch {
    try { await apply(mk(false)); } catch (e) { console.warn("Règle d'en-têtes refusée", e); ruleId = null; }
  }
}
window.addEventListener("pagehide", () => {
  if (ruleId != null) api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
});
window.addEventListener("beforeunload", (e) => {
  if (running) { e.preventDefault(); e.returnValue = ""; }
});

async function analyze(mediaUrl, variantInfo) {
  $("start").disabled = true;
  $("format").disabled = true;
  setInfo("Analyse du flux…");
  try {
    pl = await HLS.prepare(mediaUrl);
  } catch (e) {
    pl = null;
    setInfo(e.message, "error");
    return;
  }
  const kindLabel = { ts: "MPEG-TS", fmp4: "MP4 fragmenté", aac: "AAC (audio)", mp3: "MP3 (audio)", unknown: "inconnu" }[pl.kind];
  const warnings = [];
  if (variantInfo && variantInfo.separateAudio) {
    warnings.push("Cette qualité a une piste audio séparée : elle n'est pas incluse (la vidéo sera muette).");
  }
  if (pl.kind === "unknown") warnings.push("Format des segments non reconnu : ils seront simplement mis bout à bout.");
  setInfo(
    `${pl.segments.length} segments · ~${fmtTime(pl.totalDuration)} · conteneur ${kindLabel} · ` +
      (pl.encrypted ? "chiffré AES-128 (déchiffré localement)" : "non chiffré"),
    "",
    warnings
  );

  const fmt = $("format");
  fmt.replaceChildren();
  const add = (v, label) => fmt.append(new Option(label, v));
  if (pl.kind === "ts") {
    add("mp4", "MP4 classique (recommandé)");
    add("fmp4", "MP4 fragmenté (ancien format, sans index)");
    add("raw", "TS brut (aucune conversion)");
  } else if (pl.kind === "fmp4") {
    add("mp4", "MP4 classique (recommandé)");
    add("fmp4", "MP4 fragmenté (copie brute des segments)");
  } else add("raw", { aac: "AAC", mp3: "MP3", unknown: "Brut (.bin)" }[pl.kind]);
  fmt.disabled = fmt.options.length < 2;
  updateName();
  $("start").disabled = false;
}

function updateName() {
  if (!pl) return;
  const base = $("filename").value.replace(/\.[A-Za-z0-9]{2,4}$/, "") || safeName(pageTitle);
  $("filename").value = base + "." + HLS.extFor(pl.kind, $("format").value);
}

const MIMES = { mp4: "video/mp4", ts: "video/mp2t", aac: "audio/aac", mp3: "audio/mpeg" };
const cleanName = (n) => n.replace(/[\\/:*?"<>|]+/g, "_").trim() || "video";

// Remet un fichier (File / Blob) au gestionnaire de téléchargements du navigateur et attend la fin.
function saveBlobUrl(url, name) {
  return new Promise((resolve, reject) => {
    const states = new Map();
    let id = null;
    const done = (state, error) => {
      api.downloads.onChanged.removeListener(onChanged);
      if (state === "complete") resolve();
      else reject(new Error("Le navigateur a interrompu l'enregistrement" + (error ? ` (${error})` : "") + "."));
    };
    const onChanged = (d) => {
      if (!d.state) return;
      states.set(d.id, d.state.current);
      if (id !== null && d.id === id && ["complete", "interrupted"].includes(d.state.current)) {
        done(d.state.current, d.error && d.error.current);
      }
    };
    api.downloads.onChanged.addListener(onChanged);
    api.downloads
      .download({ url, filename: cleanName(name), conflictAction: "uniquify" })
      .then((newId) => {
        id = newId;
        const st = states.get(id); // l'événement a pu arriver avant la réponse
        if (st === "complete" || st === "interrupted") done(st);
      })
      .catch((e) => {
        api.downloads.onChanged.removeListener(onChanged);
        reject(e);
      });
  });
}

// Firefox : pas de showSaveFilePicker. On écrit dans le système de fichiers privé de l'extension (OPFS,
// sur disque, accès positionnel pour l'en-tête MP4), puis on copie vers « Téléchargements ».
async function opfsWriter(name, ext) {
  const dir = await navigator.storage.getDirectory();
  // ménage des restes d'une session interrompue (> 24 h)
  try {
    for await (const [n, h] of dir.entries()) {
      if (n.startsWith("mg-") && h.kind === "file" && (await h.getFile()).lastModified < Date.now() - 864e5) {
        await dir.removeEntry(n).catch(() => {});
      }
    }
  } catch {}
  const tmp = `mg-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const fh = await dir.getFileHandle(tmp, { create: true });
  if (typeof fh.createWritable !== "function") {
    await dir.removeEntry(tmp).catch(() => {});
    throw new Error("createWritable indisponible");
  }
  const w = await fh.createWritable();
  const cleanup = () => dir.removeEntry(tmp).catch(() => {});
  return {
    needsExport: true,
    write: (c) => w.write(c),
    patchHead: (head) => w.write({ type: "write", position: 0, data: head }),
    close: async () => {
      await w.close();
      const url = URL.createObjectURL(await fh.getFile());
      try {
        await saveBlobUrl(url, name);
      } finally {
        URL.revokeObjectURL(url);
        await cleanup();
      }
    },
    abort: async () => {
      try { await w.abort(); } catch {}
      await cleanup();
    },
  };
}

// Dernier recours (navigation privée Firefox, etc.) : tout en mémoire, limité par la RAM.
function memoryWriter(name, mime) {
  const chunks = [];
  return {
    needsExport: true,
    write: async (c) => { chunks.push(c); },
    // Le MP4 classique écrit d'abord une zone d'en-tête réservée (1er morceau) : on la remplace à la fin
    patchHead: async (head) => { chunks[0] = head; },
    close: async () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
      try {
        await saveBlobUrl(url, name);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    abort: async () => { chunks.length = 0; },
  };
}

async function openWriter(name, ext) {
  const mime = MIMES[ext] || "application/octet-stream";
  // Chrome / Edge : sélecteur de fichier, écriture directe sur le disque
  if (window.showSaveFilePicker) {
    const handle = await showSaveFilePicker({
      suggestedName: name,
      types: [{ description: ext.toUpperCase(), accept: { [mime]: ["." + ext] } }],
    });
    const w = await handle.createWritable();
    return {
      write: (c) => w.write(c),
      patchHead: (head) => w.write({ type: "write", position: 0, data: head }),
      close: () => w.close(),
      abort: () => w.abort().catch(() => {}),
    };
  }
  // Firefox : OPFS puis téléchargement
  if (navigator.storage && navigator.storage.getDirectory) {
    try {
      return await opfsWriter(name, ext);
    } catch (e) {
      console.warn("OPFS indisponible, repli en mémoire :", e);
    }
  }
  return memoryWriter(name, mime);
}

async function start() {
  if (!pl || running) return;
  const format = $("format").value;
  const name = $("filename").value.trim() || "video";
  const ext = HLS.extFor(pl.kind, format);

  let writer;
  try {
    // Doit être le premier await du clic (le sélecteur de fichier exige un geste utilisateur récent)
    writer = await openWriter(name, ext);
  } catch (e) {
    if (e.name !== "AbortError") setInfo("Impossible d'ouvrir le fichier : " + e.message, "error");
    return;
  }

  running = true;
  controller = new AbortController();
  $("start").disabled = true;
  $("variant").disabled = true;
  $("format").disabled = true;
  $("cancel").classList.remove("hidden");
  $("bar").classList.remove("hidden");
  $("bar").value = 0;
  setInfo("Téléchargement en cours… garde cet onglet ouvert.");

  try {
    const r = await HLS.download(pl, {
      format,
      signal: controller.signal,
      write: (c) => writer.write(c),
      patchHead: (h) => writer.patchHead(h),
      onProgress: ({ done, total, bytes, elapsed }) => {
        $("bar").value = done / total;
        const speed = elapsed > 0 ? bytes / elapsed : 0;
        const eta = speed > 0 && done > 0 ? (elapsed / done) * (total - done) : 0;
        $("stats").textContent =
          `${done}/${total} segments · ${fmtSize(bytes)} téléchargés · ${fmtSize(speed)}/s` +
          (done < total ? ` · reste ~${fmtTime(eta)}` : "");
      },
    });
    const note = r.faststart === false ? " — index placé à la fin du fichier" : "";
    if (writer.needsExport) setInfo("Téléchargement terminé, enregistrement dans le dossier Téléchargements…");
    await writer.close();
    const where = writer.needsExport ? " — enregistré dans le dossier Téléchargements" : "";
    setInfo(`Terminé ✓ — ${name} (${fmtSize(r.bytesOut)})${where}${note}`, "ok");
  } catch (e) {
    await writer.abort();
    if (e.name === "AbortError") setInfo("Téléchargement annulé.");
    else setInfo("Échec : " + e.message, "error");
  } finally {
    running = false;
    controller = null;
    $("cancel").classList.add("hidden");
    $("variant").disabled = false;
    $("format").disabled = $("format").options.length < 2;
    $("start").disabled = false;
  }
}

// Firefox traite les permissions d'hôtes du MV3 comme optionnelles : sans elles, les requêtes
// vers les serveurs de la vidéo sont bloquées par CORS. On propose de les accorder (geste requis).
async function ensureHostPermission() {
  try {
    if (await api.permissions.contains({ origins: ["<all_urls>"] })) return;
  } catch {
    return;
  }
  await new Promise((resolve) => {
    setInfo("Pour télécharger la vidéo, l'extension doit pouvoir accéder aux serveurs du site.");
    const b = document.createElement("button");
    b.className = "primary";
    b.style.marginTop = "8px";
    b.textContent = "Autoriser l'accès aux sites";
    b.addEventListener("click", async () => {
      try {
        if (await api.permissions.request({ origins: ["<all_urls>"] })) {
          b.remove();
          resolve();
        }
      } catch (e) {
        setInfo("Autorisation refusée : " + e.message, "error");
      }
    });
    $("info").append(document.createElement("br"), b);
  });
}

async function init() {
  if (!srcUrl) { setInfo("Aucune URL fournie.", "error"); return; }
  $("src").textContent = srcUrl;
  $("filename").value = safeName(pageTitle);
  await ensureHostPermission();
  await installHeaderRule();

  let text;
  try {
    text = await HLS.fetchText(srcUrl);
  } catch (e) {
    setInfo("Impossible de charger la playlist : " + e.message, "error");
    return;
  }

  if (HLS.isMaster(text)) {
    const { variants } = HLS.parseMaster(text, srcUrl);
    if (!variants.length) { setInfo("Playlist maître sans variante.", "error"); return; }
    const sel = $("variant");
    variants.forEach((v, i) => {
      const label = [v.resolution || "audio", Math.round(v.bandwidth / 1000) + " kb/s"].join(" · ");
      sel.append(new Option(label, String(i)));
    });
    $("variantBox").classList.remove("hidden");
    sel.addEventListener("change", () => analyze(variants[+sel.value].url, variants[+sel.value]));
    await analyze(variants[0].url, variants[0]);
  } else {
    await analyze(srcUrl, null);
  }
}

$("format").addEventListener("change", updateName);
$("start").addEventListener("click", start);
$("cancel").addEventListener("click", () => controller && controller.abort());
init();
