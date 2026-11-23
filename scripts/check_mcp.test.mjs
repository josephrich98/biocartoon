import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const metadata = JSON.parse(await readFile(new URL('../worker/generated/mcp-metadata.json', import.meta.url), 'utf8'));
const uri = metadata.resources[0].uri;
const assets = [{ id: 'BA001505' }, { id: 'SD016288' }];

async function runCheck(t, { missingTool = false, unguardedWrite = false } = {}) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const m = JSON.parse(body);
    calls.push(m);
    let result;
    switch (m.method) {
      case 'initialize': result = { capabilities: { resources: {} }, serverInfo: { version: 'test' } }; break;
      case 'tools/list': result = { tools: missingTool ? metadata.tools.slice(1) : metadata.tools }; break;
      case 'resources/list': result = { resources: [{ uri }] }; break;
      case 'resources/read': result = { contents: [{ mimeType: 'text/html;profile=mcp-app', text: '<html>BioCartoon</html>' }] }; break;
      case 'tools/call': {
        const { name, arguments: args } = m.params;
        if (name === 'search_assets') result = { structuredContent: { assets } };
        else if (name === 'render_assets') {
          const selected = args.ids.map(id => assets.find(a => a.id === id));
          result = { structuredContent: { assets: selected }, content: [{ type: 'text', text: 'Do not repeat the list.' }, { type: 'text', text: selected.map((a, i) => `${i + 1}. ${a.id} · x`).join('\n') }] };
        } else if (name === 'sql_query') result = { content: [{ type: 'text', text: JSON.stringify({ rows: [[21183]] }) }] };
        else if (name === 'asset_image') result = { content: [{ type: 'image', mimeType: 'image/png', data: '' }] };
        else if (name === 'list_templates') result = { structuredContent: { templates: [{ id: 'demo-template', thumb_url: 'https://assets.biocartoon.com/demo.png' }] } };
        else if (name === 'submit_artwork') result = { isError: !unguardedWrite, content: [{ type: 'text', text: 'rights_confirmed must be true' }] };
        else result = { content: [] };
        break;
      }
      default: throw new Error(`Unexpected method ${m.method}`);
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'biocartoon-live-check-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const output = join(directory, 'result.json');
  const child = spawn(process.execPath, [new URL('./check_mcp.mjs', import.meta.url).pathname, '--url', `http://127.0.0.1:${server.address().port}`, '--output', output], { stdio: 'pipe' });
  let log = '';
  child.stdout.on('data', c => { log += c; }); child.stderr.on('data', c => { log += c; });
  const [code] = await once(child, 'close');
  return { code, calls, log, result: JSON.parse(await readFile(output, 'utf8')) };
}

test('live check follows the current contract and never confirms an upload', async t => {
  const r = await runCheck(t);
  assert.equal(r.code, 0, r.log);
  assert.equal(r.result.status, 'passed');
  assert.equal(r.result.tools, metadata.tools.length);
  assert.equal(r.result.checksPassed, 20);
  assert.match(r.result.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(r.calls.filter(m => m.params?.name === 'submit_artwork').map(m => m.params.arguments), [{ rights_confirmed: false }]);
});

test('a stale deployment fails and leaves a failure artifact', async t => {
  const r = await runCheck(t, { missingTool: true });
  assert.equal(r.code, 1);
  assert.equal(r.result.status, 'failed');
  assert.match(r.result.error, /Deployed tool names differ/);
  assert.equal(r.calls.some(m => m.method === 'tools/call'), false);
});

test('an endpoint accepting an unconfirmed submission fails the check', async t => {
  const r = await runCheck(t, { unguardedWrite: true });
  assert.equal(r.code, 1);
  assert.equal(r.result.status, 'failed');
  assert.ok(r.result.error);
});
