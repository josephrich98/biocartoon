#!/usr/bin/env python3
"""Name the colour layers of every catalog SVG with Claude, into layers.json.

The editor's Layers panel recolours or fades one part of a drawing at a time. Without a name from
layers.json a part is labelled by its colour (#F49DC0); this gives each one a name for what it is
in the picture ("Liquid", "Glass").

    python data/name_layers.py --sources bioart --limit 20     # try a few
    python data/name_layers.py                                 # every SVG not yet named
    python data/name_layers.py --dry-run                       # prepare and count, ask nothing

For each asset with two or more colours the app's own renderer (biocartoon-app's `layer_sheets`
bin, so the colours are exactly the ones the panel offers) draws the picture and, per layer, the
picture with that layer in magenta and the rest faded. Claude sees them with the asset's title and
names each layer; layers given the same name become one layer. Claude is asked through Claude Code
(`claude -p`, signed in as you, so it counts against your Claude plan; no API key), several assets
at a time. Names are written into layers.json as they come, and assets already there are left
alone (hand-named ones included) unless --redo, so a run stopped by hand or by the plan's usage
limit picks up where it was when re-run.

Downloaded SVGs and renders are kept in data/.layers-work/. Re-run publish_catalog.py afterwards to
ship the names.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from build_assets_db import LAYERS_FILE
from config import UA

DATA = Path(__file__).resolve().parent
WORK = DATA / ".layers-work"
APP = Path(os.environ.get("BIOCARTOON_APP", DATA.parent.parent / "biocartoon-app")) / "app"
ASSET_URL = os.environ.get("BIOCARTOON_ASSET_URL", "https://assets.biocartoon.com")
MAX_NAME = 40

SYSTEM = """You name the parts of scientific illustrations for an illustration editor. The editor \
splits a drawing into colour layers (every shape painted in one colour) so a user can recolour or \
hide one part at a time, and lists them by the names you give.

You are shown the drawing, then each layer: the drawing with that layer highlighted in bright \
magenta (or green) and everything else faded. Name each layer for what it is in the picture, as a \
biologist would: "Cell membrane", "Nucleus", "Liquid", "Glass", "Fur", "Outline", "Shadow", \
"Highlights". Use 1-3 words, sentence case, no colour words unless the layer is purely decorative \
and has no better name. Give two layers the same name when they are the same part (for example the \
glass of a flask drawn in two greys); they will be joined into one."""

SCHEMA = {
    "type": "object",
    "properties": {
        "layers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"layer": {"type": "integer"}, "name": {"type": "string"}},
                "required": ["layer", "name"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["layers"],
    "additionalProperties": False,
}


def load_json(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def candidates(db: Path, sources: list[str] | None, ids: list[str] | None, skip: set[str]) -> list[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT id, source, svg_key, title, variant, category, tags, description FROM assets "
                       "WHERE svg_key IS NOT NULL ORDER BY id").fetchall()
    con.close()
    return [dict(r) for r in rows
            if (not sources or r["source"] in sources) and (not ids or r["id"] in ids) and r["id"] not in skip]


def download(rows: list[dict], threads: int) -> None:
    s = requests.Session()
    s.headers["User-Agent"] = UA

    def one(r):
        path = WORK / "svg" / r["svg_key"]
        if path.exists():
            return
        try:
            resp = s.get(f"{ASSET_URL}/{r['svg_key']}", timeout=60)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"  {r['id']}: {e}", file=sys.stderr)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(resp.content)

    with ThreadPoolExecutor(threads) as ex:
        list(ex.map(one, rows))


def render() -> None:
    """Run biocartoon-app's layer_sheets over the downloaded SVGs (it skips what is done)."""
    cmd = ["cargo", "run", "--release", "--quiet", "--manifest-path", str(APP / "Cargo.toml"),
           "--bin", "layer_sheets", "--", str(WORK / "svg"), str(WORK / "sheets")]
    subprocess.run(cmd, check=True)


def image(path: Path) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.b64encode(path.read_bytes()).decode()}}


def content(r: dict, colors: list[str]) -> list[dict]:
    """The message Claude gets for asset `r`: what it is, the drawing, then each layer."""
    sheets = WORK / "sheets" / r["id"]
    about = [f"Title: {r['title']}"]
    if r["variant"]:
        about.append(f"Variant: {r['variant']}")
    if r["category"]:
        about.append(f"Category: {r['category']}")
    tags = json.loads(r["tags"] or "[]")
    if tags:
        about.append(f"Tags: {', '.join(tags)}")
    if r["description"]:
        about.append(f"Description: {r['description'][:500]}")
    out = [{"type": "text", "text": "\n".join(about) + "\n\nThe drawing:"}, image(sheets / "drawing.png")]
    for i, c in enumerate(colors, 1):
        out += [{"type": "text", "text": f"Layer {i} ({c}):"}, image(sheets / f"layer-{i}.png")]
    out.append({"type": "text", "text": f"Name layers 1 to {len(colors)}."})
    return out


class UsageLimit(Exception):
    pass


def ask(r: dict, colors: list[str], model: str | None, effort: str) -> dict | None:
    """Claude's reply for asset `r`, through Claude Code (`claude -p`, signed in as you), or None."""
    cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
           "--tools", "", "--no-session-persistence", "--effort", effort,
           "--system-prompt", SYSTEM, "--json-schema", json.dumps(SCHEMA)]
    if model:
        cmd += ["--model", model]
    msg = json.dumps({"type": "user", "message": {"role": "user", "content": content(r, colors)}})
    # Its own process group, so a call that hangs is killed with everything it started.
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(msg + "\n", timeout=300)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        print(f"  {r['id']}: timed out", file=sys.stderr)
        return None
    out = subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    lines = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{")]
    last = next((l for l in reversed(lines) if l.get("type") == "result"), None)
    if not last or last.get("is_error") or last.get("subtype") != "success":
        text = json.dumps(last) if last else out.stderr
        if re.search(r"usage limit|rate limit|limit reached|429", text, re.I):
            raise UsageLimit(text[:300])
        print(f"  {r['id']}: {text[:200]}", file=sys.stderr)
        return None
    return last.get("structured_output")


def layers_from(reply: dict, colors: list[str]) -> list[dict] | None:
    """The reply's names as layers.json entries, layers with one name joined; None if any is missing."""
    names = {}
    for la in reply.get("layers", []):
        name = re.sub(r"\s+", " ", str(la.get("name", ""))).strip()[:MAX_NAME]
        if name and isinstance(la.get("layer"), int) and 1 <= la["layer"] <= len(colors):
            names[la["layer"]] = name[0].upper() + name[1:]
    if len(names) != len(colors):
        return None
    out: dict[str, dict] = {}
    for i, c in enumerate(colors, 1):
        out.setdefault(names[i].lower(), {"name": names[i], "colors": []})["colors"].append(c)
    return list(out.values())


def write_layers(named: dict[str, list[dict]]) -> None:
    """layers.json with `named` added, one asset per block and one layer per line as by hand."""
    cur = load_json(LAYERS_FILE, {})
    cur.update(named)
    keys = [k for k in cur if k.startswith("_")] + sorted(k for k in cur if not k.startswith("_"))
    blocks = []
    for k in keys:
        v = cur[k]
        if isinstance(v, list):
            inner = ",\n".join(f"    {json.dumps(la, ensure_ascii=False)}" for la in v)
            blocks.append(f"  {json.dumps(k)}: [\n{inner}\n  ]")
        else:
            blocks.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}")
    LAYERS_FILE.write_text("{\n" + ",\n".join(blocks) + "\n}\n")


def name_all(rows: list[dict], model: str | None, effort: str, workers: int) -> None:
    """Ask about every asset in `rows`, writing names into layers.json every few answers."""
    named, failed, lock = {}, [], threading.Lock()
    done = 0

    def one(r):
        nonlocal done
        colors = load_json(WORK / "sheets" / r["id"] / "meta.json", {}).get("colors", [])
        reply = ask(r, colors, model, effort)
        layers = layers_from(reply, colors) if reply else None
        with lock:
            done += 1
            (named.__setitem__(r["id"], layers) if layers else failed.append(r["id"]))
            if len(named) >= 20:
                write_layers(named)
                named.clear()
            if done % 50 == 0:
                print(f"  {done}/{len(rows)}", flush=True)

    try:
        with ThreadPoolExecutor(workers) as ex:
            for f in [ex.submit(one, r) for r in rows]:
                f.result()
    except UsageLimit as e:
        print(f"Claude usage limit reached ({e}); re-run later to continue.", file=sys.stderr)
        ex.shutdown(cancel_futures=True)
    finally:
        with lock:
            write_layers(named)
    print(f"{done - len(failed)} named, {len(failed)} failed"
          + (f" ({', '.join(failed[:5])}{', ...' if len(failed) > 5 else ''}); re-run to retry" if failed else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    ap.add_argument("--sources", help="comma-separated, e.g. bioart,bioicons (default: all)")
    ap.add_argument("--ids", help="comma-separated asset ids")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--model", help="Claude Code's model alias or id (default: Claude Code's own)")
    ap.add_argument("--effort", default="low", help="Claude Code's effort level")
    ap.add_argument("--workers", type=int, default=2, help="assets asked about at once")
    ap.add_argument("--redo", action="store_true", help="name assets layers.json already has too")
    ap.add_argument("--dry-run", action="store_true", help="download and render, ask nothing")
    ap.add_argument("--threads", type=int, default=16, help="downloads at once")
    a = ap.parse_args()

    WORK.mkdir(exist_ok=True)
    skip = set() if a.redo else {k for k in load_json(LAYERS_FILE, {}) if not k.startswith("_")}
    rows = candidates(Path(a.db), a.sources and a.sources.split(","), a.ids and a.ids.split(","), skip)
    rows = rows[: a.limit] if a.limit else rows
    print(f"{len(rows)} assets to name", flush=True)
    download(rows, a.threads)
    render()

    rows = [r for r in rows if len(load_json(WORK / "sheets" / r["id"] / "meta.json", {}).get("colors", [])) >= 2]
    print(f"{len(rows)} have two or more colour layers", flush=True)
    if a.dry_run:
        return
    name_all(rows, a.model, a.effort, a.workers)


if __name__ == "__main__":
    main()
