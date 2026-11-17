// A pending template as a `.biocartoon` file the app opens (File > Open), for the review page's
// download. The file is the app's Document (one slide) plus the bytes of the template's own images:
// those live only in the pending bucket until approval, so they are bundled the way the app bundles
// uploads (`images`: name -> base64, with the item's source a `File` of that name), keeping the
// catalog asset they were credited as in `from`. Library images stay catalog references.
// See PortableFile in biocartoon-app/app/src/projects.rs.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `doc` is a stored template.json (validate.ts checkTemplate); `images` its own img-<n>.png bytes by name. */
export function templateToBiocartoon(doc: Obj, images: Map<string, Uint8Array>): string {
  const slide = structuredClone(doc.slide) as Obj;
  const items = (slide.items ?? []) as Obj[];
  const bundled: Record<string, string> = {};
  let maxId = 0;
  const seeId = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) maxId = Math.max(maxId, v);
  };
  for (const it of items) {
    seeId(it.id);
    seeId(it.group);
    const body = isObj(it.kind) ? it.kind.Image : undefined;
    if (!isObj(body) || !isObj(body.source) || !isObj(body.source.Asset)) continue;
    const asset = body.source.Asset as Obj;
    const name = /^templates\/[a-z0-9-]+\/(img-\d{1,3}\.png)$/.exec(String(asset.key ?? ""))?.[1];
    if (!name) continue;
    const bytes = images.get(name);
    if (!bytes) throw new Error(`template image ${name} is missing`);
    bundled[name] ??= base64(bytes);
    body.source = { File: { path: name, from: { Asset: asset } } };
  }
  for (const c of (slide.comments ?? []) as Obj[]) seeId(c.id);
  const meta = isObj(doc.meta) ? doc.meta : {};
  const file = {
    title: typeof meta.title === "string" && meta.title ? meta.title : String(slide.name ?? "Template"),
    slides: [slide],
    width: doc.width,
    height: doc.height,
    unit: "Inch",
    background: doc.background,
    next_id: maxId + 1,
    guides: [],
    ...(Object.keys(bundled).length && { images: bundled }),
  };
  return JSON.stringify(file, null, 2);
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A Content-Disposition for downloading as `title` + `ext`: an ASCII fallback plus the UTF-8 name. */
export function attachment(title: string, ext: string): string {
  const name = (title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "download").slice(0, 120) + ext;
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[%;]/g, "_") || `download${ext}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
