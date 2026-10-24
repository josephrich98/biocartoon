#!/usr/bin/env python3
"""Find assets the upstream collections added since the last run and publish them.

    python data/sync.py                      # dry run (default): discover + diff + gate, print, change nothing
    python data/sync.py --apply              # fetch, rasterize, upload to R2, insert, publish the catalog
    python data/sync.py --sources scidraw,servier --limit 5 --apply   # smoke test
    python data/sync.py --held               # list what is held back and why
    python data/sync.py --approve servier/some-slug --apply           # publish a held item anyway
    python data/sync.py --force bioicons --apply                      # skip the too-many-new check once

Only ever ADDS rows to the master data/assets.sqlite: build_assets_db.py rebuilds from local
scrapes, which are no longer on disk, so it must not be run on a schedule. Existing rows and
R2 objects are never changed (they are served `immutable`); an upstream edit to an asset we
already have is ignored. Nothing is deleted.

Per source (scrape_sources.DISCOVER, scrape_bioart.discover):
  1. discover   cheap upstream signal (commit, release tag, ETag, sitemap hash); unchanged -> skip
  2. diff       upstream ids minus ids in the catalog (and ids held in sync_held)
  3. gate       license must be one this source already has in the catalog, else held for review;
                more than --max-new new items, or upstream listing far fewer than we have,
                -> the whole source is skipped this run and reported (scraper or upstream broke)
  4. fetch      download only the new files into a scratch dir
  5. rasterize  SVG -> PNG with rasterize.py, when there is no big-enough shipped PNG
  6. row        build_assets_db.finish(); a new id that collides with nothing
  7. upload     upload_r2.upload_row(); keys that already exist in the bucket are never overwritten
  8. insert     one transaction per source; then the source's signal is saved
Then publish_catalog.py on every --apply run (it also merges approved app uploads and star
counts; the app picks a changed catalog up on launch), a dated gzipped backup of
the master DB to the private bucket on every --apply run (backup_db.py), and a report in
data/sync-reports/.

Exit status: 0 fine, 2 something needs a look (see the report), 1 failed.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path

import build_assets_db as B
import scrape_sources
from backup_db import backup, local_backup
from config import R2_BACKUP_BUCKET, R2_BUCKET

DATA = Path(__file__).resolve().parent
SOURCES = ["bioart", "bioicons", "healthicons", "openmoji", "reactome", "scidraw", "servier"]
MIN_LISTED_FRACTION = 0.8  # upstream listing fewer than this share of what we have -> broken scraper

STATE_SQL = """
CREATE TABLE IF NOT EXISTS sync_state (
    source TEXT PRIMARY KEY, signal TEXT, listed INTEGER, checked_at TEXT, last_added_at TEXT, last_added INTEGER);
CREATE TABLE IF NOT EXISTS sync_held (       -- treated as known: not re-discovered every run
    source TEXT NOT NULL, source_id TEXT NOT NULL,
    reason TEXT NOT NULL,                     -- 'license: X' | 'nofile: ...' | 'approved' (process next --apply)
    item TEXT NOT NULL,                       -- the discovered build item (JSON)
    found_at TEXT NOT NULL,
    PRIMARY KEY (source, source_id));
CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS assets_source_id ON assets(source, source_id);
"""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


class Report:
    def __init__(self):
        self.lines: list[str] = []
        self.attention: list[str] = []
        self.added = 0

    def log(self, msg: str):
        print(msg, flush=True)
        self.lines.append(msg)

    def alert(self, msg: str):
        self.log(f"!! {msg}")
        self.attention.append(msg)


# ----------------------------------------------------------------------------
# discovery
# ----------------------------------------------------------------------------
def discover(source: str, known: set[str], prev: str | None, work: Path):
    """-> (signal, listed or None if unchanged, [build items with URL/absolute-path files])."""
    if source == "bioart":
        import scrape_bioart

        entries = {int(s.split("_", 1)[0]) for s in known}
        recs = scrape_bioart.discover(entries)
        items = [it for r in recs for it in B.bioart_items(r, lambda fl: fl["url"]) if it["source_id"] not in known]
        return str(max(entries | {r["id"] for r in recs}, default=0)), None if not recs else len(recs), items
    sig, listed, its = scrape_sources.DISCOVER[source](known, prev, work)
    return sig, listed, [B.source_item(source, it, lambda v: v) for it in its]


# ----------------------------------------------------------------------------
# fetch + rasterize
# ----------------------------------------------------------------------------
def _safe(sid: str) -> str:
    return B.raster_path("x", sid, Path("/")).stem


def stage_file(ref: str, kind: str, base: Path) -> str | None:
    """URL or local path -> an absolute path of a checked file in the scratch dir, or None."""
    from PIL import Image

    if ref.startswith(("http://", "https://")):
        ext = ref.rsplit("?", 1)[0].rsplit(".", 1)[-1].lower()
        ext = ext if ext in ("svg", "png", "jpg", "jpeg", "bmp", "gif", "webp") else kind
        dest = base.with_name(f"{base.name}.{kind}-download.{ext}")
        if not scrape_sources.download(ref, dest):
            return None
    else:
        dest = Path(ref)
        if not dest.is_file():
            return None
    if kind == "svg":
        head = dest.read_bytes()[:4096].lower()
        return str(dest) if b"<svg" in head else None
    try:
        with Image.open(dest) as im:
            im.load()
            if im.format == "PNG":
                return str(dest)
            out = base.with_name(f"{base.name}.png")  # JPEG/BMP (some SciDraw drawings) go up as real PNGs
            im.convert("RGBA").save(out)
            return str(out)
    except Exception:  # noqa: BLE001
        return None


def stage_item(it: dict, work: Path) -> tuple[dict | None, str]:
    """Download + rasterize + finish(); -> (row or None, reason)."""
    from PIL import Image

    import rasterize

    base = work / "files" / _safe(it["source_id"])
    base.parent.mkdir(parents=True, exist_ok=True)
    it = dict(it)
    for kind in ("svg", "png"):
        if it[kind]:
            it[kind] = stage_file(it[kind], kind, base)
    if not it["svg"] and not it["png"]:
        return None, "nofile: download failed or not an image"
    small = True
    if it["png"]:
        with Image.open(it["png"]) as im:
            small = max(im.size) < B.MIN_PNG_SIDE
    raster_root = work / "raster"
    if it["svg"] and small:
        # SIGALRM-based timeout: must run in the main thread
        rasterize.render_one((it["svg"], str(B.raster_path(it["source"], it["source_id"], raster_root))))
    row = B.finish(it, True, raster_root)
    if row is None:
        return None, "nofile: no usable PNG or SVG"
    if not row["png_local"]:
        return None, "nofile: SVG did not render"
    return row, "ok"


# ----------------------------------------------------------------------------
# R2
# ----------------------------------------------------------------------------
def key_exists(s3, bucket: str, key: str) -> bool:
    from botocore.exceptions import ClientError

    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def assign_id(row: dict, taken: set[str], s3, bucket: str):
    base = f"{row['source']}/{B.slug(row['source_id'])}"
    rid, k = base, 1
    while True:
        svg_key, png_key = (f"{rid}.svg" if row["svg_local"] else None), (f"{rid}.png" if row["png_local"] else None)
        if rid not in taken and not any(key and s3 and key_exists(s3, bucket, key) for key in (svg_key, png_key)):
            break
        k += 1
        rid = f"{base}-{k}"
    taken.add(rid)
    row.update(id=rid, svg_key=svg_key, png_key=png_key)


# ----------------------------------------------------------------------------
# one source
# ----------------------------------------------------------------------------
def adopt_author(row: dict, spelled: dict[str, str]):
    """Write an author the master already has under another case ("kehan" vs "KeHan") its way."""
    canon = spelled.get((row["author"] or "").lower())
    if canon and canon != row["author"]:
        author_url = json.loads(row["extra"] or "{}").get("author_url")
        row.update(author=canon, credit=B.credit_line(row["title"], canon, row["source"], row["source_url"],
                                                     row["license"], row["license_url"], author_url))


def sync_source(con, source: str, a, s3, rep: Report, taken: set[str]):
    in_db = {sid for (sid,) in con.execute("SELECT source_id FROM assets WHERE source = ?", (source,))}
    held = {sid: (reason, item) for sid, reason, item in
            con.execute("SELECT source_id, reason, item FROM sync_held WHERE source = ?", (source,))}
    approved = [json.loads(item) for reason, item in held.values() if reason == "approved"]
    prev = (con.execute("SELECT signal FROM sync_state WHERE source = ?", (source,)).fetchone() or (None,))[0]
    allowed = {lic for (lic,) in con.execute("SELECT DISTINCT license FROM assets WHERE source = ?", (source,))}
    genai = B.load_generative_ai()

    work = Path(tempfile.mkdtemp(prefix=f"sync-{source}-", dir=a.work))
    try:
        sig, listed, items = discover(source, in_db | set(held), prev, work)
        if listed is None and not items and not approved:
            rep.log(f"[{source}] unchanged upstream ({sig})")
            if a.apply:
                con.execute("INSERT INTO sync_state(source, signal, checked_at) VALUES (?,?,?) "
                            "ON CONFLICT(source) DO UPDATE SET checked_at = excluded.checked_at", (source, sig, now()))
                con.commit()
            return
        if listed is not None and source != "bioart" and in_db and listed < MIN_LISTED_FRACTION * len(in_db):
            rep.alert(f"[{source}] upstream lists {listed} items but the catalog has {len(in_db)}: "
                      "scraper probably broken; skipped")
            return

        ok_items, new_held = [], []
        for it in items:
            lic = B.license_info(it["license_raw"])[0]
            if it["license_raw"].strip().lower() not in B.LICENSES or lic not in allowed:
                new_held.append((it, f"license: {it['license_raw'] or 'none'} -> {lic}"))
            else:
                ok_items.append(it)
        rep.log(f"[{source}] upstream {listed if listed is not None else '?'} listed, {len(items)} new"
                f" ({len(ok_items)} pass, {len(new_held)} held for license)"
                + (f", {len(approved)} approved from hold" if approved else ""))
        for it, why in new_held:
            rep.alert(f"[{source}] held {it['source_id']!r} ({it['title']}): {why}")
        if len(ok_items) > a.max_new and source not in a.force:
            rep.alert(f"[{source}] {len(ok_items)} new items > --max-new {a.max_new}: upstream may have renamed ids; "
                      f"skipped (look with a dry run, then --force {source})")
            return
        for it in ok_items[:20]:
            rep.log(f"    + {it['source_id']}  {it['title'] or ''}")
        if len(ok_items) > 20:
            rep.log(f"    + ... {len(ok_items) - 20} more")

        todo = ok_items + approved
        if a.limit is not None:
            todo = todo[: a.limit]
        if not a.apply:
            return

        rows, complete = [], a.limit is None or a.limit >= len(ok_items) + len(approved)
        # most common spelling last, so it wins
        spelled = {au.lower(): au for (au,) in con.execute(
            "SELECT author FROM assets WHERE author IS NOT NULL GROUP BY author ORDER BY count(*)")}
        for it in todo:
            try:
                row, why = stage_item(it, work)
            except Exception as e:  # noqa: BLE001
                row, why = None, f"nofile: {type(e).__name__}: {e}"
            if row is None:
                new_held.append((it, why))
                rep.alert(f"[{source}] held {it['source_id']!r}: {why}")
                continue
            adopt_author(row, spelled)
            assign_id(row, taken, s3, a.bucket)
            try:
                from upload_r2 import upload_row

                upload_row(s3, a.bucket, row)
            except Exception as e:  # noqa: BLE001
                rep.alert(f"[{source}] upload of {row['id']} failed ({e}); retried next run")
                taken.discard(row["id"])
                complete = False
                continue
            # layers.json is applied by publish_catalog.py; generative_ai.json is applied there too.
            row.update(uploaded_at=now(), svg_local=None, png_local=None, stars=0, layers=None,
                       generative_ai_used=B.generative_ai(row, genai))
            rows.append(row)

        with con:
            con.executemany(f"INSERT INTO assets ({','.join(B.COLS)}) VALUES ({','.join('?' * len(B.COLS))})",
                            ([r[c] for c in B.COLS] for r in rows))
            con.executemany("INSERT OR REPLACE INTO sync_held VALUES (?,?,?,?,?)",
                            [(source, it["source_id"], why, json.dumps(it, ensure_ascii=False), now()) for it, why in new_held])
            con.executemany("DELETE FROM sync_held WHERE source = ? AND source_id = ? AND reason = 'approved'",
                            [(source, r["source_id"]) for r in rows])
            if rows:
                con.execute("INSERT OR REPLACE INTO sync_meta VALUES ('needs_publish', '1')")
            # the signal only moves on once everything it covers is in the catalog or held, so a failed
            # upload or a --limit run is picked up again next time even if upstream stays unchanged
            con.execute("INSERT INTO sync_state VALUES (?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET "
                        "signal = CASE WHEN ? THEN excluded.signal ELSE signal END, listed = excluded.listed, "
                        "checked_at = excluded.checked_at, last_added_at = COALESCE(excluded.last_added_at, last_added_at), "
                        "last_added = excluded.last_added",
                        (source, sig if complete else None, listed, now(), now() if rows else None, len(rows), complete))
        rep.added += len(rows)
        rep.log(f"[{source}] added {len(rows)}" + ("" if complete else " (partial: signal kept for a retry)"))
    except Exception as e:  # noqa: BLE001
        rep.alert(f"[{source}] failed: {type(e).__name__}: {e}")
        traceback.print_exc()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="actually fetch, upload, insert and publish")
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    ap.add_argument("--bucket", default=R2_BUCKET)
    ap.add_argument("--sources", default=",".join(SOURCES))
    ap.add_argument("--max-new", type=int, default=300, help="more new items than this in one source -> skip it, alert")
    ap.add_argument("--force", default="", help="comma list of sources to exempt from --max-new this run")
    ap.add_argument("--limit", type=int, default=None, help="process at most N new items per source (smoke test)")
    ap.add_argument("--no-publish", action="store_true", help="add to the master DB + R2 but don't publish the catalog")
    ap.add_argument("--held", action="store_true", help="list held items and exit")
    ap.add_argument("--approve", action="append", default=[], metavar="SOURCE/SOURCE_ID",
                    help="mark a held item for publishing on the next --apply (repeatable)")
    ap.add_argument("--work", default=str(DATA / ".sync-work"))
    a = ap.parse_args()
    a.force = {s for s in a.force.split(",") if s}

    db = Path(a.db)
    lock = open(DATA / ".sync.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("another sync is running")

    if a.held or a.approve:
        con = sqlite3.connect(db)
        con.executescript(STATE_SQL)
        for ref in a.approve:
            src, sid = ref.split("/", 1)
            n = con.execute("UPDATE sync_held SET reason = 'approved' WHERE source = ? AND source_id = ?", (src, sid)).rowcount
            print(f"{'approved' if n else 'not held:'} {ref}")
        con.commit()
        for src, sid, reason, item, at in con.execute("SELECT * FROM sync_held ORDER BY source, found_at"):
            print(f"{src}/{sid}\t{reason}\t{json.loads(item).get('title') or ''}\t{at[:10]}")
        if not a.apply:
            return 0

    rep = Report()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    rep.log(f"asset sync {'APPLY' if a.apply else 'DRY RUN'} {stamp}  db={db}  bucket={a.bucket}")
    s3 = None
    if a.apply:
        from upload_r2 import client

        s3 = client()
        rep.log(f"local backup: {local_backup(db).name}")
        con = sqlite3.connect(db)
        con.executescript(STATE_SQL)
    else:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        if not con.execute("SELECT 1 FROM sqlite_master WHERE name = 'sync_state'").fetchone():
            con.close()  # first run: dry runs read state tables that don't exist yet, from a copy
            tmp = Path(tempfile.mkdtemp()) / "assets.sqlite"
            src = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            con = sqlite3.connect(tmp)
            src.backup(con)
            src.close()
            con.executescript(STATE_SQL)
    Path(a.work).mkdir(parents=True, exist_ok=True)
    taken = {i for (i,) in con.execute("SELECT id FROM assets")}

    for source in a.sources.split(","):
        sync_source(con, source, a, s3, rep, taken)

    status = 0
    if a.apply:
        # every run publishes, so approved app uploads and star counts reach the master and the
        # catalog within a week; publish_catalog.py re-sends only a catalog whose content changed
        if not a.no_publish:
            rep.log("publishing the catalog ...")
            r = subprocess.run([sys.executable, str(DATA / "publish_catalog.py"), "--db", str(db), "--bucket", a.bucket,
                                "--no-backup"])
            if r.returncode == 0:
                con.execute("UPDATE sync_meta SET v = '0' WHERE k = 'needs_publish'")
                con.commit()
                rep.log("catalog published")
            else:
                rep.alert(f"publish_catalog.py failed (exit {r.returncode}); runs again next time")
        con.close()
        # every run changes the master (sync_state at least), so every run backs it up
        try:
            key = backup(s3, db)
            rep.log(f"master DB backed up to r2://{R2_BACKUP_BUCKET}/{key}")
        except Exception as e:  # noqa: BLE001
            rep.alert(f"R2 backup of the master DB failed: {e} (local copies are in data/backups/)")
    shutil.rmtree(a.work, ignore_errors=True)

    rep.log(f"SUMMARY: {rep.added} added, {len(rep.attention)} need attention" if a.apply
            else f"SUMMARY: dry run, {len(rep.attention)} need attention")
    out = DATA / "sync-reports"
    out.mkdir(exist_ok=True)
    (out / f"{stamp}{'' if a.apply else '-dry'}.txt").write_text("\n".join(rep.lines) + "\n")
    if rep.attention:
        status = 2
    return status


if __name__ == "__main__":
    sys.exit(main())
