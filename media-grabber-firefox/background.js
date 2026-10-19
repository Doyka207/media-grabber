// Media Grabber - arrière-plan (MV3 : service worker sous Chrome, event page sous Firefox)
// Principe : observer les en-têtes de réponse de chaque requête et garder
// celles dont le type MIME / l'extension correspond à un média.

// Firefox expose `browser` (promesses), Chrome expose `chrome` (promesses aussi en MV3)
const api = typeof browser !== "undefined" ? browser : chrome;
// Origine de l'extension : on ignore ses propres requêtes (page de téléchargement)
const OWN_ORIGIN = api.runtime.getURL("").replace(/\/$/, "");

const SEGMENT_URL = /\.(ts|m4s|cmfv|cmfa)(\?|#|$)/i;   // segments HLS/DASH : bruit
const MEDIA_URL = /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|ogg|opus|wav|flac)(\?|#|$)/i;
const MIN_SIZE = 30 * 1024; // ignore les fichiers < 30 Ko (pubs, bips, etc.)

// File d'attente pour éviter les écritures concurrentes dans storage
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch(console.error));

function header(details, name) {
  const h = (details.responseHeaders || []).find(
    (x) => x.name.toLowerCase() === name
  );
  return h ? h.value : "";
}

function classify(url, contentType) {
  if (/^text\//i.test(contentType)) return null;
  if (SEGMENT_URL.test(url) || /mp2t/i.test(contentType)) return null;
  if (/\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(contentType)) return "hls";
  if (/\.mpd(\?|#|$)/i.test(url) || /dash\+xml/i.test(contentType)) return "dash";
  if (/^(video|audio)\//i.test(contentType) || MEDIA_URL.test(url)) return "file";
  return null;
}

api.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    // originUrl (Firefox) / initiator (Chrome) : requête émise par une page de l'extension
    if ((d.originUrl || d.initiator || "").startsWith(OWN_ORIGIN)) return;
    const contentType = header(d, "content-type");
    const kind = classify(d.url, contentType);
    if (!kind) return;

    // Les lecteurs vidéo font des requêtes "Range" : la taille totale est
    // dans Content-Range ("bytes 0-1023/123456").
    const range = header(d, "content-range");
    const total = (range.match(/\/(\d+)$/) || [])[1];
    const size = Number(total || header(d, "content-length")) || 0;
    if (kind === "file" && size && size < MIN_SIZE) return;

    enqueue(() => addItem(d.tabId, { url: d.url, kind, contentType, size }));
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

async function addItem(tabId, item) {
  const key = `tab:${tabId}`;
  const { [key]: list = [] } = await api.storage.session.get(key);
  if (list.some((i) => i.url === item.url)) return;

  const tab = await api.tabs.get(tabId).catch(() => null);
  item.pageTitle = tab?.title || "";
  item.pageUrl = tab?.url || "";
  list.push(item);

  await api.storage.session.set({ [key]: list });
  await api.action.setBadgeText({ tabId, text: String(list.length) });
  await api.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
}

// Nouvelle navigation dans l'onglet : on repart de zéro
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  enqueue(async () => {
    await api.storage.session.remove(`tab:${tabId}`);
    await api.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  });
});

api.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => api.storage.session.remove(`tab:${tabId}`));
});
