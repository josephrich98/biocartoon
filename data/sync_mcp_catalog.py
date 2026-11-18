#!/usr/bin/env python3
"""Sync only changed public catalog rows to the deployed free-plan D1 database.

This avoids spending the daily free write allowance on a full reimport after each publish.
Existing submissions, accounts and image buckets are never changed. The first database import
is done with export_mcp_catalog.py; subsequent publishes use this incremental sync.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

from export_mcp_catalog import ASSET_FIELDS, TEMPLATE_FIELDS, TRIGGERS, export, snapshot

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / 'worker'


def remote_query(sql):
    command = ['node', 'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'biocartoon-catalog',
               '-c', 'wrangler.mcp.jsonc', '--remote', '--command', sql, '--json']
    result = subprocess.run(command, cwd=WORKER, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError((result.stderr + result.stdout)[-2000:])
    data = json.loads(result.stdout)
    if any(not item.get('success') for item in data):
        raise RuntimeError('D1 query failed')
    return [item['results'] for item in data]


def delta_sql(new, old):
    """Return statements and counts; unmodified rows produce no writes or index rebuilds."""
    quote = lambda value: 'NULL' if value is None else str(value) if isinstance(value, (int, float)) else "'" + str(value).replace("'", "''") + "'"
    statements = [TRIGGERS]
    counts = {'upserted': 0, 'deleted': 0}
    for table, fields in [('assets', ASSET_FIELDS), ('templates', TEMPLATE_FIELDS)]:
        previous = {r['id']: r for r in old[table]}
        current = {r['id']: r for r in new[table]}
        for id, row in current.items():
            if previous.get(id) == row:
                continue
            values = ','.join(quote(row[k]) for k in fields)
            update = ','.join(f'"{k}"=excluded."{k}"' for k in fields if k != 'id')
            statements.append(f'INSERT INTO {table} VALUES ({values}) ON CONFLICT(id) DO UPDATE SET {update};')
            counts['upserted'] += 1
        for id in previous.keys() - current.keys():
            statements.append(f'DELETE FROM {table} WHERE id={quote(id)};')
            counts['deleted'] += 1
    for key, value in new['versions'].items():
        statements.append(f'INSERT OR REPLACE INTO catalog_meta VALUES ({quote(key)},{quote(value)});')
    return '\n'.join(statements), counts


def sync(directory=None, dry_run=False):
    with tempfile.TemporaryDirectory(prefix='biocartoon-d1-') as temp:
        temp = Path(temp)
        directory = Path(directory) if directory else temp / 'snapshot'
        if not directory.exists():
            snapshot(directory)
        exported = temp / 'full.sql'
        export(directory, exported)
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.executescript(exported.read_text())
        versions = dict(db.execute('SELECT key,value FROM catalog_meta'))
        have = {r['key']: r['value'] for r in remote_query('SELECT key,value FROM catalog_meta')[0]}
        if have == versions:
            db.close()
            return {'unchanged': True, 'upserted': 0, 'deleted': 0}
        old_assets, old_templates = remote_query('SELECT * FROM assets; SELECT * FROM templates;')
        new = {table: [dict(r) for r in db.execute(f'SELECT * FROM {table}')] for table in ['assets', 'templates']}
        new['versions'] = versions
        sql, counts = delta_sql(new, {'assets': old_assets, 'templates': old_templates})
        db.close()
        delta = temp / 'delta.sql'
        delta.write_text(sql + '\n')
        if dry_run:
            return {**counts, 'dry_run': True}
        result = subprocess.run(['node', 'scripts/import_mcp_catalog.mjs', '--remote', '--file', str(delta)], cwd=WORKER, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError((result.stderr + result.stdout)[-2000:])
        return {**counts, 'unchanged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog-dir', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    print(json.dumps(sync(args.catalog_dir, args.dry_run)))
