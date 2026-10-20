"""Backups of the master data/assets.sqlite: dated gzipped snapshots in data/backups/ and the private bucket.

Every script that changes the master ends with publish_catalog.py or sync.py --apply, and both
end with backup(), so the newest R2 backup is a copy of the master as it was then.
The newest KEEP_R2_BACKUPS are kept: R2 has no object versioning, so one fixed key would let a
bad master overwrite the last good copy.
"""
from __future__ import annotations

import gzip
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from config import BACKUP_PREFIX, R2_BACKUP_BUCKET

DATA = Path(__file__).resolve().parent
KEEP_LOCAL_BACKUPS = 4
KEEP_R2_BACKUPS = 12


def local_backup(db: Path) -> Path:
    d = DATA / "backups"
    d.mkdir(exist_ok=True)
    out = d / f"assets-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.sqlite.gz"
    tmp = d / "snapshot.sqlite"
    src, dst = sqlite3.connect(db), sqlite3.connect(tmp)
    src.backup(dst)
    src.close()
    dst.close()
    with open(tmp, "rb") as f, gzip.open(out, "wb", compresslevel=6) as g:
        shutil.copyfileobj(f, g, 1 << 20)
    tmp.unlink()
    for old in sorted(d.glob("assets-*.sqlite.gz"))[:-KEEP_LOCAL_BACKUPS]:
        old.unlink()
    return out


def r2_backup(s3, snap: Path) -> str:
    """Upload a local_backup() snapshot under its dated name; prune all but the newest KEEP_R2_BACKUPS."""
    key = f"{BACKUP_PREFIX}{snap.name}"
    s3.upload_file(str(snap), R2_BACKUP_BUCKET, key)
    listed = s3.list_objects_v2(Bucket=R2_BACKUP_BUCKET, Prefix=f"{BACKUP_PREFIX}assets-")
    keys = sorted(o["Key"] for o in listed.get("Contents", []) if o["Key"].endswith(".sqlite.gz"))
    for old in keys[:-KEEP_R2_BACKUPS]:
        s3.delete_object(Bucket=R2_BACKUP_BUCKET, Key=old)
    return key


def backup(s3, db: Path) -> str:
    """Snapshot `db` locally and to the private bucket; returns the R2 key."""
    return r2_backup(s3, local_backup(db))
