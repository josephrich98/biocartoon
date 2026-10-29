"""Small PNG previews of the catalog's icons, for search results.

Each published PNG `<png_key>` gets a thumbnail at `thumbs/<png_key>`: at most THUMB_SIDE px on its
longest side, quantized to 256 colours (on a sample of 52 icons, 283 KB in all against 20 MB of
full PNGs). The master's `thumb_key` column names it, so clients load the thumbnail for a result
tile and the full PNG only when the icon is placed; a row with no thumbnail has `thumb_key` NULL
and clients fall back to the PNG.

publish_catalog.py calls ensure() before every build, so new icons from sync.py and app uploads
get theirs on the next publish. Run on its own to backfill (resumable: the bucket listing says
what is there):

    python data/thumbs.py --dry-run          # count what is missing
    python data/thumbs.py                    # make and upload the missing ones, set thumb_key
"""
from __future__ import annotations

import argparse
import io
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from config import R2_BUCKET

DATA = Path(__file__).resolve().parent
PREFIX = "thumbs/"
THUMB_SIDE = 256


def thumb_key(png_key: str) -> str:
    return PREFIX + png_key


def make_thumb(png: bytes) -> bytes:
    from PIL import Image

    im = Image.open(io.BytesIO(png))
    im.load()
    im = im.convert("RGBA")
    im.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    im.quantize(256, method=Image.Quantize.FASTOCTREE).save(out, "PNG", optimize=True)
    return out.getvalue()


def existing(s3, bucket: str) -> set[str]:
    keys = set()
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX):
        keys |= {o["Key"] for o in page.get("Contents", [])}
    return keys


def upload_thumb(s3, bucket: str, row) -> str:
    local = row["png_local"] and DATA / row["png_local"]
    if local and local.exists():
        png = local.read_bytes()
    else:
        png = s3.get_object(Bucket=bucket, Key=row["png_key"])["Body"].read()
    key = thumb_key(row["png_key"])
    s3.put_object(Bucket=bucket, Key=key, Body=make_thumb(png), ContentType="image/png",
                  CacheControl="public, max-age=31536000, immutable", Metadata={"asset-id": row["id"]})
    return key


def ensure(con: sqlite3.Connection, s3, bucket: str, dry_run: bool = False, limit: int | None = None,
           workers: int = 32, log=print) -> int:
    """Upload the thumbnails the bucket lacks for rows in the bucket (none when dry_run), then set
    every row's thumb_key to its thumbnail when the bucket has it, else NULL (not committed).
    Returns how many were made."""
    if "thumb_key" not in {c[1] for c in con.execute("PRAGMA table_info(assets)")}:
        con.execute("ALTER TABLE assets ADD COLUMN thumb_key TEXT")
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT id, png_key, png_local FROM assets WHERE uploaded_at IS NOT NULL AND png_key IS NOT NULL").fetchall()
    have = existing(s3, bucket)
    todo = [r for r in rows if thumb_key(r["png_key"]) not in have][:limit]
    made = failed = 0
    if dry_run:
        log(f"thumbnails: {len(have)} in the bucket, {len(todo)} missing (dry run: none made)")
    elif todo:
        log(f"thumbnails: making {len(todo)}")
        with ThreadPoolExecutor(workers) as ex:
            futs = {ex.submit(upload_thumb, s3, bucket, r): r["id"] for r in todo}
            for f in as_completed(futs):
                try:
                    have.add(f.result())
                    made += 1
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    log(f"  thumbnail FAIL {futs[f]}: {e}")
                if (made + failed) % 1000 == 0:
                    log(f"  {made + failed}/{len(todo)}")
        log(f"thumbnails: made {made}, failed {failed}")
    con.executemany("UPDATE assets SET thumb_key = ? WHERE id = ?",
                    [(k if (k := thumb_key(r["png_key"])) in have else None, r["id"]) for r in rows])
    con.row_factory = None
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    ap.add_argument("--bucket", default=R2_BUCKET)
    ap.add_argument("--dry-run", action="store_true", help="only count what is missing; the master is left alone")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()
    if not a.bucket:
        sys.exit("set R2_BUCKET or pass --bucket")
    from upload_r2 import client

    con = sqlite3.connect(a.db)
    ensure(con, client(), a.bucket, a.dry_run, a.limit, a.workers)
    if not a.dry_run:
        con.commit()
    con.close()


if __name__ == "__main__":
    main()
