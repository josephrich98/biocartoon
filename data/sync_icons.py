#!/usr/bin/env python3
"""Submit the icons in icons/ that the catalog doesn't have to the review queue.

    python data/sync_icons.py                     # dry run (default): report, submit nothing
    python data/sync_icons.py --todo              # icons still needing metadata, with their <desc>
    python data/sync_icons.py --apply --limit 5   # submit the first five that are ready
    python data/sync_icons.py --apply zebra wolf  # submit just these
    python data/sync_icons.py --forget zebra      # it was rejected: let it be submitted again

An icon is matched to the catalog by the SHA-256 of its SVG, so each one is:
  published  the master DB has this exact file
  new        never submitted: goes in as a new asset, and needs an entry in icons/metadata.json
  changed    an earlier version is published: goes in as an update of it, keeping its catalog id
  pending    this exact file was submitted and has not been published yet; skipped
  stale      redrawn while an earlier version is still pending: reject that one, then --forget

Submitting only fills the review queue (`biocartoon upload`, so the CLI's checks apply); nothing
reaches the catalog until it is approved and published. More than 20 a day, and any update, need
an upload key in BIOCARTOON_UPLOAD_KEY.

icons/metadata.json holds what the catalog can't work out (the /icon-metadata skill fills it in):

    {"_defaults": {"credit": "...", "license": "CC0-1.0", "ai_description": "...", "official": true},
     "zebra": {"title": "Zebra", "description": "...", "category": "organisms.animals", "tags": ["..."]}}

An entry can override any default; `"ai": false` in place of `ai_description` says no generative
AI was used. A changed icon needs no entry: it keeps its published details unless it has one.

icons/.sync-ledger.json records what has been submitted, and which catalog entry each file name
became, which the file's hash alone can't say once it is redrawn. The review queue can't be read
from here, so the ledger is how a file is known to be pending. Even a dry run updates it, from
what is published; only --apply submits.

Exit status: 0 fine, 2 something needs a look, 1 failed.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import uploads

DATA = Path(__file__).resolve().parent
PER_DAY_WITHOUT_KEY = 20  # MAX_PER_IP_PER_DAY in worker/src/limits.ts
MAX_TITLE, MAX_DESCRIPTION = 80, 500
DESC = re.compile(r"<desc>(.*?)</desc>", re.S)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def save_json(path: Path, value: dict):
    """Written whole and then renamed, so a run that dies never leaves half a ledger."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


def classify(name: str, sha: str, ledger: dict, by_sha: dict) -> str:
    """The icon's state (see the module docstring), bringing its ledger entry up to date."""
    row = by_sha.get(sha)
    if row:
        ledger[name] = {"sha": sha, "id": row["id"], "slug": row["source_id"]}
        return "published"
    e = ledger.get(name)
    if e is None:
        return "new"
    if e.get("submission") and e["sha"] == sha:
        return "pending"
    if e.get("submission"):
        row = by_sha.get(e["sha"])
        if row is None:
            return "stale"
        # What was pending has been published, and the file has been redrawn since.
        ledger[name] = e = {"sha": e["sha"], "id": row["id"], "slug": row["source_id"]}
    return "changed" if e.get("slug") else "new"


def problems(meta: dict, defaults: dict, categories: set[str]) -> list[str]:
    """What is wrong with a new icon's metadata; empty when it can be submitted."""
    m = {**defaults, **meta}
    out = []
    for field, limit in (("title", MAX_TITLE), ("description", MAX_DESCRIPTION)):
        v = m.get(field)
        if not isinstance(v, str) or not v.strip():
            out.append(f"no {field}")
        elif len(v) > limit:
            out.append(f"{field} is {len(v)} characters (limit {limit})")
    if m.get("category") not in categories:
        out.append(f"category {m.get('category')!r} is not a slug from `biocartoon --categories`")
    tags = m.get("tags")
    if not isinstance(tags, list) or not tags or len(tags) > uploads.MAX_TAGS:
        out.append(f"needs 1 to {uploads.MAX_TAGS} tags")
    else:
        out += [f"bad tag {t!r}" for t in tags
                if not isinstance(t, str) or not t.strip() or "," in t or len(t) > uploads.MAX_TAG_CHARS]
    if m.get("license") not in uploads.LICENSES:
        out.append(f"license {m.get('license')!r}")
    if not m.get("credit"):
        out.append("no credit")
    if m.get("ai") is not False and not m.get("ai_description"):
        out.append('no ai_description (or "ai": false)')
    if m.get("license") == "CC-BY-4.0" and m.get("ai") is not False:
        out.append("CC-BY-4.0 is only for artwork made without generative AI")
    return out


def upload_args(path: Path, meta: dict, defaults: dict, update: str | None, official: bool) -> list[str]:
    """The `biocartoon upload` arguments. An update sends only what its entry says; the CLI keeps
    the published details for the rest. `official` isn't kept, so it is always sent."""
    m = meta if update else {**defaults, **meta}
    a = ["upload", str(path), "--json"]
    for field, flag in (("title", "--title"), ("description", "--description"), ("category", "--category"),
                        ("credit", "--credit"), ("license", "--license"), ("ai_description", "--ai-description")):
        if m.get(field) and not (field == "ai_description" and m.get("ai") is False):
            a += [flag, m[field]]
    if m.get("tags"):
        a += ["--tags", ",".join(m["tags"])]
    if m.get("ai") is False:
        a.append("--no-ai")
    if official:
        a.append("--official-biocartoon")
    if update:
        a += ["--update", f"user/{update}"]
    return a


def submit(cli: str, args: list[str]) -> tuple[str | None, str | None, bool]:
    """Run the CLI; -> (submission id, error, whether to stop trying the rest)."""
    r = subprocess.run([cli, *args], capture_output=True, text=True)
    try:
        row = json.loads(r.stdout)[0]
    except (ValueError, IndexError, KeyError):
        return None, (r.stderr or r.stdout).strip() or f"exit {r.returncode}", True
    if row.get("status") == "pending" and row.get("id"):
        return row["id"], None, False
    error = row.get("error") or f"unexpected reply: {row}"
    return None, error, error.startswith("stopped: ")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("names", nargs="*", help="only these icons (file names without .svg)")
    ap.add_argument("--apply", action="store_true", help="actually submit")
    ap.add_argument("--limit", type=int, help="submit at most N")
    ap.add_argument("--todo", action="store_true", help="list new icons whose metadata is missing or invalid, and exit")
    ap.add_argument("--forget", action="append", default=[], metavar="NAME", help="drop a pending icon from the ledger (repeatable)")
    ap.add_argument("--icons", type=Path, default=DATA.parent / "icons")
    ap.add_argument("--db", default=str(DATA / "assets.sqlite"))
    a = ap.parse_args()

    # Two runs at once could each submit the same icons.
    lock = os.open(a.icons, os.O_RDONLY)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("another sync_icons.py is running")

    cli = shutil.which("biocartoon") or sys.exit("biocartoon isn't on PATH (activate the biocartoon conda env)")
    ledger_path, metadata_path = a.icons / ".sync-ledger.json", a.icons / "metadata.json"
    ledger, metadata = load_json(ledger_path), load_json(metadata_path)
    defaults = metadata.get("_defaults", {})

    for name in a.forget:
        entry = ledger.get(name)
        if not entry or not entry.get("submission"):
            print(f"not pending: {name}")
        elif entry.get("slug"):  # a rejected update: back to the version still published
            ledger[name] = {k: entry[k] for k in ("id", "slug", "published_sha") if k in entry}
            ledger[name]["sha"] = entry.get("published_sha", "")
            print(f"forgot the pending update of {name}")
        else:
            del ledger[name]
            print(f"forgot {name}")
    if a.forget:
        save_json(ledger_path, ledger)
        return 0

    con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute("SELECT id, source_id, source_name, title, svg_sha256 FROM assets WHERE source = 'user'").fetchall()
    con.close()
    by_sha = {r["svg_sha256"]: r for r in rows if r["svg_sha256"]}
    by_id = {r["id"]: r for r in rows}
    categories = {c["slug"] for c in json.loads(subprocess.run([cli, "--categories", "--json"], capture_output=True, text=True, check=True).stdout)}

    files = sorted(a.icons.glob("*.svg"))
    unknown = set(a.names) - {f.stem for f in files}
    if unknown:
        sys.exit(f"no such icon: {', '.join(sorted(unknown))}")

    state = {f.stem: classify(f.stem, sha256(f), ledger, by_sha) for f in files}
    save_json(ledger_path, ledger)

    # A second icon under a title already taken would be indistinguishable in the library.
    titles: dict[str, str] = {r["title"].lower(): f"published as {r['id']}" for r in rows if r["title"]}
    why: dict[str, list[str]] = {}
    for f in files:
        name = f.stem
        if state[name] == "new":
            meta = metadata.get(name, {})
            why[name] = problems(meta, defaults, categories) if meta else ["no metadata"]
            title = str(meta.get("title", "")).strip().lower()
            if title and title in titles:
                why[name].append(f"title {meta['title']!r} is already used ({titles[title]})")
            elif title:
                titles[title] = f"by {name}"
        if state[name] in ("new", "changed"):
            bad = uploads.svg_problem(f.read_bytes())
            if bad:
                why.setdefault(name, []).append(f"the Worker would refuse this SVG: {bad}")

    if a.todo:
        for f in files:
            if state[f.stem] == "new" and why.get(f.stem) and (not a.names or f.stem in a.names):
                d = DESC.search(f.read_text())
                print(f"{f.stem}\t{' '.join(d.group(1).split()) if d else ''}")
        return 0

    counts = {s: sum(v == s for v in state.values()) for s in ("published", "pending", "new", "changed", "stale")}
    print(", ".join(f"{n} {s}" for s, n in counts.items()))
    attention = 0
    for name, s in state.items():
        if s == "stale":
            print(f"!! {name}: redrawn while submission {ledger[name]['submission']} is pending; reject it, then --forget {name}")
            attention += 1
    blocked = [n for n, w in why.items() if w and (not a.names or n in a.names)]
    no_metadata = [n for n in blocked if why[n] == ["no metadata"]]
    if no_metadata:
        print(f"{len(no_metadata)} new icons have no metadata yet (run /icon-metadata, or see --todo)")
    for n in blocked:
        if why[n] != ["no metadata"]:
            print(f"!! {n}: {'; '.join(why[n])}")
            attention += 1

    todo = [f for f in files if state[f.stem] in ("new", "changed") and not why.get(f.stem) and (not a.names or f.stem in a.names)]
    if a.limit is not None:
        todo = todo[:a.limit]
    print(f"{len(todo)} ready to submit" + ("" if a.apply else " (dry run: pass --apply)"))
    if not a.apply:
        for f in todo:
            print(f"    {state[f.stem]:8} {f.stem}  {metadata.get(f.stem, {}).get('title', '')}")
        return 2 if attention else 0

    has_key = bool(os.environ.get("BIOCARTOON_UPLOAD_KEY", "").strip())
    if not has_key and (len(todo) > PER_DAY_WITHOUT_KEY or any(state[f.stem] == "changed" for f in todo)):
        sys.exit(f"set BIOCARTOON_UPLOAD_KEY: updates need it, and without it the server takes {PER_DAY_WITHOUT_KEY} a day")

    submitted = 0
    for i, f in enumerate(todo):
        name, sha = f.stem, sha256(f)
        old = ledger.get(name, {}) if state[name] == "changed" else {}
        row = by_id.get(old.get("id"))
        official = row["source_name"] == "BioCartoon" if row else {**defaults, **metadata.get(name, {})}.get("official") is True
        sid, error, stop = submit(cli, upload_args(f, metadata.get(name, {}), defaults, old.get("slug"), official))
        if error:
            print(f"!! {name}: {error}")
            attention += 1
            if stop:
                print(f"stopped; {len(todo) - i - 1} not tried")
                break
            continue
        entry = {"sha": sha, "submission": sid, "submitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        if old:
            entry.update(id=old["id"], slug=old["slug"], published_sha=old["sha"])
        ledger[name] = entry
        save_json(ledger_path, ledger)  # after every one, so a crash can't submit it twice
        submitted += 1
        print(f"    {state[name]:8} {name}  -> {sid}")
    print(f"{submitted} submitted for review")
    return 2 if attention else 0


if __name__ == "__main__":
    sys.exit(main())
