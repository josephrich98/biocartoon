import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { catalogTool } from "../src/mcp_catalog.ts";
import { figureTool, heuristicPlan, layers, parseSpec, wrap } from "../src/mcp_figure.ts";
import type { McpEnv } from "../src/mcp_artwork.ts";
import { inspectImage, svgSize } from "../src/mcp_images.ts";

const schema = execFileSync("python3", ["-c", "import sys;sys.path.insert(0,'../data');from export_mcp_catalog import SCHEMA,INDEXES;print(SCHEMA+INDEXES)"], { encoding: "utf8" });
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec(schema);
  const add = db.prepare("INSERT INTO assets (id,source,source_name,title,variant,description,tags,category,license,credit,author,png_key,svg_key,thumb_key,png_width,png_height,grp,style_group,dup,stars) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insert = (id: string, title: string, tags: string[], license = "PD", source = "bioart", svg = true, author = "Ryan Kissinger") =>
    add.run(id, source, source === "openmoji" ? "OpenMoji" : "NIH BioArt", title, "", `${title} illustration`, JSON.stringify(tags), "Cells, Immune", license, `"${title}" by ${author}, ${license}`, author, `${id}.png`, svg ? `${id}.svg` : null, `thumbs/${id}.png`, 400, 200, id, id, 0, 0);
  insert("BA1", "T Cell", ["lymphocyte", "immune"]);
  insert("BA2", "Dendritic Cell", ["antigen presenting cell"]);
  insert("BA3", "Virus", ["pathogen", "virion"], "CC-BY-4.0", "bioart", false, "Someone Else");
  insert("OM1", "T Cell emoji", ["lymphocyte"], "CC-BY-SA-4.0", "openmoji");
  insert("BA4", "Antibody", ["immunoglobulin"]);
  db.exec("INSERT INTO assets_fts(assets_fts) VALUES ('rebuild'); INSERT INTO templates (id,title,tags,json_key,thumb_key,license) VALUES ('t1','Cell signaling','[]','templates/t1.json','templates/t1.png','CC0-1.0');");
  const catalog = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const prepared = {
        bind(...values: unknown[]) { args = values; return prepared; },
        async all() { return { success: true, results: db.prepare(sql).all(...args as []) }; },
        async first() { return db.prepare(sql).get(...args as []) ?? null; },
      };
      return prepared;
    },
  } as unknown as D1Database;
  const shares: { req: Request; body: Uint8Array }[] = [];
  const env = { CATALOG: catalog, MCP_TOKEN: "tok", SUBMISSIONS: { async fetch(req: Request) {
    shares.push({ req, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(JSON.stringify({ id: "AbC-_0123456789abcdefg", version: 1 }), { status: 200 });
  } } } as unknown as McpEnv;
  return { env, db, shares };
}

async function unseal(bytes: Uint8Array, key: string): Promise<any> {
  assert.deepEqual([...bytes.subarray(0, 4)], [0x42, 0x43, 0x53, 0x31]);
  const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  assert.equal(raw.length, 32);
  const k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(4, 16) }, k, bytes.subarray(16));
  const text = await new Response(new Response(plain).body!.pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}

test("a prompt becomes a connected plan", () => {
  const plan = heuristicPlan("Make a diagram showing virus -> dendritic cell -> T cell");
  assert.deepEqual((plan.elements as any[]).map(e => e.query), ["virus", "dendritic cell", "T cell"]);
  assert.equal((plan.connections as any[]).length, 2);
  const inhibit = heuristicPlan("antibody inhibits virus");
  assert.equal((inhibit.connections as any[])[0].kind, "inhibit");
  const cycle = heuristicPlan("the cycle of virus to T cell to antibody");
  assert.equal(cycle.layout, "cycle");
  assert.equal((cycle.connections as any[]).length, 3);
  const list = heuristicPlan("T cell, antibody and virus");
  assert.equal((list.elements as any[]).length, 3);
  assert.deepEqual(list.connections, []);
});

test("specs are validated and cycles still layer", () => {
  assert.throws(() => parseSpec({ elements: [] }), /1–16/);
  assert.throws(() => parseSpec({ elements: [{ id: "a", label: "A" }], connections: [{ from: "a", to: "b" }] }), /not an element/);
  assert.throws(() => parseSpec({ elements: [{ id: "a", label: "A" }, { id: "b", label: "B" }], connections: [{ from: "a", to: "b", kind: "zap" }] }), /kind/);
  const spec = parseSpec({ elements: [{ label: "A" }, { label: "B" }, { label: "C" }], connections: [{ from: "A", to: "e2" }, { from: "e2", to: "e3" }, { from: "e3", to: "e1" }] });
  assert.deepEqual([...layers(spec).values()], [0, 1, 2]);
  assert.deepEqual(wrap("a very long label that needs wrapping", 80, 16, 2).length, 2);
});

test("compose_figure picks strong matches, leaves gaps as boxes, and makes an editor link", async () => {
  const { env, db, shares } = fixture();
  try {
    const r = await figureTool(env, "compose_figure", {
      title: "Antigen presentation",
      elements: [{ id: "v", label: "Virus" }, { id: "d", label: "Dendritic cell" }, { id: "t", label: "T cell" }, { id: "x", label: "Zebrafish" }],
      connections: [{ from: "v", to: "d", label: "taken up" }, { from: "d", to: "t", kind: "arrow" }, { from: "t", to: "x", kind: "inhibit" }],
    }, new Request("https://mcp.biocartoon.com/mcp"));
    const f = r.structuredContent!.figure as any;
    assert.deepEqual(f.elements.map((e: any) => [e.id, e.asset?.id ?? null, e.match]), [["v", "BA3", "strong"], ["d", "BA2", "strong"], ["t", "BA1", "strong"], ["x", null, "none"]]);
    assert.equal(f.layout, "flow");
    assert.equal(f.scene.images.length, 3);
    assert.equal(f.scene.boxes.length, 1);
    assert.equal(f.scene.lines.length, 3);
    // Left to right: each picture is right of the one before it.
    const xs = ["v", "d", "t"].map(id => f.scene.images.find((i: any) => i.id === id).x);
    assert.ok(xs[0] < xs[1] && xs[1] < xs[2]);
    // Wide (2:1) pictures keep their shape.
    const img = f.scene.images[0]; assert.equal(Math.round(img.w / img.h), 2);
    assert.deepEqual(f.spec.elements.map((e: any) => e.asset_id ?? (e.placeholder ? "box" : "?")), ["BA3", "BA2", "BA1", "box"]);
    assert.ok(f.credits.some((c: string) => c.includes("Someone Else")));
    const text = (r.content[0] as any).text as string;
    assert.match(text, /No icon found for x "Zebrafish"/);
    assert.match(f.open_url, /^https:\/\/app\.biocartoon\.com\/#share=AbC-_0123456789abcdefg\.[A-Za-z0-9_-]{43}$/);

    // The share the Worker received is the project, readable only with the link's key.
    assert.equal(shares.length, 1);
    const { req, body } = shares[0];
    assert.equal(req.headers.get("x-mcp-token"), "tok");
    assert.match(req.headers.get("x-share-edit")!, /^[A-Za-z0-9_-]{22}$/);
    const doc = await unseal(body, f.open_url.split(".").at(-1));
    assert.equal(doc.title, "Antigen presentation");
    assert.equal(doc.unit, "Inch");
    const items = doc.slides[0].items as any[];
    assert.equal(items.filter(i => i.kind.Image).length, 3);
    assert.deepEqual(items.find(i => i.kind.Image).kind.Image.source.Asset.key.endsWith(".png"), true);
    assert.equal(items.filter(i => i.kind.Line).length, 3);
    assert.equal(items.find(i => i.kind.Line?.kind === "Inhibitor") !== undefined, true);
    assert.equal(items.filter(i => i.kind.Shape).length, 1);
    assert.ok(doc.next_id > Math.max(...items.map(i => i.id), ...items.map(i => i.group ?? 0)));
    assert.equal("_dpi" in doc, false);
    // Each picture is grouped with its label.
    const tcell = items.find(i => i.kind.Image?.source.Asset.id === "BA1");
    assert.ok(items.some(i => i.kind.Text?.text === "T cell" && i.group === tcell.group && tcell.group !== null));

    // Passing the resolved spec back reproduces the figure without searching.
    const again = await figureTool(env, "compose_figure", { figure: f.spec, open_link: false });
    assert.deepEqual((again.structuredContent!.figure as any).scene, f.scene);
    assert.equal(shares.length, 1);
  } finally { db.close(); }
});

test("hub and cycle layouts, source restriction, and a bare prompt", async () => {
  const { env, db } = fixture();
  try {
    const hub = await figureTool(env, "compose_figure", { open_link: false, elements: [{ label: "T cell" }, { label: "Virus" }, { label: "Antibody" }, { label: "Dendritic cell" }], connections: [{ from: "e1", to: "e2" }, { from: "e1", to: "e3" }, { from: "e1", to: "e4" }] });
    assert.equal((hub.structuredContent!.figure as any).layout, "hub");
    const prompt = await figureTool(env, "compose_figure", { open_link: false, prompt: "cycle of virus to dendritic cell to T cell" });
    const f = prompt.structuredContent!.figure as any;
    assert.equal(f.layout, "cycle");
    assert.deepEqual(f.elements.map((e: any) => e.asset?.id), ["BA3", "BA2", "BA1"]);
    const om = await figureTool(env, "compose_figure", { open_link: false, sources: ["openmoji"], elements: [{ label: "T cell" }] });
    assert.equal((om.structuredContent!.figure as any).elements[0].asset.id, "OM1");
  } finally { db.close(); }
});

test("open_in_biocartoon wraps one icon, and search filters by license, author, category and file type", async () => {
  const { env, db, shares } = fixture();
  try {
    const r = await figureTool(env, "open_in_biocartoon", { asset_id: "BA1" });
    const url = (r.structuredContent as any).url as string;
    const doc = await unseal(shares[0].body, url.split(".").at(-1)!);
    assert.equal(doc.slides[0].items.length, 1);
    assert.equal(doc.slides[0].items[0].kind.Image.source.Asset.id, "BA1");
    await assert.rejects(figureTool(env, "open_in_biocartoon", { asset_id: "BA1", template_id: "t1" }), /exactly one/);
    const ids = async (args: Record<string, unknown>) => ((await catalogTool(env.CATALOG, "search_assets", args)).structuredContent!.assets as any[]).map(a => a.id).sort();
    assert.deepEqual(await ids({ licenses: ["CC-BY-4.0"] }), ["BA3"]);
    assert.deepEqual(await ids({ author: "someone, nobody" }), ["BA3"]);
    assert.deepEqual(await ids({ file_type: "png" }), ["BA3"]);
    assert.deepEqual(await ids({ category: "Immune", sources: ["openmoji"] }), ["OM1"]);
    await assert.rejects(catalogTool(env.CATALOG, "search_assets", { file_type: "gif" }), /svg or png/);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------
// The user's own pictures

/** A share store that keeps what is posted and serves it back, like the submissions Worker. */
function store(env: McpEnv) {
  const kept = new Map<string, Uint8Array>(); let n = 0;
  (env as any).SUBMISSIONS = { async fetch(req: Request) {
    const url = new URL(req.url);
    if (req.method === "POST") {
      const id = `share${String(++n).padStart(17, "0")}`;
      kept.set(id, new Uint8Array(await req.arrayBuffer()));
      return new Response(JSON.stringify({ id, version: 1 }));
    }
    const m = /^\/shares\/([^/]+)\/latest$/.exec(url.pathname);
    const body = m && kept.get(m[1]);
    return body ? new Response(body) : new Response(JSON.stringify({ error: "gone" }), { status: 404 });
  } };
  return kept;
}
const NEURON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><circle cx="50" cy="50" r="30" fill="#c06"/><path d="M50 80 L50 190" stroke="#c06" stroke-width="6"/></svg>`;
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("own pictures: drawn SVG and a conversation file sit beside catalog icons, travel in the editor link, and are kept by image_ref", async () => {
  const { env, db } = fixture();
  const kept = store(env);
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(Uint8Array.from(atob(PNG_1x1), c => c.charCodeAt(0)), { headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;
  try {
    const r = await figureTool(env, "compose_figure", {
      title: "Neurons and immune cells",
      image: { download_url: "https://files.oaiusercontent.com/file-abc?sig=1", file_id: "file-abc" },
      elements: [{ id: "n", label: "Neuron", svg: NEURON }, { id: "u", label: "Uploaded cell", image_file: "image" }, { id: "t", label: "T cell" }],
      connections: [{ from: "n", to: "t" }],
    });
    const f = r.structuredContent!.figure as any;
    assert.deepEqual(fetched, ["https://files.oaiusercontent.com/file-abc?sig=1"]);
    assert.deepEqual(f.elements.slice(0, 2).map((e: any) => e.match), ["own", "own"]);
    assert.equal(f.elements[0].own.format, "svg");
    assert.equal(f.elements[2].asset.id, "BA1");
    // The SVG's 1:2 viewBox decides its shape.
    const neuron = f.scene.images.find((i: any) => i.id === "n");
    assert.equal(Math.round(neuron.h / neuron.w), 2);
    assert.equal(neuron.href, "", "the scene doesn't repeat the picture");
    assert.match(f.preview_svg, /href="data:image\/svg\+xml;base64,/);
    assert.match(f.preview_svg, /href="data:image\/png;base64,/);
    assert.equal(f.credits.length, 1);
    const refs = f.spec.elements.slice(0, 2).map((e: any) => e.image_ref);
    for (const ref of refs) assert.match(ref, /^share\d{17}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(f.spec.elements[2].asset_id, "BA1");
    assert.equal(JSON.stringify(f.spec).includes("<svg"), false, "the spec names pictures, it doesn't carry them");
    const text = (r.content[0] as any).text as string;
    assert.match(text, /n "Neuron": the user's own picture \(SVG\) \[own\]/);
    assert.match(text, /image_ref/);

    // Two pictures and one project were stored; the project holds the pictures as files.
    assert.equal(kept.size, 3);
    const projectId = f.open_url.split("#share=")[1].split(".")[0];
    const doc = await unseal(kept.get(projectId)!, f.open_url.split(".").at(-1));
    const files = doc.slides[0].items.filter((i: any) => i.kind.Image?.source.File).map((i: any) => i.kind.Image.source.File.path);
    assert.deepEqual(files, ["img-1-neuron.svg", "img-2-uploaded-cell.png"]);
    assert.equal(new TextDecoder().decode(Uint8Array.from(atob(doc.images["img-1-neuron.svg"]), c => c.charCodeAt(0))), NEURON);
    assert.equal(doc.images["img-2-uploaded-cell.png"], PNG_1x1);
    const item = doc.slides[0].items.find((i: any) => i.kind.Image?.source.File?.path === "img-1-neuron.svg");
    assert.ok(doc.slides[0].items.some((i: any) => i.kind.Text?.text === "Neuron" && i.group === item.group && item.group !== null));
    assert.equal(item.name, "Neuron");

    // An edit passes the spec back: the pictures come from the store, nothing is fetched or stored again but the project.
    const edited = { ...f.spec, title: "Edited" };
    const again = await figureTool(env, "compose_figure", { figure: edited });
    const g = again.structuredContent!.figure as any;
    assert.deepEqual(g.spec.elements.map((e: any) => e.image_ref ?? e.asset_id), [...refs, "BA1"]);
    assert.deepEqual(g.scene.images.map((i: any) => [i.x, i.y, i.w, i.h]), f.scene.images.map((i: any) => [i.x, i.y, i.w, i.h]));
    assert.equal(fetched.length, 1);
    assert.equal(kept.size, 4);

    // Export embeds them; open_in_biocartoon carries them too.
    const exp = await figureTool(env, "export_figure", { figure: f.spec });
    assert.match((exp.structuredContent as any).svg, /data:image\/svg\+xml;base64,/);
    const open = await figureTool(env, "open_in_biocartoon", { figure: { elements: [{ label: "Just mine", svg: NEURON }] } });
    const url = (open.structuredContent as any).url as string;
    const one = await unseal(kept.get(url.split("#share=")[1].split(".")[0])!, url.split(".").at(-1)!);
    assert.deepEqual(Object.keys(one.images), ["img-1-just-mine.svg"]);
  } finally { globalThis.fetch = realFetch; db.close(); }
});

test("own pictures are checked: one source each, safe SVG, real images, files that were passed, refs that exist", async () => {
  const { env, db } = fixture();
  store(env);
  try {
    const compose = (elements: unknown[], extra: Record<string, unknown> = {}) => figureTool(env, "compose_figure", { open_link: false, elements, ...extra });
    await assert.rejects(compose([{ label: "X", svg: NEURON, asset_id: "BA1" }]), /either asset_id or its own picture/);
    await assert.rejects(compose([{ label: "X", svg: NEURON, image_base64: PNG_1x1 }]), /give its picture once/);
    await assert.rejects(compose([{ label: "X", svg: `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>` }]), /element e1 \(X\): SVG files can't contain/);
    await assert.rejects(compose([{ label: "X", image_base64: btoa("not an image at all") }]), /SVG, PNG, JPEG, GIF or WebP/);
    await assert.rejects(compose([{ label: "X", image_file: "image" }]), /no file was passed in `image`/);
    await assert.rejects(compose([{ label: "X", image_file: "photo" }]), /image_file must be/);
    await assert.rejects(compose([{ label: "X", image_ref: "nope" }]), /not one compose_figure returned/);
    await assert.rejects(compose([{ label: "X", image_ref: `share${"9".repeat(17)}.${"A".repeat(43)}` }]), /expired/);
    await assert.rejects(compose([{ label: "X", image_url: "http://example.com/a.png" }]), /HTTPS/);
    await assert.rejects(figureTool(env, "export_figure", { figure: { elements: [{ label: "T cell" }] } }), /asset_id or image_ref/);
    // A data: URL works as base64, and an unused file is pointed out.
    const ok = await compose([{ label: "Dot", image_base64: `data:image/png;base64,${PNG_1x1}` }], { image: { download_url: "https://files.example.com/x" } });
    assert.match((ok.content[0] as any).text, /Not used: the file in image/);
  } finally { db.close(); }
});

test("image formats are recognised and measured", () => {
  const b = (...v: number[]) => new Uint8Array(v);
  const pad = (head: Uint8Array, n = 40) => { const out = new Uint8Array(Math.max(n, head.length)); out.set(head); return out; };
  const png = Uint8Array.from(atob(PNG_1x1), c => c.charCodeAt(0));
  assert.deepEqual([inspectImage(png).mime, inspectImage(png).width, inspectImage(png).height], ["image/png", 1, 1]);
  const gif = pad(new Uint8Array([...new TextEncoder().encode("GIF89a"), 0x40, 0x01, 0xf0, 0x00]));
  assert.deepEqual([inspectImage(gif).ext, inspectImage(gif).width, inspectImage(gif).height], ["gif", 320, 240]);
  // JPEG: SOI, an APP0 segment, then SOF0 with height 480 and width 640.
  const jpeg = pad(b(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03));
  assert.deepEqual([inspectImage(jpeg).mime, inspectImage(jpeg).width, inspectImage(jpeg).height], ["image/jpeg", 640, 480]);
  // WebP (VP8X): canvas size minus one, 24-bit little-endian, at bytes 24 and 27.
  const webp = pad(new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00]));
  assert.deepEqual([inspectImage(webp).mime, inspectImage(webp).width, inspectImage(webp).height], ["image/webp", 800, 480]);
  assert.deepEqual(svgSize(`<svg width="300" height="150">`), [1024, 512]);
  assert.deepEqual(svgSize(`<svg viewBox="0,0,50,100" width="10cm">`), [512, 1024]);
  assert.deepEqual(svgSize(`<svg>`), [512, 512]);
  assert.throws(() => inspectImage(new Uint8Array(3 * 1024 * 1024)), /at most 2 MB/);
});
