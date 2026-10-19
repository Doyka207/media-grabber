// Firefox expose `browser` (promesses), Chrome expose `chrome` (promesses aussi en MV3)
const api = typeof browser !== "undefined" ? browser : chrome;
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");

const formatSize = (n) =>
  !n ? "taille inconnue"
     : n > 1e9 ? (n / 1e9).toFixed(2) + " Go"
     : n > 1e6 ? (n / 1e6).toFixed(1) + " Mo"
     : Math.round(n / 1e3) + " Ko";

function fileName(item) {
  let name = "media";
  try {
    name = decodeURIComponent(new URL(item.url).pathname.split("/").pop()) || name;
  } catch {}
  name = name.replace(/[\\/:*?"<>|]/g, "_");
  if (!/\.\w{2,5}$/.test(name)) {
    const ext = ((item.contentType || "").split("/")[1] || "bin").split(";")[0];
    name += "." + ext;
  }
  return name;
}

function button(label, onClick, primary = false) {
  const b = document.createElement("button");
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", () => onClick(b));
  return b;
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = "Copié ✓";
  setTimeout(() => (btn.textContent = old), 1200);
}

function render(items) {
  emptyEl.style.display = items.length ? "none" : "block";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "item";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = fileName(item);

    const meta = document.createElement("div");
    meta.className = "meta";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.kind.toUpperCase();
    meta.append(tag, `${formatSize(item.size)} · ${new URL(item.url).hostname}`);

    const actions = document.createElement("div");
    if (item.kind === "file") {
      actions.append(
        button("Télécharger", () =>
          api.downloads.download({ url: item.url, filename: fileName(item), saveAs: true }), true)
      );
    } else {
      if (item.kind === "hls") {
        actions.append(
          button("Télécharger", () =>
            api.tabs.create({
              url: api.runtime.getURL("download.html") + "?" + new URLSearchParams({
                u: item.url, p: item.pageUrl || "", t: item.pageTitle || "",
              }),
            }), true)
        );
      }
      const out = (item.pageTitle || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) + ".mp4";
      const cmd = `ffmpeg -i "${item.url}" -c copy "${out}"`;
      actions.append(button("Commande ffmpeg", (b) => copy(cmd, b), item.kind !== "hls"));
    }
    actions.append(button("Copier l'URL", (b) => copy(item.url, b)));

    row.append(name, meta, actions);
    listEl.append(row);
  }
}

// Firefox traite les permissions d'hôtes du MV3 comme optionnelles : si elles manquent,
// aucune requête n'est observée tant que l'utilisateur n'a pas cliqué sur « Autoriser ».
async function checkPermission() {
  try {
    if (await api.permissions.contains({ origins: ["<all_urls>"] })) return;
  } catch {
    return;
  }
  const box = document.getElementById("perm");
  box.hidden = false;
  document.getElementById("grant").addEventListener("click", async () => {
    try {
      if (await api.permissions.request({ origins: ["<all_urls>"] })) box.hidden = true;
    } catch (e) {
      console.error(e);
    }
  });
}

(async () => {
  await checkPermission();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const key = `tab:${tab.id}`;
  const { [key]: items = [] } = await api.storage.session.get(key);
  render(items);
})();
