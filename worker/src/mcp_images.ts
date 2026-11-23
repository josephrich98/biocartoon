// The user's own pictures in figures: artwork the assistant drew (SVG), an image the user uploaded
// or generated in the conversation (ChatGPT passes those as file references), a URL, or base64.
// Each is checked, measured and stored once as an encrypted blob in the share store, so a
// figure spec refers to it by a short `image_ref` (the blob's id and key) instead of carrying the
// bytes through every edit. Without the key the stored blob is unreadable; it expires like a share link.
import type { Args } from "./mcp_catalog.ts";
import { fetchImage, type McpEnv } from "./mcp_artwork.ts";
import { checkSvg } from "./validate.ts";

/** Largest picture taken (the hosted MCP endpoint accepts requests up to 3 MB). */
export const MAX_UPLOAD = 2 * 1024 * 1024;
/** Most picture bytes in one figure, which keeps its editor link under the share store's MCP limit. */
export const MAX_FIGURE_UPLOADS = 6 * 1024 * 1024;
const MAX_SIDE = 8192;
/** Top-level tool arguments that hold conversation files (listed in `openai/fileParams`). */
export const FILE_PARAMS = ["image", "image2", "image3"] as const;
const SOURCES = ["svg", "image_url", "image_base64", "image_file", "image_ref"] as const;
const REF = /^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/;

export interface Upload { mime: string; ext: string; width: number; height: number; bytes: Uint8Array; ref?: string }
/** Where an element's own picture comes from, as given; read by [`loadInput`]. */
export type ImageInput = { kind: typeof SOURCES[number]; value: string };

// ---------------------------------------------------------------------------------------------
// Encoding

export const b64url = (b: Uint8Array) => base64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const parts: string[] = []; for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}

export const dataUrl = (u: Upload) => `data:${u.mime};base64,${base64(u.bytes)}`;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Response(data).body!.pipeThrough(stream)).arrayBuffer());
}

/** JSON, gzipped and AES-256-GCM encrypted with a new key: the share store's format (biocartoon-app app/src/share.rs). */
export async function seal(value: Record<string, unknown>): Promise<{ bytes: Uint8Array; key: string }> {
  const plain = await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("gzip"));
  const raw = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const bytes = new Uint8Array(4 + 12 + sealed.length);
  bytes.set([0x42, 0x43, 0x53, 0x31]); bytes.set(nonce, 4); bytes.set(sealed, 16);
  return { bytes, key: b64url(raw) };
}

export async function unseal(bytes: Uint8Array, key: string): Promise<unknown> {
  if (bytes.length < 32 || [0x42, 0x43, 0x53, 0x31].some((m, i) => bytes[i] !== m)) throw new Error("not a sealed BioCartoon blob");
  const k = await crypto.subtle.importKey("raw", fromB64url(key), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(4, 16) }, k, bytes.subarray(16)));
  return JSON.parse(new TextDecoder().decode(await pipe(plain, new DecompressionStream("gzip"))));
}

// ---------------------------------------------------------------------------------------------
// The share store (the submissions Worker, through its service binding)

function storeHeaders(env: McpEnv, original?: Request): Headers {
  const headers = new Headers();
  if (env.MCP_TOKEN) headers.set("X-MCP-Token", env.MCP_TOKEN);
  const ip = original?.headers.get("CF-Connecting-IP"); if (ip) headers.set("CF-Connecting-IP", ip);
  return headers;
}

/** Store sealed bytes as a new share; returns its id. */
export async function postShare(env: McpEnv, bytes: Uint8Array, original?: Request): Promise<string> {
  const headers = storeHeaders(env, original);
  headers.set("Content-Type", "application/octet-stream"); headers.set("Content-Length", String(bytes.length));
  headers.set("x-share-edit", b64url(crypto.getRandomValues(new Uint8Array(16)))); headers.set("x-share-owner", b64url(crypto.getRandomValues(new Uint8Array(16))));
  const response = await env.SUBMISSIONS.fetch(new Request("https://api.biocartoon.com/shares", { method: "POST", headers, body: bytes }));
  const reply = await response.json().catch(() => ({})) as { id?: string; error?: string };
  if (!response.ok || !reply.id) throw new Error(reply.error || `could not store it: HTTP ${response.status}`);
  return reply.id;
}

export async function storeUpload(env: McpEnv, u: Upload, original?: Request): Promise<string> {
  const { bytes, key } = await seal({ biocartoon_image: 1, mime: u.mime, width: u.width, height: u.height, data: base64(u.bytes) });
  return `${await postShare(env, bytes, original)}.${key}`;
}

async function loadUpload(env: McpEnv, ref: string): Promise<Upload> {
  if (!REF.test(ref)) throw new Error("image_ref is not one compose_figure returned");
  const [id, key] = ref.split(".");
  const response = await env.SUBMISSIONS.fetch(new Request(`https://api.biocartoon.com/shares/${id}/latest`, { headers: storeHeaders(env) }));
  if (response.status === 404) throw new Error("that image_ref has expired; give the picture again (svg, image_url, image_base64 or a file)");
  if (!response.ok) throw new Error(`could not load image_ref: HTTP ${response.status}`);
  let v: Args;
  try { v = await unseal(new Uint8Array(await response.arrayBuffer()), key) as Args; } catch { throw new Error("image_ref could not be read: use the exact value compose_figure returned"); }
  if (v.biocartoon_image !== 1 || typeof v.data !== "string") throw new Error("image_ref is not an image");
  // Checked again, as if new: the blob is only as trustworthy as whoever holds the key.
  return { ...inspectImage(Uint8Array.from(atob(v.data), c => c.charCodeAt(0))), ref };
}

// ---------------------------------------------------------------------------------------------
// Checking and measuring

/** What the bytes are and how big they are drawn. SVG must pass the library's safety check; rasters
 *  must be PNG, JPEG, GIF or WebP (the formats the editor decodes). */
export function inspectImage(bytes: Uint8Array): Upload {
  if (bytes.length > MAX_UPLOAD) throw new Error(`each picture must be at most ${MAX_UPLOAD >> 20} MB (this one is ${(bytes.length / 1048576).toFixed(1)} MB)`);
  const b = bytes, u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8), u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ok = (mime: string, ext: string, width: number, height: number): Upload => {
    if (!(width > 0 && height > 0) || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`the ${ext.toUpperCase()} must be 1–${MAX_SIDE} px on each side`);
    return { mime, ext, width, height, bytes };
  };
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length > 24 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return ok("image/png", "png", u32be(16), u32be(20));
  if (b.length > 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return ok("image/gif", "gif", u16le(6), u16le(8));
  if (b.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return ok("image/webp", "webp", u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return ok("image/webp", "webp", (v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
    if (chunk === "VP8X") return ok("image/webp", "webp", u24le(24) + 1, u24le(27) + 1);
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = (b[i + 2] << 8) | b[i + 3];
      // Start-of-frame markers (not DHT c4, JPG c8 or DAC cc) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return ok("image/jpeg", "jpg", (b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]);
      i += 2 + length;
    }
    throw new Error("the JPEG could not be read");
  }
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<")) {
    checkSvg(b);
    const [w, h] = svgSize(head);
    return ok("image/svg+xml", "svg", w, h);
  }
  throw new Error("pictures must be SVG, PNG, JPEG, GIF or WebP");
}

/** An SVG's drawn proportions: its viewBox, else its width and height, else square. */
export function svgSize(markup: string): [number, number] {
  const tag = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box[2] > 0 && box[3] > 0) return scaled(box[2], box[3]);
  const len = (v?: string) => { const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v ?? ""); return m ? Number(m[1]) : 0; };
  const w = len(attr("width")), h = len(attr("height"));
  return w > 0 && h > 0 ? scaled(w, h) : [512, 512];
}
/** Proportions kept, at a size the editor treats as a normal picture. */
function scaled(w: number, h: number): [number, number] {
  const s = 1024 / Math.max(w, h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// ---------------------------------------------------------------------------------------------
// Reading what a tool call gave

/** The picture source an element names, if any (exactly one). */
export function elementInput(x: Args, id: string): ImageInput | undefined {
  const given = SOURCES.filter(k => typeof x[k] === "string" && (x[k] as string).trim());
  if (given.length > 1) throw new Error(`element ${id}: give its picture once (one of ${SOURCES.join(", ")})`);
  if (!given.length) return;
  const kind = given[0], value = (x[kind] as string).trim();
  if (kind === "image_file" && !(FILE_PARAMS as readonly string[]).includes(value)) throw new Error(`element ${id}: image_file must be ${FILE_PARAMS.map(f => `"${f}"`).join(", ")} (the argument holding the file)`);
  return { kind, value };
}

/** A conversation file's download URL from a top-level file argument ({download_url, file_id}). */
function fileUrl(args: Args, name: string): string {
  const f = args[name] as Args | string | undefined;
  const url = f && typeof f === "object" ? f.download_url : undefined;
  if (typeof url !== "string" || !url) throw new Error(`image_file "${name}": no file was passed in \`${name}\``);
  return url;
}

export async function loadInput(env: McpEnv, input: ImageInput, args: Args): Promise<Upload> {
  switch (input.kind) {
    case "image_ref": return loadUpload(env, input.value);
    case "svg": return inspectImage(new TextEncoder().encode(input.value));
    case "image_base64": {
      const data = input.value.replace(/^data:[^,]*;base64,/, "").replace(/\s/g, "");
      if (data.length > Math.ceil(MAX_UPLOAD / 3) * 4) throw new Error(`each picture must be at most ${MAX_UPLOAD >> 20} MB`);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { throw new Error("image_base64 is not valid base64"); }
      return inspectImage(bytes);
    }
    case "image_url": return inspectImage(await fetchImage(input.value, MAX_UPLOAD));
    case "image_file": return inspectImage(await fetchImage(fileUrl(args, input.value), MAX_UPLOAD));
  }
}

/** Every file argument passed but not used by an element: a likely mistake worth saying. */
export function unusedFiles(args: Args, used: Set<string>): string[] {
  return FILE_PARAMS.filter(f => !!args[f] && typeof args[f] === "object" && !used.has(f));
}
