"""Upload every asset in data/assets.sqlite to a Cloudflare R2 bucket (resumable).

Each row's files go to `svg_key` / `png_key` (= `<id>.svg` / `<id>.png`). Rows are marked with
`uploaded_at` once all their files are in the bucket, so re-running only sends what is missing.

    pip install boto3
    export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...   # bucket: config.R2_BUCKET
    python data/upload_r2.py --limit 20        # smoke test
    python data/upload_r2.py                   # everything (~200k assets, ~130 GB)
    python data/upload_r2.py --sources bioart,servier
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from config import R2_BUCKET

DATA = Path(__file__).resolve().parent
CONTENT_TYPES = {".svg": "image/svg+xml", ".png": "image/png"}


def credential(name: str) -> str:
    """$name, else the macOS Keychain item service=<BRAND>-r2, account=name (what the scheduled
    sync uses: security add-generic-password -s <BRAND>-r2 -a R2_ACCESS_KEY_ID -w)."""
    if os.environ.get(name):
        return os.environ[name]
    import subprocess

    from config import BRAND

    r = subprocess.run(["security", "find-generic-password", "-s", f"{BRAND}-r2", "-a", name, "-w"],
                       capture_output=True, text=True)
    if r.returncode or not r.stdout.strip():
        sys.exit(f"{name} is not set (env, or Keychain service {BRAND}-r2)")
    return r.stdout.strip()


def client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=f"https://{credential('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
        aws_access_key_id=credential("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=credential("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(retries={"max_attempts": 8, "mode": "adaptive"}, max_pool_connections=64),
    )


def upload_row(s3, bucket, row):
    for key, local, sha in ((row["svg_key"], row["svg_local"], row["svg_sha256"]),
                            (row["png_key"], row["png_local"], row["png_sha256"])):
        if not key:
            continue
        meta = {"asset-id": row["id"], "license": row["license"]}
        if sha:
            meta["sha256"] = sha
        s3.upload_file(str(DATA / local), bucket, key, ExtraArgs={
            "ContentType": CONTENT_TYPES[Path(key).suffix],
            "CacheControl": "public, max-age=31536000, immutable",
            "Metadata": meta,
        })
    return row["id"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    ap.add_argument("--bucket", default=R2_BUCKET)
    ap.add_argument("--sources", default=None, help="comma list; default all")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()
    if not a.bucket:
        sys.exit("set R2_BUCKET or pass --bucket")

    con = sqlite3.connect(a.db)
    con.row_factory = sqlite3.Row
    q, args = "SELECT * FROM assets WHERE uploaded_at IS NULL", []
    if a.sources:
        srcs = a.sources.split(",")
        q += f" AND source IN ({','.join('?' * len(srcs))})"
        args += srcs
    if a.limit:
        q += f" LIMIT {int(a.limit)}"
    rows = con.execute(q, args).fetchall()
    print(f"{len(rows)} assets to upload -> r2://{a.bucket}", flush=True)

    s3 = client()  # boto3 clients are thread-safe
    done, failed, t0 = 0, 0, time.time()
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(upload_row, s3, a.bucket, r): r["id"] for r in rows}
        for f in as_completed(futs):
            try:
                rid = f.result()
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"  FAIL {futs[f]}: {e}", file=sys.stderr, flush=True)
                continue
            con.execute("UPDATE assets SET uploaded_at=?, svg_local=NULL, png_local=NULL WHERE id=?",
                        (datetime.now(timezone.utc).isoformat(timespec="seconds"), rid))
            done += 1
            if done % 1000 == 0:
                con.commit()
                print(f"  {done}/{len(rows)}  {done / (time.time() - t0):.0f}/s  failed={failed}", flush=True)
    con.commit()
    print(f"uploaded {done}, failed {failed}")


if __name__ == "__main__":
    main()
