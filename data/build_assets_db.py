"""Build the asset catalog (SQLite + CSV) for every downloaded illustration.

One row per asset (a BioArt colour variant, a Bioicons icon, an OpenMoji emoji, ...).
`id` doubles as the R2 object-key stem: the files live at `<id>.svg` / `<id>.png` in the bucket
(`svg_key` / `png_key` columns; NULL when that format does not exist for the asset).

    python data/build_assets_db.py                 # -> data/assets.sqlite, data/assets.csv
    python data/build_assets_db.py --no-hash       # skip sha256 (fast, ~120 GB less IO)

Rasterize SVGs first with data/rasterize.py; upload afterwards with data/upload_r2.py.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DATA = Path(__file__).resolve().parent
MIN_PNG_SIDE = 256  # shipped PNGs smaller than this (Reactome's 72px thumbnails) lose to our raster

SOURCE_NAMES = {
    "bioart": "NIAID NIH BioArt Source",
    "bioicons": "Bioicons",
    "healthicons": "Health Icons",
    "openmoji": "OpenMoji",
    "reactome": "Reactome Icon Library",
    "scidraw": "SciDraw",
    "servier": "Servier Medical Art",
}

# raw license string (lower-cased) -> (spdx-ish id, license url, attribution required, share-alike)
LICENSES = {
    "public domain": ("PD", "https://www.usa.gov/government-copyright", False, False),
    "cc0": ("CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/", False, False),
    "cc-0": ("CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/", False, False),
    "https://creativecommons.org/publicdomain/zero/1.0/": ("CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/", False, False),
    "cc-by": ("CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/", True, False),  # SciDraw (Zenodo CC BY 4.0)
    "cc by 4.0": ("CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/", True, False),
    "cc-by-4.0": ("CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/", True, False),
    "cc-by-3.0": ("CC-BY-3.0", "https://creativecommons.org/licenses/by/3.0/", True, False),
    "cc by-sa 4.0": ("CC-BY-SA-4.0", "https://creativecommons.org/licenses/by-sa/4.0/", True, True),
    "cc-by-sa-4.0": ("CC-BY-SA-4.0", "https://creativecommons.org/licenses/by-sa/4.0/", True, True),
    "cc-by-sa-3.0": ("CC-BY-SA-3.0", "https://creativecommons.org/licenses/by-sa/3.0/", True, True),
    # MIT/BSD: keep the copyright + license notice with copies
    "mit": ("MIT", "https://opensource.org/license/mit", True, False),
    "bsd": ("BSD", "https://opensource.org/license/bsd-3-clause", True, False),
}

SCHEMA = """
CREATE TABLE assets (
    id                   TEXT PRIMARY KEY,   -- R2 key stem: <source>/<slug>
    source               TEXT NOT NULL,
    source_name          TEXT NOT NULL,
    source_id            TEXT NOT NULL,      -- id in the upstream collection
    title                TEXT,
    variant              TEXT,               -- BioArt colour scheme / Health Icons style
    description          TEXT,
    category             TEXT,
    tags                 TEXT,               -- JSON array
    license              TEXT NOT NULL,      -- normalized (PD, CC0-1.0, CC-BY-4.0, ...)
    license_raw          TEXT,
    license_url          TEXT,
    attribution_required INTEGER NOT NULL,
    share_alike          INTEGER NOT NULL,
    author               TEXT,
    source_url           TEXT,               -- upstream page for the asset
    doi                  TEXT,
    credit               TEXT NOT NULL,      -- ready-to-display attribution line
    svg_key              TEXT,
    png_key              TEXT,
    png_is_raster        INTEGER,            -- 1 = PNG rendered by us from the SVG
    png_width            INTEGER,
    png_height           INTEGER,
    svg_bytes            INTEGER,
    png_bytes            INTEGER,
    svg_sha256           TEXT,
    png_sha256           TEXT,
    svg_local            TEXT,               -- path relative to data/ (for the uploader)
    png_local            TEXT,
    extra                TEXT,               -- JSON: source-specific fields
    uploaded_at          TEXT,               -- set by upload_r2.py
    stars                INTEGER NOT NULL DEFAULT 0  -- app users' stars, filled in by publish_catalog.py
);
CREATE INDEX assets_source ON assets(source);
CREATE UNIQUE INDEX assets_source_id ON assets(source, source_id);
CREATE INDEX assets_license ON assets(license);
CREATE INDEX assets_category ON assets(category);
"""
COLS = [c.split()[0] for c in SCHEMA.split("(", 1)[1].split(");")[0].strip().splitlines()
        if c.strip() and not c.strip().startswith("--")]


def clean(s: str | None) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_./-]+", "_", s).strip("_/")[:180]


def raster_path(source: str, sid: str, root: Path | None = None) -> Path:
    # must match rasterize.py
    return (root or DATA / "raster") / source / (re.sub(r"[^A-Za-z0-9_.-]+", "_", sid)[:150] + ".png")


def credit_line(title, author, source, url, lic, lic_url, author_url=None):
    """The attribution to print with a figure: title, author, source and license, with a link
    to the license wherever it asks for credit. MIT and BSD also want the copyright notice."""
    who = f" by {author}" if author and author != SOURCE_NAMES[source] else ""
    what = f'"{title}"' if title else "Illustration"
    lic_txt = {"PD": "public domain", "CC0-1.0": "CC0"}.get(lic, lic)
    if lic in ("MIT", "BSD"):
        holder = f"Copyright (c) {author}. " if author else ""
        lic_txt = f"{holder}{lic} License ({lic_url})"
    elif lic_url and license_needs_credit(lic):
        lic_txt = f"{lic_txt} ({lic_url})"
    # Bioicons has no page per icon; link the artist's page instead of the site's front page.
    return f"{what}{who}, {SOURCE_NAMES[source]} ({author_url or url}), {lic_txt}"


# BioArt captions spell the same scheme several ways ("BlackWhite", "Black & White", "BW", ...).
VARIANT_ALIASES = {"black white": "black and white", "black & white": "black and white", "bw": "black and white",
                   "greyscale": "grey"}


def license_needs_credit(lic: str) -> bool:
    return any(v[0] == lic and v[2] for v in LICENSES.values())


# ----------------------------------------------------------------------------
def iter_bioart():
    for line in open(DATA / "bioart" / "bioart.jsonl"):
        yield from bioart_items(json.loads(line), lambda fl: f"bioart/{fl['path']}" if fl.get("path") else None)


def bioart_items(r: dict, ref):
    """One BioArt entry (scrape_bioart.parse_entry) -> one item per colour variant.
    `ref(file)` gives the item's png/svg value for a file record (a path, or a URL for sync.py),
    None to treat the file as absent."""
    f = r.get("fields", {})
    groups: dict = {}
    for fl in r.get("files", []):
        if fl.get("format") in ("PNG", "SVG") and ref(fl):
            groups.setdefault(fl["groupId"], {})[fl["format"]] = fl
    for g in groups.values():
        png, svg = g.get("PNG"), g.get("SVG")
        anchor = png or svg
        cap = anchor.get("caption") or ""
        variant = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", cap.rsplit(" - ", 1)[1]).lower() if " - " in cap else None
        variant = VARIANT_ALIASES.get(variant, variant)
        yield dict(
            source="bioart", source_id=f"{r['id']}_{anchor['fileId']}", title=clean(r.get("title")),
            variant=variant, description=clean(r.get("description")), category=r.get("category"),
            tags=[k.strip() for k in (f.get("Keywords") or "").split(",") if k.strip()],
            license_raw=r.get("license") or "Public Domain", author=f.get("Creator", ""), url=r["url"],
            doi=f.get("DOI"), png=ref(png) if png else None, svg=ref(svg) if svg else None,
            extra={k: f[k] for k in ("Collection", "Credit", "Image Style", "Image Type") if f.get(k)}
            | {"accession": r.get("accession")},
        )


def iter_source(s: str):
    for line in open(DATA / "sources" / s / "items.jsonl"):
        it = json.loads(line)
        yield source_item(s, it, lambda rel: f"sources/{s}/{rel}")


def source_item(s: str, it: dict, ref) -> dict:
    """One scrape_sources.item() record -> a build item; `ref(svg_or_png)` maps its file fields."""
    desc, doi, variant = clean(it.get("description")), None, None
    m = re.search(r"10\.\d{4,9}/\S+", desc)
    if s == "scidraw" and m:
        doi, desc = m.group(0), ""
    if s == "healthicons":
        variant, desc = it["id"].split("/", 1)[0], ""
    cat, url, extra = (it.get("category") or "").strip(), it.get("url") or "", {}
    if s == "servier":  # breadcrumb scraped with nav junk: "back / A / B / See all / B / C"
        cat = " / ".join(c.strip() for c in cat.split(" See all")[0].split("/") if c.strip() and c.strip() != "back")
    if s == "bioicons":  # items.jsonl `url` is the author's homepage; bioicons has no per-icon pages
        extra["author_url"], url = url, "https://bioicons.com"
    return dict(
        source=s, source_id=it["id"], title=clean(it.get("title")) or None, variant=variant,
        description=desc, category=cat or None, tags=it.get("tags") or [],
        license_raw=it.get("license") or "", author=it.get("author") or "", url=url,
        doi=doi, png=ref(it["png"]) if it.get("png") else None,
        svg=ref(it["svg"]) if it.get("svg") else None, extra=extra,
    )


def file_info(rel: str | None, want_hash: bool):
    if not rel:
        return None, None
    p = DATA / rel
    try:
        size = p.stat().st_size
    except OSError:
        return None, None
    if not want_hash:
        return size, None
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return size, h.hexdigest()


def license_info(raw: str) -> tuple[str, str | None, bool, bool]:
    return LICENSES.get(raw.strip().lower(), (raw or "unknown", None, True, False))


def finish(it: dict, want_hash: bool, raster_root: Path | None = None):
    """`png`/`svg` are paths relative to data/ (absolute paths work too: DATA / abs == abs)."""
    from PIL import Image

    s = it["source"]
    svg = it["svg"] if it["svg"] and (DATA / it["svg"]).exists() else None
    png, is_raster, wh = None, None, (None, None)
    shipped = it["png"] if it["png"] and (DATA / it["png"]).exists() else None
    if shipped:
        try:
            with Image.open(DATA / shipped) as im:
                wh = im.size
        except Exception:  # noqa: BLE001
            shipped = None
    if shipped and (not svg or max(wh) >= MIN_PNG_SIDE):
        png, is_raster = shipped, 0
    elif svg and (rp := raster_path(s, it["source_id"], raster_root)).exists():
        png, is_raster = str(rp.relative_to(DATA) if rp.is_relative_to(DATA) else rp), 1
        try:
            with Image.open(DATA / png) as im:
                wh = im.size
        except Exception:  # noqa: BLE001
            png, is_raster, wh = None, None, (None, None)
    elif shipped:  # only a small thumbnail: still better than nothing
        png, is_raster = shipped, 0
    if not png and not svg:
        return None
    lic, lic_url, attr, sa = license_info(it["license_raw"])
    it["author"] = clean(it["author"])  # SciDraw names come with a trailing space
    svg_b, svg_h = file_info(svg, want_hash)
    png_b, png_h = file_info(png, want_hash)
    return dict(
        source=s, source_name=SOURCE_NAMES[s], source_id=it["source_id"], title=it["title"], variant=it["variant"],
        description=it["description"] or None, category=it["category"], tags=json.dumps(it["tags"], ensure_ascii=False),
        license=lic, license_raw=it["license_raw"], license_url=lic_url, attribution_required=int(attr),
        share_alike=int(sa), author=it["author"] or None, source_url=it["url"], doi=it["doi"],
        credit=credit_line(it["title"], it["author"], s, it["url"], lic, lic_url, it["extra"].get("author_url")),
        png_is_raster=is_raster, png_width=wh[0] if png else None, png_height=wh[1] if png else None,
        svg_bytes=svg_b, png_bytes=png_b, svg_sha256=svg_h, png_sha256=png_h, svg_local=svg, png_local=png,
        extra=json.dumps(it["extra"], ensure_ascii=False) if it["extra"] else None, uploaded_at=None,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=",".join(SOURCE_NAMES))
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    ap.add_argument("--csv", default=str(DATA / "assets.csv"))
    ap.add_argument("--no-hash", action="store_true")
    ap.add_argument("--threads", type=int, default=16)
    a = ap.parse_args()

    raw = []
    for s in a.sources.split(","):
        raw.extend(iter_bioart() if s == "bioart" else iter_source(s))
    print(f"{len(raw)} candidate assets", flush=True)

    with ThreadPoolExecutor(a.threads) as ex:
        rows = [r for r in ex.map(lambda it: finish(it, not a.no_hash), raw, chunksize=64) if r]

    # bioicons' icons.json lists a few icons twice (same file): keep one row per upstream file
    uniq, files = [], set()
    for r in rows:
        k = (r["source"], r["source_id"], r["svg_local"], r["png_local"])
        if k not in files:
            files.add(k)
            uniq.append(r)
    rows = uniq

    seen: set = set()
    for r in rows:
        base = f"{r['source']}/{slug(r['source_id'])}"
        rid, k = base, 1
        while rid in seen:
            k += 1
            rid = f"{base}-{k}"
        seen.add(rid)
        r["id"] = rid
        r["svg_key"] = f"{rid}.svg" if r["svg_local"] else None
        r["png_key"] = f"{rid}.png" if r["png_local"] else None

    db = Path(a.db)
    tmp = db.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    # keep upload state (and star counts) from a previous build so re-building does not force a re-upload
    prev, stars = {}, {}
    if db.exists():
        con.execute("ATTACH ? AS old", (str(db),))
        prev = dict(con.execute("SELECT id, uploaded_at FROM old.assets WHERE uploaded_at IS NOT NULL"))
        if any(c[1] == "stars" for c in con.execute("PRAGMA old.table_info(assets)")):
            stars = dict(con.execute("SELECT id, stars FROM old.assets WHERE stars > 0"))
        con.execute("DETACH old")
    for r in rows:
        r["uploaded_at"] = prev.get(r["id"])
        r["stars"] = stars.get(r["id"], 0)
    con.executemany(f"INSERT INTO assets ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})",
                    ([r[c] for c in COLS] for r in rows))
    con.commit()
    con.close()
    tmp.replace(db)

    with open(a.csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(COLS)
        w.writerows([r[c] for c in COLS] for r in rows)

    per: dict = {}
    for r in rows:
        d = per.setdefault(r["source"], [0, 0, 0])
        d[0] += 1
        d[1] += bool(r["svg_local"])
        d[2] += bool(r["png_local"])
    print(f"{len(rows)} assets -> {db}, {a.csv}")
    for s, (n, sv, pn) in per.items():
        print(f"  {s:12s} {n:7d} assets  {sv:7d} svg  {pn:7d} png")


if __name__ == "__main__":
    sys.exit(main())
