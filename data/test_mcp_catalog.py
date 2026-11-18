import gzip
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from export_mcp_catalog import SCHEMA, export
from sync_mcp_catalog import delta_sql, sync


def snapshot(directory):
    db = sqlite3.connect(':memory:')
    db.executescript(SCHEMA)
    db.execute("ALTER TABLE assets ADD COLUMN png_local TEXT")
    db.execute("CREATE TABLE private_accounts (email TEXT)")
    db.execute("INSERT INTO private_accounts VALUES ('private@example.com')")
    db.execute("INSERT INTO assets (id,source,title,description,tags,license,credit,png_key,png_local) VALUES ('a','bioart','Neuron','A cell','[\"brain\"]','PD','Artist, PD','bioart/a.png','/private/a.png')")
    db.execute("INSERT INTO assets (id,source,title,description,tags,license,credit,png_key) VALUES ('b','bioart','Heart','An organ','[]','PD','Artist, PD','bioart/b.png')")
    db.execute("INSERT INTO templates (id,title,tags,json_key) VALUES ('t','Cell signaling','[\"kinase\"]','templates/t.json')")
    db.commit()
    raw = db.serialize(); db.close()
    version = '20260101T000000Z-' + hashlib.sha256(raw).hexdigest()[:12]
    for table, name in [('assets', 'version.txt'), ('templates', 'templates_version.txt')]:
        (directory / f'{table}.sqlite.gz').write_bytes(gzip.compress(raw))
        (directory / name).write_text(version)


def records(db):
    return {**{table: [dict(r) for r in db.execute(f'SELECT * FROM {table}')] for table in ['assets', 'templates']}, 'versions': dict(db.execute('SELECT key,value FROM catalog_meta'))}


class CatalogExportTests(unittest.TestCase):
    def test_exports_only_public_fields_and_validates_checksums(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); snapshot(directory)
            sql = directory / 'catalog.sql'
            self.assertEqual(export(directory, sql), {'assets': 2, 'templates': 1})
            text = sql.read_text()
            self.assertNotIn('/private/', text)
            self.assertNotIn('private_accounts', text)
            db = sqlite3.connect(':memory:'); db.executescript(text)
            self.assertEqual(db.execute("SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'neuron'").fetchone()[0], 1)
            db.close()
            (directory / 'version.txt').write_text('incorrect-hash')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                export(directory, sql)

    def test_incremental_upsert_and_delete_keep_full_text_index_current(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); snapshot(directory); sql = directory / 'catalog.sql'; export(directory, sql)
            db = sqlite3.connect(':memory:'); db.row_factory = sqlite3.Row; db.executescript(sql.read_text())
            old = records(db)
            new = {'assets': [dict(old['assets'][0], title="Neuron's mitochondrion")], 'templates': old['templates'], 'versions': old['versions']}
            new['assets'].append(dict(old['assets'][1], id='c', title='Liver'))
            delta, counts = delta_sql(new, old)
            self.assertEqual(counts, {'upserted': 2, 'deleted': 1})
            self.assertNotIn('DROP TABLE', delta)
            db.executescript(delta)
            self.assertEqual({r['id'] for r in db.execute('SELECT id FROM assets')}, {'a', 'c'})
            self.assertEqual(db.execute("SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'heart'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'mitochondrion'").fetchone()[0], 1)
            self.assertEqual(delta_sql(records(db), records(db))[1], {'upserted': 0, 'deleted': 0})
            db.close()

    def test_same_versions_skip_remote_catalog_read_and_write(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); snapshot(directory); sql = directory / 'catalog.sql'; export(directory, sql)
            db = sqlite3.connect(':memory:'); db.executescript(sql.read_text())
            versions = [{'key': k, 'value': v} for k, v in db.execute('SELECT key,value FROM catalog_meta')]; db.close()
            with patch('sync_mcp_catalog.remote_query', return_value=[versions]) as query, patch('sync_mcp_catalog.subprocess.run') as command:
                self.assertTrue(sync(directory)['unchanged'])
                self.assertEqual(query.call_count, 1)
                command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
