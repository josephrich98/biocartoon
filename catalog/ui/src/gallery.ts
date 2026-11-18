import { App } from "@modelcontextprotocol/ext-apps";

type Asset = { id: string; title: string; source: string; license: string; credit: string; url: string; thumb_url?: string; svg_url?: string; description?: string };
const app = new App({ name: "BioCartoon gallery", version: "0.4.10" });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const gallery = $("gallery"), status = $("status"), error = $("error"), selection = $("selection");
const query = $<HTMLInputElement>("query"), source = $<HTMLSelectElement>("source"), searchButton = $<HTMLButtonElement>("search-button");
const sources: Record<string, string> = { user: "BioCartoon", bioart: "NIH BioArt", bioicons: "Bioicons", servier: "Servier", scidraw: "SciDraw", healthicons: "Health Icons", reactome: "Reactome", openmoji: "OpenMoji" };
let connected = false, revision = 0;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function showError(message: string) { error.textContent = message; error.hidden = false; }
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const u = new URL(value); if (u.protocol === "https:" && u.hostname === "assets.biocartoon.com" && !u.username && !u.password && (!u.port || u.port === "443")) return u.href; } catch { /* Invalid links are omitted. */ }
}
function link(label: string, value: unknown) {
  const url = safeUrl(value); if (!url) return null;
  const a = node("a", label, "link"); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
  a.addEventListener("click", e => { if (connected) { e.preventDefault(); void app.openLink({ url }).catch(() => showError("The link could not be opened. Try the download link from the conversation.")); } });
  return a;
}
document.querySelector<HTMLAnchorElement>("header a")!.addEventListener("click", e => {
  if (connected) { e.preventDefault(); void app.openLink({ url: "https://app.biocartoon.com" }).catch(() => showError("Open https://app.biocartoon.com in your browser.")); }
});
function downloads(asset: Asset) {
  const actions = node("div", "", "actions");
  for (const [label, url] of [["PNG ↗", asset.url], ["SVG ↗", asset.svg_url]]) { const a = link(label!, url); if (a) actions.append(a); }
  return actions;
}
function creditButton(asset: Asset) {
  const button = node("button", "Copy credit", "credit-button"); button.type = "button";
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(asset.credit); button.textContent = "Copied"; }
    catch {
      // The visible credit remains selectable when the host denies clipboard access.
      const details = button.closest("details"); if (details) details.open = true;
      button.textContent = "Select the credit text to copy";
    }
  };
  return button;
}
function parseAssets(result: { structuredContent?: unknown; content?: unknown[]; isError?: boolean }): Asset[] {
  if (result.isError) {
    const text = result.content?.find((c): c is { type: string; text: string } => !!c && typeof c === "object" && "text" in c);
    throw new Error(text?.text || "BioCartoon could not load illustrations.");
  }
  const data = result.structuredContent;
  const assets = data && typeof data === "object" && "assets" in data ? data.assets : undefined;
  if (!Array.isArray(assets)) throw new Error("BioCartoon returned an unexpected result. Try searching again.");
  return assets.filter((a): a is Asset => a && typeof a === "object" && ["id", "title", "source", "license", "credit", "url"].every(k => typeof a[k] === "string")).slice(0, 60);
}
function render(assets: Asset[], label = "Selected illustrations") {
  gallery.replaceChildren(); selection.hidden = true; gallery.setAttribute("aria-busy", "false");
  status.textContent = `${label} · ${assets.length} illustration${assets.length === 1 ? "" : "s"}`;
  if (!assets.length) { gallery.append(node("div", "No illustrations found. Try a broader term or a different collection.", "empty")); return; }
  for (const asset of assets) {
    const card = node("article", "", "card");
    const preview = node("button", "", "preview"); preview.type = "button"; preview.setAttribute("aria-label", `Select ${asset.title}`); preview.setAttribute("aria-pressed", "false");
    const url = safeUrl(asset.thumb_url) ?? safeUrl(asset.url);
    if (url) {
      const img = node("img"); img.src = url; img.alt = asset.title; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.onerror = () => preview.replaceChildren(node("span", "Preview unavailable")); preview.append(img);
    } else preview.textContent = "Preview unavailable";
    preview.onclick = () => selectAsset(asset, card, preview);
    const info = node("div", "", "info"), meta = node("div", "", "meta");
    meta.append(node("span", sources[asset.source] ?? asset.source), node("span", asset.license, "license"));
    const details = node("details"); details.append(node("summary", "Credit & license"), node("p", asset.credit), creditButton(asset));
    info.append(meta, node("h2", asset.title, "title"), details, downloads(asset)); card.append(preview, info); gallery.append(card);
  }
}
function selectAsset(asset: Asset, card: HTMLElement, preview: HTMLButtonElement) {
  for (const other of gallery.querySelectorAll(".card")) { other.classList.remove("selected"); other.querySelector("button")?.setAttribute("aria-pressed", "false"); }
  card.classList.add("selected"); preview.setAttribute("aria-pressed", "true");
  selection.replaceChildren(node("h2", asset.title), node("p", `${asset.id} · ${sources[asset.source] ?? asset.source} · ${asset.license}`));
  if (asset.description) selection.append(node("p", asset.description));
  selection.append(node("p", asset.credit), creditButton(asset), downloads(asset)); selection.hidden = false;
  const variants = node("button", "Other colours & styles"); variants.disabled = !connected; variants.type = "button";
  variants.onclick = () => void load("asset_variants", { id: asset.id }, `Variants of ${asset.title}`);
  selection.querySelector(".actions")!.append(variants);
  if (connected) void app.updateModelContext({ content: [{ type: "text", text: `The user selected BioCartoon illustration ${asset.id}: ${asset.title}. License: ${asset.license}. Credit: ${asset.credit}` }], structuredContent: { selectedAsset: asset } }).catch(() => showError("Selected here. Mention the illustration ID in chat so the assistant can use it."));
}
async function load(name: string, args: Record<string, unknown>, label: string) {
  const request = ++revision; searchButton.disabled = true; error.hidden = true;
  status.textContent = "Finding illustrations…"; gallery.setAttribute("aria-busy", "true");
  try {
    const result = await app.callServerTool({ name, arguments: args });
    if (request === revision) render(parseAssets(result), label);
  } catch (e) { if (request === revision) { showError(e instanceof Error ? e.message : "Search failed. Please try again."); status.textContent = "Could not load illustrations. Try again."; } }
  finally { if (request === revision) { searchButton.disabled = !connected; gallery.setAttribute("aria-busy", "false"); } }
}
$("search").addEventListener("submit", e => {
  e.preventDefault(); if (!connected || !query.value.trim()) return;
  void load("search_assets", { query: query.value.trim(), ...(source.value ? { sources: [source.value] } : {}), limit: 12 }, `Closest matches for “${query.value.trim()}”`);
});
app.ontoolresult = result => {
  ++revision; searchButton.disabled = !connected; error.hidden = true;
  try { render(parseAssets(result)); } catch (e) { gallery.setAttribute("aria-busy", "false"); showError(e instanceof Error ? e.message : "Could not show illustrations."); status.textContent = "Illustrations unavailable."; }
};
app.ontoolcancelled = () => { ++revision; searchButton.disabled = !connected; gallery.setAttribute("aria-busy", "false"); status.textContent = "Loading cancelled. Search to try again."; };
function theme(context: { theme?: "light" | "dark" }) { if (context.theme) document.documentElement.dataset.theme = context.theme; }
app.onhostcontextchanged = theme;
try {
  await app.connect(); connected = true; searchButton.disabled = false;
  const context = app.getHostContext(); if (context) theme(context);
  if (status.textContent === "Connecting to BioCartoon…") status.textContent = "Ready. Waiting for selected illustrations…";
} catch { gallery.setAttribute("aria-busy", "false"); showError("Could not connect to the app host. Use the illustration links in the conversation or reopen this gallery."); status.textContent = "Connection unavailable."; }
