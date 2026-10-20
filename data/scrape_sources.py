#!/usr/bin/env python3
"""Download open scientific-illustration collections into a common layout.

    python data/scrape_sources.py <source> [...]     sources: bioicons healthicons openmoji
                                                     reactome scidraw servier all

Each source lands in data/sources/<source>/ with
    files/...          the assets (SVG and/or PNG, as the source provides them)
    items.jsonl        one record per asset:
        {source, id, title, description, tags, category, license, author, url, svg, png}
      `svg`/`png` are paths relative to data/sources/<source>/, or null.

Everything is resumable: an existing file is not re-downloaded; items.jsonl is rewritten from
what is on disk at the end of each run.

Licenses (recorded per item where the source provides it):
  bioicons     per-icon: CC0 / CC-BY 3.0,4.0 / CC-BY-SA / MIT / BSD  (static/icons/icons.json)
  healthicons  CC0 / MIT
  openmoji     CC BY-SA 4.0
  reactome     CC BY 4.0
  scidraw      per-drawing: CC-BY 4.0 or CC0 (API `license` field); each has a Zenodo DOI
  servier      CC BY 4.0  (PNG per image; PPTX per set)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import html
import json
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

import requests

from config import UA

ROOT = Path(__file__).resolve().parent / "sources"
S = requests.Session()
S.headers["User-Agent"] = UA
TIMEOUT = 40


def get(url, retries=3, stream=False, allow_404=True):
    for i in range(retries):
        try:
            r = S.get(url, timeout=TIMEOUT, stream=stream, allow_redirects=True)
            if r.status_code == 200:
                return r
            if r.status_code in (404, 410) and allow_404:
                return r
            if r.status_code == 429:
                time.sleep(10 * (i + 1))
                continue
        except requests.RequestException:
            pass
        time.sleep(2 * (i + 1))
    return None


def download(url, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for i in range(3):  # get() retries the request; this retries a body that stalls mid-stream
        r = get(url, stream=True)
        if r is None or r.status_code != 200:
            return False
        try:
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    fh.write(chunk)
        except requests.RequestException:
            time.sleep(5 * (i + 1))
            continue
        tmp.rename(dest)
        return True
    tmp.unlink(missing_ok=True)
    return False


def write_items(src: str, items: list[dict]):
    out = ROOT / src / "items.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as fh:
        for it in items:
            fh.write(json.dumps(it, ensure_ascii=False) + "\n")
    n_svg = sum(1 for i in items if i.get("svg"))
    n_png = sum(1 for i in items if i.get("png"))
    print(f"[{src}] {len(items)} items  svg={n_svg} png={n_png} -> {out}", flush=True)


def item(src, id, title, *, description="", tags=(), category="", license="", author="", url="", svg=None, png=None):
    return dict(source=src, id=str(id), title=title, description=description or "", tags=list(tags),
                category=category or "", license=license or "", author=author or "", url=url, svg=svg, png=png)


# ----------------------------------------------------------------------------
def bioicons():
    src = "bioicons"
    repo = ROOT / "bioicons_repo"
    if not repo.exists():
        import subprocess
        subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/duerrsimon/bioicons", str(repo)], check=True)
    files = ROOT / src / "files"

    def copy(srcp: Path, rel: Path) -> str:
        dest = files / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(srcp, dest)
        return str(Path("files") / rel)

    write_items(src, list(bioicons_items(repo, copy)))


def bioicons_items(repo: Path, place, want=lambda sid: True):
    """`place(file in checkout, layout path)` gives the item's `svg` value; `want(id)` filters."""
    icons = json.load(open(repo / "static/icons/icons.json"))
    authors = json.load(open(repo / "static/icons/authors.json"))
    for ic in icons:
        sid = f"{ic['license']}/{ic['category']}/{ic['name']}"
        if not want(sid):
            continue
        # layout: static/icons/<license>/<category>/[<author>/]<name>.svg
        cands = list((repo / "static/icons" / ic["license"] / ic["category"]).rglob(ic["name"] + ".svg"))
        if not cands:
            continue
        rel = Path(ic["license"]) / ic["category"] / (ic["name"] + ".svg")
        yield item("bioicons", sid, ic["name"].replace("_", " ").replace("-", " "),
                   category=ic["category"].replace("_", " "), license=ic["license"], author=ic.get("author", ""),
                   url=authors.get(ic.get("author", ""), "https://bioicons.com"), svg=place(cands[0], rel))


def healthicons():
    src = "healthicons"
    repo = ROOT / "healthicons_repo"
    if not repo.exists():
        import subprocess
        subprocess.run(["git", "clone", "-q", "--depth", "1", "https://github.com/resolvetosavelives/healthicons", str(repo)], check=True)
    files = ROOT / src / "files"

    def copy(srcp: Path, rel: Path) -> str:
        dest = files / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(srcp, dest)
        return str(Path("files") / rel)

    write_items(src, list(healthicons_items(repo, copy)))


def healthicons_items(repo: Path, place, want=lambda sid: True):
    meta = json.load(open(repo / "public/icons/meta-data.json"))
    for m in meta:
        for style in ("filled", "outline"):
            sid = f"{style}/{m['path']}"
            srcp = repo / "public/icons/svg" / style / (m["path"] + ".svg")
            if not want(sid) or not srcp.exists():
                continue
            tags = [t for t in m.get("tags", []) if not t.startswith("dhis2:")]
            yield item("healthicons", sid, m["title"], tags=tags, category=m["category"].replace("_", " "),
                       license="CC0", author="Resolve to Save Lives", url=f"https://healthicons.org/icon/{style}/{m['path']}",
                       svg=place(srcp, Path(style) / (m["path"] + ".svg")), description=f"{style} style")


def openmoji():
    src = "openmoji"
    d = ROOT / src
    d.mkdir(parents=True, exist_ok=True)
    rel = "https://github.com/hfg-gmuend/openmoji/releases/download/17.0.0/"
    for z in ("openmoji-svg-color.zip", "openmoji-618x618-color.zip"):
        download(rel + z, d / z)
    download("https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/data/openmoji.json", d / "openmoji.json")
    for z, sub in (("openmoji-svg-color.zip", "svg-color"), ("openmoji-618x618-color.zip", "png-618")):
        if not (d / sub).exists():
            zipfile.ZipFile(d / z).extractall(d / sub)
    meta = json.load(open(d / "openmoji.json"))
    items = []
    for m in meta:
        hx = m["hexcode"]
        svg = d / "svg-color" / f"{hx}.svg"
        png = d / "png-618" / f"{hx}.png"
        if not svg.exists():
            continue
        items.append(openmoji_item(m, f"svg-color/{hx}.svg", f"png-618/{hx}.png" if png.exists() else None))
    write_items(src, items)


def openmoji_item(m: dict, svg, png):
    hx = m["hexcode"]
    tags = [t.strip() for t in (m.get("tags", "") + "," + m.get("openmoji_tags", "")).split(",") if t.strip()]
    return item("openmoji", hx, m["annotation"], tags=tags, category=f"{m['group']} / {m.get('subgroups', '')}", license="CC BY-SA 4.0",
                author=m.get("openmoji_author", "OpenMoji"), url=f"https://openmoji.org/library/emoji-{hx}/",
                svg=svg, png=png, description="skin tone variant" if m.get("skintone") else "")


def reactome():
    src = "reactome"
    d = ROOT / src
    d.mkdir(parents=True, exist_ok=True)
    for fmt in ("svg", "png"):
        tgz = d / f"icon-lib-{fmt}.tgz"
        download(f"https://reactome.org/icon/icon-lib-{fmt}.tgz", tgz)
        if not (d / fmt).exists():
            import tarfile
            tarfile.open(tgz).extractall(d / fmt)
    ids = sorted(p.stem for p in (d / "svg").glob("R-ICO-*.svg"))
    meta_path = d / "icons_meta.json"
    meta = json.load(open(meta_path)) if meta_path.exists() else {}
    api = "https://reactome.org/ContentService/search/query"
    # the API ignores `start`; one big page usually works, else fall back to per-id queries
    if len(meta) < len(ids):
        r = get(f"{api}?query=*&types=Icon&rows=5000", allow_404=False)
        if r is not None:
            for e in (e for res in r.json().get("results", []) for e in res.get("entries", [])):
                meta[e["stId"]] = e
        missing = [i for i in ids if i not in meta]
        print(f"[{src}] bulk query gave {len(meta)}; fetching {len(missing)} individually", flush=True)

        def one(i):
            r = get(f"{api}?query={i}&types=Icon&rows=5", allow_404=False)
            if r is None:
                return None
            for e in (e for res in r.json().get("results", []) for e in res.get("entries", [])):
                if e.get("stId") == i:
                    return e
            return None

        with cf.ThreadPoolExecutor(4) as ex:
            for i, e in zip(missing, ex.map(one, missing)):
                if e:
                    meta[i] = e
        json.dump(meta, open(meta_path, "w"))
    items = [reactome_item(i, meta.get(i, {}), f"svg/{i}.svg", f"png/{i}.png" if (d / "png" / f"{i}.png").exists() else None)
             for i in ids]
    write_items(src, items)


def reactome_item(i: str, e: dict, svg, png):
    """`e`: a search-API Icon entry (or the same keys from reactome_xml_meta)."""
    return item("reactome", i, e.get("iconName") or e.get("name") or i, description=e.get("summation", ""),
                category=", ".join(c.replace("_", " ") for c in e.get("iconCategories", [])),
                license="CC BY 4.0", author=e.get("iconDesignerName", "Reactome"), url=f"https://reactome.org/icon-lib/{i}",
                svg=svg, png=png)


def reactome_xml_meta(i: str) -> dict:
    """Per-icon metadata from reactome.org/icon/<id>.xml, in the search API's key names
    (the search API answers 500 for Icon queries as of 2026-10)."""
    import xml.etree.ElementTree as ET

    r = get(f"https://reactome.org/icon/{i}.xml")
    if r is None or r.status_code != 200:
        return {}
    try:
        x = ET.fromstring(r.content)
    except ET.ParseError:
        return {}
    designer = x.find("person[@role='designer']")
    return {k: v for k, v in dict(
        iconName=(x.findtext("name") or "").strip(), summation=(x.findtext("description") or "").strip(),
        iconCategories=[(c.text or "").strip() for c in x.iter("category") if (c.text or "").strip()],
        iconDesignerName=(designer.text or "").strip() if designer is not None else "",
    ).items() if v}


def scidraw():
    src = "scidraw"
    d = ROOT / src
    files = d / "files"
    recs = scidraw_list()
    print(f"[{src}] {len(recs)} drawings listed", flush=True)

    def one(rec):
        u, ext = scidraw_image(rec)
        dest = files / f"{rec['id']}.{ext}"
        return rec, (str(dest.relative_to(d)) if download(u, dest) else None), ext

    items = []
    with cf.ThreadPoolExecutor(4) as ex:
        for rec, rel, ext in ex.map(one, recs):
            if rel:
                items.append(scidraw_item(rec, rel, ext))
    write_items(src, items)


def scidraw_list() -> list[dict]:
    recs, url = [], "https://scidraw.io/api/v1/drawings/?page=1"
    while url:
        r = get(url, allow_404=False)
        if r is None:
            raise RuntimeError(f"scidraw listing failed at {url}")
        j = r.json()
        recs += j.get("results", [])
        url = j.get("next")
        time.sleep(0.3)
    return recs


def scidraw_image(rec) -> tuple[str, str]:
    u = rec["image_url"].replace("http://", "https://")
    return u, (rec.get("image_type") or u.rsplit(".", 1)[-1]).lower()


def scidraw_item(rec, ref, ext):
    return item("scidraw", rec["id"], rec["name"], category=rec.get("category_name", ""), license=rec.get("license", ""),
                author=(rec.get("primary_author") or {}).get("full_name", ""), url=f"https://scidraw.io/drawing/{rec['slug']}",
                description=f"DOI {rec['doi']}" if rec.get("doi") else "",
                svg=ref if ext == "svg" else None, png=ref if ext in ("png", "jpg", "jpeg", "bmp", "gif", "webp") else None)


def servier():
    src = "servier"
    d = ROOT / src
    files = d / "files"
    pages = servier_pages()
    print(f"[{src}] {len(pages)} image pages in sitemaps", flush=True)

    def one(pair):
        page, img = pair
        slug = servier_slug(page)
        ext = img.rsplit(".", 1)[-1].lower()
        dest = files / f"{slug}.{ext}"
        ok = download(img, dest)
        return servier_item(page, img, str(dest.relative_to(d)) if ok else None)

    items = []
    with cf.ThreadPoolExecutor(4) as ex:
        for k, it in enumerate(ex.map(one, sorted(pages.items()))):
            items.append(it)
            if k % 200 == 0:
                print(f"[{src}] {k}/{len(pages)}", flush=True)
    write_items(src, items)


def servier_pages() -> dict[str, str]:
    """{image page url: image url} from the image sitemaps."""
    pages = {}
    for sm in ("smart_image-sitemap.xml", "smart_image-sitemap2.xml", "smart_image-sitemap3.xml", "smart_image-sitemap4.xml"):
        r = get("https://smart.servier.com/" + sm, allow_404=False)
        if r is None:
            continue
        for blk in re.findall(r"<url>(.*?)</url>", r.text, re.S):
            loc = re.search(r"<loc>([^<]+)", blk)
            img = re.search(r"<image:loc>([^<]+)", blk)
            if loc and img and "/smart_image/" in loc.group(1) and loc.group(1).rstrip("/") != "https://smart.servier.com/smart_image":
                pages[loc.group(1)] = html.unescape(img.group(1))
    return pages


def servier_slug(page: str) -> str:
    return page.rstrip("/").rsplit("/", 1)[-1]


def servier_item(page: str, img: str, ref):
    """Fetches the image page for title/categories/tags; `ref` is the item's file value (None = no file)."""
    slug = servier_slug(page)
    r = get(page)
    title, cats, tags = slug.replace("-", " "), [], []
    if r is not None and r.status_code == 200:
        t = re.search(r"<title>([^<]+?)\s*-\s*Servier Medical Art", r.text)
        if t:
            title = html.unescape(t.group(1)).strip()
        cats = [html.unescape(c) for c in re.findall(r'href="https://smart\.servier\.com/category/[^"]+"[^>]*>([^<]{2,80})<', r.text)]
        tags = [html.unescape(c) for c in re.findall(r'href="https://smart\.servier\.com/tag/[^"]+"[^>]*>([^<]{2,80})<', r.text)]
    ext = img.rsplit(".", 1)[-1].lower()
    return item("servier", slug, title, tags=sorted(set(tags)), category=" / ".join(dict.fromkeys(cats)), license="CC BY 4.0",
                author="Servier Medical Art", url=page, png=ref if ref and ext == "png" else None,
                svg=ref if ref and ext == "svg" else None)


# ----------------------------------------------------------------------------
# Incremental discovery, for data/sync.py.
#
#   discover_<source>(known, prev, work) -> (signal, listed, new_items)
#
# `known`: source_ids already in the catalog. `prev`: this function's signal from the last
# successful run (None the first time). `work`: an empty scratch dir. Returns `listed=None,
# new_items=[]` when the cheap upstream signal (commit, release tag, ETag, sitemap hash) equals
# `prev`, i.e. nothing changed. Otherwise `listed` is how many items upstream has in total (a
# sanity check: a broken scraper lists far fewer than `known`) and `new_items` are item() records
# for ids not in `known`, whose svg/png are URLs or absolute paths in `work`; sync.py downloads
# them. Nothing here downloads asset files, except where the source only ships them in bulk.
# ----------------------------------------------------------------------------
def _git(*args: str, timeout=600) -> str:
    import subprocess

    for i in range(3):
        r = subprocess.run(["git", *args], capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0:
            return r.stdout
        if args[0] == "clone":
            shutil.rmtree(args[-1], ignore_errors=True)
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"git {' '.join(args[:2])} failed: {r.stderr.strip()[-300:]}")


def _git_source(repo_url: str, items_fn, known, prev, work):
    head = _git("ls-remote", repo_url, "HEAD").split()[0]
    if head == prev:
        return head, None, []
    repo = work / "repo"
    _git("clone", "-q", "--depth", "1", repo_url, str(repo))
    listed = list(items_fn(repo, lambda srcp, rel: str(srcp)))
    return head, len(listed), [it for it in listed if it["id"] not in known]


def discover_bioicons(known, prev, work):
    return _git_source("https://github.com/duerrsimon/bioicons", bioicons_items, known, prev, work)


def discover_healthicons(known, prev, work):
    return _git_source("https://github.com/resolvetosavelives/healthicons", healthicons_items, known, prev, work)


def discover_openmoji(known, prev, work):
    def ver(tag):
        return tuple(int(x) for x in re.findall(r"\d+", tag))

    tags = [ln.split("refs/tags/", 1)[1] for ln in _git("ls-remote", "--tags", "https://github.com/hfg-gmuend/openmoji").splitlines()
            if "refs/tags/" in ln and not ln.endswith("^{}")]
    tag = max((t for t in tags if re.fullmatch(r"\d+(\.\d+)*", t)), key=ver)
    if tag == prev:
        return tag, None, []
    raw = f"https://raw.githubusercontent.com/hfg-gmuend/openmoji/{tag}"
    r = get(f"{raw}/data/openmoji.json", allow_404=False)
    if r is None or r.status_code != 200:
        raise RuntimeError(f"openmoji {tag}: no data/openmoji.json")
    meta = r.json()
    new = [openmoji_item(m, f"{raw}/color/svg/{m['hexcode']}.svg", f"{raw}/color/618x618/{m['hexcode']}.png")
           for m in meta if m["hexcode"] not in known]
    return tag, len(meta), new


def discover_reactome(known, prev, work):
    url = "https://reactome.org/icon/icon-lib-svg.tgz"
    r = S.head(url, timeout=TIMEOUT, allow_redirects=True)
    r.raise_for_status()
    sig = r.headers.get("ETag") or r.headers.get("Last-Modified") or r.headers.get("Content-Length")
    if sig and sig == prev:
        return sig, None, []
    import tarfile

    if not download(url, work / "icon-lib-svg.tgz"):
        raise RuntimeError(f"could not download {url}")
    with tarfile.open(work / "icon-lib-svg.tgz") as tf:
        ids = sorted({Path(n).stem for n in tf.getnames() if re.fullmatch(r"R-ICO-\d+", Path(n).stem)})
    new = [reactome_item(i, reactome_xml_meta(i), f"https://reactome.org/icon/{i}.svg", f"https://reactome.org/icon/{i}.png")
           for i in ids if i not in known]
    return sig, len(ids), new


def discover_scidraw(known, prev, work):
    recs = scidraw_list()  # no cheap change signal: the listing is ~one request per 100 drawings
    sig = str(len(recs))
    new = []
    for rec in recs:
        if rec["id"] not in known:
            u, ext = scidraw_image(rec)
            new.append(scidraw_item(rec, u, ext))
    return sig, len(recs), new


def discover_servier(known, prev, work):
    import hashlib

    pages = servier_pages()
    sig = hashlib.sha256("\n".join(sorted(pages)).encode()).hexdigest()[:16]
    if sig == prev:
        return sig, None, []
    todo = [(p, img) for p, img in sorted(pages.items()) if servier_slug(p) not in known]
    with cf.ThreadPoolExecutor(4) as ex:
        new = list(ex.map(lambda pi: servier_item(pi[0], pi[1], pi[1]), todo))
    return sig, len(pages), new


DISCOVER = dict(bioicons=discover_bioicons, healthicons=discover_healthicons, openmoji=discover_openmoji,
                reactome=discover_reactome, scidraw=discover_scidraw, servier=discover_servier)


SOURCES = dict(bioicons=bioicons, healthicons=healthicons, openmoji=openmoji, reactome=reactome,
               scidraw=scidraw, servier=servier)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+", choices=list(SOURCES) + ["all"])
    a = ap.parse_args()
    for s in (list(SOURCES) if "all" in a.sources else a.sources):
        SOURCES[s]()
