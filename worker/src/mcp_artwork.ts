// Image inspection and submission use existing public assets and the existing review queue.
// PNG/SVG are handled without CPU-heavy image codecs or a paid image-transformation service.
import { assetUrl, getAsset, num, pretty, required, selectedIds, str, strings, template, text, type Args, type ToolResult } from "./mcp_catalog.ts";
import { checkSvg, parseEmail, parseMeta, pngSize } from "./validate.ts";

export interface McpEnv {
  CATALOG: D1Database;
  SUBMISSIONS: Fetcher;
  MCP_TOKEN?: string;
  /** Optional Workers AI binding: plans a figure from a bare prompt (src/mcp_figure.ts). */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  PLAN_MODEL?: string;
}
const MAX_IMAGE = 2 * 1024 * 1024;

export function publicImageUrl(raw: string): URL {
  const u = new URL(raw);
  // Public DNS names only; also validate every redirect rather than allowing fetch to follow it.
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !u.hostname.includes(".") || /^\[|^[\d.]+$/.test(u.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid|home|lan)\.?$/i.test(u.hostname)) throw new Error("image_url must use HTTPS on a public hostname");
  return u;
}
export async function limitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`could not fetch image: HTTP ${response.status}`); }
  if (Number(response.headers.get("Content-Length")) > limit) { await response.body?.cancel(); throw new Error(`image exceeds ${Math.round(limit / 1024)} KB; use a smaller PNG or SVG`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("image is empty");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error(`image exceeds ${Math.round(limit / 1024)} KB; use a smaller PNG or SVG`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}
export async function fetchImage(raw: string, limit = MAX_IMAGE): Promise<Uint8Array> {
  let url = publicImageUrl(raw);
  for (let i = 0; i < 5; i++) {
    const response = await fetch(url.href, { redirect: "manual", headers: { "User-Agent": "biocartoon-mcp" }, signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location"); await response.body?.cancel();
      if (!location) throw new Error("image redirect has no destination");
      url = publicImageUrl(new URL(location, url).href); continue;
    }
    return limitedBytes(response, limit);
  }
  throw new Error("too many image redirects");
}
function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const parts: string[] = []; for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}
function png(bytes: Uint8Array): Record<string, unknown> {
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error("this asset did not return a PNG image");
  return { type: "image", data: base64(bytes), mimeType: "image/png" };
}

export function adaptationLicenses(license: string): string[] {
  const l = license.toUpperCase();
  if (l === "PD" || l === "CC0-1.0" || l.startsWith("PUBLIC")) return ["CC0-1.0", "CC-BY-4.0"];
  if (l.includes("-SA")) throw new Error(`License ${license} is ShareAlike; adaptations cannot be submitted to this library. You may still use an adaptation in your own figure with the required credit.`);
  if (l.startsWith("CC-BY-") || l === "MIT" || l.startsWith("BSD")) return ["CC-BY-4.0"];
  throw new Error(`License ${license || "unknown"} does not allow submission of an adaptation`);
}
function adaptationNote(license: string): string {
  try { return `An adaptation may be submitted as ${adaptationLicenses(license).join(" or ")}. Generative-AI artwork must be CC0; attribution-licensed originals therefore cannot be submitted as AI-made adaptations.`; }
  catch (e) { return (e as Error).message; }
}

async function submitArtwork(env: McpEnv, args: Args, original: Request): Promise<ToolResult> {
  // These checks deliberately happen before looking up an adaptation or fetching an image.
  if (args.rights_confirmed !== true) throw new Error("rights_confirmed must be true after the user has reviewed the artwork and submission details and explicitly agreed to share it");
  if (typeof args.generative_ai_used !== "boolean") throw new Error("generative_ai_used must be true or false");
  if (str(args, "file_path")) throw new Error("file_path only works with the local biocartoon MCP server");
  let description = str(args, "description");
  if (str(args, "derived_from")) {
    const row = await getAsset(env.CATALOG, str(args, "derived_from"));
    const allowed = adaptationLicenses(String(row.license));
    if (!allowed.includes(str(args, "license"))) throw new Error(`An adaptation of ${row.id} (${row.license}) may be submitted only as ${allowed.join(" or ")}`);
    const note = `Adapted from ${String(row.credit).replace(/\.$/, "")} (BioCartoon ${row.id}).`;
    description = `${[...description].slice(0, Math.max(0, 499 - [...note].length)).join("")} ${note}`.trim();
  }
  const meta = parseMeta({ ...args, title: required(args, "title"), description, author: str(args, "credit", "anonymous") });
  const email = parseEmail(args.email);
  const image = args.image;
  const fileUrl = image && typeof image === "object" && "download_url" in image && typeof image.download_url === "string" ? image.download_url : "";
  const sources = [str(args, "svg"), str(args, "image_base64"), str(args, "image_url"), fileUrl].filter(Boolean);
  if (sources.length !== 1) throw new Error("give the image once: only one of svg, image_base64, image_url or image");
  let bytes: Uint8Array;
  if (str(args, "svg")) bytes = new TextEncoder().encode(str(args, "svg"));
  else if (str(args, "image_base64")) {
    const input = str(args, "image_base64").replace(/^data:[^,]*;base64,/, "").replace(/\s/g, "");
    if (input.length > Math.ceil(MAX_IMAGE / 3) * 4) throw new Error("image must be at most 2 MB");
    try { bytes = Uint8Array.from(atob(input), c => c.charCodeAt(0)); } catch { throw new Error("image_base64 is not valid base64"); }
  } else bytes = await fetchImage(str(args, "image_url") || fileUrl);
  if (bytes.length > MAX_IMAGE) throw new Error("image must be at most 2 MB");
  const svg = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^\uFEFF/, "").trimStart().startsWith("<");
  if (svg) checkSvg(bytes);
  else {
    try { pngSize(bytes); } catch (e) { throw new Error(`The free hosted endpoint needs a PNG up to 2 MB and 4096 px, or SVG. Use the local biocartoon command to convert/resize other images. ${(e as Error).message}`); }
  }
  const form = new FormData(); form.set("kind", "asset"); form.set("meta", JSON.stringify({ ...meta, ...(email ? { email } : {}) }));
  const copy = new Uint8Array(bytes.length); copy.set(bytes);
  form.set(svg ? "svg" : "image", new Blob([copy], { type: svg ? "image/svg+xml" : "image/png" }), svg ? "image.svg" : "image.png");
  const built = new Request("https://api.biocartoon.com/submit", { method: "POST", body: form });
  const body = await built.arrayBuffer();
  const headers = new Headers(built.headers); headers.set("Content-Length", String(body.byteLength));
  if (env.MCP_TOKEN) headers.set("X-MCP-Token", env.MCP_TOKEN);
  // A service binding keeps submission validation, storage, moderation and quotas in the
  // existing Worker. No new R2 bucket or public write route is introduced here.
  const ip = original.headers.get("CF-Connecting-IP"); if (ip) headers.set("CF-Connecting-IP", ip);
  const response = await env.SUBMISSIONS.fetch(new Request(built.url, { method: "POST", headers, body }));
  const reply = await response.json() as { id?: string; error?: string };
  if (!response.ok || !reply.id) throw new Error(reply.error || `submission failed: HTTP ${response.status}`);
  return { content: [text(`Submitted ${JSON.stringify(meta.title)} as ${reply.id}. It is pending human review; after approval and catalog publishing it will be available under ${meta.license}, credited to ${meta.author}.`), pretty({ id: reply.id, status: "pending" })], isError: false };
}

export async function artworkTool(env: McpEnv, name: string, args: Args, request: Request): Promise<ToolResult> {
  switch (name) {
    case "asset_image": {
      const row = await getAsset(env.CATALOG, required(args, "id"));
      const small = num(args, "max_side", 512, 4096) <= 256;
      const url = assetUrl(small ? row.thumb_key || row.png_key : row.png_key); if (!url) throw new Error("asset has no published image");
      return { content: [text(`${row.title} (${row.source_name}, ${row.license}). Credit: ${row.credit}. ${small && row.thumb_key ? "Catalog thumbnail;" : "Original PNG;"} this endpoint does not resize images.`), png(await fetchImage(url))] };
    }
    case "preview_assets": {
      const ids = selectedIds(args); const content: Record<string, unknown>[] = [];
      for (const id of ids) {
        try {
          const a = await getAsset(env.CATALOG, id); content.push(text(`${a.id} — ${a.title} (${a.source_name}, ${a.license}). Credit: ${a.credit}`));
          const url = assetUrl(a.thumb_key || a.png_key); if (!url) throw new Error("no published preview");
          content.push(png(await fetchImage(url, 512 * 1024)));
        } catch (e) { content.push(text(`${id}: preview unavailable: ${(e as Error).message}`)); }
      }
      return { content };
    }
    case "asset_svg": {
      const row = await getAsset(env.CATALOG, required(args, "id")); const url = assetUrl(row.svg_key);
      if (!url) throw new Error("This illustration has no SVG. Use its PNG instead.");
      const svg = new TextDecoder().decode(await fetchImage(url, num(args, "max_kb", 150, 500) * 1024))
        .replace(/<!--[\s\S]*?-->/g, "").replace(/<metadata\b[^>]*(?:\/>|>[\s\S]*?<\/metadata>)/gi, "")
        .replace(/<\?xml[^>]*\?>/gi, "").trim();
      return { content: [text(`${row.id} — ${row.title}. Credit: ${row.credit}. ${adaptationNote(String(row.license))}`), text(svg)] };
    }
    case "template_image": {
      const row = await env.CATALOG.prepare("SELECT * FROM templates WHERE id=?").bind(required(args, "id")).first<import("./mcp_catalog.ts").Row>();
      if (!row) throw new Error("no such template"); const t = template(row);
      if (!t.thumb_url) throw new Error("this template has no thumbnail");
      return { content: [text(`${row.title} (${row.license}, by ${row.author})`), png(await fetchImage(String(t.thumb_url)))] };
    }
    case "submit_artwork": return submitArtwork(env, args, request);
    case "submission_status": {
      const ids = strings(args, "ids", 100); if (!ids.length) throw new Error("ids is required");
      const response = await env.SUBMISSIONS.fetch(`https://api.biocartoon.com/status?ids=${encodeURIComponent(ids.join(","))}`);
      if (!response.ok) throw new Error(`could not retrieve submission status: HTTP ${response.status}`);
      const found = await response.json() as Record<string, string>;
      return { content: [pretty(ids.map(id => ({ id, status: found[id] ?? "unknown id" })))] };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}
