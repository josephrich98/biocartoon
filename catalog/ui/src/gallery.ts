import { App } from "@modelcontextprotocol/ext-apps";

type Asset = { id: string; title: string; source: string; source_name?: string; license: string; credit: string; url: string; thumb_url?: string; svg_url?: string; description?: string };
type Template = { id: string; title: string; license: string; author?: string; description?: string; thumb_url?: string; json_url?: string };
type FigureElement = { id: string; label: string; match: string; asset?: Asset; own?: unknown };
type Figure = { title: string; layout: string; width: number; height: number; spec: unknown; elements: FigureElement[]; credits: string[]; preview_svg?: string; open_url?: string };
type ToolResult = { structuredContent?: unknown; content?: unknown[]; isError?: boolean };

const app = new App({ name: "BioCartoon gallery", version: "0.5.0" });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const results = $("results"), status = $("status"), error = $("error");
const query = $<HTMLInputElement>("query"), sort = $<HTMLSelectElement>("sort"), searchButton = $<HTMLButtonElement>("search-button");
const filterButton = $<HTMLButtonElement>("filter-button"), filters = $("filters"), filterCount = $("filter-count");
const fSource = $<HTMLSelectElement>("f-source"), fAuthor = $<HTMLInputElement>("f-author"), fCategory = $<HTMLSelectElement>("f-category");
const fLicense = $<HTMLSelectElement>("f-license"), fType = $<HTMLSelectElement>("f-type"), fTags = $<HTMLInputElement>("f-tags"), fKind = $<HTMLSelectElement>("f-kind");
const SOURCES: Record<string, string> = { biocartoon: "BioCartoon", user: "BioCartoon community", bioart: "NIH BioArt", bioicons: "Bioicons", servier: "Servier Medical Art", scidraw: "SciDraw", healthicons: "Health Icons", reactome: "Reactome", phylopic: "PhyloPic", togotv: "TogoTV", openmoji: "OpenMoji", noto: "Noto Emoji" };
const LICENSES: Record<string, string> = { PD: "Public domain", "CC0-1.0": "CC0", "CC-BY-4.0": "CC BY 4.0", "CC-BY-3.0": "CC BY 3.0", "CC-BY-SA-4.0": "CC BY-SA 4.0", MIT: "MIT", "BSD-3-Clause": "BSD" };
let connected = false, revision = 0, editors = 0;
// The result the gallery opened with; an empty search with no filters brings it back.
let original: ToolResult | undefined;

// ---------------------------------------------------------------------------------------------
// Small DOM helpers

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el;
}
const ICONS: Record<string, string> = {
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4", download: "M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5", copy: "M9 9h10v11H9zM5 15V4h10",
  prev: "m15 5-7 7 7 7", next: "m9 5 7 7-7 7", send: "M5 12h13m0 0-5-5m5 5-5 5",
};
function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "i"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", ICONS[name]); svg.append(path);
  return svg;
}
function button(label: string, iconName = "", className = "btn"): HTMLButtonElement {
  const b = node("button", "", className); b.type = "button";
  if (iconName) b.append(icon(iconName)); b.append(label); return b;
}
function showError(message: string) { error.textContent = message; error.hidden = false; }
function clearError() { error.hidden = true; }

/** Only pictures from the public asset host are shown or linked. */
function assetUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const u = new URL(value); if (u.protocol === "https:" && u.hostname === "assets.biocartoon.com" && !u.username && !u.password && (!u.port || u.port === "443")) return u.href; } catch { /* Omitted. */ }
}
/** Editor links: the web app, with a share fragment. */
function editorUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const u = new URL(value); if (u.protocol === "https:" && u.hostname === "app.biocartoon.com" && !u.username && !u.password && (!u.port || u.port === "443")) return u.href; } catch { /* Omitted. */ }
}
async function openExternal(url: string) {
  if (!connected) { window.open(url, "_blank", "noopener,noreferrer"); return; }
  const r = await app.openLink({ url }).catch(() => ({ isError: true }));
  if (r.isError) showError(`The link could not be opened here. Copy it into your browser: ${url}`);
}
const fileName = (title: string, ext: string) => `${(title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "biocartoon").slice(0, 60)}.${ext}`;
const canDownload = () => connected && !!app.getHostCapabilities()?.downloadFile;

async function downloadLink(url: string, title: string, ext: "svg" | "png") {
  if (canDownload()) {
    const r = await app.downloadFile({ contents: [{ type: "resource_link", uri: url, name: fileName(title, ext), mimeType: ext === "svg" ? "image/svg+xml" : "image/png" }] }).catch(() => ({ isError: true }));
    if (!r.isError) return;
  }
  await openExternal(url);
}
async function downloadData(name: string, mimeType: string, data: { text?: string; blob?: string }) {
  if (!canDownload()) throw new Error("This chat app doesn't allow downloads from the gallery. Use Open in BioCartoon and export from the editor.");
  const r = await app.downloadFile({ contents: [{ type: "resource", resource: { uri: `file:///${name}`, mimeType, ...(data.text !== undefined ? { text: data.text } : { blob: data.blob! }) } }] });
  if (r.isError) throw new Error("The download was cancelled or refused.");
}
function toolText(result: ToolResult): string {
  const t = result.content?.find((c): c is { type: string; text: string } => !!c && typeof c === "object" && "text" in c);
  return t?.text ?? "";
}
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = await app.callServerTool({ name, arguments: args }) as ToolResult;
  if (r.isError) throw new Error(toolText(r) || "BioCartoon could not do that. Please try again.");
  return r;
}

// ---------------------------------------------------------------------------------------------
// Cards

type CardSpec = {
  title: string; sub?: string; media: Element; credit?: { license: string; text: string }; selected?: () => void;
  edit: { what: string; context: () => string; structured?: Record<string, unknown>; placeholder: string };
  download: { svg?: () => Promise<void>; png?: () => Promise<void> };
  open: () => Promise<void>;
  className?: string;
};

async function busy(b: HTMLButtonElement, label: string, f: () => Promise<void>) {
  const before = [...b.childNodes]; b.disabled = true; b.replaceChildren(label); clearError();
  try { await f(); } catch (e) { showError(e instanceof Error ? e.message : "That didn't work. Please try again."); }
  finally { b.disabled = false; b.replaceChildren(...before); }
}

function card(spec: CardSpec): HTMLElement {
  const el = node("article", "", `card ${spec.className ?? ""}`.trim());
  const media = node("div", "", "media"); media.append(spec.media);
  const overlay = node("div", "", "overlay");
  const edit = button("Edit", "edit", "btn orange");
  const download = button("Download", "download");
  download.setAttribute("aria-haspopup", "true"); download.setAttribute("aria-expanded", "false");
  const menu = node("div", "", "menu");
  const svg = button("SVG"), png = button("PNG");
  svg.disabled = !spec.download.svg; png.disabled = !spec.download.png;
  if (!spec.download.svg) svg.title = "This illustration has no SVG";
  menu.append(svg, png);
  const open = button("Open in BioCartoon", "open");
  overlay.append(edit, download, menu, open);
  media.append(overlay);

  download.onclick = () => { const show = !menu.classList.contains("show"); menu.classList.toggle("show", show); download.setAttribute("aria-expanded", String(show)); el.classList.toggle("open", show); if (show) svg.disabled ? png.focus() : svg.focus(); };
  svg.onclick = () => spec.download.svg && busy(svg, "Preparing…", spec.download.svg);
  png.onclick = () => spec.download.png && busy(png, "Preparing…", spec.download.png);
  open.onclick = () => busy(open, "Opening…", spec.open);
  edit.onclick = () => startEdit(el, media, spec);
  el.addEventListener("mouseleave", () => { if (!el.querySelector(".composer")) { menu.classList.remove("show"); el.classList.remove("open"); download.setAttribute("aria-expanded", "false"); } });

  const body = node("div", "", "body");
  body.append(node("h3", spec.title, "title"));
  if (spec.sub) body.append(node("div", spec.sub, "sub"));
  if (spec.credit) body.append(creditDetails(spec.credit));
  if (spec.selected) body.addEventListener("click", e => { if (!(e.target as HTMLElement).closest("details")) spec.selected!(); });
  el.append(media, body);
  return el;
}

function creditDetails(credit: { license: string; text: string }): HTMLDetailsElement {
  const details = node("details");
  details.append(node("summary", "Credit & license"));
  const box = node("div", "", "credit"), text = node("p");
  text.append(node("span", LICENSES[credit.license] ?? credit.license, "chip"), document.createElement("br"), credit.text);
  const copy = button("Copy", "copy", "btn copy");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(credit.text); copy.replaceChildren(icon("copy"), "Copied"); }
    catch {
      // The credit stays selectable when the host denies clipboard access.
      const range = document.createRange(); range.selectNodeContents(text); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
      copy.replaceChildren("Select and copy");
    }
  };
  box.append(text, copy); details.append(box);
  return details;
}

/** Edit starts a message to the assistant: the user says what to change, and it goes to the chat. */
function startEdit(el: HTMLElement, media: HTMLElement, spec: CardSpec) {
  media.querySelector(".composer")?.remove();
  const composer = node("form", "", "composer");
  const label = node("label", `What should change in ${spec.edit.what}?`, "sr-only"); label.htmlFor = `edit-${++editors}`;
  const area = node("textarea"); area.id = label.htmlFor; area.placeholder = spec.edit.placeholder; area.maxLength = 1000; area.required = true;
  const row = node("div"), cancel = button("Cancel"), send = button("Send", "send", "btn orange"); send.type = "submit";
  row.append(cancel, send); composer.append(label, area, row); media.append(composer); media.classList.add("editing"); el.classList.add("open");
  area.focus();
  const close = () => { composer.remove(); media.classList.remove("editing"); el.classList.remove("open"); };
  cancel.onclick = close;
  area.addEventListener("keydown", e => { if (e.key === "Escape") close(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) composer.requestSubmit(); });
  composer.onsubmit = e => {
    e.preventDefault();
    const request = area.value.trim(); if (!request) return;
    const message = `Edit ${spec.edit.what}: ${request}`;
    void busy(send, "Sending…", async () => {
      if (!connected) throw new Error("Not connected to the chat. Copy your request into the conversation.");
      await app.updateModelContext({ content: [{ type: "text", text: spec.edit.context() }], ...(spec.edit.structured ? { structuredContent: spec.edit.structured } : {}) }).catch(() => undefined);
      const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: message }] }).catch(() => ({ isError: true }));
      if (r.isError) {
        await navigator.clipboard.writeText(message).catch(() => undefined);
        throw new Error("The chat didn't accept the message. It is copied: paste it into the conversation.");
      }
      close(); status.textContent = "Edit sent to the assistant.";
    });
  };
}

function picture(url: string | undefined, alt: string): HTMLElement {
  if (!url) return node("span", "Preview unavailable", "missing");
  const img = node("img"); img.src = url; img.alt = alt; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.decoding = "async";
  img.onerror = () => img.replaceWith(node("span", "Preview unavailable", "missing"));
  return img;
}

const editorLinks = new Map<string, string>();
async function openVia(key: string, args: Record<string, unknown>) {
  let url = editorLinks.get(key);
  if (!url) {
    if (!connected) throw new Error("Not connected. Ask the assistant for an editor link.");
    url = editorUrl(((await call("open_in_biocartoon", args)).structuredContent as { url?: string } | undefined)?.url);
    if (!url) throw new Error("BioCartoon didn't return an editor link. Please try again.");
    editorLinks.set(key, url);
  }
  await openExternal(url);
}

function assetCard(asset: Asset): HTMLElement {
  const sourceName = SOURCES[asset.source] ?? asset.source_name ?? asset.source;
  const svgUrl = assetUrl(asset.svg_url), pngUrl = assetUrl(asset.url);
  return card({
    title: asset.title, sub: `${sourceName} · ${asset.id}`,
    media: picture(assetUrl(asset.thumb_url) ?? pngUrl, asset.title),
    credit: { license: asset.license, text: asset.credit },
    selected: () => select(asset),
    edit: {
      what: `BioCartoon illustration ${asset.id} ("${asset.title}")`, placeholder: "Describe the change: colours, a part to add or remove, a different pose…",
      context: () => `The user wants to edit BioCartoon illustration ${asset.id}: ${asset.title} (${sourceName}, ${asset.license}). Credit: ${asset.credit}. Adapt it with asset_svg (or redraw it in its style), following the license rules asset_svg gives.`,
      structured: { selectedAsset: asset },
    },
    download: { ...(svgUrl ? { svg: () => downloadLink(svgUrl, asset.title, "svg") } : {}), ...(pngUrl ? { png: () => downloadLink(pngUrl, asset.title, "png") } : {}) },
    open: () => openVia(`asset:${asset.id}`, { asset_id: asset.id }),
  });
}

function templateCard(t: Template): HTMLElement {
  const thumb = assetUrl(t.thumb_url);
  return card({
    title: t.title, sub: t.author ? `Template · ${t.author}` : "Template",
    media: picture(thumb, t.title),
    credit: { license: t.license, text: `"${t.title}"${t.author ? ` by ${t.author}` : ""}, BioCartoon template, ${t.license}` },
    edit: {
      what: `the BioCartoon template ${t.id} ("${t.title}")`, placeholder: "Describe your figure: what to swap in, relabel or add…",
      context: () => `The user wants a figure based on BioCartoon template ${t.id}: ${t.title}. ${t.description ?? ""} Look at it with template_image, then build their version with compose_figure (or open the template with open_in_biocartoon for them to edit).`,
      structured: { selectedTemplate: t },
    },
    download: thumb ? { png: () => downloadLink(thumb, t.title, "png") } : {},
    open: () => openVia(`template:${t.id}`, { template_id: t.id }),
  });
}

function select(asset: Asset) {
  for (const c of results.querySelectorAll(".card.selected")) c.classList.remove("selected");
  if (!connected) return;
  void app.updateModelContext({ content: [{ type: "text", text: `The user selected BioCartoon illustration ${asset.id}: ${asset.title}. License: ${asset.license}. Credit: ${asset.credit}` }], structuredContent: { selectedAsset: asset } }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Figures

const SVG_NS = "http://www.w3.org/2000/svg", XLINK = "http://www.w3.org/1999/xlink";
const SVG_TAGS = new Set(["svg", "rect", "path", "image", "text", "tspan", "g"]);
const SVG_ATTRS = new Set(["viewBox", "width", "height", "x", "y", "dy", "rx", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "paint-order", "font-size", "font-weight", "font-family", "text-anchor", "preserveAspectRatio", "href"]);

/** The user's own pictures in a figure arrive embedded: raster or SVG data URLs (an SVG in <image> is drawn
 *  without scripts or external loads). */
const OWN_PICTURE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/** The server's preview SVG, rebuilt from allowed elements only; pictures only from the asset host, or embedded. */
function cleanSvg(markup: string): SVGSVGElement | undefined {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror")) return;
  const copy = (from: Element): Element | undefined => {
    if (!SVG_TAGS.has(from.localName)) return;
    const to = document.createElementNS(SVG_NS, from.localName);
    for (const a of from.attributes) {
      const name = a.localName;
      if (!SVG_ATTRS.has(name)) continue;
      if (name === "href") { const url = from.localName === "image" && OWN_PICTURE.test(a.value) ? a.value : assetUrl(a.value); if (url) to.setAttribute("href", url); continue; }
      if (/url\(|javascript:/i.test(a.value)) continue;
      to.setAttribute(name, a.value);
    }
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) to.append(child.textContent ?? "");
      else if (child.nodeType === Node.ELEMENT_NODE) { const c = copy(child as Element); if (c) to.append(c); }
    }
    return to;
  };
  const svg = copy(root) as SVGSVGElement | undefined;
  svg?.removeAttribute("width"); svg?.removeAttribute("height");
  svg?.setAttribute("role", "img");
  return svg;
}

const exported = new Map<string, string>();
async function figureSvg(figure: Figure): Promise<string> {
  const key = JSON.stringify(figure.spec);
  let svg = exported.get(key);
  if (!svg) {
    const r = await call("export_figure", { figure: figure.spec });
    svg = (r.structuredContent as { svg?: string } | undefined)?.svg;
    if (typeof svg !== "string" || !svg.startsWith("<svg")) throw new Error("BioCartoon couldn't export the figure. Please try again.");
    exported.set(key, svg);
  }
  return svg;
}
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** A PNG at twice the figure's size, drawn here from the standalone SVG (its pictures are embedded). */
async function figurePng(figure: Figure): Promise<string> {
  const svg = await figureSvg(figure);
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("The figure could not be drawn as PNG here. Download the SVG instead.")); img.src = `data:image/svg+xml;base64,${utf8Base64(svg)}`; });
  const canvas = document.createElement("canvas"); canvas.width = figure.width * 2; canvas.height = figure.height * 2;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try { return canvas.toDataURL("image/png").split(",")[1]; }
  catch { throw new Error("This chat app blocks drawing the PNG here. Download the SVG instead."); }
}

function figurePanel(figure: Figure): HTMLElement {
  const panel = node("section", "", "panel"); panel.setAttribute("aria-label", "Figure");
  panel.append(node("h2", "Figure"));
  const svg = figure.preview_svg ? cleanSvg(figure.preview_svg) : undefined;
  const media = svg ?? node("span", "Preview unavailable", "missing");
  const credits = figure.credits.join("\n");
  const c = card({
    className: "figure-card", title: figure.title || "Figure", sub: `${figure.elements.length} pictures · ${figure.layout} layout`,
    media, credit: credits ? { license: "Credits", text: credits } : undefined,
    edit: {
      what: `the BioCartoon figure "${figure.title || "figure"}"`, placeholder: "Describe the change: swap an icon, add a step, relabel an arrow, change the layout…",
      context: () => `The user is editing the BioCartoon figure "${figure.title}". To change it, call compose_figure with figure set to this spec, edited (keep asset_id and image_ref on elements that stay): ${JSON.stringify(figure.spec)}`,
      structured: { figure: { title: figure.title, spec: figure.spec } },
    },
    download: {
      svg: async () => downloadData(fileName(figure.title, "svg"), "image/svg+xml", { text: await figureSvg(figure) }),
      png: async () => downloadData(fileName(figure.title, "png"), "image/png", { blob: await figurePng(figure) }),
    },
    open: async () => {
      const url = editorUrl(figure.open_url);
      if (url) return openExternal(url);
      return openVia(`figure:${JSON.stringify(figure.spec)}`, { figure: figure.spec });
    },
  });
  c.style.setProperty("--ratio", `${figure.width}/${figure.height}`);
  panel.append(c);
  const gaps = figure.elements.filter(e => !e.asset && e.match !== "own").map(e => e.label);
  const weak = figure.elements.filter(e => e.match === "weak").map(e => e.label);
  const notes = [gaps.length ? `No library icon fits ${gaps.join(", ")}: shown as empty boxes to fill in the editor.` : "", weak.length ? `Loose matches: ${weak.join(", ")}.` : ""].filter(Boolean);
  if (notes.length) { const p = node("p", notes.join(" "), "gaps"); p.style.marginTop = "10px"; panel.append(p); }
  return panel;
}

// ---------------------------------------------------------------------------------------------
// Panels with carousels

function carouselPanel(heading: string, cards: HTMLElement[], note = ""): HTMLElement {
  const panel = node("section", "", "panel"); panel.setAttribute("aria-label", heading);
  panel.append(node("h2", heading));
  if (note) panel.append(node("p", note, "note"));
  if (!cards.length) { panel.append(node("div", "Nothing found. Try a broader term, a synonym, or fewer filters.", "empty")); return panel; }
  const wrap = node("div", "", "carousel"), track = node("div", "", "track");
  track.append(...cards); track.tabIndex = -1;
  const prev = button("", "prev", "nav prev"), next = button("", "next", "nav next");
  prev.setAttribute("aria-label", `Previous ${heading.toLowerCase()}`); next.setAttribute("aria-label", `More ${heading.toLowerCase()}`);
  const step = () => Math.max(track.clientWidth * 0.9, 240);
  prev.onclick = () => track.scrollBy({ left: -step(), behavior: "smooth" });
  next.onclick = () => track.scrollBy({ left: step(), behavior: "smooth" });
  const update = () => { prev.hidden = track.scrollLeft < 4; next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4; };
  track.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(track);
  wrap.append(track, prev, next); panel.append(wrap);
  requestAnimationFrame(update);
  return panel;
}

// ---------------------------------------------------------------------------------------------
// Tool results

function isAsset(a: unknown): a is Asset {
  return !!a && typeof a === "object" && ["id", "title", "source", "license", "credit", "url"].every(k => typeof (a as Record<string, unknown>)[k] === "string");
}
function isTemplate(t: unknown): t is Template {
  return !!t && typeof t === "object" && ["id", "title"].every(k => typeof (t as Record<string, unknown>)[k] === "string");
}
function isFigure(f: unknown): f is Figure {
  if (!f || typeof f !== "object") return false;
  const x = f as Record<string, unknown>;
  return typeof x.width === "number" && typeof x.height === "number" && Array.isArray(x.elements) && Array.isArray(x.credits) && !!x.spec;
}

function show(result: ToolResult, heading = "Selected illustrations") {
  if (result.isError) throw new Error(toolText(result) || "BioCartoon could not load illustrations.");
  const data = (result.structuredContent ?? {}) as Record<string, unknown>;
  const panels: HTMLElement[] = [];
  if (isFigure(data.figure)) {
    const f = data.figure;
    f.elements = f.elements.filter(e => e && typeof e.label === "string").map(e => ({ ...e, asset: isAsset(e.asset) ? e.asset : undefined }));
    f.credits = f.credits.filter(c => typeof c === "string");
    panels.push(figurePanel(f));
    const used = f.elements.flatMap(e => e.asset ? [e.asset] : []).filter((a, i, all) => all.findIndex(b => b.id === a.id) === i);
    if (used.length) panels.push(carouselPanel("Icons in this figure", used.map(assetCard)));
    status.textContent = `${f.title || "Figure"} · ${f.elements.length} pictures`;
  }
  if (Array.isArray(data.assets)) {
    const assets = data.assets.filter(isAsset).slice(0, 60);
    panels.push(carouselPanel(heading, assets.map(assetCard)));
    status.textContent = `${heading} · ${assets.length} illustration${assets.length === 1 ? "" : "s"}`;
  }
  if (Array.isArray(data.templates)) {
    const templates = data.templates.filter(isTemplate).slice(0, 60);
    panels.push(carouselPanel("Template results", templates.map(templateCard)));
  }
  if (!panels.length) throw new Error("BioCartoon returned an unexpected result. Try searching again.");
  return panels;
}

function render(panels: HTMLElement[]) {
  results.replaceChildren(...panels); results.setAttribute("aria-busy", "false");
}

// ---------------------------------------------------------------------------------------------
// Search and filters

const list = (s: string) => s.split(",").map(t => t.trim()).filter(Boolean);
function activeFilters(): number {
  return [fSource.value, fAuthor.value.trim(), fCategory.value, fLicense.value, fType.value, fTags.value.trim(), fKind.value !== "both" ? "x" : ""].filter(Boolean).length;
}
function updateFilterCount() {
  const n = activeFilters();
  filterCount.hidden = !n; filterCount.textContent = String(n);
  filterButton.classList.toggle("active", n > 0);
}
filterButton.onclick = () => { const open = filters.hidden; filters.hidden = !open; filterButton.setAttribute("aria-expanded", String(open)); if (open) fSource.focus(); };
for (const el of [fSource, fAuthor, fCategory, fLicense, fType, fTags, fKind]) for (const ev of ["change", "input"]) el.addEventListener(ev, updateFilterCount);
$("clear-filters").onclick = () => {
  for (const s of [fSource, fCategory, fLicense, fType, sort]) s.value = "";
  fAuthor.value = ""; fTags.value = ""; fKind.value = "both"; fCategory.disabled = true; fCategory.replaceChildren(new Option("Any", ""));
  updateFilterCount();
};

function parseJsonText(r: ToolResult): unknown {
  try { return JSON.parse(toolText(r)); } catch { return undefined; }
}
async function loadFilterOptions() {
  try {
    const sources = parseJsonText(await call("list_sources", {}));
    if (!Array.isArray(sources)) return;
    const licenses = new Set<string>();
    for (const s of sources as Record<string, unknown>[]) {
      if (typeof s.source !== "string") continue;
      const label = SOURCES[s.source] ?? (typeof s.name === "string" ? s.name : s.source);
      if (![...fSource.options].some(o => o.value === s.source)) fSource.append(new Option(label, s.source));
      for (const l of String(s.licenses ?? "").split(",")) if (l.trim()) licenses.add(l.trim());
    }
    for (const l of [...licenses].sort()) fLicense.append(new Option(LICENSES[l] ?? l, l));
  } catch { /* The filters keep "Any"; searching still works. */ }
}
fSource.addEventListener("change", async () => {
  fCategory.replaceChildren(new Option("Any", "")); fCategory.disabled = true;
  if (!fSource.value || !connected) return;
  try {
    const cats = parseJsonText(await call("list_categories", { source: fSource.value }));
    if (!Array.isArray(cats)) return;
    for (const c of cats as Record<string, unknown>[]) if (typeof c.name === "string" && c.name) fCategory.append(new Option(`${c.name}${typeof c.count === "number" ? ` (${c.count})` : ""}`, c.name));
    fCategory.disabled = fCategory.options.length < 2;
  } catch { /* Category stays "Any". */ }
});

async function search() {
  if (!connected) return;
  const q = query.value.trim();
  if (!q && original && !activeFilters() && !sort.value) {
    ++revision; clearError(); searchButton.disabled = false;
    render(show(original)); return;
  }
  const request = ++revision;
  searchButton.disabled = true; clearError(); results.setAttribute("aria-busy", "true");
  status.textContent = "Searching…";
  const kind = fKind.value;
  const args: Record<string, unknown> = { query: q, limit: 24, ...(sort.value ? { sort: sort.value } : {}) };
  if (fSource.value) args.sources = [fSource.value];
  if (fLicense.value) args.licenses = [fLicense.value];
  if (fAuthor.value.trim()) args.author = fAuthor.value.trim();
  if (fCategory.value) args.category = fCategory.value;
  if (fType.value) args.file_type = fType.value;
  if (list(fTags.value).length) args.tags = list(fTags.value).slice(0, 20);
  try {
    const [icons, templates] = await Promise.all([
      kind !== "templates" ? call("search_assets", args) : undefined,
      kind !== "icons" ? call("list_templates", { query: q }) : undefined,
    ]);
    if (request !== revision) return;
    const label = q ? `Icon results for “${q}”` : "Icon results";
    const panels = [...(icons ? show(icons, label) : []), ...(templates ? show(templates) : [])];
    // A search for templates alone, with no templates, still says so.
    render(panels);
    const n = icons ? ((icons.structuredContent as { assets?: unknown[] })?.assets?.length ?? 0) : 0;
    const t = templates ? ((templates.structuredContent as { templates?: unknown[] })?.templates?.length ?? 0) : 0;
    status.textContent = [icons ? `${n} icon${n === 1 ? "" : "s"}` : "", templates ? `${t} template${t === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  } catch (e) {
    if (request !== revision) return;
    showError(e instanceof Error ? e.message : "Search failed. Please try again.");
    status.textContent = "Could not search. Try again."; results.setAttribute("aria-busy", "false");
  } finally { if (request === revision) searchButton.disabled = false; }
}
$("search").addEventListener("submit", e => { e.preventDefault(); void search(); });
$<HTMLAnchorElement>("open-app").addEventListener("click", e => { if (connected) { e.preventDefault(); void openExternal("https://app.biocartoon.com/"); } });

app.ontoolresult = result => {
  ++revision; searchButton.disabled = !connected; clearError();
  try { render(show(result as ToolResult)); original = result as ToolResult; }
  catch (e) { results.setAttribute("aria-busy", "false"); showError(e instanceof Error ? e.message : "Could not show illustrations."); status.textContent = "Illustrations unavailable."; }
};
app.ontoolinput = () => { status.textContent = "Working…"; };
app.ontoolcancelled = () => { ++revision; searchButton.disabled = !connected; results.setAttribute("aria-busy", "false"); status.textContent = "Cancelled. Search to try again."; };
function theme(context: { theme?: "light" | "dark" }) { if (context.theme) document.documentElement.dataset.theme = context.theme; }
app.onhostcontextchanged = theme;
try {
  await app.connect(); connected = true; searchButton.disabled = false;
  const context = app.getHostContext(); if (context) theme(context);
  if (status.textContent === "Connecting to BioCartoon…") status.textContent = "Ready.";
  void loadFilterOptions();
} catch { results.setAttribute("aria-busy", "false"); showError("Could not connect to the app host. Use the links in the conversation or reopen this gallery."); status.textContent = "Connection unavailable."; }
