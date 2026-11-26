#!/usr/bin/env python3
"""Download open scientific-illustration collections into a common layout.

    python data/scrape_sources.py <source> [...]     sources: bioicons healthicons noto openmoji
                                                     phylopic reactome scidraw servier togotv all

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
  noto         Apache-2.0 (Noto's own emoji); public domain (its flags, from Wikipedia)
  openmoji     CC BY-SA 4.0
  phylopic     per-silhouette: CC0 / public domain mark / CC BY 3.0,4.0 / CC BY-SA 3.0 (API `license`);
               the NC ones (CC BY-NC, CC BY-NC-SA) are left out
  reactome     CC BY 4.0
  scidraw      per-drawing: CC-BY 4.0 or CC0 (API `license` field); each has a Zenodo DOI
  servier      CC BY 4.0  (PNG per image; PPTX per set)
  togotv       CC BY 4.0  (DBCLS TogoTV pictures; each has a DOI)
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


NOTO_REPO = "googlefonts/noto-emoji"
# Noto's own color SVGs are Apache-2.0; its flags come from Wikipedia and are public domain.
NOTO_DIRS = {"2D/svg": "Apache-2.0", "third_party/region-flags/waved-svg": "Public Domain"}


def noto_release() -> str:
    """The newest dated release tag (`v2026-09-24-unicode18_0`)."""
    tags = [ln.split("refs/tags/", 1)[1] for ln in _git("ls-remote", "--tags", f"https://github.com/{NOTO_REPO}").splitlines()
            if "refs/tags/" in ln and not ln.endswith("^{}")]
    return max(t for t in tags if re.fullmatch(r"v\d{4}-\d\d-\d\d.*", t))


def noto_listing(tag: str, work: Path) -> tuple[str, list[tuple[dict, str, str]]]:
    """(emojibase version, [(emojibase record, path in the repo, license, path of the file it is
    (the path, or a symlink's target))]) for every Noto emoji
    SVG at `tag`. Noto has no names or keywords, so they come from emojibase-data (MIT; the Unicode
    CLDR names and keywords, with the same group / subgroup names OpenMoji uses). The few SVGs
    emojibase doesn't list (bare keycap digits the font composes from) are left out."""
    # A blob-less clone lists the files without downloading them (the GitHub API's 60 requests an
    # hour without a token run out); the SVGs are then fetched one by one from raw.githubusercontent.
    repo = work / "noto-repo"
    _git("clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "1", "--branch", tag,
         f"https://github.com/{NOTO_REPO}", str(repo))
    files = {}
    for line in _git("-C", str(repo), "ls-tree", "-r", "HEAD").splitlines():
        mode, _, sha_path = line.split(" ", 2)
        sha, path = sha_path.split("\t", 1)
        m = re.fullmatch(r"(.+)/emoji_u([0-9a-f_]+)\.svg", path)
        if m and m.group(1) in NOTO_DIRS:
            # Some flags are symlinks to another (Bouvet Island -> Norway); raw.githubusercontent
            # serves a symlink's target name, not the file, so download the target.
            target = path
            if mode == "120000":
                target = str(Path(path).parent / _git("-C", str(repo), "cat-file", "-p", sha).strip())
            files[m.group(2)] = (path, NOTO_DIRS[m.group(1)], target)
    r = get("https://data.jsdelivr.com/v1/package/npm/emojibase-data", allow_404=False)
    if r is None or r.status_code != 200:
        raise RuntimeError("emojibase-data: no version")
    ver = r.json()["tags"]["latest"]
    base = f"https://cdn.jsdelivr.net/npm/emojibase-data@{ver}"
    data, groups = (get(f"{base}/{p}", allow_404=False) for p in ("en/data.json", "meta/groups.json"))
    if data is None or groups is None or data.status_code != 200 or groups.status_code != 200:
        raise RuntimeError(f"emojibase-data {ver}: no data")
    groups = groups.json()

    def key(hexcode):  # Noto's file names drop the FE0F variation selector
        return "_".join(c for c in hexcode.lower().split("-") if c != "fe0f")

    out = []
    for e in data.json():
        for rec in [e] + [dict(s, tags=e.get("tags") or []) for s in e.get("skins") or []]:
            if f := files.pop(key(rec["hexcode"]), None):
                cat = [groups[k].get(str(rec.get(k[:-1])), "") for k in ("groups", "subgroups")]
                # emojibase files the regional indicator letters under no group; OpenMoji's name for them
                rec["category"] = " / ".join(c for c in cat if c) or ("symbols / regional-indicator" if rec["label"].startswith("regional indicator") else "")
                out.append((rec, *f))
    return ver, out


def noto_item(rec: dict, path: str, lic: str, tag: str, svg):
    """`path` is the emoji's own path in the repo (for its page); `svg` the file to fetch."""
    return item("noto", rec["hexcode"], rec["label"], tags=rec.get("tags") or [], category=rec["category"], license=lic,
                author="Google" if lic != "Public Domain" else "", url=f"https://github.com/{NOTO_REPO}/blob/{tag}/{path}",
                svg=svg, description="skin tone variant" if rec.get("tone") else "")


def noto():
    src = "noto"
    tag = noto_release()
    import tempfile

    with tempfile.TemporaryDirectory() as work:
        _, listing = noto_listing(tag, Path(work))
    raw = f"https://raw.githubusercontent.com/{NOTO_REPO}/{tag}"

    def one(entry):
        rec, path, lic, target = entry
        rel = Path("files") / Path(path).name
        return noto_item(rec, path, lic, tag, str(rel)) if download(f"{raw}/{target}", ROOT / src / rel) else None

    with cf.ThreadPoolExecutor(8) as ex:
        write_items(src, [it for it in ex.map(one, listing) if it])


# ----------------------------------------------------------------------------
# Model organisms, by scientific name (lower case, matched at the start of a title or name):
# the English names people search for. PhyloPic titles are scientific names only.
MODEL_ORGANISMS = {
    "homo sapiens": ["human", "person"],
    "mus musculus": ["mouse", "house mouse", "lab mouse"],
    "rattus norvegicus": ["rat", "brown rat", "lab rat"],
    "danio rerio": ["zebrafish"],
    "drosophila melanogaster": ["fruit fly", "drosophila"],
    "caenorhabditis elegans": ["c. elegans", "nematode", "worm"],
    "arabidopsis thaliana": ["thale cress", "arabidopsis"],
    "saccharomyces cerevisiae": ["baker's yeast", "budding yeast", "yeast"],
    "schizosaccharomyces pombe": ["fission yeast", "yeast"],
    "escherichia coli": ["e. coli", "bacterium"],
    "bacillus subtilis": ["b. subtilis", "bacterium"],
    "xenopus laevis": ["african clawed frog", "xenopus", "frog"],
    "xenopus tropicalis": ["western clawed frog", "xenopus", "frog"],
    "gallus gallus": ["chicken"],
    "macaca mulatta": ["rhesus macaque", "monkey"],
    "macaca fascicularis": ["crab-eating macaque", "monkey"],
    "callithrix jacchus": ["common marmoset", "monkey"],
    "oryzias latipes": ["medaka", "japanese rice fish"],
    "nothobranchius furzeri": ["turquoise killifish", "killifish"],
    "bombyx mori": ["silkworm", "silk moth"],
    "apis mellifera": ["honey bee", "bee"],
    "tribolium castaneum": ["red flour beetle", "beetle"],
    "oryza sativa": ["rice"],
    "zea mays": ["maize", "corn"],
    "nicotiana tabacum": ["tobacco"],
    "physcomitrium patens": ["moss"],
    "physcomitrella patens": ["moss"],
    "chlamydomonas reinhardtii": ["green alga", "alga"],
    "dictyostelium discoideum": ["slime mold"],
    "ciona intestinalis": ["sea squirt", "tunicate"],
    "strongylocentrotus purpuratus": ["purple sea urchin", "sea urchin"],
    "sus scrofa": ["pig"],
    "bos taurus": ["cow", "cattle"],
    "ovis aries": ["sheep"],
    "canis familiaris": ["dog"],
    "canis lupus familiaris": ["dog"],
    "felis catus": ["cat"],
    "oryctolagus cuniculus": ["rabbit"],
    "cavia porcellus": ["guinea pig"],
    "mesocricetus auratus": ["golden hamster", "hamster"],
}


def model_organism(*names: str) -> list[str] | None:
    """The English names of the model organism any of `names` is (a species or below), or None."""
    for n in names:
        n = re.sub(r"\s+", " ", (n or "").lower()).strip()
        for sci, common in MODEL_ORGANISMS.items():
            if n == sci or n.startswith(sci + " "):
                return common
    return None


def is_human(*names: str) -> bool:
    return any((n or "").lower().startswith("homo sapiens") for n in names)


# ----------------------------------------------------------------------------
# PhyloPic: silhouettes of organisms, one license per image. https://www.phylopic.org/api
PHYLOPIC_API = "https://api.phylopic.org"
PHYLOPIC_LICENSES = {  # license URL -> kept; the NC licenses are not open for published figures
    "https://creativecommons.org/publicdomain/zero/1.0/": True,
    "https://creativecommons.org/publicdomain/mark/1.0/": True,
    "https://creativecommons.org/licenses/by/3.0/": True,
    "https://creativecommons.org/licenses/by/4.0/": True,
    "https://creativecommons.org/licenses/by-sa/3.0/": True,
    "https://creativecommons.org/licenses/by-nc/3.0/": False,
    "https://creativecommons.org/licenses/by-nc-sa/3.0/": False,
}
# PhyloPic has no categories and its titles are scientific names, so each image is placed by the
# clades it falls in: (clade name as PhyloPic lists it, English tags, group). The first clade
# with a group sets the category ("Organisms / <group>"); every clade adds its tags.
PHYLOPIC_CLADES = [
    ("Aves", ["bird"], "Birds"),
    ("Dinosauria", ["dinosaur", "reptile"], "Dinosaurs"),
    ("Pterosauria", ["pterosaur", "reptile"], "Reptiles"),
    ("Serpentes", ["snake"], None),
    ("Squamata", ["lizard", "squamate"], None),
    ("Testudines", ["turtle", "tortoise"], None),
    ("Crocodylia", ["crocodile", "alligator"], None),
    ("Reptilia", ["reptile"], "Reptiles"),
    ("Homo", ["human", "hominin"], None),
    ("Primates", ["primate", "monkey", "ape"], None),
    ("Rodentia", ["rodent"], None),
    ("Carnivora", ["carnivore"], None),
    ("Chiroptera", ["bat"], None),
    ("Cetacea", ["whale", "dolphin", "cetacean"], None),
    ("Artiodactyla", ["even-toed ungulate", "ungulate"], None),
    ("Perissodactyla", ["odd-toed ungulate", "ungulate"], None),
    ("Marsupialia", ["marsupial"], None),
    ("Mammalia", ["mammal"], "Mammals"),
    ("pan-Lissamphibia", ["amphibian"], "Amphibians"),
    ("Chondrichthyes", ["shark", "ray", "cartilaginous fish", "fish"], "Fish"),
    ("Actinopterygii", ["ray-finned fish", "fish"], "Fish"),
    ("Coleoptera", ["beetle"], None),
    ("Lepidoptera", ["butterfly", "moth"], None),
    ("Diptera", ["fly"], None),
    ("Hymenoptera", ["bee", "ant", "wasp"], None),
    ("Insecta", ["insect"], None),
    ("Araneae", ["spider"], None),
    ("Arachnida", ["arachnid"], None),
    ("Malacostraca", ["crustacean", "crab", "shrimp"], None),
    ("Trilobita", ["trilobite", "fossil"], None),
    ("Arthropoda", ["arthropod"], "Arthropods"),
    ("Cephalopoda", ["cephalopod", "octopus", "squid"], None),
    ("Gastropoda", ["snail", "slug", "gastropod"], None),
    ("Bivalvia", ["bivalve", "clam"], None),
    ("Mollusca", ["mollusc"], "Molluscs"),
    ("Nematoda", ["nematode", "roundworm", "worm"], "Worms"),
    ("Annelida", ["annelid", "worm"], "Worms"),
    ("Platyhelminthes", ["flatworm", "worm"], "Worms"),
    ("Cnidaria", ["cnidarian", "jellyfish", "coral"], None),
    ("Echinodermata", ["echinoderm", "starfish", "sea urchin"], None),
    ("Porifera", ["sponge"], None),
    ("Metazoa", ["animal"], "Animals"),
    ("Gramineae", ["grass"], None),
    ("Coniferae", ["conifer"], None),
    ("Angiospermae", ["flowering plant"], None),
    ("Viridiplantae", ["plant"], "Plants"),
    ("Fungi", ["fungus"], "Fungi"),
    ("Eubacteria", ["bacterium", "bacteria", "microbe"], "Bacteria"),
    ("Methanobacteriati", ["archaeon", "archaea", "microbe"], "Archaea"),
    ("Thermoproteota", ["archaeon", "archaea", "microbe"], "Archaea"),
    ("viruses", ["virus"], "Viruses"),
    ("Rhodoplantae", ["red alga", "alga", "seaweed"], "Algae"),
    ("Phaeophyceae", ["brown alga", "alga", "seaweed", "kelp"], "Algae"),
    ("Diatomea", ["diatom", "alga"], "Algae"),
    ("Amoebozoa", ["amoeba", "protist"], "Protists"),
    ("Ciliophora", ["ciliate", "protist"], "Protists"),
    ("Foraminifera", ["foraminiferan", "protist"], "Protists"),
    ("Radiolaria", ["radiolarian", "protist"], "Protists"),
    ("Sar", ["protist"], "Protists"),
]


def _phylopic(path: str, params: dict | None = None) -> dict:
    r = None
    for i in range(3):
        try:
            r = S.get(PHYLOPIC_API + path, params=params, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"phylopic {path} {params}: {getattr(r, 'status_code', 'no answer')}")


def phylopic_build() -> int:
    """The current build of PhyloPic's data (the API root redirects to `/?build=N`); every
    listing is asked for at one build. It changes whenever PhyloPic's data does."""
    for i in range(3):
        try:
            r = S.get(PHYLOPIC_API + "/", timeout=TIMEOUT, allow_redirects=False)
            if m := re.search(r"build=(\d+)", r.headers.get("location", "")):
                return int(m.group(1))
        except requests.RequestException:
            pass
        time.sleep(3 * (i + 1))
    raise RuntimeError("phylopic: no build")


def _phylopic_pages(path: str, build: int, params: dict, embed: bool) -> list:
    """Every item of a paged listing (48 a page), embedded records or `_links` entries."""
    first = _phylopic(path, {"build": build, **params})
    pages = first.get("totalPages", 0)

    def page(n):
        d = _phylopic(path, {"build": build, "page": n, **params, **({"embed_items": "true"} if embed else {})})
        return d["_embedded"]["items"] if embed else d["_links"]["items"]

    with cf.ThreadPoolExecutor(8) as ex:
        out = [x for p in ex.map(page, range(pages)) for x in p]
    if len(out) != first.get("totalItems", len(out)):
        raise RuntimeError(f"phylopic {path}: listed {len(out)} of {first.get('totalItems')}")
    return out


def phylopic_listing(build: int) -> tuple[list[dict], dict[str, list[tuple]]]:
    """(every image record at `build`, {image uuid: [PHYLOPIC_CLADES entries it falls in]})."""
    images = _phylopic_pages("/images", build, {}, True)
    clades: dict[str, list[tuple]] = {}
    for entry in PHYLOPIC_CLADES:
        found = _phylopic("/nodes", {"build": build, "filter_name": entry[0].lower(), "page": 0, "embed_items": "true"})
        # A name can also be another node's synonym (Squamata on Pholidota): match the node's own first name.
        nodes = [n for n in found.get("_embedded", {}).get("items", []) if n["names"] and n["names"][0][0]["text"] == entry[0]]
        if len(nodes) != 1:
            raise RuntimeError(f"phylopic: clade {entry[0]} matched {len(nodes)} nodes")
        for link in _phylopic_pages("/images", build, {"filter_clade": nodes[0]["uuid"]}, False):
            uuid = link["href"].split("/images/", 1)[1].split("?", 1)[0]
            clades.setdefault(uuid, []).append(entry)
    return images, clades


def phylopic_item(rec: dict, clades: list[tuple], svg, png=None):
    links = rec["_links"]
    title = links["self"].get("title") or (links.get("specificNode") or {}).get("title") or ""
    group = next((g for _, _, g in clades if g), "Other organisms")
    tags = [t for _, ts, _ in clades for t in ts] + [c for c, _, _ in clades if c not in ("Metazoa", "Eubacteria", "viruses", "Sar")]
    general = (links.get("generalNode") or {}).get("title")
    if general and general != title:
        tags.append(general)
    cats = [f"Organisms / {group}"]
    if common := model_organism(title):
        if not is_human(title):  # a person, not a lab organism
            cats.insert(0, "Model organisms")
        tags = common + tags
    tags.append("silhouette")
    return item("phylopic", rec["uuid"], title, tags=list(dict.fromkeys(tags)), category=", ".join(cats),
                license=links["license"]["href"], author=rec.get("attribution") or "",
                url=f"https://www.phylopic.org/images/{rec['uuid']}", svg=svg, png=png,
                description=f"Silhouette of {title}" + (f" ({', '.join(common)})" if common else ""))


def phylopic_records(build: int) -> list[tuple[dict, list[tuple]]]:
    images, clades = phylopic_listing(build)
    return [(rec, clades.get(rec["uuid"], [])) for rec in images if PHYLOPIC_LICENSES.get(rec["_links"]["license"]["href"])]


def phylopic():
    src = "phylopic"
    recs = phylopic_records(phylopic_build())

    def one(rc):
        rec, cl = rc
        rel = Path("files") / f"{rec['uuid']}.svg"
        return phylopic_item(rec, cl, str(rel)) if download(rec["_links"]["vectorFile"]["href"], ROOT / src / rel) else None

    with cf.ThreadPoolExecutor(8) as ex:
        write_items(src, [it for it in ex.map(one, recs) if it])


# ----------------------------------------------------------------------------
# TogoTV: DBCLS's life-science pictures (https://togotv.dbcls.jp/en/pics.html), all CC BY 4.0.
TOGOTV_API = "https://togotv-api.dbcls.jp/api/entries?target=pictures"
TOGOTV_FILES = "https://dbarchive.biosciencedbc.jp/data/togo-pic/image/"
# Not pictures of science: lab door signs and labels (mostly Japanese text), TogoTV's own
# copyright logos, and sheets of other pictures.
TOGOTV_SKIP_TAGS = {"Signage", "Use cases"}
# Society collections, not subjects: their pictures are placed by their first other tag.
TOGOTV_COLLECTIONS = {"JSHG WebCast", "JSPG", "KBG", "Icon"}
# taxon1_en (mostly a class) -> organism group
TOGOTV_GROUPS = {
    "Arthropods": {"Insecta", "Arachnida", "Merostomata", "Malacostraca", "Branchiopoda", "Lepidoptera", "Coleoptera",
                   "Odonata", "Trilobita"},
    "Plants": {"Angiosperms (Magnoliopsida)", "Bryopsida", "Chlorophyceae", "Taraxacum", "Saxifragales", "Cupressales",
               "Gymnosperms", "Ericales", "Rosales", "Sapindales", "Pinopsida", "Marchantiopsida", "Zygnematophyceae"},
    "Bacteria": {"Gammaproteobacteria", "Actinomycetes"},
    "Fungi": {"Saccharomycetes", "Ascomycota"},
    "Protists": {"Oligohymenophorea", "Oxymonadida", "Trichomonadida", "Heterotrichea", "Euglenophyceae"},
}


def togotv_listing() -> tuple[int, list[dict]]:
    """(how many pictures TogoTV has, every picture's record). `from` is a page number; the
    API answers 500 for pages much over 5,000 rows."""
    data, page, found = [], 1, None
    while found is None or len(data) < found:
        r = get(f"{TOGOTV_API}&from={page}&rows=2000", allow_404=False)
        if r is None or r.status_code != 200:
            raise RuntimeError(f"togotv: no listing page {page}")
        body = r.json()
        found = body["numfound"]
        if not body["data"]:
            break
        data += body["data"]
        page += 1
    if len({d["TogoTV_Image_ID"] for d in data}) != found:
        raise RuntimeError(f"togotv: listed {len(data)} of {found}")
    return found, data


def _togotv_list(s) -> list[str]:
    return [t.strip() for t in re.split(r"[,/]", s or "") if re.search(r"\w", t)]


def togotv_keep(rec: dict) -> bool:
    labels = set(_togotv_list(rec.get("other_tags_en"))) | set(_togotv_list(rec.get("other_tags_comma_en")))
    return bool(rec.get("png") or rec.get("svg")) and not labels & TOGOTV_SKIP_TAGS \
        and not (rec.get("name_en") or "").lower().startswith("togopic")


def togotv_item(rec: dict, svg, png):
    tags = _togotv_list(rec.get("other_tags_comma_en"))
    labels = [t for t in _togotv_list(rec.get("other_tags_en")) if t not in TOGOTV_COLLECTIONS]
    if not labels:  # a society collection: its first subject tag
        labels = [t for t in tags if t not in TOGOTV_COLLECTIONS][:1]
    taxon, sci = rec.get("taxon1_en") or "", rec.get("scientific_name") or ""
    title = next((t for t in (rec.get("name_en"), sci, rec.get("name")) if re.search(r"\w", t or "")), "")
    title = re.sub(r"\s+", " ", title).strip()
    common = model_organism(sci, title)
    if taxon or "Organisms" in labels or (not labels and not tags):
        group = next((g for g, ts in TOGOTV_GROUPS.items() if taxon in ts), "Animals" if taxon else "")
        labels = [f"Organisms / {group}" if (l == "Organisms" and group) else l for l in labels if l != "Fossil organisms"] \
            or ([f"Organisms / {group}"] if group else ["Organisms"])
        if "Fossil organisms" in _togotv_list(rec.get("other_tags_en")):
            tags.append("fossil")
    if common:
        # Pictures of an organism, not of a body part or a condition (TogoTV draws many for Homo sapiens).
        if any(l.startswith("Organisms") for l in labels) and not is_human(sci, title):
            labels.insert(0, "Model organisms")
        tags = common + tags
    tags += [t for t in (sci, taxon, rec.get("taxon2_en")) if t]
    tags = [t for t in dict.fromkeys(tags) if t not in TOGOTV_COLLECTIONS and re.search(r"\w", t)]
    # No author: TogoTV's own staff drew it, and the source in the credit line already names them.
    author = re.sub(r"<[^>]+>", "", rec.get("author_str") or "").strip()
    lic = rec.get("license") or ""
    lic = lic if lic.startswith("https://creativecommons.org/") else "https://creativecommons.org/licenses/by/4.0/"
    desc = rec.get("Description_small_en") or ""
    if sci and sci.lower() != title.lower():
        desc = f"{sci}. {desc}".strip()
    return item("togotv", rec["TogoTV_Image_ID"], title, tags=tags, category=", ".join(dict.fromkeys(labels)),
                license=lic, author=author, url=rec.get("id") or "https://togotv.dbcls.jp/en/pics.html",
                svg=svg, png=png, description=desc)


def togotv():
    src = "togotv"
    _, recs = togotv_listing()

    def one(rec):
        out = {}
        for kind in ("svg", "png"):
            if rec.get(kind):
                rel = Path("files") / rec[kind]
                out[kind] = str(rel) if download(TOGOTV_FILES + rec[kind], ROOT / src / rel) else None
        return togotv_item(rec, out.get("svg"), out.get("png")) if any(out.values()) else None

    with cf.ThreadPoolExecutor(4) as ex:
        write_items(src, [it for it in ex.map(one, [r for r in recs if togotv_keep(r)]) if it])


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


def discover_noto(known, prev, work):
    tag = noto_release()
    if prev and prev.split("+", 1)[0] == tag:
        return prev, None, []
    ver, listing = noto_listing(tag, work)
    raw = f"https://raw.githubusercontent.com/{NOTO_REPO}/{tag}"
    new = [noto_item(rec, path, lic, tag, f"{raw}/{target}") for rec, path, lic, target in listing if rec["hexcode"] not in known]
    return f"{tag}+{ver}", len(listing), new


def reactome_listing() -> dict:
    """{icon id: search-API entry}, or {icon id: {}} if the search API is down (it answered 500
    for Icon queries in 2026-10) and the ids had to come from the icon-lib category pages.
    The icon-lib-{svg,png}.tgz archives are gone (404 as of 2026-11)."""
    r = get("https://reactome.org/ContentService/search/query?query=*&types=Icon&rows=5000", allow_404=False)
    if r is not None:
        body = r.json()
        entries = {e["stId"]: e for res in body.get("results", []) for e in res.get("entries", [])}
        if entries and len(entries) >= body.get("numberOfMatches", 0):
            return entries

    def page(url):
        r = get(url, allow_404=False)
        if r is None:  # a partial listing would read as icons having disappeared
            raise RuntimeError(f"could not fetch {url}")
        return r.text

    ids = set()
    for cat in set(re.findall(r'href="/icon-lib/([a-z_]+)"', page("https://reactome.org/icon-lib"))):
        n = 1
        while found := set(re.findall(r"R-ICO-\d+", page(f"https://reactome.org/icon-lib/{cat}?page={n}"))):
            ids |= found
            n += 1
    return dict.fromkeys(ids, {})


def discover_reactome(known, prev, work):
    import hashlib

    listing = reactome_listing()
    sig = hashlib.sha256("\n".join(sorted(listing)).encode()).hexdigest()[:16]
    if sig == prev:
        return sig, None, []
    new = [reactome_item(i, e or reactome_xml_meta(i), f"https://reactome.org/icon/{i}.svg", f"https://reactome.org/icon/{i}.png")
           for i, e in sorted(listing.items()) if i not in known]
    return sig, len(listing), new


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


def discover_phylopic(known, prev, work):
    build = phylopic_build()
    if prev == str(build):
        return prev, None, []
    recs = phylopic_records(build)
    new = [phylopic_item(rec, cl, rec["_links"]["vectorFile"]["href"]) for rec, cl in recs if rec["uuid"] not in known]
    return str(build), len(recs), new


def discover_togotv(known, prev, work):
    import hashlib

    _, recs = togotv_listing()
    recs = [r for r in recs if togotv_keep(r)]
    sig = hashlib.sha256("\n".join(sorted(f"{r['TogoTV_Image_ID']}:{r.get('svg')}:{r.get('png')}" for r in recs)).encode()).hexdigest()[:16]
    if sig == prev:
        return sig, None, []
    new = [togotv_item(r, TOGOTV_FILES + r["svg"] if r.get("svg") else None, TOGOTV_FILES + r["png"] if r.get("png") else None)
           for r in recs if str(r["TogoTV_Image_ID"]) not in known]
    return sig, len(recs), new


DISCOVER = dict(bioicons=discover_bioicons, healthicons=discover_healthicons, noto=discover_noto, openmoji=discover_openmoji,
                phylopic=discover_phylopic, reactome=discover_reactome, scidraw=discover_scidraw, servier=discover_servier,
                togotv=discover_togotv)


SOURCES = dict(bioicons=bioicons, healthicons=healthicons, noto=noto, openmoji=openmoji, phylopic=phylopic,
               reactome=reactome, scidraw=scidraw, servier=servier, togotv=togotv)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+", choices=list(SOURCES) + ["all"])
    a = ap.parse_args()
    for s in (list(SOURCES) if "all" in a.sources else a.sources):
        SOURCES[s]()
