"""Every product-name-dependent setting for the data pipeline, in one place.

Renaming the product only needs this file, or just the
environment: `BRAND=newname` changes the default bucket, backup bucket, Worker URL and
User-Agents together; each can also be overridden on its own. R2 object keys
(`<source>/<slug>.png`, `catalog/...`) never contain the brand, so a rename moves no data.
"""
from __future__ import annotations

import os

BRAND = os.environ.get("BRAND", "biocartoon")

# Public bucket: asset files + catalog/. The app reads it through the public R2 domain.
R2_BUCKET = os.environ.get("R2_BUCKET", BRAND)
# Private bucket for the master assets.sqlite backup (sync.py), under BACKUP_PREFIX.
R2_BACKUP_BUCKET = os.environ.get("R2_BACKUP_BUCKET", f"{BRAND}-pending")
BACKUP_PREFIX = "internal/"

# The deployed submit Worker (worker/src/submit.ts); keep in step with DEFAULT_SUBMIT_URL in
# biocartoon-app: app/src/submit.rs. BIOCARTOON_SUBMIT_URL is the older name of SUBMIT_URL.
SUBMIT_URL = (os.environ.get("SUBMIT_URL") or os.environ.get("BIOCARTOON_SUBMIT_URL")
              or f"https://api.{BRAND}.com")

UA = f"{BRAND}-scraper/0.1 (open-source research)"
BIOART_UA = f"{BRAND}-bioart-scraper/0.1 (open-source research; contact via GitHub)"
PUBLISH_UA = f"{BRAND}-publish"
