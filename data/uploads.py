"""Collect approved contributions from the bucket, validated, for publish_catalog.py.

Contributions are submitted from the app to the review Worker (worker/), and approving one
copies it into the bucket as `user/<slug>.png` or `user/<slug>.svg`, + `user/<slug>.json` (metadata
sidecar, written last), or `templates/<slug>/{img-N.png, thumb.png, template.json}`. They are checked again here
in case anything else wrote to the bucket: every object is size-checked, PNGs are checked by
signature and real dimensions, SVGs by the Worker's safety rules (svg_problem), templates may only reference images that are in the bucket, and
the number per publish (total and per author) is capped. Ids or authors listed in
data/upload_blocklist.txt are skipped (to pull something that was approved by mistake).

An SVG upload's PNG (`user/<slug>.png`, what the app shows) is rendered here, the way
rasterize.py renders the catalog's SVGs, and put in the bucket the first time it is published.

    python data/uploads.py            # report what would be published, without publishing
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent
BLOCKLIST = DATA / "upload_blocklist.txt"
RENDERS = DATA / "raster" / "user"
IMMUTABLE = "public, max-age=31536000, immutable"

# Keep in sync with biocartoon-app (app/src/submit.rs).
MAX_PNG_BYTES = 2 * 1024 * 1024
MAX_SVG_BYTES = 2 * 1024 * 1024
MAX_IMAGE_SIDE = 4096
MAX_TEMPLATE_JSON_BYTES = 1024 * 1024
MAX_TEMPLATE_ITEMS = 300
MAX_TEMPLATE_IMAGES = 24
MAX_SIDECAR_BYTES = 16 * 1024
LICENSES = {
    "CC0-1.0": ("https://creativecommons.org/publicdomain/zero/1.0/", 0),
    "CC-BY-4.0": ("https://creativecommons.org/licenses/by/4.0/", 1),
}
SLUG = r"[a-z0-9][a-z0-9-]{0,100}"
ASSET_SIDECAR = re.compile(rf"^user/({SLUG})\.json$")
TEMPLATE_JSON = re.compile(rf"^templates/({SLUG})/template\.json$")
TEMPLATE_IMAGE = re.compile(rf"^templates/({SLUG})/(img-\d{{1,3}}|thumb)\.png$")


def blocklist() -> set[str]:
    if not BLOCKLIST.exists():
        return set()
    return {l.strip() for l in BLOCKLIST.read_text().splitlines() if l.strip() and not l.startswith("#")}


def is_blocked(blocked: set[str], rid: str, author: str) -> bool:
    """Ids match exactly; authors ignore case."""
    return rid in blocked or author.lower() in {b.lower() for b in blocked}


def list_objects(s3, bucket: str, prefix: str) -> dict[str, dict]:
    out = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for o in page.get("Contents", []):
            out[o["Key"]] = o
    return out


def text(v, limit: int, required=False) -> str:
    if not isinstance(v, str):
        v = ""
    v = re.sub(r"[\x00-\x1f\x7f]", " ", v).strip()
    if required and not v:
        raise ValueError("missing title")
    if len(v) > limit:
        raise ValueError(f"field longer than {limit}")
    return v


def png_size(s3, bucket: str, key: str, objs: dict) -> tuple[int, int]:
    """Checks a PNG object's size, signature and IHDR; returns (width, height)."""
    o = objs.get(key)
    if o is None:
        raise ValueError(f"{key} missing")
    if o["Size"] > MAX_PNG_BYTES:
        raise ValueError(f"{key} is {o['Size']} bytes")
    return png_dims(s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-23")["Body"].read(), key)


def png_dims(head: bytes, key: str) -> tuple[int, int]:
    """(width, height) from a PNG's first 24 bytes, checking the signature and limits."""
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        raise ValueError(f"{key} is not a PNG")
    w, h = struct.unpack(">II", head[16:24])
    if not (0 < w <= MAX_IMAGE_SIDE and 0 < h <= MAX_IMAGE_SIDE):
        raise ValueError(f"{key} is {w}x{h}")
    return w, h


# Mirrors checkSvg() in worker/src/validate.ts: refuse anything that could run or load something.
SVG_BLOCKED_ELEMENTS = {
    "script", "foreignobject", "iframe", "embed", "object", "audio", "video", "canvas", "handler", "listener",
    "set", "animate", "animatemotion", "animatetransform", "animatecolor", "discard",
}
SVG_BLOCKED_NAMESPACES = {"http://www.w3.org/1999/xhtml", "http://www.w3.org/1998/Math/MathML"}
_NAME = re.compile(r"[A-Za-z_][\w.:-]*")
_ATTR = re.compile(r"\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:\"([^\"<]*)\"|'([^'<]*)')")
_TAG_END = re.compile(r"\s*(/?)>")
_END_TAG = re.compile(r"</([A-Za-z_][\w.:-]*)\s*>")
_DOCTYPE = re.compile(r"<!DOCTYPE\s+svg(\s+PUBLIC\s+(\"[^\"]*\"|'[^']*')\s+(\"[^\"]*\"|'[^']*'))?\s*>")
_XML_ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}


def _unescape_xml(s: str) -> str:
    def one(m: re.Match) -> str:
        ref, body = m.group(0), m.group(1)
        code = re.fullmatch(r"#x([0-9a-fA-F]{1,6})", body) or re.fullmatch(r"#(\d{1,7})", body)
        n = int(code.group(1), 16 if body[:2].lower() == "#x" else 10) if code else 0
        if ref.endswith(";") and 0 < n <= 0x10FFFF:
            return chr(n)
        if ref.endswith(";") and body in _XML_ENTITIES:
            return _XML_ENTITIES[body]
        raise ValueError("not well-formed XML")
    return re.sub(r"&([^;\s&]{0,10});?", one, s)


def _bad_css(v: str, style: bool) -> bool:
    return bool(re.search(r"url\s*\(\s*(?!['\"]?\s*#)", v, re.I) or re.search(r"@import|javascript:", v, re.I)
                or (style and "\\" in v))


def svg_problem(b: bytes) -> str | None:
    """Why the SVG `b` is unsafe to publish as is, or None."""
    if len(b) > MAX_SVG_BYTES:
        return f"{len(b)} bytes"
    try:
        s = b.decode("utf-8").removeprefix("﻿")
    except UnicodeDecodeError:
        return "not UTF-8"
    stack: list[str] = []
    root, i = False, 0
    try:
        while i < len(s):
            lt = s.find("<", i)
            text = _unescape_xml(s[i:] if lt < 0 else s[i:lt])
            if not stack and text.strip():
                return "not well-formed XML"
            if stack and stack[-1] == "style" and _bad_css(text, True):
                return "CSS that loads other files"
            if lt < 0:
                break
            if s.startswith("<!--", lt):
                end = s.find("-->", lt + 4)
                if end < 0:
                    return "not well-formed XML"
                i = end + 3
            elif s.startswith("<![CDATA[", lt):
                end = s.find("]]>", lt + 9)
                if end < 0 or not stack:
                    return "not well-formed XML"
                if stack[-1] == "style" and _bad_css(s[lt + 9:end], True):
                    return "CSS that loads other files"
                i = end + 3
            elif s.startswith("<?", lt):
                end = s.find("?>", lt + 2)
                if end < 0 or root or not re.match(r"<\?xml\s", s[lt:end]):
                    return "processing instructions"
                i = end + 2
            elif s.startswith("<!", lt):
                m = _DOCTYPE.match(s, lt)
                if root or not m:
                    return "entity declarations"
                i = m.end()
            elif s[lt + 1:lt + 2] == "/":
                m = _END_TAG.match(s, lt)
                if not m or not stack or stack.pop() != m.group(1).split(":")[-1].lower():
                    return "not well-formed XML"
                i = m.end()
            else:
                m = _NAME.match(s, lt + 1)
                if not m:
                    return "not well-formed XML"
                local = m.group(0).split(":")[-1].lower()
                if not stack and (root or local != "svg"):
                    return "root element is not <svg>"
                root = True
                if local in SVG_BLOCKED_ELEMENTS:
                    return f"<{local}> element"
                at = m.end()
                while a := _ATTR.match(s, at):
                    at = a.end()
                    attr = a.group(1).lower()
                    attr_local = attr.split(":")[-1]
                    value = _unescape_xml(a.group(2) if a.group(2) is not None else a.group(3))
                    if re.fullmatch(r"on[a-z]+", attr_local):
                        return "event handler"
                    if (attr == "xmlns" or attr.startswith("xmlns:")) and value.strip() in SVG_BLOCKED_NAMESPACES:
                        return "HTML or MathML"
                    if attr_local == "href" and not re.match(r"\s*(#|data:image/(png|jpeg|gif|webp);base64,)", value, re.I):
                        return "link to another file"
                    if _bad_css(value, attr_local == "style"):
                        return "CSS that loads other files"
                end = _TAG_END.match(s, at)
                if not end:
                    return "not well-formed XML"
                if not end.group(1):
                    stack.append(local)
                i = end.end()
    except ValueError as e:
        return str(e)
    return None if root and not stack else "not well-formed XML"


def svg_body(s3, bucket: str, key: str, objs: dict) -> bytes:
    """An SVG object, after checking its size and content (svg_problem)."""
    o = objs.get(key)
    if o is None:
        raise ValueError(f"{key} missing")
    if o["Size"] > MAX_SVG_BYTES:
        raise ValueError(f"{key} is {o['Size']} bytes")
    svg = s3.get_object(Bucket=bucket, Key=key)["Body"].read(MAX_SVG_BYTES + 1)
    why = svg_problem(svg)
    if why:
        raise ValueError(f"{key} is refused: {why}")
    return svg


def render_svg(svg: bytes, slug: str) -> bytes:
    """The PNG of an uploaded SVG, rendered by rasterize.py (cached in data/raster/user/) without
    cairosvg's unsafe mode, in a child process that is killed if it hangs: cairo can ignore the
    SIGALRM that rasterize.py times renders out with."""
    import multiprocessing as mp

    import rasterize

    out = RENDERS / f"{slug}.png"
    if not out.exists():
        RENDERS.mkdir(parents=True, exist_ok=True)
        src = RENDERS / f"{slug}.svg"
        src.write_bytes(svg)
        pool = mp.get_context("spawn").Pool(1)
        try:
            job = pool.apply_async(rasterize.render_one, ((str(src), str(out), False),))
            _, status = job.get(timeout=4 * rasterize.RENDER_TIMEOUT)
        except mp.TimeoutError:
            status = "timeout"
        finally:
            pool.terminate()
            src.unlink(missing_ok=True)
        if not out.exists():
            raise ValueError(f"the SVG did not render ({status})")
    return out.read_bytes()


def get_json(s3, bucket: str, key: str, size: int, limit: int):
    if size > limit:
        raise ValueError(f"{key} is {size} bytes")
    return json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read(limit + 1))


class Caps:
    """Oldest uploads first; stops at `total`, and at `per_author` for any one author."""

    def __init__(self, total: int, per_author: int):
        self.total, self.per_author, self.n, self.by = total, per_author, 0, {}

    def take(self, author: str) -> str | None:
        key = author.lower()  # "KeHan" and "kehan" share one cap
        if self.n >= self.total:
            return "over the per-publish cap"
        if self.by.get(key, 0) >= self.per_author:
            return f"over the per-author cap for {author!r}"
        self.n += 1
        self.by[key] = self.by.get(key, 0) + 1
        return None


def asset_rows(s3, bucket: str, caps: Caps, blocked: set[str], log=print, upload_renders=False) -> list[dict]:
    """Rows for the `assets` table (schema in build_assets_db.py) from valid asset sidecars. SVG
    uploads are rendered to PNG, and the PNGs put in the bucket with `upload_renders`."""
    objs = list_objects(s3, bucket, "user/")
    sidecars = sorted((o for k, o in objs.items() if k.endswith(".json")), key=lambda o: o["LastModified"])
    rows = []
    for o in sidecars:
        key = o["Key"]
        try:
            m = ASSET_SIDECAR.match(key)
            if not m:
                raise ValueError("bad key")
            rid = f"user/{m.group(1)}"
            meta = get_json(s3, bucket, key, o["Size"], MAX_SIDECAR_BYTES)
            if meta.get("id") != rid or meta.get("png_key") != f"{rid}.png":
                raise ValueError("id / png_key do not match the key")
            author = text(meta.get("author"), 80) or "anonymous"
            if is_blocked(blocked, rid, author):
                raise ValueError("blocklisted")
            lic = meta.get("license")
            if lic not in LICENSES:
                raise ValueError(f"license {lic!r}")
            png_key, svg_key = f"{rid}.png", meta.get("svg_key")
            png_sha = text(meta.get("png_sha256"), 64) or None
            if svg_key is None:
                w, h = png_size(s3, bucket, png_key, objs)
            else:
                if svg_key != f"{rid}.svg":
                    raise ValueError("svg_key does not match the key")
                png = render_svg(svg_body(s3, bucket, svg_key, objs), m.group(1))
                w, h = png_dims(png[:24], png_key)
                png_sha = hashlib.sha256(png).hexdigest()
                if upload_renders and png_key not in objs:
                    s3.put_object(Bucket=bucket, Key=png_key, Body=png, ContentType="image/png", CacheControl=IMMUTABLE,
                                  Metadata={"asset-id": rid, "license": lic, "sha256": png_sha})
                objs[png_key] = {"Key": png_key, "Size": len(png)}
            row = dict(
                id=rid, source="user", source_name="User-generated", source_id=rid,
                title=text(meta.get("title"), 80, required=True), variant=None,
                description=text(meta.get("description"), 500), category=text(meta.get("category"), 60) or None,
                tags="[]", license=lic, license_raw=lic, license_url=LICENSES[lic][0],
                attribution_required=LICENSES[lic][1], share_alike=0, author=author, source_url=None, doi=None,
                credit=text(meta.get("credit"), 600) or f'"{meta.get("title")}" by {author}, {lic}',
                svg_key=svg_key, png_key=png_key, png_is_raster=int(svg_key is not None), png_width=w, png_height=h,
                svg_bytes=objs[svg_key]["Size"] if svg_key else None, png_bytes=objs[png_key]["Size"],
                svg_sha256=text(meta.get("svg_sha256"), 64) or None, png_sha256=png_sha,
                svg_local=None, png_local=None, extra=json.dumps({"uploaded": True}),
                uploaded_at=o["LastModified"].isoformat(timespec="seconds"),
            )
            why = caps.take(author)
            if why:
                raise ValueError(why)
            rows.append(row)
        except Exception as e:  # noqa: BLE001
            log(f"  skip {key}: {e}")
    return rows


def _image_keys(slide: dict):
    """Yields the ImageSource of every image item; raises on anything that is not an asset."""
    items = slide.get("items")
    if not isinstance(items, list) or not items or len(items) > MAX_TEMPLATE_ITEMS:
        raise ValueError("bad item list")
    n = 0
    for it in items:
        kind = it.get("kind") if isinstance(it, dict) else None
        if isinstance(kind, dict) and "Image" in kind:
            n += 1
            src = (kind["Image"] or {}).get("source") or {}
            if "Asset" not in src:
                raise ValueError("image that is not a bucket object")
            yield src["Asset"].get("key")
    if n > MAX_TEMPLATE_IMAGES:
        raise ValueError(f"{n} images")


def template_rows(s3, bucket: str, catalog_keys: set[str], caps: Caps, blocked: set[str], log=print) -> list[dict]:
    """Rows for templates.sqlite (schema in biocartoon-app: app/src/templates.rs) from valid templates."""
    objs = list_objects(s3, bucket, "templates/")
    jsons = sorted((o for k, o in objs.items() if k.endswith("/template.json")), key=lambda o: o["LastModified"])
    rows = []
    for o in jsons:
        key = o["Key"]
        try:
            m = TEMPLATE_JSON.match(key)
            if not m:
                raise ValueError("bad key")
            slug = m.group(1)
            t = get_json(s3, bucket, key, o["Size"], MAX_TEMPLATE_JSON_BYTES)
            meta = t.get("meta") or {}
            if meta.get("id") != slug or meta.get("thumb_key") != f"templates/{slug}/thumb.png":
                raise ValueError("id / thumb_key do not match the key")
            author = text(meta.get("author"), 80) or "anonymous"
            if is_blocked(blocked, slug, author):
                raise ValueError("blocklisted")
            if meta.get("license") not in LICENSES:
                raise ValueError(f"license {meta.get('license')!r}")
            for f in ("width", "height"):
                if not isinstance(t.get(f), (int, float)) or not 0 < t[f] <= 100_000:
                    raise ValueError(f"bad {f}")
            for k in _image_keys(t.get("slide") or {}):
                im = TEMPLATE_IMAGE.match(k or "")
                # Its own images, or those of another approved template (e.g. a shared one re-saved).
                if im and (im.group(1) == slug or k in objs):
                    png_size(s3, bucket, k, objs)
                elif k not in catalog_keys:
                    raise ValueError(f"image {k!r} is not in the bucket")
            png_size(s3, bucket, meta["thumb_key"], objs)
            row = dict(
                id=slug, title=text(meta.get("title"), 80, required=True), description=text(meta.get("description"), 500),
                category=text(meta.get("category"), 60), author=author, license=meta["license"],
                created_at=o["LastModified"].isoformat(timespec="seconds"), json_key=key, thumb_key=meta["thumb_key"],
                json_local=None, thumb_local=None,
            )
            why = caps.take(author)
            if why:
                raise ValueError(why)
            rows.append(row)
        except Exception as e:  # noqa: BLE001
            log(f"  skip {key}: {e}")
    return rows


if __name__ == "__main__":
    import os
    from upload_r2 import client

    bucket = os.environ.get("R2_BUCKET") or sys.exit("set R2_BUCKET")
    s3 = client()
    blocked = blocklist()
    a = asset_rows(s3, bucket, Caps(10**9, 10**9), blocked)
    print(f"{len(a)} valid asset uploads")
    t = template_rows(s3, bucket, {r["png_key"] for r in a}, Caps(10**9, 10**9), blocked)
    print(f"{len(t)} valid templates (catalog-asset references not checked here)")
