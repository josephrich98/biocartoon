// Keep Wrangler's per-statement results out of the terminal (a catalog has >20,000 rows).
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const remote = process.argv.includes('--remote');
if (remote === process.argv.includes('--local')) throw new Error('Choose exactly one of --local or --remote.');
const fileIndex = process.argv.indexOf('--file');
const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : fileURLToPath(new URL('../../dist/mcp-catalog.sql', import.meta.url));
if (!file) throw new Error('--file needs a path');
const config = await readFile(new URL('../wrangler.mcp.jsonc', import.meta.url), 'utf8');
if (!config.includes('"database_name": "biocartoon-catalog"') || config.includes('"containers"') || config.includes('"durable_objects"')) throw new Error('Expected the free-plan public catalog configuration.');
const args = ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'biocartoon-catalog', '-c', 'wrangler.mcp.jsonc', remote ? '--remote' : '--local', '--file', file, '--yes', '--json'];
if (!remote) args.push('--persist-to', '.wrangler/state');
const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (result.status !== 0) {
  process.stderr.write((result.stderr + '\n' + result.stdout).slice(-5000));
  process.exit(result.status ?? 1);
}
// Remote imports print upload progress before their JSON result, even with --json.
let data;
for (const match of result.stdout.matchAll(/^[\[{]/gm)) {
  try { data = JSON.parse(result.stdout.slice(match.index)); break; } catch { /* Next candidate. */ }
}
if (!data) throw new Error(`Import exited successfully but its summary could not be parsed. Verify the remote catalog before retrying. ${result.stdout.slice(-1200)}`);
const entries = Array.isArray(data) ? data : [data];
if (entries.some(r => r.success === false)) throw new Error('Catalog import failed');
console.log(JSON.stringify({ location: remote ? 'remote' : 'local', commands: entries.length, rows_written: entries.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0), results: entries.flatMap(r => r.results ?? []) }));
