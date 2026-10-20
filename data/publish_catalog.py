"""Publish data/assets.sqlite to R2 for the app to download.

The catalog is the master DB plus a prebuilt FTS index, minus sync.py's bookkeeping tables, the
`templates` table (published on its own) and the master-only columns in UNPUBLISHED_COLS, gzipped. Rows whose files are not in the bucket
(`uploaded_at` or `png_key` unset) are left out too, so every search result has an image; the
master is kept free of those, so normally nothing is.

    export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...   # bucket: config.R2_BUCKET
    python data/publish_catalog.py                       # build + upload
    python data/publish_catalog.py --dry-run             # build only

Writes `catalog/assets.sqlite.gz` and `catalog/version.txt` to R2 and, as a copy of what is live,
to data/catalog/ (a dry run writes the would-be catalog there instead). The app checks version.txt
on launch and downloads the catalog when it changed. Re-run after upload_r2.py adds assets.

Before building, what the app uploaded (user assets under `user/`, templates under `templates/`),
after the checks in uploads.py, is written into the master: the `source = 'user'` rows and the
`templates` table are replaced by what is in the bucket now. `catalog/templates.sqlite.gz` +
`catalog/templates_version.txt` are built from that table. Caps: --max-uploads / --max-per-author
per publish (oldest first); data/upload_blocklist.txt removes an id or author. --no-uploads
leaves the master's uploads alone and the catalogs without them.

Star counts (the app's star button, kept live by the submit Worker in D1) are fetched from
`<submit worker>/stars/all` and written into the master's `stars` column, so a freshly
downloaded catalog shows them before the app has asked the Worker. --stars-url / SUBMIT_URL
(config.py) point at the Worker; --no-stars skips the fetch (counts stay as in --db).

--dry-run makes these changes to a copy of the master and leaves the master and R2 alone.
A real publish ends with a backup of the master to the private bucket (backup_db.py);
--no-backup skips it (sync.py backs up itself, after the publish).

Each publish (and --dry-run) also rewrites the "Current resources" table in README.md from the
catalog it built (readme_stats.py).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import readme_stats
from config import PUBLISH_UA, R2_BUCKET, SUBMIT_URL

DATA = Path(__file__).resolve().parent

# Must match FTS_SQL in catalog/src/catalog.rs.
FTS_SQL = """
DROP TABLE IF EXISTS assets_fts;
CREATE VIRTUAL TABLE assets_fts USING fts5(title, description, tags, category, variant,
    content='assets', content_rowid='rowid', tokenize='porter unicode61');
INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
INSERT INTO assets_fts(assets_fts, rank) VALUES('rank', 'bm25(10.0, 1.0, 3.0, 1.0, 0.5)');
"""


TEMPLATES_SQL = """
CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, category TEXT, author TEXT,
    license TEXT, created_at TEXT, json_key TEXT NOT NULL, thumb_key TEXT,
    json_local TEXT, thumb_local TEXT);
"""
TEMPLATE_COLS = ["id", "title", "description", "category", "author", "license", "created_at", "json_key",
                 "thumb_key", "json_local", "thumb_local"]
NOT_PUBLISHED = ("sync_state", "sync_held", "sync_meta", "templates")
# assets columns kept in the master but left out of the catalog. The hashes are ~40% of the gzipped
# catalog and nothing in the app reads them; delete a name here to publish that column again.
UNPUBLISHED_COLS = ("svg_sha256", "png_sha256")


def write_local(files):
    """Copy (catalog file, version, version file name) triples to data/catalog/, which then matches
    what the app downloads: the live catalog after a publish, the would-be one after a dry run."""
    dest = DATA / "catalog"
    dest.mkdir(exist_ok=True)
    for f, ver, name in files:
        shutil.copy(f, dest / f.name)
        (dest / name).write_text(ver)
    print(f"wrote {dest}")


def gzip_versioned(db: Path) -> tuple[Path, str]:
    gz = db.with_suffix(db.suffix + ".gz")
    h = hashlib.sha256()
    with open(db, "rb") as f, gzip.open(gz, "wb", compresslevel=9) as g:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            g.write(chunk)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return gz, f"{stamp}-{h.hexdigest()[:12]}"


def published_version(s3, bucket: str, name: str) -> str | None:
    """`catalog/<name>` as now in the bucket, or None if it isn't there."""
    from botocore.exceptions import ClientError

    try:
        return s3.get_object(Bucket=bucket, Key=f"catalog/{name}")["Body"].read().decode().strip()
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def same_content(a: str | None, b: str) -> bool:
    """Versions are `<UTC stamp>-<sha256 prefix of the uncompressed DB>`; equal hashes, equal catalogs."""
    return a is not None and a.split("-", 1)[-1] == b.split("-", 1)[-1]


def update_master(con: sqlite3.Connection, user_rows: list[dict] | None, tmpl_rows: list[dict] | None,
                  stars: dict[str, int] | None):
    """Write the app uploads and star counts into the master (None: leave that part as it is)."""
    if not any(c[1] == "stars" for c in con.execute("PRAGMA table_info(assets)")):
        con.execute("ALTER TABLE assets ADD COLUMN stars INTEGER NOT NULL DEFAULT 0")
    con.executescript(TEMPLATES_SQL)
    with con:
        if user_rows is not None:
            keep = [r["id"] for r in user_rows]
            con.execute(f"DELETE FROM assets WHERE source = 'user' AND id NOT IN ({','.join('?' * len(keep))})", keep)
            if user_rows:
                cols = list(user_rows[0])
                con.executemany(  # an upsert, so a row keeps its star count
                    f"INSERT INTO assets ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) ON CONFLICT(id) DO UPDATE "
                    f"SET {', '.join(f'{c} = excluded.{c}' for c in cols if c != 'id')}",
                    [tuple(r[c] for c in cols) for r in user_rows])
        if tmpl_rows is not None:
            con.execute("DELETE FROM templates")
            con.executemany(f"INSERT INTO templates ({','.join(TEMPLATE_COLS)}) VALUES ({','.join('?' * len(TEMPLATE_COLS))})",
                            [tuple(r[c] for c in TEMPLATE_COLS) for r in tmpl_rows])
        if stars is not None:
            con.execute("UPDATE assets SET stars = 0 WHERE stars != 0")
            con.executemany("UPDATE assets SET stars = ? WHERE id = ?", [(n, i) for i, n in stars.items()])


def build_templates(src: Path, out_dir: Path, with_uploads: bool) -> tuple[Path, str, int]:
    db = out_dir / "templates.sqlite"
    d = sqlite3.connect(db)
    d.executescript(TEMPLATES_SQL + "CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);")
    if with_uploads:
        d.execute("ATTACH ? AS m", (str(src),))
        d.execute(f"INSERT INTO templates SELECT {','.join(TEMPLATE_COLS)} FROM m.templates")
        d.commit()
        d.execute("DETACH m")
    n = d.execute("SELECT count(*) FROM templates").fetchone()[0]
    d.commit()
    d.close()
    gz, version = gzip_versioned(db)
    return gz, version, n


def fetch_stars(url: str) -> dict[str, int]:
    """`{asset id: stars}` for every starred asset, from the submit Worker."""
    # Cloudflare answers urllib's default User-Agent with 403.
    req = urllib.request.Request(f"{url.rstrip('/')}/stars/all", headers={"User-Agent": PUBLISH_UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        counts = json.load(r)
    if not isinstance(counts, dict):
        raise ValueError("unexpected reply")
    return {k: int(v) for k, v in counts.items() if isinstance(k, str) and isinstance(v, int) and v > 0}


def add_groups(d: sqlite3.Connection):
    """Fill the catalog's `grp` and `dup` columns, which the app reads to show one tile per drawing
    (see GROUP_KEY in catalog/src/catalog.rs). Rows are in one group when they are colours of one
    BioArt accession or byte-identical images (same `png_sha256`) in one source; `grp` is the
    group's smallest id, NULL for a row on its own. `dup` is 1 on every copy of an identical image
    but the first (by id): BioArt lists some files under two accessions, and OpenMoji reuses
    flags. Copies stay in the catalog, so each one's title still finds the group."""
    rows = d.execute("SELECT id, source, json_extract(extra, '$.accession'), png_sha256 FROM assets ORDER BY id").fetchall()
    parent = {r[0]: r[0] for r in rows}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    first, dups = {}, []
    for rid, source, accession, sha in rows:
        keys = [("sha", source, sha)] if sha else []
        if source == "bioart" and accession:
            keys.append(("accession", accession))
        for k in keys:
            if k not in first:
                first[k] = rid
                continue
            if k[0] == "sha":
                dups.append(rid)
            a, b = find(first[k]), find(rid)
            parent[max(a, b)] = min(a, b)  # ids come in order, so the root is the smallest id
    size = {}
    for rid in parent:
        size[find(rid)] = size.get(find(rid), 0) + 1
    d.execute("ALTER TABLE assets ADD COLUMN grp TEXT")
    d.execute("ALTER TABLE assets ADD COLUMN dup INTEGER NOT NULL DEFAULT 0")
    d.executemany("UPDATE assets SET grp = ? WHERE id = ?", [(find(r), r) for r in parent if size[find(r)] > 1])
    d.executemany("UPDATE assets SET dup = 1 WHERE id = ?", [(r,) for r in set(dups)])
    print(f"{len(size)} icons ({sum(1 for n in size.values() if n > 1)} grouped), {len(set(dups))} identical copies")


def build(src: Path, out_dir: Path, with_uploads: bool) -> tuple[Path, str, int]:
    db = out_dir / "assets.sqlite"
    s = sqlite3.connect(src)
    d = sqlite3.connect(db)
    s.backup(d)
    s.close()
    left_out = d.execute("DELETE FROM assets WHERE uploaded_at IS NULL OR png_key IS NULL").rowcount
    if left_out:
        print(f"warning: {left_out} rows of {src} are not in the bucket and are left out of the catalog")
    if not with_uploads:
        d.execute("DELETE FROM assets WHERE source = 'user'")
    for t in NOT_PUBLISHED:
        d.execute(f"DROP TABLE IF EXISTS {t}")
    add_groups(d)  # reads png_sha256, so before it goes
    have = {c[1] for c in d.execute("PRAGMA table_info(assets)")}
    for c in UNPUBLISHED_COLS:
        if c in have:
            d.execute(f"ALTER TABLE assets DROP COLUMN {c}")
    d.executescript(FTS_SQL)
    d.commit()
    n = d.execute("SELECT count(*) FROM assets").fetchone()[0]
    d.execute("PRAGMA journal_mode=DELETE")
    d.execute("VACUUM")
    d.close()
    gz, version = gzip_versioned(db)
    return gz, version, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    ap.add_argument("--bucket", default=R2_BUCKET)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-uploads", action="store_true", help="leave out app uploads (assets and templates)")
    ap.add_argument("--max-uploads", type=int, default=500, help="most user assets/templates per publish (each)")
    ap.add_argument("--max-per-author", type=int, default=50, help="most per self-reported author (each kind)")
    ap.add_argument("--stars-url", default=SUBMIT_URL,
                    help="the submit Worker, whose /stars/all gives the star counts")
    ap.add_argument("--no-stars", action="store_true", help="leave star counts as they are in --db")
    ap.add_argument("--no-backup", action="store_true", help="skip the R2 backup of the master after publishing")
    a = ap.parse_args()
    if not a.bucket and not a.dry_run:
        sys.exit("set R2_BUCKET or pass --bucket")

    s3 = None
    user_rows = tmpl_rows = None
    if not a.no_uploads and a.bucket:
        from upload_r2 import client
        import uploads

        s3 = client()
        blocked = uploads.blocklist()
        user_rows = uploads.asset_rows(s3, a.bucket, uploads.Caps(a.max_uploads, a.max_per_author), blocked,
                                       upload_renders=not a.dry_run)
        con = sqlite3.connect(a.db)
        keys = {k for (k,) in con.execute("SELECT png_key FROM assets WHERE uploaded_at IS NOT NULL AND png_key IS NOT NULL")}
        con.close()
        keys |= {r["png_key"] for r in user_rows}
        tmpl_rows = uploads.template_rows(s3, a.bucket, keys, uploads.Caps(a.max_uploads, a.max_per_author), blocked)
        print(f"{len(user_rows)} user assets, {len(tmpl_rows)} templates from app uploads")
    elif not a.no_uploads:
        print("no bucket: the master's app uploads are published as they are")

    stars = None
    if not a.no_stars and a.stars_url:
        try:
            stars = fetch_stars(a.stars_url)
            print(f"{len(stars)} starred assets, {sum(stars.values())} stars")
        except Exception as e:  # noqa: BLE001
            print(f"warning: could not fetch star counts from {a.stars_url}: {e}; keeping the counts in {a.db}")

    tmp = Path(tempfile.mkdtemp(prefix="catalog-"))
    try:
        master = Path(a.db)
        if a.dry_run:  # the same changes, to a copy
            s, d = sqlite3.connect(master), sqlite3.connect(tmp / "master.sqlite")
            s.backup(d)
            s.close()
            d.close()
            master = tmp / "master.sqlite"
        con = sqlite3.connect(master)
        update_master(con, user_rows, tmpl_rows, stars)
        con.close()
        gz, version, n = build(master, tmp, not a.no_uploads)
        tgz, tversion, tn = build_templates(master, tmp, not a.no_uploads)
        print(f"{n} assets, {gz.stat().st_size / 1e6:.1f} MB gzipped, version {version}; {tn} templates ({tversion})")
        if a.dry_run:
            write_local(((gz, version, "version.txt"), (tgz, tversion, "templates_version.txt")))
            readme_stats.update(tmp / "assets.sqlite", templates_db=tmp / "templates.sqlite")
            return
        if s3 is None:
            from upload_r2 import client

            s3 = client()
        # Catalog first, version last, so a client never sees a version without its file. A catalog
        # whose content hash matches the published one is not re-sent, so the app doesn't download
        # it again for nothing (the weekly sync publishes every run).
        sent, live = [], []
        for f, ver, name in ((gz, version, "version.txt"), (tgz, tversion, "templates_version.txt")):
            if same_content(old := published_version(s3, a.bucket, name), ver):
                print(f"catalog/{f.name} unchanged ({ver.split('-', 1)[1]}); not re-published")
                live.append((f, old, name))
                continue
            live.append((f, ver, name))
            sent.append(ver)
            s3.upload_file(str(f), a.bucket, f"catalog/{f.name}", ExtraArgs={
                "ContentType": "application/gzip", "CacheControl": "no-cache"})
            s3.put_object(Bucket=a.bucket, Key=f"catalog/{name}", Body=ver.encode(),
                          ContentType="text/plain", CacheControl="no-cache")
        if sent:
            print(f"published r2://{a.bucket}/catalog/ ({', '.join(sent)})")
        write_local(live)
        readme_stats.update(tmp / "assets.sqlite", templates_db=tmp / "templates.sqlite")
        if not a.no_backup:
            from backup_db import backup
            from config import R2_BACKUP_BUCKET

            print(f"master DB backed up to r2://{R2_BACKUP_BUCKET}/{backup(s3, master)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
