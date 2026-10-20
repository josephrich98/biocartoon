// Validation of submitted assets and templates. Pure functions (no bindings) so they are unit-tested.

import { LICENSES, LICENSE_URLS, MAX_IMAGE_SIDE, MAX_PNG_BYTES, MAX_SVG_BYTES, MAX_TEMPLATE_IMAGES, MAX_TEMPLATE_ITEMS } from "./limits.ts";
import { Rejected, checkLanguage, clean, impersonatesBioCartoon } from "./text.ts";

export interface Meta {
  title: string;
  description: string;
  category: string;
  author: string;
  license: string;
}

export function pngSize(b: Uint8Array): { width: number; height: number } {
  if (b.length > MAX_PNG_BYTES) throw new Rejected(`Images must be under ${MAX_PNG_BYTES / 1024 / 1024} MB`, 413);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = String.fromCharCode(...b.slice(12, 16));
  if (b.length < 24 || sig.some((v, i) => b[i] !== v) || ihdr !== "IHDR") throw new Rejected("Images must be PNG files");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw new Rejected(`Images must be at most ${MAX_IMAGE_SIDE} px on each side`);
  }
  return { width, height };
}

// SVG is published as is, so anything that could run, or fetch something, when the file is opened
// is refused rather than stripped: scripts and event handlers, HTML islands, animation (it can
// rewrite links), entity declarations, and links or CSS urls to anything but the file itself or an
// embedded raster. Mirrored by svg_problem() in data/uploads.py.
const BLOCKED_ELEMENTS = new Set([
  "script", "foreignobject", "iframe", "embed", "object", "audio", "video", "canvas", "handler", "listener",
  "set", "animate", "animatemotion", "animatetransform", "animatecolor", "discard",
]);
const BLOCKED_NAMESPACES = new Set(["http://www.w3.org/1999/xhtml", "http://www.w3.org/1998/Math/MathML"]);
const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][\w.:-]*)\s*>/y;
// The DOCTYPE editors write (browsers never fetch the DTD); an internal subset `[...]` is refused.
const DOCTYPE = /<!DOCTYPE\s+svg(\s+PUBLIC\s+("[^"]*"|'[^']*')\s+("[^"]*"|'[^']*'))?\s*>/y;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Expands XML character and predefined entity references; any other `&` is malformed XML. */
function unescapeXml(s: string): string {
  return s.replace(/&([^;\s&]{0,10});?/g, (ref, body: string) => {
    const code = /^#x([0-9a-f]{1,6})$/i.exec(body)?.[1] ?? /^#(\d{1,7})$/.exec(body)?.[1];
    const n = code ? Number.parseInt(code, /^#x/i.test(body) ? 16 : 10) : NaN;
    if (ref.endsWith(";") && n > 0 && n <= 0x10ffff) return String.fromCodePoint(n);
    if (ref.endsWith(";") && Object.hasOwn(ENTITIES, body)) return ENTITIES[body];
    throw new Rejected("SVG is not well-formed XML");
  });
}

/** CSS that could load something. `style` (a style element or attribute) also refuses CSS escapes,
 *  which could spell `url(` another way; elsewhere a backslash is just text (Windows paths). */
function badCss(v: string, style: boolean): boolean {
  return /url\s*\(\s*(?!['"]?\s*#)/i.test(v) || /@import|javascript:/i.test(v) || (style && v.includes("\\"));
}

/** Throws unless `b` is an SVG document that is safe to publish as is. */
export function checkSvg(b: Uint8Array): void {
  if (b.length > MAX_SVG_BYTES) throw new Rejected(`SVG files must be under ${MAX_SVG_BYTES / 1024 / 1024} MB`, 413);
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    throw new Rejected("SVG files must be UTF-8 text");
  }
  const refuse = (what: string): never => {
    throw new Rejected(`SVG files can't contain ${what}`);
  };
  const malformed = (): never => {
    throw new Rejected("SVG is not well-formed XML");
  };
  const stack: string[] = [];
  let sawRoot = false;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const text = unescapeXml(s.slice(i, lt < 0 ? s.length : lt));
    if (stack.length === 0 && text.trim()) malformed();
    if (stack.at(-1) === "style" && badCss(text, true)) refuse("CSS that loads other files");
    if (lt < 0) break;
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) malformed();
      i = end + 3;
    } else if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      if (end < 0 || stack.length === 0) malformed();
      if (stack.at(-1) === "style" && badCss(s.slice(lt + 9, end), true)) refuse("CSS that loads other files");
      i = end + 3;
    } else if (s.startsWith("<?", lt)) {
      // Only the XML declaration; <?xml-stylesheet?> would load a stylesheet.
      const end = s.indexOf("?>", lt + 2);
      if (end < 0 || sawRoot || !/^<\?xml\s/.test(s.slice(lt, end))) refuse("processing instructions");
      i = end + 2;
    } else if (s.startsWith("<!", lt)) {
      DOCTYPE.lastIndex = lt;
      if (sawRoot || !DOCTYPE.test(s)) refuse("entity declarations (a DOCTYPE with [...]); please re-save it as plain SVG");
      i = DOCTYPE.lastIndex;
    } else if (s[lt + 1] === "/") {
      END_TAG.lastIndex = lt;
      const m = END_TAG.exec(s);
      if (!m || stack.pop() !== m[1].split(":").pop()!.toLowerCase()) malformed();
      i = END_TAG.lastIndex;
    } else {
      NAME.lastIndex = lt + 1;
      const name = NAME.exec(s)?.[0] ?? malformed();
      const local = name.split(":").pop()!.toLowerCase();
      if (stack.length === 0 && (sawRoot || local !== "svg")) throw new Rejected("Not an SVG file (the root element must be <svg>)");
      sawRoot = true;
      if (BLOCKED_ELEMENTS.has(local)) refuse(`<${local}> elements`);
      let at = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = at;
        const m = ATTR.exec(s);
        if (!m) break;
        at = ATTR.lastIndex;
        const attr = m[1].toLowerCase();
        const attrLocal = attr.split(":").pop()!;
        const value = unescapeXml(m[2] ?? m[3]);
        if (/^on[a-z]+$/.test(attrLocal)) refuse("event handlers");
        if ((attr === "xmlns" || attr.startsWith("xmlns:")) && BLOCKED_NAMESPACES.has(value.trim())) refuse("HTML or MathML");
        if (attrLocal === "href" && !/^\s*(#|data:image\/(png|jpeg|gif|webp);base64,)/i.test(value)) refuse("links to other files");
        if (badCss(value, attrLocal === "style")) refuse("CSS that loads other files");
      }
      TAG_END.lastIndex = at;
      const end = TAG_END.exec(s) ?? malformed();
      if (!end[1]) stack.push(local);
      i = TAG_END.lastIndex;
    }
  }
  if (!sawRoot || stack.length) malformed();
}

export function parseMeta(raw: unknown): Meta {
  const m = (typeof raw === "object" && raw) || {};
  const r = m as Record<string, unknown>;
  const meta: Meta = {
    title: clean(r.title, 80, "Name", true),
    description: clean(r.description, 500, "Description"),
    category: clean(r.category, 60, "Category"),
    author: clean(r.author, 60, "Credit name") || "anonymous",
    license: String(r.license ?? ""),
  };
  if (!(LICENSES as readonly string[]).includes(meta.license)) throw new Rejected("License must be CC0-1.0 or CC-BY-4.0");
  // CC BY exists so the artist is credited: it needs a name to credit.
  if (meta.license === "CC-BY-4.0" && meta.author === "anonymous") throw new Rejected("CC BY 4.0 needs a credit name");
  checkLanguage([meta.title, meta.description, meta.category, meta.author]);
  // Only BioCartoon's own assets go under its name, and a reviewer gives it (src/publish.ts).
  if (impersonatesBioCartoon(meta.author)) throw new Rejected("Credit name can't include BioCartoon: that name is kept for BioCartoon's own assets.");
  return meta;
}

/** A bucket key a template may point at (an existing published object, checked by the caller). */
export function isReferenceKey(k: string): boolean {
  return /^[A-Za-z0-9_.\/-]{1,300}$/.test(k) && !k.includes("..") && !k.startsWith("/") && !k.startsWith("catalog/") && k.endsWith(".png");
}

export interface CheckedTemplate {
  /** The template JSON to store, with meta filled in and uploaded images re-keyed. */
  doc: Record<string, unknown>;
  /** Text inside the slide, shown to the reviewer. */
  texts: string[];
  /** Bucket keys the slide references that must already exist in the public bucket. */
  references: string[];
  /** Uploaded images it uses, e.g. "img-1.png". */
  images: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ITEM_KINDS = new Set(["Image", "Text", "Shape", "Line", "Table"]);

/**
 * Checks the app's template JSON (`TemplateFile` in biocartoon-app: app/src/templates.rs). Uploaded images are
 * referenced by the app as `img-<n>.png` and become `templates/<id>/img-<n>.png`.
 */
export function checkTemplate(raw: unknown, id: string, meta: Meta, uploaded: Set<string>, createdAt: string): CheckedTemplate {
  if (!isObj(raw)) throw new Rejected("Template is not valid JSON");
  const { width, height, background, slide } = raw;
  for (const v of [width, height]) {
    if (typeof v !== "number" || !(v > 0 && v <= 100_000)) throw new Rejected("Template page size is invalid");
  }
  if (!Array.isArray(background) || background.length !== 4 || !background.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
    throw new Rejected("Template background is invalid");
  }
  if (!isObj(slide) || !Array.isArray(slide.items)) throw new Rejected("Template has no slide");
  const items = slide.items as unknown[];
  if (items.length === 0 || items.length > MAX_TEMPLATE_ITEMS) throw new Rejected(`Templates need 1 to ${MAX_TEMPLATE_ITEMS} items`);
  const texts: string[] = [];
  const references: string[] = [];
  const images: string[] = [];
  const text = (v: unknown, limit: number) => {
    const s = typeof v === "string" ? v : "";
    if (s.length > limit) throw new Rejected("Template text is too long");
    if (s.trim()) texts.push(s);
  };
  text(slide.name, 200);
  let nImages = 0;
  for (const it of items) {
    if (!isObj(it) || !isObj(it.kind)) throw new Rejected("Template item is invalid");
    const kinds = Object.keys(it.kind);
    if (kinds.length !== 1 || !ITEM_KINDS.has(kinds[0])) throw new Rejected("Template item is invalid");
    const body = it.kind[kinds[0]];
    if (!isObj(body)) throw new Rejected("Template item is invalid");
    text(it.name, 200);
    if (kinds[0] === "Text") text(body.text, 5000);
    if (kinds[0] === "Table") {
      if (!Array.isArray(body.cells) || body.cells.length > 400) throw new Rejected("Template table is invalid");
      body.cells.forEach((c) => text(c, 1000));
    }
    if (kinds[0] === "Image") {
      nImages++;
      const src = body.source;
      // Local file paths are never accepted: they would read files on other users' computers.
      if (!isObj(src) || !isObj(src.Asset)) throw new Rejected("Template images must be uploaded with it");
      const a = src.Asset;
      const key = typeof a.key === "string" ? a.key : "";
      text(a.title, 200);
      const own = /^img-\d{1,3}\.png$/.exec(key);
      if (own) {
        if (!uploaded.has(key)) throw new Rejected(`Template image ${key} is missing`);
        const full = `templates/${id}/${key}`;
        a.key = full;
        a.id = full;
        a.source = "template";
        a.credit = creditLine(typeof a.title === "string" && a.title ? a.title : meta.title, meta.author, meta.license, `template "${meta.title}"`);
        a.license = meta.license;
        if (!images.includes(key)) images.push(key);
      } else if (isReferenceKey(key)) {
        // A library asset keeps the credit the app copied from the catalog (shown to the reviewer).
        text(a.credit, 600);
        text(a.license, 40);
        references.push(key);
      } else {
        throw new Rejected("Template image reference is invalid");
      }
    }
  }
  if (nImages > MAX_TEMPLATE_IMAGES) throw new Rejected(`Templates can have at most ${MAX_TEMPLATE_IMAGES} images`);
  for (const u of uploaded) {
    if (!images.includes(u)) throw new Rejected(`Uploaded image ${u} is not used by the template`);
  }
  checkLanguage(texts);
  slide.name = meta.title;
  const doc = {
    ...raw,
    meta: {
      id,
      title: meta.title,
      description: meta.description,
      category: meta.category,
      author: meta.author,
      license: meta.license,
      created_at: createdAt,
      thumb_key: `templates/${id}/thumb.png`,
    },
  };
  return { doc, texts, references: [...new Set(references)], images };
}

/** The attribution line published with a community upload (or a template's own image). */
export function creditLine(title: string, author: string, license: string, from = "BioCartoon community contribution"): string {
  const by = author && author !== "anonymous" ? ` by ${author}` : "";
  const lic = license === "CC0-1.0" ? "CC0" : `${license} (${LICENSE_URLS[license] ?? ""})`;
  return `"${title}"${by}, ${from}, ${lic}`;
}
