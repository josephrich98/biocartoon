#!/usr/bin/env python3
"""Rewrite the `credit` line of every catalog asset with build_assets_db.credit_line().

    python data/refresh_credits.py           # dry run (default): count changes, print a few
    python data/refresh_credits.py --apply   # back up the master DB, then update it

Only the credit text changes, built from columns the row already has; no other column and no R2
object is touched. Community uploads (source 'user') keep the credit their sidecar gave them.
Run data/publish_catalog.py afterwards so the app picks the new lines up.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import build_assets_db as B

DATA = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="write the new credit lines")
    ap.add_argument("--db", type=Path, default=DATA / "assets.sqlite")
    ap.add_argument("--show", type=int, default=5, help="changed lines to print per source")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    rows = con.execute(
        "SELECT id, source, title, author, source_url, license, license_url, extra, credit FROM assets WHERE source != 'user'"
    ).fetchall()
    changes: list[tuple[str, str]] = []
    shown: dict[str, int] = {}
    for rid, source, title, author, url, lic, lic_url, extra, old in rows:
        author_url = (json.loads(extra) if extra else {}).get("author_url")
        new = B.credit_line(title, author, source, url, lic, lic_url, author_url)
        if new == old:
            continue
        changes.append((new, rid))
        if shown.get(source, 0) < args.show:
            shown[source] = shown.get(source, 0) + 1
            print(f"{rid}\n  - {old}\n  + {new}")
    by_source: dict[str, int] = {}
    for _, rid in changes:
        by_source[rid.split("/", 1)[0]] = by_source.get(rid.split("/", 1)[0], 0) + 1
    print(f"\n{len(changes)} of {len(rows)} credit lines change: {by_source}")
    if not args.apply or not changes:
        if changes:
            print("dry run; pass --apply to write them")
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = args.db.with_name(f"{args.db.stem}.before-credits-{stamp}.sqlite")
    con.close()
    shutil.copy2(args.db, backup)
    con = sqlite3.connect(args.db)
    with con:
        con.executemany("UPDATE assets SET credit=? WHERE id=?", changes)
    print(f"updated; backup at {backup}. Run data/publish_catalog.py to publish.")


if __name__ == "__main__":
    main()
