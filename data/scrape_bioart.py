#!/usr/bin/env python3
"""Scrape the NIH NIAID BioArt Source (https://bioart.niaid.nih.gov).

The site is a Next.js app. Each entry page /bioart/<id> server-renders its full
metadata in the React Server Components payload (self.__next_f.push([1, "..."]))
and lists every downloadable file id. Files are served from
/api/bioarts/<id>/files/<fileId>.

License (bioart.niaid.nih.gov/terms): "free for any use, including educational,
research, informational, and commercial purposes". Per-entry license is either
Public Domain or CC-BY; we record it per entry.

Output layout (under --out):
  meta/<id>.json          one record per entry
  files/<id>/<fileId>.<ext>
  bioart.jsonl            all records, one per line (written at the end)
  failed.txt              ids that returned non-200 (for retry / range check)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import sys
import time
from pathlib import Path

import requests

from config import BIOART_UA as UA

BASE = "https://bioart.niaid.nih.gov"
PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
TAG_RE = re.compile(r"<[^>]+>")

session = requests.Session()
session.headers["User-Agent"] = UA


# ----------------------------------------------------------------------------
# RSC payload parsing
# ----------------------------------------------------------------------------
def rsc_blob(html: str) -> str:
    return "".join(json.loads('"' + p + '"') for p in PUSH_RE.findall(html))


ROW_HEAD_RE = re.compile(rb"([0-9a-f]+):")


def rsc_rows(blob: str) -> tuple[dict, dict]:
    """Split the flight payload into rows.

    Rows are `id:<json>\\n`, except text rows `id:T<hexlen>,<raw bytes>` which carry long strings
    (e.g. description HTML with newlines) with NO trailing newline — so this must walk by bytes.
    Returns (json_rows, text_rows); JSON trees refer to text rows as the string "$<id>".
    """
    data = blob.encode("utf-8")
    pos, json_rows, text_rows = 0, {}, {}
    while pos < len(data):
        m = ROW_HEAD_RE.match(data, pos)
        if not m:  # garbage; skip to next line
            nl = data.find(b"\n", pos)
            pos = len(data) if nl < 0 else nl + 1
            continue
        rid = m.group(1).decode()
        pos = m.end()
        if data[pos : pos + 1] == b"T":
            comma = data.index(b",", pos)
            n = int(data[pos + 1 : comma], 16)
            text_rows[rid] = data[comma + 1 : comma + 1 + n].decode("utf-8", "replace")
            pos = comma + 1 + n
            continue
        nl = data.find(b"\n", pos)
        payload = data[pos:] if nl < 0 else data[pos:nl]
        pos = len(data) if nl < 0 else nl + 1
        if payload[:1] in (b"[", b"{", b'"'):  # skip module refs like I[...], HL[...]
            try:
                json_rows[rid] = json.loads(payload)
            except json.JSONDecodeError:
                pass
    return json_rows, text_rows


def rsc_lines(blob: str):
    """Yield (row_id, parsed_json) for each JSON row."""
    json_rows, _ = rsc_rows(blob)
    yield from json_rows.items()


def walk(node):
    """Depth-first over every list/dict in the React element tree."""
    yield node
    if isinstance(node, list):
        for c in node:
            yield from walk(c)
    elif isinstance(node, dict):
        for c in node.values():
            yield from walk(c)


def is_el(node, want_props=None):
    """React element encoding: ["$", type, key, props]."""
    return (
        isinstance(node, list)
        and len(node) == 4
        and node[0] == "$"
        and isinstance(node[3], dict)
    )


def text_of(children) -> str:
    if isinstance(children, str):
        return children
    if isinstance(children, (int, float)):
        return str(children)
    if is_el(children):  # must precede the generic list case: elements are lists
        return text_of(children[3].get("children"))
    if isinstance(children, list):
        return "".join(text_of(c) for c in children)
    return ""


def parse_entry(bioart_id: int, html: str) -> dict:
    blob = rsc_blob(html)
    rec: dict = {
        "id": bioart_id,
        "accession": f"BIOART-{bioart_id:06d}",
        "url": f"{BASE}/bioart/{bioart_id}",
        "title": None,
        "description_html": None,
        "description": None,
        "license": None,
        "category": None,
        "fields": {},  # Keywords, Collection, Creator, Credit, Image Type, ... + ontology groups
        "dates": {},
        "carousel": [],
        "file_groups": {},  # groupId -> {fmt: fileId}
        "files": [],  # flattened: fileId, groupId, fmt, name?, caption?
    }

    json_rows, text_rows = rsc_rows(blob)

    def deref(v):
        """'$2b' -> contents of text row 2b (long strings are hoisted out of the tree)."""
        if isinstance(v, str) and v.startswith("$") and v[1:] in text_rows:
            return text_rows[v[1:]]
        return v

    for _, node in json_rows.items():
        for n in walk(node):
            if not is_el(n):
                continue
            props = n[3]

            # Title: Typography variant h4
            if props.get("variant") == "h4" and isinstance(deref(props.get("children")), str):
                rec["title"] = rec["title"] or deref(props["children"])

            # Description: dangerouslySetInnerHTML (long ones are hoisted to a text row)
            dsi = props.get("dangerouslySetInnerHTML")
            if isinstance(dsi, dict) and "__html" in dsi:
                rec["description_html"] = deref(dsi["__html"])

            # Carousel items (display PNGs with captions)
            if isinstance(props.get("carouselItems"), list):
                rec["carousel"] = props["carouselItems"]

            # Download file mapping groupId -> {fmt: fileId}
            if isinstance(props.get("filemapping"), dict):
                rec["file_groups"] = props["filemapping"]

            ch = props.get("children")

            # "Licensing: " <Link>Public Domain</Link>  (label may use nbsp)
            if (
                isinstance(ch, list)
                and ch
                and isinstance(ch[0], str)
                and ch[0].strip().startswith("Licensing")
            ):
                rec["license"] = text_of(ch[1:]).strip()

            # ["Creation Date: ", "9/26/2024"]
            if (
                isinstance(ch, list)
                and len(ch) == 2
                and isinstance(ch[0], str)
                and ch[0].endswith("Date: ")
            ):
                rec["dates"][ch[0].rstrip(": ")] = ch[1]

            # Label/value pairs: two Typography children, first uppercase-styled label
            if isinstance(ch, list) and len(ch) == 2 and is_el(ch[0]) and is_el(ch[1]):
                p0, p1 = ch[0][3], ch[1][3]
                sx0 = p0.get("sx") or {}
                if (
                    sx0.get("textTransform") == "uppercase"
                    and isinstance(p0.get("children"), str)
                ):
                    rec["fields"][p0["children"]] = text_of(deref(p1.get("children"))).strip()
                elif p0.get("children") == "Category:":
                    rec["category"] = text_of(p1.get("children")).strip()

    if rec["description_html"]:
        rec["description"] = re.sub(r"\s+", " ", TAG_RE.sub(" ", rec["description_html"])).strip()

    # Flatten files
    cap_by_file = {c["fileId"]: c for c in rec["carousel"] if isinstance(c, dict)}
    for gid, fmts in rec["file_groups"].items():
        png = cap_by_file.get(fmts.get("PNG"))
        for fmt, fid in fmts.items():
            rec["files"].append(
                {
                    "fileId": fid,
                    "groupId": int(gid),
                    "format": fmt,
                    "caption": png["caption"] if png else None,
                    "png_name": png["name"] if png else None,
                    "url": f"{BASE}/api/bioarts/{bioart_id}/files/{fid}",
                }
            )
    return rec


# ----------------------------------------------------------------------------
# Network
# ----------------------------------------------------------------------------
def get(url: str, retries: int = 4, **kw) -> requests.Response | None:
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=60, **kw)
            if r.status_code == 200:
                return r
            if r.status_code in (404, 500):
                return r  # definitive for this site
        except requests.RequestException:
            pass
        time.sleep(1.5 * (attempt + 1))
    return None


EXT_BY_FMT = {"PNG": "png", "SVG": "svg", "AI": "ai", "EPS": "eps", "JPG": "jpg", "JPEG": "jpg"}


def download_file(f: dict, dest_dir: Path, formats: set[str]) -> str | None:
    if f["format"] not in formats:
        return None
    ext = EXT_BY_FMT.get(f["format"], f["format"].lower())
    dest = dest_dir / f"{f['fileId']}.{ext}"
    if dest.exists() and dest.stat().st_size > 0:
        return str(dest)
    r = get(f["url"], stream=True)
    if r is None or r.status_code != 200:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with open(tmp, "wb") as fh:
        for chunk in r.iter_content(1 << 16):
            fh.write(chunk)
    tmp.rename(dest)
    # keep server filename if provided (useful for the AI/EPS variants)
    cd = r.headers.get("Content-Disposition", "")
    m = re.search(r'filename="?([^";]+)"?', cd)
    if m:
        f["server_name"] = m.group(1)
    return str(dest)


def scrape_one(bioart_id: int, out: Path, formats: set[str], skip_files: bool) -> tuple[int, str]:
    meta_path = out / "meta" / f"{bioart_id}.json"
    if meta_path.exists():
        rec = json.loads(meta_path.read_text())
    else:
        r = get(f"{BASE}/bioart/{bioart_id}")
        if r is None:
            return bioart_id, "net"
        if r.status_code != 200:
            return bioart_id, str(r.status_code)
        rec = parse_entry(bioart_id, r.text)
        if not rec["title"]:
            return bioart_id, "noparse"
    if not skip_files:
        dest_dir = out / "files" / str(bioart_id)
        for f in rec["files"]:
            p = download_file(f, dest_dir, formats)
            if p:
                f["path"] = str(Path(p).relative_to(out))
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(rec, indent=1, ensure_ascii=False))
    return bioart_id, "ok"


def discover(known_ids: set[int], stop_after: int = 25, workers: int = 4) -> list[dict]:
    """For data/sync.py: entries above the highest known id, probed in order until `stop_after`
    consecutive ids don't answer 200. Metadata only; each file record carries its `url`."""
    recs, bad, nxt = [], 0, max(known_ids, default=0) + 1
    with cf.ThreadPoolExecutor(workers) as ex:
        while bad < stop_after:
            batch = list(range(nxt, nxt + workers * 2))
            nxt += len(batch)
            for bid, r in zip(batch, ex.map(lambda b: get(f"{BASE}/bioart/{b}"), batch)):
                if r is None:
                    raise RuntimeError(f"bioart {bid}: network error")
                rec = parse_entry(bid, r.text) if r.status_code == 200 else None
                if rec and rec["title"]:
                    recs.append(rec)
                    bad = 0
                else:
                    bad += 1
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent / "bioart"))
    ap.add_argument("--start", type=int, default=1)
    ap.add_argument("--end", type=int, default=1500, help="inclusive upper id to try")
    ap.add_argument("--stop-after", type=int, default=150, help="stop after N consecutive non-200 ids")
    ap.add_argument("--formats", default="PNG,SVG,AI,EPS", help="comma list of formats to download")
    ap.add_argument("--skip-files", action="store_true", help="metadata only")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--ids", default=None, help="comma list of specific ids (overrides range)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    formats = {f.strip().upper() for f in args.formats.split(",") if f.strip()}

    ids = [int(x) for x in args.ids.split(",")] if args.ids else list(range(args.start, args.end + 1))
    failed, ok = [], 0
    consecutive_bad = 0
    t0 = time.time()
    # Submit in order in small windows so the stop-after heuristic works.
    with cf.ThreadPoolExecutor(args.workers) as ex:
        window = args.workers * 4
        for i in range(0, len(ids), window):
            batch = ids[i : i + window]
            results = list(ex.map(lambda b: scrape_one(b, out, formats, args.skip_files), batch))
            for bid, status in results:
                if status == "ok":
                    ok += 1
                    consecutive_bad = 0
                else:
                    failed.append((bid, status))
                    consecutive_bad += 1
            print(
                f"[{time.time()-t0:6.0f}s] ids {batch[0]}-{batch[-1]}  ok={ok}  "
                f"bad={len(failed)}  streak_bad={consecutive_bad}",
                flush=True,
            )
            if not args.ids and consecutive_bad >= args.stop_after:
                print(f"stopping: {consecutive_bad} consecutive non-200 ids", flush=True)
                break

    (out / "failed.txt").write_text("\n".join(f"{b}\t{s}" for b, s in failed))
    # consolidated jsonl
    recs = []
    for p in sorted((out / "meta").glob("*.json"), key=lambda p: int(p.stem)):
        recs.append(json.loads(p.read_text()))
    with open(out / "bioart.jsonl", "w") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    n_files = sum(1 for r in recs for f in r["files"] if f.get("path"))
    print(f"done: {len(recs)} entries, {n_files} files, {len(failed)} failed ids -> {out}")


if __name__ == "__main__":
    main()
