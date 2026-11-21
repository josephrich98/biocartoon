---
name: add-icon-library
description: Add a new upstream icon or illustration collection (a "source", like Noto Emoji or OpenMoji) to the BioCartoon catalog end to end. Covers vetting its license, the scraper and the weekly auto-update, the catalog crate (the editor's left Library panel, badges, categories), the MCP server and Worker, the published catalog in R2, the README icon-count tables (the repo's, the PyPI page's and the app's download page), the biocartoon.com resources table, and NOTICE files. Needs the biocartoon and biocartoon-app repositories checked out side by side. Use when asked to "add <collection> as an icon library", "add a new icon source", "import <repo> icons into BioCartoon", or "support <collection> in the catalog".
---

# Add an icon library to BioCartoon

A library is a **source**: a short lowercase key (`noto`, `openmoji`), a two-letter ID prefix and
badge code (`NE`, `OM`), a display name, and one or more licenses. Its assets live in R2 at
`<source>/<source_id>.{svg,png}` and as rows in the master `data/assets.sqlite`. Every step below
has to name the new source, or something downstream quietly leaves it out.

Noto Emoji was added this way (Nov 2026). Look at how `noto` appears in each file below and copy it.

## Requirements

- `~/code/biocartoon` and `~/code/biocartoon-app` side by side. The app builds the catalog crate
  from `../../biocartoon/catalog`, and `readme_stats.py` writes the app's README.
- The `biocartoon` conda env. R2 credentials in the keychain (`security find-generic-password -s biocartoon-r2 ...`).
- `export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` before anything that rasterizes. Otherwise cairosvg
  loads an x86 libcairo and SVG renders fail.
- Both repos may have uncommitted work of the user's. Edit around it and don't commit unless asked.

## 1. Vet the collection (stop here if it fails)

- **License.** It has to be open for reuse in published figures: PD, CC0, CC BY, CC BY-SA, MIT, BSD or Apache-2.0.
  Read the upstream LICENSE and README yourself. Collections often mix licenses (Noto: Apache-2.0
  for its art, public domain for flags under `third_party/region-flags`). Record the license per item.
  Refuse proprietary sets (Apple, Samsung, WhatsApp, JoyPixels' free tier) and NC/ND licenses.
- **Trademarks.** Leave out logo or brand glyphs. A trademark is restricted whatever the art's license says.
- **Metadata.** Every asset needs a title, and tags and categories make search work. If upstream has none
  (Noto has none), find an openly licensed metadata set keyed the same way. Noto uses `emojibase-data` (MIT),
  whose `group / subgroup` names match OpenMoji's, so it reuses OpenMoji's category rules.
- **A stable id per asset** (`source_id`) that won't change between upstream releases. It becomes the R2 key
  and must never be reused.
- **A cheap change signal** for auto-update: a release tag, commit hash, ETag or sitemap hash.
- Pick the key, display name and a two-letter prefix not already in `ID_PREFIX` or `catalog.rs` `SOURCES`.
  Tell the user the plan (count, licenses, prefix) before writing code.

## 2. Pipeline (`biocartoon/data/`)

| file | add |
|---|---|
| `scrape_sources.py` | `<source>_item()` building `item(...)`; a full `<source>()` download into `data/sources/<source>/`; `discover_<source>(known, prev, work) -> (signal, listed count or None if unchanged, [new items with URL files])`; register in `DISCOVER` and `SOURCES`; docstring license list |
| `build_assets_db.py` | `SOURCE_NAMES`, `ID_PREFIX`, and a `LICENSES` entry for any new raw license string (normalized id, URL, attribution required, share-alike) |
| `sync.py` | `SOURCES`; `NEW_SOURCE_LICENSES[<source>]` = the normalized licenses it may bring (the gate otherwise only admits licenses the source already has in the catalog, which for a new source is none) |
| `rasterize.py` | `SOURCES` (if it ships SVGs) |
| `readme_stats.py` | `DISPLAY` (name and link, as in NOTICE.md) and `EXAMPLES`: five `png_key`s, ideally DNA, cell/microbe, heart, mouse and person, like the other rows |
| `generative_ai.json` | `"sources": {"<source>": null}` (or `false` only if every asset provably predates April 2022) |

Two traps from adding Noto:
- **Don't list files with the GitHub API.** It allows 60 requests an hour without a token, and the weekly
  job and your tests share them. A blob-less clone (`git clone --filter=blob:none --no-checkout --depth 1
  --branch <tag>`, then `git ls-tree -r HEAD`) lists everything without downloading it.
- **Symlinks.** `raw.githubusercontent.com` serves a symlink as its target's name, not as the file, and the
  sync then holds the item as "not an image". Read `ls-tree`'s mode, and for `120000` download the target
  (`git cat-file -p <sha>`). Noto has 8 such flags.

Discovery is the auto-update: `data/schedule/` runs `sync.py` weekly for every source in its
`SOURCES`. Nothing else is needed, but make `discover_` return `listed=None` when the signal hasn't
changed, so the weekly run costs one request.

Test before going further:

```bash
cd ~/code/biocartoon/data
python -c "import scrape_sources as s; sig, n, new = s.discover_<source>(set(), None, None); print(sig, n, len(new)); print(new[0])"
```

Check the license counts, that no category is empty or malformed (Noto's regional-indicator letters
had no group and came out as `" / "`), and that every item has a title. Then stage a handful of items
with `sync.stage_item(B.source_item(...), Path(scratch))`, render the PNGs into a contact sheet, and
**look at it**: gradients, clipping, transparent backgrounds.

## 3. Catalog crate, MCP and Worker (`biocartoon/`)

- `catalog/src/catalog.rs`: a `SOURCES` entry `(key, badge code, name, description)` and its place in
  `SOURCE_ORDER`. The editor's left Library panel and the CLI list databases from these, so this is
  what puts the library in the panel.
- `catalog/src/taxonomy.rs`: map the source's categories to BioCartoon's in `rules()`. Reuse an existing
  `Rules` table if the scheme matches; otherwise write one and add it to `every_rule_lands_in_the_taxonomy`.
- `catalog/src/mcp.rs`: the collection list in `CATALOG_INSTRUCTIONS`, the guidance on when to prefer it,
  the `sources` description, and the `dbs` list for category search.
- `catalog/src/figure_tools.json`: every "Draw icons only from these collections" list.
- `worker/src/mcp_figure.ts`: `SOURCE_BONUS` (science collections near 1; emoji and pictograms 0).
- `catalog/ui/src/gallery.ts`: `SOURCES` display name.
- `catalog/skills/biocartoon-find-icons/SKILL.md`: the per-collection hint, and the collection list in
  its `description`.
- `catalog/README.md` (the PyPI page): nothing by hand. Its resources table is generated between the
  `pypi-stats` markers by the publish step; confirm the new source appears there after it.
- `README.md`: the `id` prefix list, the `source` values, `license` values if new, and the `scrape_sources.py` line.
- `NOTICE.md`: a row in the third-party table.

Regenerate and test, as CI does:

```bash
cd ~/code/biocartoon/catalog/ui && npm run build && npm test     # dist/gallery.html must be rebuilt
cd ~/code/biocartoon/catalog && cargo test --release && cargo build --release --locked --bin biocartoon
python3 ../scripts/build_mcp_metadata.py                         # worker/generated/mcp-metadata.json
cd ~/code/biocartoon/worker && npm test && npm run typecheck
```

## 4. App (`biocartoon-app/`)

- `app/src/theme.rs` `source_badge`: a badge color unlike the others.
- `NOTICE.md`: the same row as biocartoon's.
- `cd app && cargo check`.

## 5. Publish (ask the user first)

Uploading is public and can't be undone. Keys are served `immutable`, and sync only ever adds.
Show the dry run, then get an explicit yes:

```bash
cd ~/code/biocartoon/data
python sync.py --sources <source>                                   # dry run: expect "N new (N pass, 0 held)"
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib python sync.py --sources <source> --force <source> --apply
```

`--force` gets past `--max-new` (300), which exists to catch renamed ids in existing sources.
Expect several thousand uploads to take a while, so run it in the background. The run then publishes the catalog
(`publish_catalog.py`). That regenerates the resources table in `biocartoon/README.md`,
`biocartoon/catalog/README.md` (the PyPI page, which only updates on PyPI with the next release) and the
app's `README.md` (the download page), and syncs the hosted MCP catalog in D1. It also backs up the master
DB. Read the report in `data/sync-reports/`. Items listed as held need `--held`, then `--approve`.

Check that the examples resolve: `curl -sI https://assets.biocartoon.com/<source>/<id>.png`.

## 6. Website (`biocartoon-app/site/public/index.html`)

Its resources table is maintained by hand. Copy the published numbers from the regenerated
`README.md` table:

- the summary line, `N icons and M templates across K resources.`
- a `<tr>` for the new source, in alphabetical order, with the same name, link, count, license and
  five example images as the README row
- the example-icon credits paragraph below the table

Then open the page in a browser at desktop and phone (390px) widths. Confirm the table still scrolls
inside `.table-wrap`, not the page, and that the new images load.

## 7. Report

Tell the user what was added (count per license), the prefix, what was held, and which files changed
in each repo, and leave committing to them unless they ask.
