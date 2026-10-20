#!/usr/bin/env python3
"""Rasterize the SVGs of every scraped collection that has no big-enough shipped PNG.

    python data/rasterize.py [--sources bioicons,servier,...] [--limit N] [--procs 32]

Inputs : data/sources/<source>/items.jsonl
Outputs: data/raster/<source>/<id>.png     (max side RASTER_MAX, RGBA), read by build_assets_db.py
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import re
import signal
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent
RASTER_MAX = 1024
MIN_PNG_SIDE = 384   # a shipped PNG smaller than this loses to rasterizing the SVG
RENDER_TIMEOUT = 15  # seconds per SVG (a 1024px icon renders in <1 s; slow ones are pathological)

# BioArt ships PNGs only, so it never needs rasterizing
SOURCES = ["bioicons", "healthicons", "openmoji", "reactome", "scidraw", "servier"]


# ----------------------------------------------------------------------------
# rasterization (worker process)
# ----------------------------------------------------------------------------
_SIZE_RE = re.compile(r'<svg[^>]*?\s(width|height|viewBox)\s*=\s*"([^"]+)"', re.I | re.S)


def _svg_dims(txt: str):
    head = txt[:4000]
    m = re.search(r"<svg\b[^>]*>", head, re.I | re.S)
    if not m:
        return None
    tag = m.group(0)
    attrs = dict(re.findall(r'\b(width|height|viewBox)\s*=\s*"([^"]+)"', tag, re.I))
    attrs = {k.lower(): v for k, v in attrs.items()}

    def num(v):
        m = re.match(r"\s*([0-9.]+)\s*(px|pt|mm|cm|in)?", v or "")
        if not m:
            return None
        x = float(m.group(1))
        return x * {"pt": 1.333, "mm": 3.78, "cm": 37.8, "in": 96}.get(m.group(2), 1)

    w, h = num(attrs.get("width")), num(attrs.get("height"))
    if (not w or not h) and "viewbox" in attrs:
        vb = re.split(r"[\s,]+", attrs["viewbox"].strip())
        if len(vb) == 4:
            try:
                w, h = w or float(vb[2]), h or float(vb[3])
            except ValueError:
                pass
    return (w, h) if w and h else None


def _alarm(signum, frame):
    raise TimeoutError("render timeout")


def render_one(args):
    """Pool worker; must never raise (one escaped exception kills the whole imap)."""
    try:
        return _render_one(args)
    except Exception as e:  # noqa: BLE001  e.g. SIGALRM fired while another exception was being handled
        signal.alarm(0)
        try:
            Path(args[1]).with_suffix(".fail").write_text(f"late:{type(e).__name__}")
        except OSError:
            pass
        return None, f"late:{type(e).__name__}"


def _render_one(args):
    # (svg, png), or (svg, png, unsafe): data/uploads.py passes unsafe=False for contributors' files
    src_path, out_path, unsafe = args if len(args) == 3 else (*args, True)
    out_path = Path(out_path)
    if out_path.exists():
        return str(out_path), "cached"
    fail_marker = out_path.with_suffix(".fail")  # remembered failure: never retried
    if fail_marker.exists():
        return None, "failed_before"
    import cairosvg
    from PIL import Image

    # mark as started first: a render that hangs inside cairo's C code ignores SIGALRM, gets the
    # pool terminated by main()'s stall detector, and must not be retried next time
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fail_marker.write_text("started")
    sys.setrecursionlimit(50000)  # cairosvg recurses per nested <g>; old Inkscape files go deep
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(RENDER_TIMEOUT)
    status = "ok"
    try:
        txt = Path(src_path).read_text(encoding="utf-8", errors="replace")
        dims = _svg_dims(txt)
        # always give cairosvg an explicit output size so a 20000px-wide nominal canvas can't
        # render at native size; the other side scales proportionally
        if dims and dims[1] > dims[0]:
            kw = {"output_height": RASTER_MAX}
        else:
            kw = {"output_width": RASTER_MAX}
        # unsafe=True: allow DOCTYPE entities (common in old Inkscape files); it also
        # lets the file read local files and URLs, so untrusted SVGs are rendered without it
        png = cairosvg.svg2png(bytestring=txt.encode("utf-8"), unsafe=unsafe, **kw)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        im = Image.open(__import__("io").BytesIO(png)).convert("RGBA")
        if max(im.size) > RASTER_MAX * 1.05 or max(im.size) < 64:
            s = RASTER_MAX / max(im.size)
            im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
        if im.getbbox() is None:  # fully transparent
            status = "blank"
            return None, status
        im.save(out_path)
        fail_marker.unlink(missing_ok=True)
        return str(out_path), "ok"
    except TimeoutError:
        status = "timeout"
        return None, status
    except Exception as e:  # noqa: BLE001
        status = f"err:{type(e).__name__}"
        return None, status
    finally:
        signal.alarm(0)
        if status != "ok":
            try:
                fail_marker.parent.mkdir(parents=True, exist_ok=True)
                fail_marker.write_text(status)
            except OSError:
                pass


# ----------------------------------------------------------------------------
def load_items(sources: list[str], limit: int | None):
    items = []
    for s in sources:
        p = DATA / "sources" / s / "items.jsonl"
        if not p.exists():
            print(f"skip {s}: no items.jsonl", file=sys.stderr)
            continue
        for line in open(p):
            it = json.loads(line)
            if it.get("png"):
                it["png"] = str(Path("sources") / s / it["png"])
            if it.get("svg"):
                it["svg"] = str(Path("sources") / s / it["svg"])
            items.append(it)
    if limit:
        # take `limit` per source so small sources still show up in smoke tests
        by = {}
        for it in items:
            by.setdefault(it["source"], []).append(it)
        items = [it for v in by.values() for it in v[:limit]]
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=",".join(SOURCES))
    ap.add_argument("--limit", type=int, default=None, help="per-source cap (smoke tests)")
    ap.add_argument("--procs", type=int, default=max(4, mp.cpu_count() - 2))
    a = ap.parse_args()
    sources = [s.strip() for s in a.sources.split(",") if s.strip()]
    items = load_items(sources, a.limit)
    print(f"{len(items)} items from {len(sources)} sources", flush=True)

    # decide the image for each item: a shipped PNG wins if it is big enough (BioArt, Servier,
    # OpenMoji; Reactome's PNGs are 72px thumbnails), otherwise rasterize the SVG
    from PIL import Image

    def png_ok(rel):
        try:
            with Image.open(DATA / rel) as im:
                return max(im.size) >= MIN_PNG_SIDE
        except Exception:  # noqa: BLE001
            return False

    jobs = []
    for it in items:
        if it.get("png") and (DATA / it["png"]).exists() and (not it.get("svg") or png_ok(it["png"])):
            continue
        if it.get("svg") and (DATA / it["svg"]).exists():
            safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", it["id"])[:150]
            jobs.append((str(DATA / it["svg"]), str(DATA / "raster" / it["source"] / (safe + ".png"))))
    todo = [j for j in jobs if not Path(j[1]).exists()]
    print(f"{len(jobs)} SVGs to rasterize ({len(todo)} not cached) with {a.procs} procs", flush=True)
    stats = {}
    if todo:
        pool = mp.Pool(a.procs, maxtasksperchild=200)
        # chunksize must stay 1: only then is the result an IMapUnorderedIterator with next(timeout)
        it = pool.imap_unordered(render_one, todo)
        k = 0
        try:
            while True:
                try:
                    _, st = it.next(timeout=max(120, 4 * RENDER_TIMEOUT))
                except mp.TimeoutError:
                    # every live worker is stuck in cairo (SIGALRM can't interrupt C code); those
                    # files already carry a "started" marker and will be skipped on the next run
                    print(f"  pool stalled after {k} results; terminating", flush=True)
                    pool.terminate()
                    break
                except StopIteration:
                    pool.close()
                    break
                stats[st] = stats.get(st, 0) + 1
                k += 1
                if k % 2000 == 0:
                    print(f"  {k}/{len(todo)} {stats}", flush=True)
        except BaseException:
            pool.terminate()
            raise
        finally:
            pool.join()
    print("raster stats:", stats, flush=True)


if __name__ == "__main__":
    main()
