import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createMcpHandler, rpc } from "../src/mcp_server.ts";
import { catalogTool, ftsQuery, readOnlySql } from "../src/mcp_catalog.ts";
import { adaptationLicenses, artworkTool, limitedBytes, publicImageUrl, type McpEnv } from "../src/mcp_artwork.ts";

const schema = execFileSync("python3", ["-c", "import sys;sys.path.insert(0,'../data');from export_mcp_catalog import SCHEMA,INDEXES;print(SCHEMA+INDEXES)"], { encoding: "utf8" });
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec(schema);
  const add = db.prepare("INSERT INTO assets (id,source,source_name,title,variant,description,tags,category,license,credit,author,png_key,svg_key,thumb_key,grp,style_group,dup,stars) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insert = (id: string, title: string, description: string, license: string, grp = id, variant = "", source = "bioart") => add.run(id, source, source === "user" ? "BioCartoon" : "NIH BioArt", title, variant, description, '["biology"]', 'cells', license, 'Artist, ' + license, 'Artist', id + '.png', id + '.svg', 'thumbs/' + id + '.png', grp, grp, 0, 0);
  insert("BA1", "Pyramidal Neuron", "A cortical cell", "PD");
  insert("BA2", "Pyramidal Neuron", "Blue recolour", "PD", "BA1", "blue");
  insert("BA3", "Computer", "A neuron image on a monitor", "CC-BY-4.0");
  insert("BA4", "Mitochondrion", "Produces ATP", "CC0-1.0");
  insert("BA5", "Antibody", "Immunoglobulin", "CC-BY-SA-4.0");
  insert("BC1", "Stem Cell", "Undifferentiated cell", "CC0-1.0", "BC1", "", "user");
  db.exec("INSERT INTO assets_fts(assets_fts) VALUES ('rebuild'); INSERT INTO templates (id,title,tags,json_key,thumb_key,license) VALUES ('t1','Cell signaling','[\"kinase\"]','templates/t1.json','templates/t1.png','CC0-1.0');");
  const catalog = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const prepared = {
        bind(...values: unknown[]) { args = values; return prepared; },
        async all() { return { success: true, results: db.prepare(sql).all(...args as []) }; },
        async first(column?: string) { const row = db.prepare(sql).get(...args as []) as Record<string, unknown> | undefined; return column ? row?.[column] ?? null : row ?? null; },
        async raw(options?: { columnNames?: boolean }) { const st = db.prepare(sql); st.setReturnArrays(true); const rows = st.all(...args as []); return options?.columnNames ? [st.columns().map(c => c.name), ...rows] : rows; },
      };
      return prepared;
    },
  } as unknown as D1Database;
  const submissions: Request[] = [];
  const env = { CATALOG: catalog, SUBMISSIONS: { async fetch(input: Request | string) {
    const req = input instanceof Request ? input : new Request(input); submissions.push(req);
    return new Response(JSON.stringify(req.method === "POST" ? { id: "new-cell", status: "pending" } : { "new-cell": "pending" }), { status: req.method === "POST" ? 201 : 200 });
  } } } as unknown as McpEnv;
  return { env, db, submissions };
}
const request = () => new Request("https://mcp.biocartoon.com/mcp", { headers: { "CF-Connecting-IP": "203.0.113.1" } });

test("catalog search ranks a title above a description, deduplicates recolours and preserves filters", async () => {
  const { env, db } = fixture();
  try {
    const found = await catalogTool(env.CATALOG, "search_assets", { query: "neuron" });
    const assets = found.structuredContent!.assets as Record<string, unknown>[];
    assert.equal(assets[0].id, "BA1");
    assert.equal(assets.filter(a => a.title === "Pyramidal Neuron").length, 1);
    assert.deepEqual(assets[0].matched_fields, ["title"]);
    assert.equal((await catalogTool(env.CATALOG, "search_assets", { query: "mitochondria" })).structuredContent!.assets instanceof Array, true);
    const filtered = await catalogTool(env.CATALOG, "search_assets", { query: "cell", sources: ["user"], tags: ["BIOLOGY"] });
    assert.deepEqual((filtered.structuredContent!.assets as { id: string }[]).map(a => a.id), ["BC1"]);
    assert.equal((await catalogTool(env.CATALOG, "search_assets", { query: "zzzznonsense" })).structuredContent!.assets instanceof Array, true);
    assert.equal((await catalogTool(env.CATALOG, "search_assets", { query: "zzzznonsense" })).structuredContent!.assets.length, 0);
    assert.equal(ftsQuery('" OR '), '("or"*)');
  } finally { db.close(); }
});

test("gallery, variants, browsing, source/category counts, templates and SQL use the public database", async () => {
  const { env, db } = fixture();
  try {
    const rendered = await catalogTool(env.CATALOG, "render_assets", { ids: ["BA4", "BA1"] });
    const assets = rendered.structuredContent!.assets as Record<string, unknown>[];
    assert.deepEqual(assets.map(a => a.id), ["BA4", "BA1"]);
    assert.match(String(assets[0].svg_url), /^https:\/\/assets.biocartoon.com\//);
    assert.deepEqual(JSON.parse(String(rendered.content.at(-1)!.text)), assets);
    assert.equal((await catalogTool(env.CATALOG, "asset_variants", { id: "BA1" })).structuredContent!.assets.length, 2);
    assert.equal((await catalogTool(env.CATALOG, "browse_assets", { source: "user", category: "cells" })).structuredContent!.assets.length, 1);
    for (const name of ["list_sources", "list_categories", "db_schema", "list_templates"]) assert.ok((await catalogTool(env.CATALOG, name, { source: "bioart" })).content.length);
    assert.equal((await catalogTool(env.CATALOG, "list_templates", { query: "kinase" })).structuredContent!.templates.length, 1);
    const result = await catalogTool(env.CATALOG, "sql_query", { sql: "SELECT id FROM assets ORDER BY id; -- comment", max_rows: 2 });
    const sql = JSON.parse(String(result.content[0].text)); assert.equal(sql.rows.length, 2); assert.equal(sql.truncated, true);
    const expression = await catalogTool(env.CATALOG, "sql_query", { sql: "SELECT title || ' illustration' AS label FROM assets WHERE stars >= 0 AND id <> 'missing' LIMIT 1; -- tail" });
    assert.match(JSON.parse(String(expression.content[0].text)).rows[0][0], / illustration$/);
    await assert.rejects(catalogTool(env.CATALOG, "render_assets", { ids: ["BA1", "missing"] }), /no asset missing/);
    await assert.rejects(catalogTool(env.CATALOG, "render_assets", { ids: ["BA1", "BA1"] }), /unique/);
  } finally { db.close(); }
});

test("read-only SQL blocks statements hidden in WITH or comments, while allowing quoted words", () => {
  for (const sql of ["DELETE FROM assets", "SELECT 1; DROP TABLE assets", "WITH x AS (SELECT 1) DELETE FROM assets", "PRAGMA query_only=OFF", "SELECT load_extension('x')"]) assert.throws(() => readOnlySql(sql), /read-only/);
  for (const sql of ["SELECT 'DELETE; DROP' AS title; -- x", 'WITH x AS (SELECT "title" FROM assets) SELECT * FROM x', "/* hi */ SELECT count(*) FROM assets"]) assert.ok(readOnlySql(sql).length);
  assert.ok(ftsQuery('neuron" OR DROP TABLE').includes('"neuron"*'));
});

test("MCP keeps all tools and gallery resources in the plugin contract, with valid transport errors", async () => {
  const { env, db } = fixture(); const handler = createMcpHandler("<!doctype html><title>Gallery</title>");
  const call = async (message: unknown) => handler.fetch!(new Request("https://mcp.biocartoon.com/mcp", { method: "POST", body: JSON.stringify(message) }), env, {} as ExecutionContext);
  try {
    const init = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json() as any;
    assert.equal(init.result.capabilities.resources.subscribe, false);
    const tools = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
    assert.equal(tools.result.tools.length, 16);
    assert.equal('file_path' in tools.result.tools.find((t: any) => t.name === 'submit_artwork').inputSchema.properties, false);
    const render = tools.result.tools.find((t: any) => t.name === "render_assets");
    const ui = await (await call({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: render._meta.ui.resourceUri } })).json() as any;
    assert.match(ui.result.contents[0].text, /Gallery/);
    assert.equal(ui.result.contents[0].mimeType, "text/html;profile=mcp-app");
    const failed = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "render_assets", arguments: { ids: [] } } })).json() as any;
    assert.equal(failed.result.isError, true);
    assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    assert.equal((await call([])).status, 400);
    const invalid = await (await call(null)).json() as any; assert.equal(invalid.error.code, -32600);
    const tooLarge = new Request("https://mcp.biocartoon.com/mcp", { method: "POST", body: "x", headers: { "Content-Length": "4000000" } });
    assert.equal((await handler.fetch!(tooLarge, env, {} as ExecutionContext)).status, 413);
    assert.equal((await handler.fetch!(new Request("https://mcp.biocartoon.com/mcp"), env, {} as ExecutionContext)).status, 405);
    const batch = await (await call([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: "p", method: "ping" }])).json() as any[]; assert.equal(batch.length, 1); assert.equal(batch[0].id, "p");
  } finally { db.close(); }
});

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"/></svg>';
const submission = { title: "Cell", svg, license: "CC0-1.0", generative_ai_used: true, rights_confirmed: true, credit: "Ada" };
test("submissions retain author approval, licensing and review, and use the existing service", async () => {
  const { env, db, submissions } = fixture();
  try {
    for (const args of [{ ...submission, rights_confirmed: false }, { ...submission, license: "CC-BY-4.0" }, { ...submission, derived_from: "BA5" }, { ...submission, image_url: "https://example.com/a.png" }]) await assert.rejects(artworkTool(env, "submit_artwork", args, request()));
    assert.equal(submissions.length, 0);
    const result = await artworkTool(env, "submit_artwork", { ...submission, derived_from: "BA1" }, request());
    assert.equal(result.isError, false); assert.equal(submissions.length, 1);
    const form = await submissions[0].formData(); const meta = JSON.parse(String(form.get("meta")));
    assert.equal(meta.author, "Ada"); assert.match(meta.description, /Adapted from Artist, PD/);
    assert.equal(submissions[0].headers.get("X-MCP-Token"), null);
    const status = await artworkTool(env, "submission_status", { ids: ["new-cell", "missing"] }, request());
    assert.match(String(status.content[0].text), /pending/);
    assert.deepEqual(adaptationLicenses("CC-BY-4.0"), ["CC-BY-4.0"]);
  } finally { db.close(); }
});

test("URL and download limits prevent private fetches and oversized streams", async () => {
  for (const url of ["http://example.com/a", "https://127.0.0.1/a", "https://user@example.com/a", "https://[::1]/a", "https://metadata.internal/a", "https://example.com:8080/a"]) assert.throws(() => publicImageUrl(url));
  assert.equal(publicImageUrl("https://files.oaiusercontent.com/a.png?signature=abc").hostname, "files.oaiusercontent.com");
  await assert.rejects(limitedBytes(new Response("too large"), 2), /exceeds/);
});
