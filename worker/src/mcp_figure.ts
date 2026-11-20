// Whole-figure composition on the server: a prompt or a structured spec becomes a laid-out figure
// of catalog icons, labels and arrows, a preview scene for the gallery, a self-contained SVG for
// downloads, and a `.biocartoon` project the editor opens from an encrypted share link.
//
// Nothing here draws new artwork: every picture is a catalog asset (or, when the library has
// nothing that fits, a labelled placeholder box the user can replace in the editor). The layout
// is deterministic, so a figure's resolved spec reproduces it exactly for edits and exports.
import { asset, assetUrl, getAsset, rows, searchRows, str, strings, text, words, type Args, type Row, type ToolResult } from "./mcp_catalog.ts";
import { fetchImage, type McpEnv } from "./mcp_artwork.ts";

export const WEB_APP = "https://app.biocartoon.com/";
const MAX_ELEMENTS = 16, MAX_CONNECTIONS = 32;
const KINDS = ["arrow", "inhibit", "double", "line", "equilibrium", "dashed"] as const;
const LAYOUTS = ["auto", "flow", "cycle", "hub", "grid"] as const;
export type Kind = typeof KINDS[number];
type Layout = typeof LAYOUTS[number];

export interface Element { id: string; label: string; query: string; asset_id?: string; placeholder?: boolean }
export interface Connection { from: string; to: string; kind: Kind; label: string }
export interface Spec { title: string; layout: Layout; elements: Element[]; connections: Connection[]; sources: string[] }

export interface SImage { id: string; asset_id: string; x: number; y: number; w: number; h: number; href: string; svg_href?: string; thumb_href?: string }
export interface SText { x: number; y: number; w: number; h: number; text: string; lines: string[]; size: number; bold: boolean; color: string; role: "title" | "label" | "connection"; owner?: string }
export interface SLine { x1: number; y1: number; x2: number; y2: number; kind: Kind }
export interface SBox { id: string; x: number; y: number; w: number; h: number }
export interface Scene { width: number; height: number; images: SImage[]; texts: SText[]; lines: SLine[]; boxes: SBox[]; groups: Record<string, number> }

type Resolved = Element & { row?: Row; match: "chosen" | "strong" | "weak" | "none" };

// ---------------------------------------------------------------------------------------------
// Spec parsing

const clean = (s: unknown, max: number) => typeof s === "string" ? [...s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("") : "";

export function parseSpec(raw: unknown): Spec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("figure must be an object with elements");
  const a = raw as Args;
  const layout = (clean(a.layout, 10) || "auto") as Layout;
  if (!LAYOUTS.includes(layout)) throw new Error(`layout must be one of ${LAYOUTS.join(", ")}`);
  if (!Array.isArray(a.elements) || !a.elements.length || a.elements.length > MAX_ELEMENTS) throw new Error(`elements must list 1–${MAX_ELEMENTS} pictures`);
  const ids = new Set<string>();
  const elements = a.elements.map((e, i): Element => {
    if (!e || typeof e !== "object") throw new Error(`element ${i + 1} must be an object`);
    const x = e as Args;
    const id = clean(x.id, 40) || `e${i + 1}`;
    if (ids.has(id)) throw new Error(`element id ${JSON.stringify(id)} is used twice`);
    ids.add(id);
    const label = clean(x.label, 60), query = clean(x.query, 120), asset_id = clean(x.asset_id, 40);
    if (!label && !query && !asset_id) throw new Error(`element ${id} needs a label, a query or an asset_id`);
    return { id, label, query: query || label, ...(asset_id ? { asset_id } : {}), ...(x.placeholder === true && !asset_id ? { placeholder: true } : {}) };
  });
  const byLabel = new Map(elements.map(e => [e.label.toLowerCase(), e.id]));
  const ref = (v: unknown, what: string) => {
    const s = clean(v, 60);
    if (ids.has(s)) return s;
    const found = byLabel.get(s.toLowerCase()); if (found) return found;
    throw new Error(`connection ${what} ${JSON.stringify(s)} is not an element id`);
  };
  const conns = a.connections === undefined ? [] : a.connections;
  if (!Array.isArray(conns) || conns.length > MAX_CONNECTIONS) throw new Error(`connections must be a list of at most ${MAX_CONNECTIONS}`);
  const connections = conns.map((c): Connection => {
    if (!c || typeof c !== "object") throw new Error("each connection must be an object");
    const x = c as Args;
    const kind = (clean(x.kind, 12) || "arrow") as Kind;
    if (!KINDS.includes(kind)) throw new Error(`connection kind must be one of ${KINDS.join(", ")}`);
    const from = ref(x.from, "from"), to = ref(x.to, "to");
    if (from === to) throw new Error(`connection from ${from} to itself`);
    return { from, to, kind, label: clean(x.label, 40) };
  });
  const sources = Array.isArray(a.sources) ? strings(a, "sources", 8) : [];
  return { title: clean(a.title, 120), layout, elements, connections, sources };
}

// ---------------------------------------------------------------------------------------------
// Planning a spec from a plain prompt

const LEAD = /^(?:please\s+)?(?:(?:make|create|draw|generate|build|show|illustrate|depict)\s+(?:me\s+)?)?(?:an?\s+|the\s+)?(?:(?:simple|scientific|biology|biological)\s+)*(?:figure|diagram|illustration|schematic|cartoon|picture|graphic|overview)?\s*(?:of|showing|that shows|depicting|about|for)?\s+/i;
const STEP = /\s*(->|→|⟶|=>|\bthen\b|\bleads? to\b|\bbecomes?\b|\bproduces?\b|\bgives? rise to\b|\bdifferentiates? into\b|\bactivates?\b|\binhibits?\b|\bblocks?\b|\bbinds?(?: to)?\b|\bconverts? (?:in)?to\b|\binto\b|\bto\b)\s*/i;

export function heuristicPlan(prompt: string): Args {
  const p = clean(prompt, 600).replace(/[.!?]+$/, "");
  const cycle = /\b(?:cycle|cyclic|loop|circular)\b/i.test(p);
  // "The cell cycle: G1 to S to ..." names the figure, then its parts.
  const colon = p.indexOf(":");
  const head = colon > 0 && colon < 60 ? p.slice(0, colon) : "";
  const body = (head ? p.slice(colon + 1).trim() : p).replace(LEAD, "").replace(/\b(?:the\s+)?(?:cycle|loop|pathway|process)\s+(?:of|from)\s+/i, "");
  const parts = body.split(STEP);
  const chunks: string[] = [], kinds: Kind[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) kinds.push(/inhibit|block/i.test(parts[i]) ? "inhibit" : /bind/i.test(parts[i]) ? "line" : "arrow");
    else chunks.push(parts[i]);
  }
  const tidy = (s: string) => clean(s.replace(/^(?:and|or|a|an|the|from|of)\s+/i, "").replace(/\s+(?:and|or)$/i, ""), 60);
  let names = chunks.map(tidy).filter(Boolean);
  let connected = names.length > 1;
  if (names.length < 2) { names = body.split(/\s*(?:,|;|\band\b|\bwith\b|\bvs\.?\b|\bversus\b|\+)\s*/i).map(tidy).filter(Boolean); connected = false; }
  names = names.slice(0, 8);
  const elements = names.map((n, i) => ({ id: `e${i + 1}`, label: n[0].toUpperCase() + n.slice(1), query: n }));
  const connections = connected ? elements.slice(1).map((e, i) => ({ from: elements[i].id, to: e.id, kind: kinds[i] ?? "arrow" })) : [];
  if (cycle && elements.length > 2 && connected) connections.push({ from: elements.at(-1)!.id, to: elements[0].id, kind: "arrow" });
  const named = (head || p).replace(LEAD, "").replace(/\s*(?:->|→|⟶|=>)\s*/g, " → ");
  return { title: clean(named[0]?.toUpperCase() + named.slice(1), 80), layout: cycle ? "cycle" : "auto", elements, connections };
}

const PLAN_PROMPT = `You plan scientific figures built from an icon library. Reply with JSON only:
{"title": string, "layout": "flow"|"cycle"|"hub"|"grid", "elements": [{"id": "e1", "label": "short label", "query": "1-3 word icon search, the thing's plain name"}], "connections": [{"from": "e1", "to": "e2", "kind": "arrow"|"inhibit"|"double"|"line"|"equilibrium"|"dashed", "label": "optional short verb"}]}
Use 2-10 elements, each a concrete depictable thing (cell, organ, molecule, organism, instrument). No explanations.`;

async function planWithAi(env: McpEnv, prompt: string): Promise<Args | undefined> {
  if (!env.AI) return;
  try {
    const out = await env.AI.run(env.PLAN_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [{ role: "system", content: PLAN_PROMPT }, { role: "user", content: prompt }], max_tokens: 900, temperature: 0.2,
    }) as { response?: unknown };
    const reply = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
    const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
    const plan = JSON.parse(json) as Args;
    parseSpec(plan); // Only a plan that validates is used.
    return plan;
  } catch { return; }
}

// ---------------------------------------------------------------------------------------------
// Choosing icons

const STOP = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "with", "to", "for", "cell", "cells"]);
/** Words that say little about what to draw: a match on them alone is no match ("G1 phase" is not a locust's phase). */
const GENERIC = new Set(["phase", "stage", "step", "process", "type", "level", "state", "form", "system", "structure", "sample", "human", "generic", "simple", "icon", "image"]);
/** Pictures of a scan or a device's screen, not of the thing itself. */
const IMAGING = /\b(?:ct|mri|ultrasound|x-?ray|scan|window|histology|micrograph|slice|section|screen)\b/i;
const SOURCE_BONUS: Record<string, number> = { bioart: 1, bioicons: 1, servier: 1, scidraw: 0.9, user: 1, reactome: 0.5, healthicons: 0.3, openmoji: 0, noto: 0 };
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const sameWord = (w: string, t: string) => w === t || w === t.replace(/(?:es|s)$/, "") || t === w.replace(/(?:es|s)$/, "") || (t.length >= 5 && w.startsWith(t));

export function scoreHit(row: Row, query: string, rank: number): { score: number; strong: boolean; any: boolean } {
  const all = tokens(query).filter(t => !STOP.has(t));
  const specific = all.filter(t => !GENERIC.has(t));
  const terms = specific.length ? specific : all.length ? all : tokens(query);
  const title = tokens(String(row.title ?? "")), tags = tokens(String(row.tags ?? ""));
  const inTitle = terms.filter(t => title.some(w => sameWord(w, t))).length, inTags = terms.filter(t => tags.some(w => sameWord(w, t))).length;
  const covered = terms.filter(t => title.some(w => sameWord(w, t)) || tags.some(w => sameWord(w, t))).length;
  const n = Math.max(1, terms.length);
  const extra = title.filter(w => !STOP.has(w) && !GENERIC.has(w) && !terms.some(t => sameWord(w, t))).length;
  const query_ = tokens(query).join(" ");
  const score = (inTitle === n ? 4 : 0) + 2 * inTitle / n + 1.5 * inTags / n + (extra === 0 && inTitle === n ? 2 : 0) - 0.35 * Math.min(extra, 4)
    - (IMAGING.test(String(row.title ?? "")) && !IMAGING.test(query_) ? 3 : 0)
    + (SOURCE_BONUS[String(row.source)] ?? 0.5) + (row.svg_key ? 0.3 : 0) - (row.variant ? 0.2 : 0) - rank * 0.03;
  return { score, strong: covered === n, any: covered > 0 };
}

async function resolve(env: McpEnv, spec: Spec): Promise<Resolved[]> {
  type Cand = { row: Row; score: number; strong: boolean };
  const found = await Promise.all(spec.elements.map(async (e): Promise<Resolved | Cand[]> => {
    if (e.asset_id) {
      const row = await getAsset(env.CATALOG, e.asset_id);
      return { ...e, label: e.label || String(row.title ?? ""), row, match: "chosen" };
    }
    if (e.placeholder) return { ...e, match: "none" };
    const scope = spec.sources.length ? { sources: spec.sources } : {};
    const [phrase, loose] = await Promise.all([
      words(e.query).length > 1 ? searchRows(env.CATALOG, { query: e.query, phrase: true, limit: 20, ...scope }) : Promise.resolve([] as Row[]),
      searchRows(env.CATALOG, { query: e.query, limit: 30, ...scope }),
    ]);
    const seen = new Set<unknown>(), hits = [...phrase, ...loose].filter(r => !seen.has(r.id) && seen.add(r.id));
    // A term found only in a description is too weak to place: such hits are dropped.
    return hits.map((row, i) => ({ row, ...scoreHit(row, e.query, i) })).filter(h => h.any).sort((a, b) => b.score - a.score);
  }));
  // One collection keeps a figure's style consistent: where its candidate is nearly as good as
  // the best, it wins.
  const count = new Map<string, number>();
  for (const f of found) if (Array.isArray(f) && f[0]) count.set(String(f[0].row.source), (count.get(String(f[0].row.source)) ?? 0) + 1);
  const main = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominant = main && main[1] >= 2 ? main[0] : "";
  return found.map((f, i): Resolved => {
    if (!Array.isArray(f)) return f;
    const e = spec.elements[i];
    if (!f.length) return { ...e, match: "none" };
    const best = f[0], styled = dominant ? f.find(c => String(c.row.source) === dominant && c.strong === best.strong && c.score >= best.score - 1.5) : undefined;
    const pick = styled ?? best;
    return { ...e, row: pick.row, match: pick.strong ? "strong" : "weak" };
  });
}

// ---------------------------------------------------------------------------------------------
// Layout

const PAGE_W = 960, MARGIN = 40;

function chooseLayout(spec: Spec): Exclude<Layout, "auto"> {
  if (spec.layout !== "auto") return spec.layout;
  const n = spec.elements.length, c = spec.connections;
  if (!c.length) return "grid";
  const degree = new Map<string, number>();
  for (const x of c) for (const k of [x.from, x.to]) degree.set(k, (degree.get(k) ?? 0) + 1);
  if (n >= 4 && [...degree.values()].some(d => d >= n - 1)) return "hub";
  // One closed loop through every element: each has one way in and one way out.
  if (n >= 3 && c.length === n && spec.elements.every(e => c.filter(x => x.from === e.id).length === 1 && c.filter(x => x.to === e.id).length === 1)) return "cycle";
  return "flow";
}

/** Longest-path layers of the connection graph; back edges of cycles are ignored. */
export function layers(spec: Spec): Map<string, number> {
  const out = new Map(spec.elements.map(e => [e.id, [] as string[]]));
  for (const c of spec.connections) out.get(c.from)!.push(c.to);
  const state = new Map<string, number>(), order: string[] = [], back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id)!) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2); order.push(id);
  };
  for (const e of spec.elements) if (!state.get(e.id)) visit(e.id);
  const layer = new Map(spec.elements.map(e => [e.id, 0]));
  for (const id of order.reverse()) for (const t of out.get(id)!) if (!back.has(`${id}>${t}`)) layer.set(t, Math.max(layer.get(t)!, layer.get(id)! + 1));
  return layer;
}

export function wrap(s: string, width: number, size: number, maxLines = 3): string[] {
  const per = Math.max(4, Math.floor(width / (size * 0.56)));
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if ([...next].length <= per || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = [...lines[maxLines - 1]].slice(0, per - 1).join("") + "…"; }
  return lines;
}

const round = (v: number) => Math.round(v * 10) / 10;

export function layout(spec: Spec, resolved: Resolved[]): Scene & { layout: string } {
  const kind = chooseLayout(spec), n = resolved.length;
  const titleH = spec.title ? 70 : 0;
  const centers = new Map<string, [number, number]>();
  let cell = 200, height = 0;
  if (kind === "grid" || kind === "flow") {
    let cols: number, grid: [string, number, number][];
    if (kind === "grid") {
      cols = n <= 4 ? n : n <= 6 ? 3 : n <= 8 ? 4 : 5;
      grid = resolved.map((e, i) => [e.id, i % cols, Math.floor(i / cols)]);
    } else {
      const layer = layers(spec), maxLayer = Math.max(...layer.values());
      const perRow = Math.min(5, maxLayer + 1);
      cols = perRow;
      // Layers wrap onto new bands after five columns; a layer's members stack within its band.
      const bandRows: number[] = [];
      const slot = new Map<number, number>();
      grid = [];
      for (const e of resolved) {
        const l = layer.get(e.id)!, band = Math.floor(l / perRow), k = slot.get(l) ?? 0;
        slot.set(l, k + 1); bandRows[band] = Math.max(bandRows[band] ?? 0, k + 1);
        grid.push([e.id, l % perRow, band * 100 + k]);
      }
      const offsets: number[] = []; let acc = 0;
      for (let b = 0; b < bandRows.length; b++) { offsets[b] = acc; acc += bandRows[b] ?? 1; }
      // Center each layer's stack within its band.
      grid = grid.map(([id, c, r]) => {
        const band = Math.floor(r / 100), k = r % 100;
        const inLayer = grid.filter(g => g[1] === c && Math.floor(g[2] / 100) === band).length;
        return [id, c, offsets[band] + k + ((bandRows[band] ?? 1) - inLayer) / 2];
      });
    }
    cell = Math.min(230, (PAGE_W - 2 * MARGIN) / cols);
    const rowH = Math.min(cell, 170) + 90;
    const rowsUsed = Math.max(...grid.map(g => g[2])) + 1;
    const x0 = (PAGE_W - cols * cell) / 2;
    for (const [id, c, r] of grid) centers.set(id, [x0 + (c + 0.5) * cell, MARGIN + titleH + r * rowH + Math.min(cell, 170) * 0.45]);
    height = MARGIN * 2 + titleH + rowsUsed * rowH - 30;
  } else {
    // Around a circle: every element for a cycle; all but the hub for a hub.
    const degree = new Map<string, number>();
    for (const x of spec.connections) for (const k of [x.from, x.to]) degree.set(k, (degree.get(k) ?? 0) + 1);
    const hub = kind === "hub" ? [...resolved].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0].id : "";
    const ring = resolved.filter(e => e.id !== hub);
    cell = ring.length > 8 ? 150 : 180;
    // Wide enough that neighbours (with their labels) never touch, and round rather than squashed.
    const r = Math.min(PAGE_W / 2 - MARGIN - cell / 2, Math.max(hub ? 240 : 200, ring.length * cell / (2 * Math.PI) * 1.8));
    const ry = r;
    const cy = MARGIN + titleH + ry + cell * 0.4;
    ring.forEach((e, i) => { const t = -Math.PI / 2 + i * 2 * Math.PI / ring.length; centers.set(e.id, [PAGE_W / 2 + r * Math.cos(t), cy + ry * Math.sin(t)]); });
    if (hub) centers.set(hub, [PAGE_W / 2, cy]);
  }
  const icon = Math.min(cell * (kind === "cycle" || kind === "hub" ? 0.6 : 0.68), 150);
  const scene: Scene = { width: PAGE_W, height: Math.round(Math.max(420, height)), images: [], texts: [], lines: [], boxes: [], groups: {} };
  if (spec.title) scene.texts.push({ x: MARGIN, y: MARGIN - 10, w: PAGE_W - 2 * MARGIN, h: 40, text: spec.title, lines: wrap(spec.title, PAGE_W - 2 * MARGIN, 26, 1), size: 26, bold: true, color: "#1e293b", role: "title" });
  type Rect = { x: number; y: number; w: number; h: number };
  const rects = new Map<string, Rect>(), labelRects = new Map<string, Rect>();
  for (const e of resolved) {
    const [cx, cy] = centers.get(e.id)!;
    let w = icon, h = icon;
    if (e.row) {
      const aw = Number(e.row.png_width) || 1, ah = Number(e.row.png_height) || 1;
      if (aw >= ah) h = icon * ah / aw; else w = icon * aw / ah;
      const href = assetUrl(e.row.png_key)!;
      scene.images.push({ id: e.id, asset_id: String(e.row.id), x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h), href, ...(e.row.svg_key ? { svg_href: assetUrl(e.row.svg_key) } : {}), ...(e.row.thumb_key ? { thumb_href: assetUrl(e.row.thumb_key) } : {}) });
    } else {
      h = icon * 0.7;
      scene.boxes.push({ id: e.id, x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h) });
    }
    rects.set(e.id, { x: cx - w / 2, y: cy - h / 2, w, h });
    const label = e.label || e.query;
    const lw = Math.max(110, cell - 16);
    const lines = wrap(label, lw, 16, 2);
    // In rows, labels share a baseline; around a circle each sits under its own picture.
    const lh = lines.length * 20 + 4, ly = cy + (kind === "flow" || kind === "grid" ? icon : h) / 2 + 8;
    scene.texts.push({ x: round(cx - lw / 2), y: round(ly), w: round(lw), h: lh, text: label, lines, size: 16, bold: false, color: "#1e293b", role: "label", owner: e.id });
    // The label's actual text, for keeping arrows off it.
    const tw = Math.min(lw, Math.max(...lines.map(l => [...l].length)) * 16 * 0.56);
    labelRects.set(e.id, { x: cx - tw / 2, y: ly, w: tw, h: lh });
  }
  const all = [...rects.values()], pageCx = PAGE_W / 2, pageCy = all.reduce((sum, r) => sum + r.y + r.h / 2, 0) / all.length;
  for (const c of spec.connections) {
    const a = rects.get(c.from)!, b = rects.get(c.to)!;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // How far along the line it leaves a box centred on its start (ox, oy from that centre).
    const leave = (r: Rect, cx: number, cy: number, sx: number, sy: number) => {
      // The ray leaves through whichever side it reaches first.
      let t = Infinity;
      for (const [lo, hi, c0, d] of [[r.x, r.x + r.w, cx, sx], [r.y, r.y + r.h, cy, sy]] as const) {
        if (Math.abs(d) < 1e-6) continue;
        t = Math.min(t, Math.max((lo - c0) / d, (hi - c0) / d));
      }
      return Number.isFinite(t) ? Math.max(0, t) : 0;
    };
    // Off the picture, and off its label when the line heads down through it.
    const exitFrom = (id: string, r: Rect, cx: number, cy: number, sx: number, sy: number) => {
      let t = leave(r, cx, cy, sx, sy);
      const lr = labelRects.get(id)!;
      const px = cx + sx * t, py = cy + sy * t;
      if (sy > 0.25) { const tl = leave(lr, px, py, sx, sy); if (px + sx * tl >= lr.x - 1 && px + sx * tl <= lr.x + lr.w + 1 && py < lr.y + lr.h) t += tl; }
      return t + 10;
    };
    const s = Math.min(exitFrom(c.from, a, ax, ay, ux, uy), len / 2 - 6), t = Math.min(exitFrom(c.to, b, bx, by, -ux, -uy), len / 2 - 6);
    const line: SLine = { x1: round(ax + ux * s), y1: round(ay + uy * s), x2: round(bx - ux * t), y2: round(by - uy * t), kind: c.kind };
    scene.lines.push(line);
    if (c.label) {
      const mx = (line.x1 + line.x2) / 2, my = (line.y1 + line.y2) / 2;
      const lines = wrap(c.label, 120, 13, 2), w = 120, h = lines.length * 16 + 2;
      // Beside the arrow, on the side away from the figure's middle (above, for a level arrow).
      let nx = -uy, ny = ux;
      const level = Math.abs(uy) < 0.2;
      if (level ? ny > 0 : nx * (mx - pageCx) + ny * (my - pageCy) < 0) { nx = -nx; ny = -ny; }
      const off = 8 + Math.abs(nx) * w / 2 + Math.abs(ny) * h / 2;
      const lx = mx + nx * off, ly = my + ny * off;
      scene.texts.push({ x: round(lx - w / 2), y: round(ly - h / 2), w, h, text: c.label, lines, size: 13, bold: false, color: "#475569", role: "connection" });
    }
  }
  // The page ends just below what is on it.
  const bottom = Math.max(...scene.texts.map(t => t.y + t.h), ...scene.images.map(i => i.y + i.h), ...scene.boxes.map(b => b.y + b.h), ...scene.lines.map(l => Math.max(l.y1, l.y2)));
  scene.height = Math.round(Math.max(360, bottom + MARGIN));
  return { ...scene, layout: kind };
}

// ---------------------------------------------------------------------------------------------
// Output: a self-contained SVG and a .biocartoon project

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function heads(l: SLine): string {
  const ang = Math.atan2(l.y2 - l.y1, l.x2 - l.x1), size = 11;
  const tri = (x: number, y: number, a: number) => `<path d="M${round(x)} ${round(y)} L${round(x - size * Math.cos(a - 0.45))} ${round(y - size * Math.sin(a - 0.45))} L${round(x - size * Math.cos(a + 0.45))} ${round(y - size * Math.sin(a + 0.45))} Z" fill="#3c4850"/>`;
  const bar = (x: number, y: number, a: number) => `<path d="M${round(x + 9 * Math.sin(a))} ${round(y - 9 * Math.cos(a))} L${round(x - 9 * Math.sin(a))} ${round(y + 9 * Math.cos(a))}" stroke="#3c4850" stroke-width="3.5" stroke-linecap="round"/>`;
  switch (l.kind) {
    case "arrow": case "dashed": return tri(l.x2, l.y2, ang);
    case "double": return tri(l.x2, l.y2, ang) + tri(l.x1, l.y1, ang + Math.PI);
    case "inhibit": return bar(l.x2, l.y2, ang);
    default: return "";
  }
}

/** The scene as SVG. `href` gives each picture's image (a data: URI for a standalone file). */
export function sceneSvg(scene: Scene, href: (img: SImage) => string): string {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}" font-family="Inter, Helvetica, Arial, sans-serif">`, `<rect width="100%" height="100%" fill="#ffffff"/>`];
  for (const l of scene.lines) {
    if (l.kind === "equilibrium") {
      const a = Math.atan2(l.y2 - l.y1, l.x2 - l.x1), ox = 4 * Math.sin(a), oy = -4 * Math.cos(a);
      const half = (x1: number, y1: number, x2: number, y2: number, ang: number) => `<path d="M${round(x1)} ${round(y1)} L${round(x2)} ${round(y2)} L${round(x2 - 11 * Math.cos(ang - 0.5))} ${round(y2 - 11 * Math.sin(ang - 0.5))}" fill="none" stroke="#3c4850" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
      out.push(half(l.x1 + ox, l.y1 + oy, l.x2 + ox, l.y2 + oy, a), half(l.x2 - ox, l.y2 - oy, l.x1 - ox, l.y1 - oy, a + Math.PI));
      continue;
    }
    const shorten = l.kind === "arrow" || l.kind === "double" || l.kind === "dashed" ? 8 : 0;
    const a = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
    const x2 = l.x2 - shorten * Math.cos(a), y2 = l.y2 - shorten * Math.sin(a);
    const x1 = l.kind === "double" ? l.x1 + shorten * Math.cos(a) : l.x1, y1 = l.kind === "double" ? l.y1 + shorten * Math.sin(a) : l.y1;
    out.push(`<path d="M${round(x1)} ${round(y1)} L${round(x2)} ${round(y2)}" stroke="#3c4850" stroke-width="3" stroke-linecap="round"${l.kind === "dashed" ? ` stroke-dasharray="9 6"` : ""}/>`, heads(l));
  }
  for (const b of scene.boxes) out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="14" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2" stroke-dasharray="7 5"/>`);
  for (const img of scene.images) out.push(`<image x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" preserveAspectRatio="xMidYMid meet" xlink:href="${esc(href(img))}"/>`);
  for (const t of scene.texts) {
    const anchor = t.role === "title" ? "start" : "middle", x = anchor === "start" ? t.x : t.x + t.w / 2;
    const lh = t.size * 1.25;
    out.push(`<text x="${round(x)}" y="${round(t.y + t.size)}" font-size="${t.size}"${t.bold ? ` font-weight="700"` : ""} fill="${t.color}" text-anchor="${anchor}"${t.role === "connection" ? ` stroke="#ffffff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : ""}>${t.lines.map((s, i) => `<tspan x="${round(x)}" dy="${i ? round(lh) : 0}">${esc(s)}</tspan>`).join("")}</text>`);
  }
  out.push("</svg>");
  return out.join("");
}

const rgba = (hex: string): number[] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
const LINE_KIND: Record<Kind, [string, string]> = { arrow: ["Arrow", "Solid"], inhibit: ["Inhibitor", "Solid"], double: ["DoubleArrow", "Solid"], line: ["Straight", "Solid"], equilibrium: ["Equilibrium", "Solid"], dashed: ["Arrow", "Dashed"] };

/** The figure as the editor's portable project (`.biocartoon`, see biocartoon-app app/src/projects.rs). */
export function sceneProject(scene: Scene, title: string, rowsById: Map<string, Row>): Record<string, unknown> {
  let next = 1;
  const items: Record<string, unknown>[] = [];
  const groups = new Map<string, number>();
  const groupOf = (id: string) => { if (!groups.has(id)) groups.set(id, next++); return groups.get(id)!; };
  const item = (name: string, kind: unknown, x: number, y: number, w: number, h: number, group: number | null = null) =>
    items.push({ id: next++, name, kind, pos: [x, y], size: [w, h], rotation: 0, flip_h: false, flip_v: false, locked: false, opacity: 1, group, fitted: false });
  const textKind = (t: SText, align = "Center") => ({ Text: { text: t.text, size: t.size, color: rgba(t.color), align, bold: t.bold, italic: false, underline: false, strike: false, font: "Sans", line_spacing: 1, valign: "Top", fill: [0, 0, 0, 0] } });
  for (const l of scene.lines) {
    const [kind, style] = LINE_KIND[l.kind];
    item(l.kind === "inhibit" ? "Inhibitor" : "Arrow", { Line: { kind, color: [60, 72, 80, 255], width: 3, style } }, l.x1, l.y1, l.x2 - l.x1, l.y2 - l.y1);
  }
  for (const b of scene.boxes) item("Placeholder", { Shape: { shape: "RoundedRectangle", fill: [241, 245, 249, 255], stroke: [148, 163, 184, 255], stroke_width: 2 } }, b.x, b.y, b.w, b.h, groupOf(b.id));
  for (const img of scene.images) {
    const r = rowsById.get(img.asset_id)!;
    const source: Record<string, unknown> = { id: r.id, key: r.png_key, title: r.title ?? "", source: r.source, credit: r.credit ?? "", license: r.license ?? "" };
    if (r.svg_key) source.svg = r.svg_key;
    item(String(r.title ?? "Image"), { Image: { source: { Asset: source }, crop: [0, 0, 1, 1], overlay: [0, 0, 0, 0] } }, img.x, img.y, img.w, img.h, groupOf(img.id));
  }
  // Labels group with the picture above them; the title and arrow labels stand alone.
  for (const t of scene.texts) {
    const isTitle = t.role === "title";
    item(isTitle ? "Title" : t.text, textKind(t, isTitle ? "Left" : "Center"), t.x, t.y, t.w, t.h + 6, t.owner && groups.has(t.owner) ? groupOf(t.owner) : null);
  }
  const DPI = 96;
  return { title: title || "BioCartoon figure", slides: [{ name: title || "Figure", items }], width: scene.width, height: scene.height, unit: "Inch", background: [255, 255, 255, 255], next_id: next, guides: [], _dpi: DPI };
}

// ---------------------------------------------------------------------------------------------
// Share links: the project, gzipped and AES-256-GCM encrypted here, kept by the submissions
// Worker. The key exists only in the returned link's fragment (biocartoon-app app/src/share.rs).

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function seal(project: Record<string, unknown>): Promise<{ bytes: Uint8Array; key: string }> {
  const { _dpi, ...doc } = project; void _dpi;
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(doc)));
  const raw = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const bytes = new Uint8Array(4 + 12 + sealed.length);
  bytes.set([0x42, 0x43, 0x53, 0x31]); bytes.set(nonce, 4); bytes.set(sealed, 16);
  return { bytes, key: b64url(raw) };
}

/** A view link: whoever opens it gets their own copy of the project in the editor. */
export async function shareProject(env: McpEnv, project: Record<string, unknown>, original?: Request): Promise<string> {
  const { bytes, key } = await seal(project);
  const headers = new Headers({
    "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length),
    "x-share-edit": b64url(crypto.getRandomValues(new Uint8Array(16))), "x-share-owner": b64url(crypto.getRandomValues(new Uint8Array(16))),
  });
  if (env.MCP_TOKEN) headers.set("X-MCP-Token", env.MCP_TOKEN);
  const ip = original?.headers.get("CF-Connecting-IP"); if (ip) headers.set("CF-Connecting-IP", ip);
  const response = await env.SUBMISSIONS.fetch(new Request("https://api.biocartoon.com/shares", { method: "POST", headers, body: bytes }));
  const reply = await response.json().catch(() => ({})) as { id?: string; error?: string };
  if (!response.ok || !reply.id) throw new Error(reply.error || `could not make an editor link: HTTP ${response.status}`);
  return `${WEB_APP}#share=${reply.id}.${key}`;
}

// ---------------------------------------------------------------------------------------------
// Tools

async function build(env: McpEnv, spec: Spec) {
  const resolved = await resolve(env, spec);
  const scene = layout(spec, resolved);
  const rowsById = new Map(resolved.filter(e => e.row).map(e => [String(e.row!.id), e.row!]));
  const elements = resolved.map(e => ({
    id: e.id, label: e.label || e.query, query: e.query, match: e.match,
    ...(e.row ? { asset: asset(e.row, e.match === "chosen" ? "" : e.query) } : {}),
  }));
  // The spec with every choice pinned, so passing it back reproduces this figure exactly.
  const resolvedSpec: Spec = {
    ...spec, layout: spec.layout,
    elements: resolved.map(e => ({ id: e.id, label: e.label || e.query, query: e.query, ...(e.row ? { asset_id: String(e.row.id) } : { placeholder: true }) })),
  };
  return { scene, rowsById, elements, resolvedSpec, layoutUsed: scene.layout };
}

function credits(rowsById: Map<string, Row>): string[] {
  return [...rowsById.values()].map(r => String(r.credit ?? "")).filter((c, i, all) => c && all.indexOf(c) === i);
}

async function compose(env: McpEnv, args: Args, request?: Request): Promise<ToolResult> {
  let raw: Args;
  if (args.figure !== undefined) raw = args.figure as Args;
  else if (Array.isArray(args.elements)) raw = args;
  else {
    const prompt = str(args, "prompt");
    if (!prompt) throw new Error("give elements (preferred), a figure to change, or a prompt");
    if (prompt.length > 1000) throw new Error("prompt must be at most 1,000 characters");
    raw = (await planWithAi(env, prompt)) ?? heuristicPlan(prompt);
    if (str(args, "title")) raw.title = str(args, "title");
  }
  if (Array.isArray(args.sources) && !Array.isArray(raw.sources)) raw = { ...raw, sources: args.sources };
  if (str(args, "layout") && args.figure === undefined && !Array.isArray(args.elements)) raw = { ...raw, layout: str(args, "layout") };
  const spec = parseSpec(raw);
  const { scene, rowsById, elements, resolvedSpec, layoutUsed } = await build(env, spec);
  let open_url = "", linkNote = "";
  if (args.open_link !== false) {
    try { open_url = await shareProject(env, sceneProject(scene, spec.title, rowsById), request); }
    catch (e) { linkNote = `No editor link this time (${(e as Error).message}); call open_in_biocartoon with this figure to try again.`; }
  }
  const weak = elements.filter(e => e.match === "weak").map(e => `${e.id} "${e.label}" → ${e.asset?.id} "${(e.asset as Record<string, unknown>)?.title}"`);
  const none = elements.filter(e => e.match === "none").map(e => `${e.id} "${e.label}"`);
  const figure = { title: spec.title, layout: layoutUsed, width: scene.width, height: scene.height, spec: resolvedSpec, elements, scene, preview_svg: sceneSvg(scene, img => img.href), credits: credits(rowsById), ...(open_url ? { open_url } : {}) };
  const summary = [
    `Composed ${JSON.stringify(spec.title || "figure")} (${layoutUsed} layout, ${elements.length} pictures, ${spec.connections.length} connections).`,
    ...elements.map(e => `- ${e.id} "${e.label}": ${e.asset ? `${e.asset.id} "${e.asset.title}" (${e.asset.source_name}, ${e.asset.license}) [${e.match}]` : "placeholder box: no suitable icon"}`),
    weak.length ? `Weak matches (check them with asset_image; pass a better query or asset_id): ${weak.join("; ")}.` : "",
    none.length ? `No icon found for ${none.join(", ")}; they are placeholder boxes. Try another query, or offer to draw one (biocartoon-create-icon).` : "",
    open_url ? `Open and edit in BioCartoon: ${open_url}` : linkNote,
    "To change the figure, call compose_figure again with `figure` set to figure.spec below, edited (keep asset_id on elements that should stay).",
    `Credits to include: ${figure.credits.join(" | ")}`,
  ].filter(Boolean).join("\n");
  return { content: [text(summary), text(JSON.stringify({ spec: resolvedSpec }))], structuredContent: { figure }, isError: false };
}

async function exportFigure(env: McpEnv, args: Args): Promise<ToolResult> {
  const spec = parseSpec(args.figure);
  if (spec.elements.some(e => !e.asset_id && !e.placeholder)) throw new Error("export a figure from compose_figure: pass its figure.spec, with asset_id on each element");
  const { scene } = await build(env, spec);
  const images = new Map<string, string>();
  let budget = 8 * 1024 * 1024;
  for (const img of scene.images) {
    if (images.has(img.asset_id)) continue;
    const tries: [string | undefined, string][] = [[img.svg_href, "image/svg+xml"], [img.href, "image/png"], [img.thumb_href, "image/png"]];
    for (const [url, mime] of tries) {
      if (!url) continue;
      try {
        const bytes = await fetchImage(url, Math.min(budget, 2 * 1024 * 1024));
        budget -= bytes.length;
        const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
        let b64: string;
        if (native) b64 = native.call(bytes);
        else { const parts: string[] = []; for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000))); b64 = btoa(parts.join("")); }
        images.set(img.asset_id, `data:${mime};base64,${b64}`);
        break;
      } catch { /* Next, smaller, version of the picture. */ }
    }
  }
  const svg = sceneSvg(scene, img => images.get(img.asset_id) ?? img.href);
  const name = (spec.title || "biocartoon-figure").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase() || "biocartoon-figure";
  return { content: [text(`Standalone SVG of ${JSON.stringify(spec.title || "the figure")} (${Math.round(svg.length / 1024)} KB), pictures embedded.`)], structuredContent: { svg, filename: `${name}.svg`, width: scene.width, height: scene.height }, isError: false };
}

async function templateProject(env: McpEnv, id: string): Promise<Record<string, unknown>> {
  const [row] = await rows(env.CATALOG, "SELECT * FROM templates WHERE id=?", [id]);
  if (!row) throw new Error(`no template ${id}`);
  const url = assetUrl(row.json_key); if (!url) throw new Error("this template has no published layout");
  const doc = JSON.parse(new TextDecoder().decode(await fetchImage(url, 1024 * 1024))) as Args;
  const slide = doc.slide as Args | undefined;
  if (!slide || !Array.isArray(slide.items)) throw new Error("this template's layout could not be read");
  let max = 0;
  for (const it of slide.items as Args[]) for (const v of [it.id, it.group]) if (typeof v === "number") max = Math.max(max, v);
  for (const c of (Array.isArray(slide.comments) ? slide.comments : []) as Args[]) if (typeof c.id === "number") max = Math.max(max, c.id);
  return { title: String(row.title || slide.name || "Template"), slides: [slide], width: doc.width, height: doc.height, unit: "Inch", background: doc.background ?? [255, 255, 255, 255], next_id: max + 1, guides: [] };
}

async function assetProject(env: McpEnv, id: string): Promise<Record<string, unknown>> {
  const row = await getAsset(env.CATALOG, id);
  const spec = parseSpec({ elements: [{ id: "e1", label: String(row.title ?? id), asset_id: id }] });
  const { scene, rowsById } = await build(env, spec);
  // One picture, larger, with no label: the user places it in their own figure.
  const img = scene.images[0], size = 360, aw = Number(row.png_width) || 1, ah = Number(row.png_height) || 1;
  const w = aw >= ah ? size : size * aw / ah, h = aw >= ah ? size * ah / aw : size;
  const one: Scene = { ...scene, width: 960, height: 672, texts: [], images: [{ ...img, x: round(480 - w / 2), y: round(336 - h / 2), w: round(w), h: round(h) }] };
  return sceneProject(one, String(row.title ?? "Illustration"), rowsById);
}

async function openInBiocartoon(env: McpEnv, args: Args, request?: Request): Promise<ToolResult> {
  const given = ["figure", "asset_id", "template_id"].filter(k => args[k] !== undefined && args[k] !== "");
  if (given.length !== 1) throw new Error("give exactly one of figure, asset_id or template_id");
  let project: Record<string, unknown>, what: string;
  if (args.figure !== undefined) {
    const spec = parseSpec(args.figure);
    const { scene, rowsById } = await build(env, spec);
    project = sceneProject(scene, spec.title, rowsById); what = JSON.stringify(spec.title || "the figure");
  } else if (args.asset_id !== undefined) { project = await assetProject(env, str(args, "asset_id")); what = `illustration ${str(args, "asset_id")}`; }
  else { project = await templateProject(env, str(args, "template_id")); what = `template ${str(args, "template_id")}`; }
  const url = await shareProject(env, project, request);
  return { content: [text(`Open ${what} in the BioCartoon editor: ${url}\nThe link opens a copy the user can edit; it lasts 90 days after its last use.`)], structuredContent: { url }, isError: false };
}

export const FIGURE_TOOL_NAMES = new Set(["compose_figure", "export_figure", "open_in_biocartoon"]);

export async function figureTool(env: McpEnv, name: string, args: Args, request?: Request): Promise<ToolResult> {
  switch (name) {
    case "compose_figure": return compose(env, args, request);
    case "export_figure": return exportFigure(env, args);
    case "open_in_biocartoon": return openInBiocartoon(env, args, request);
    default: throw new Error(`unknown tool ${name}`);
  }
}
// The tools' definitions (schemas, descriptions, UI) are in catalog/src/figure_tools.json, shared with
// the local Rust server, which lists them and relays calls here.
