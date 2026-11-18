import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { catalogTool } from "../src/mcp_catalog.ts";
import { figureTool, heuristicPlan, layers, parseSpec, wrap } from "../src/mcp_figure.ts";
import type { McpEnv } from "../src/mcp_artwork.ts";

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
