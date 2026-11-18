#!/usr/bin/env python3
"""Export the public catalog to D1 SQL; never reads or copies the private submissions DB.

By default downloads the published snapshots. --catalog-dir uses an existing snapshot directory.
Import the result with `wrangler d1 execute biocartoon-catalog -c wrangler.mcp.jsonc --local|--remote --file PATH`.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://assets.biocartoon.com/catalog'
ASSET_FIELDS = {
    'id': 'TEXT PRIMARY KEY', 'source': 'TEXT NOT NULL', 'source_name': 'TEXT', 'source_id': 'TEXT',
    'title': 'TEXT', 'variant': 'TEXT', 'description': 'TEXT', 'category': 'TEXT', 'tags': "TEXT DEFAULT '[]'",
    'license': 'TEXT', 'credit': 'TEXT', 'author': 'TEXT', 'source_url': 'TEXT', 'png_key': 'TEXT',
    'svg_key': 'TEXT', 'thumb_key': 'TEXT', 'png_width': 'INTEGER', 'png_height': 'INTEGER',
    'stars': 'INTEGER DEFAULT 0', 'grp': 'TEXT', 'style_group': 'TEXT', 'dup': 'INTEGER DEFAULT 0',
    'generative_ai_used': 'INTEGER', 'generative_ai_details': 'TEXT',
}
TEMPLATE_FIELDS = {
    'id': 'TEXT PRIMARY KEY', 'title': 'TEXT', 'description': 'TEXT', 'category': 'TEXT',
    'author': 'TEXT', 'license': 'TEXT', 'created_at': 'TEXT', 'json_key': 'TEXT', 'thumb_key': 'TEXT',
    'tags': "TEXT DEFAULT '[]'", 'generative_ai_used': 'INTEGER',
}
SCHEMA = '\n'.join([
    'DROP TABLE IF EXISTS assets_fts;', 'DROP TABLE IF EXISTS assets;', 'DROP TABLE IF EXISTS templates;',
    'DROP TABLE IF EXISTS catalog_meta;',
    'CREATE TABLE assets (' + ', '.join(f'"{k}" {v}' for k, v in ASSET_FIELDS.items()) + ');',
    'CREATE TABLE templates (' + ', '.join(f'"{k}" {v}' for k, v in TEMPLATE_FIELDS.items()) + ');',
    'CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
])
INDEXES = """
CREATE INDEX assets_source_title ON assets(source, title COLLATE NOCASE);
CREATE VIRTUAL TABLE assets_fts USING fts5(title, description, tags, category, variant,
    content='assets', content_rowid='rowid', tokenize='porter unicode61');
INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
"""
TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS assets_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts(rowid,title,description,tags,category,variant) VALUES(new.rowid,new.title,new.description,new.tags,new.category,new.variant);
END;
CREATE TRIGGER IF NOT EXISTS assets_ad AFTER DELETE ON assets BEGIN
  INSERT INTO assets_fts(assets_fts,rowid,title,description,tags,category,variant) VALUES('delete',old.rowid,old.title,old.description,old.tags,old.category,old.variant);
END;
CREATE TRIGGER IF NOT EXISTS assets_au AFTER UPDATE ON assets BEGIN
  INSERT INTO assets_fts(assets_fts,rowid,title,description,tags,category,variant) VALUES('delete',old.rowid,old.title,old.description,old.tags,old.category,old.variant);
  INSERT INTO assets_fts(rowid,title,description,tags,category,variant) VALUES(new.rowid,new.title,new.description,new.tags,new.category,new.variant);
END;
INSERT OR REPLACE INTO catalog_meta VALUES ('schema_version','1');
"""


def snapshot(directory, base=BASE):
    directory.mkdir(parents=True, exist_ok=True)
    def fetch(name):
        request = urllib.request.Request(f'{base}/{name}', headers={'User-Agent': 'biocartoon-publish'})
        return urllib.request.urlopen(request, timeout=60).read()
    for prefix in ['', 'templates_']:
        version_name = prefix + 'version.txt'
        db_name = 'templates.sqlite.gz' if prefix else 'assets.sqlite.gz'
        for _ in range(3):
            version = fetch(version_name).decode().strip()
            compressed = fetch(db_name)
            after = fetch(version_name).decode().strip()
            raw = gzip.decompress(compressed)
            if version == after and version.rsplit('-', 1)[-1] == hashlib.sha256(raw).hexdigest()[:12]:
                (directory / db_name).write_bytes(compressed)
                (directory / version_name).write_text(version)
                break
        else:
            raise RuntimeError('The published catalog changed or its checksum failed; try again.')


def export(directory: Path, output: Path):
    directory, output = Path(directory), Path(output)
    parts = [SCHEMA]
    counts = {}
    for table, fields in [('assets', ASSET_FIELDS), ('templates', TEMPLATE_FIELDS)]:
        raw = gzip.decompress((directory / f'{table}.sqlite.gz').read_bytes())
        version = (directory / ('version.txt' if table == 'assets' else 'templates_version.txt')).read_text().strip()
        if not version.endswith(hashlib.sha256(raw).hexdigest()[:12]):
            raise ValueError(f'{table}: snapshot checksum does not match its version')
        db = sqlite3.connect(':memory:')
        db.deserialize(raw)
        db.row_factory = sqlite3.Row
        cols = {r[1] for r in db.execute(f'PRAGMA table_info({table})')}
        count = 0
        for row in db.execute(f'SELECT * FROM {table} ORDER BY id'):
            values = []
            for key in fields:
                value = row[key] if key in cols else None
                if key in ('grp', 'style_group') and not value:
                    if key == 'style_group' and row['source'] == 'healthicons':
                        value = 'healthicons:' + (str(row['source_id']).partition('/')[2] if 'source_id' in cols else str(row['title']))
                    else:
                        value = row['id']
                if key == 'dup' and value is None:
                    value = 0
                values.append(db.execute('SELECT quote(?)', (value,)).fetchone()[0])
            sql = f'INSERT INTO {table} VALUES ({",".join(values)});'
            if len(sql.encode()) > 95_000:
                raise ValueError(f'{table} {row["id"]}: record exceeds D1 statement limit')
            parts.append(sql)
            count += 1
        parts.append(f"INSERT INTO catalog_meta VALUES ('{table}_version', '{version}');")
        counts[table] = count
        db.close()
    parts.append(INDEXES + TRIGGERS)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(parts) + '\n')
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog-dir', type=Path)
    parser.add_argument('--out', type=Path, default=ROOT / 'dist/mcp-catalog.sql')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='biocartoon-mcp-') as temp:
        directory = args.catalog_dir or Path(temp)
        if not args.catalog_dir:
            snapshot(directory)
        counts = export(directory, args.out)
    print(json.dumps({'output': str(args.out), **counts}))


if __name__ == '__main__':
    main()
