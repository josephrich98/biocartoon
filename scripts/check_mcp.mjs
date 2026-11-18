// Read-only checks of the hosted MCP App (the sole submission check refuses before writing).
import https from 'node:https';
import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = option('--url') ?? 'https://mcp.biocartoon.com/mcp';
const connectIp = option('--connect-ip');
const checks = []; let id = 0;
async function rpc(method, params = {}) {
  const url = new URL(endpoint), start = performance.now();
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
  const reply = await new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'biocartoon-mcp-check' },
      ...(connectIp ? { lookup: (_host, options, callback) => callback(null, options.all ? [{ address: connectIp, family: 4 }] : connectIp, 4) } : {}),
    }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', c => { data += c; });
      response.on('end', () => { try { assert.equal(response.statusCode, 200, data.slice(0, 250)); resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('Request timed out'))); req.on('error', reject); req.end(body);
  });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  checks.push({ method, ...(params.name ? { tool: params.name } : {}), milliseconds: Math.round(performance.now() - start) });
  return reply.result;
}
async function tool(name, args = {}) { const r = await rpc('tools/call', { name, arguments: args }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r; }
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'biocartoon-check', version: '1' } });
assert.ok(init.capabilities.resources);
const { tools } = await rpc('tools/list'); assert.equal(tools.length, 16);
const galleryTool = tools.find(t => t.name === 'render_assets'); assert.ok(galleryTool._meta.ui.resourceUri);
const resources = await rpc('resources/list'); assert.equal(resources.resources[0].uri, galleryTool._meta.ui.resourceUri);
const gallery = await rpc('resources/read', { uri: galleryTool._meta.ui.resourceUri });
assert.equal(gallery.contents[0].mimeType, 'text/html;profile=mcp-app'); assert.match(gallery.contents[0].text, /BioCartoon/);
const search = await tool('search_assets', { query: 'pyramidal neuron', limit: 6 });
const ids = search.structuredContent.assets.map(a => a.id); assert.ok(ids.length);
const shown = await tool('render_assets', { ids: ids.slice(0, 4) });
assert.deepEqual(shown.structuredContent.assets.map(a => a.id), ids.slice(0, 4));
assert.deepEqual(JSON.parse(shown.content.at(-1).text), shown.structuredContent.assets);
await tool('get_asset', { id: ids[0] }); await tool('asset_variants', { id: 'BA001505' });
await tool('browse_assets', { source: 'bioart', limit: 2 });
await tool('list_sources'); await tool('list_categories', { source: 'bioart' }); await tool('db_schema');
const count = await tool('sql_query', { sql: 'SELECT count(*) AS count FROM assets' });
const rows = JSON.parse(count.content[0].text).rows[0][0]; assert.ok(rows > 16000);
const picture = await tool('asset_image', { id: 'BA001505', max_side: 256 }); assert.ok(picture.content.some(c => c.type === 'image'));
await tool('preview_assets', { ids: ids.slice(0, 2) });
await tool('asset_svg', { id: 'BC020061', max_kb: 500 });
const templates = await tool('list_templates');
const firstTemplate = templates.structuredContent.templates.find(t => t.thumb_url); if (firstTemplate) await tool('template_image', { id: firstTemplate.id });
await tool('submission_status', { ids: ['biocartoon-readiness-check'] });
const refused = await rpc('tools/call', { name: 'submit_artwork', arguments: { rights_confirmed: false } }); assert.equal(refused.isError, true);
const result = { endpoint, version: init.serverInfo.version, tools: tools.length, catalogRecords: rows, selectedIds: ids, galleryBytes: Buffer.byteLength(gallery.contents[0].text), checks };
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/live-mcp-check.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ endpoint, version: init.serverInfo.version, tools: tools.length, catalogRecords: rows, checksPassed: checks.length }));
