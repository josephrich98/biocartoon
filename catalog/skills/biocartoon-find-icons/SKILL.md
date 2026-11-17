---
name: biocartoon-find-icons
description: Find open-licensed scientific illustrations (cells, organelles, proteins, organs, animals, lab equipment, pathogens, people) in the BioCartoon library of about 20,000 icons from NIH BioArt, Bioicons, Servier Medical Art, SciDraw, Health Icons, Reactome and OpenMoji, show the best candidates, and download them with the correct credit line. Use when asked to "find an icon/illustration/clipart of X", "get a picture of a mitochondrion for my figure", "what BioCartoon icons are there for X", "download a mouse icon", "browse BioCartoon", or when building a biology figure, slide or poster that needs pictures.
---

# Find BioCartoon icons

BioCartoon is a free catalog of about 20,000 scientific illustrations. Every icon keeps the license of
the collection it came from, so each one used must be credited as its `credit` field says.

## Which tools to use

- **BioCartoon MCP tools** (`search_assets`, `preview_assets`, `get_asset`, ...): use them when they are
  connected (in ChatGPT, claude.ai, or an agent with the `biocartoon` server).
- **The `biocartoon` command** otherwise, when you have a shell. Run `biocartoon --version` to check it
  is installed. If it isn't, install it with `pip install biocartoon` (or `pipx install biocartoon`).
  The first search downloads the catalog (about 3 MB).

| step | MCP tool | command |
|---|---|---|
| search | `search_assets {query, sources?, tags?, limit?}` | `biocartoon search "TERM" --icons --limit 12 --json` |
| look | `preview_assets {ids}`, `asset_image {id}` | `biocartoon fetch ID --max-side 256 --out /tmp/x.png`, then view the file |
| details | `get_asset {id}` | `biocartoon get ID --json` |
| other colours | `asset_variants {id}` | `biocartoon get ID` (lists the variants) |
| SVG markup (to adapt it) | `asset_svg {id}` | `biocartoon fetch ID --svg --out icon.svg` |
| collections | `list_sources`, `list_categories {source}` | `biocartoon --sources`, `biocartoon --categories` |
| download | the `svg_url` / `url` in the result | `biocartoon fetch ID --out DIR` (SVG when there is one) |

## Steps

1. **Turn the request into search words.** Use the plain name of the thing ("pyramidal neuron",
   "mitochondria", "lab mouse", "pipette"). Run separate searches for separate objects. If the user needs
   a particular style, narrow to one collection:
   - `bioart` (NIH BioArt, public domain, detailed), `servier` (Servier Medical Art, CC BY, PNG only),
     `bioicons` and `scidraw` (flat line art) suit biology.
   - `healthicons` has clinical and public-health pictograms.
   - `reactome` has molecules and pathway icons.
   - `openmoji` has emoji-style pictograms.
   - To avoid credit requirements, filter by license: `--license CC0-1.0 --license PD`.

2. **Judge the results.** Search always returns its closest matches, even when nothing fits.
   - A match in the title or tags (`matched_fields`) is strong. A match only in the description is weak.
   - `missing_terms` lists words that matched nothing.
   - When titles are ambiguous, look at the pictures before recommending anything (`preview_assets` takes
     up to 12 ids).
   - Don't present a poor match as a fit. Say plainly when the library has nothing suitable, and offer
     the `biocartoon-create-icon` skill to make one.

3. **Show the user the candidates.** Show the 3–6 best, each with:
   - its id, title and collection
   - its license
   - a preview (the image from `preview_assets`, or the `thumb_url`)

   If the user wants a colour that one drawing doesn't come in, mention its colour variants. If they want
   an icon changed ("like this but ..."), use the `biocartoon-create-icon` skill to adapt it.

4. **Download** the ones the user picks:
   - Prefer the SVG, which scales and can be recoloured. Servier and user uploads are PNG only.
   - With a shell, use `biocartoon fetch ID --out DIR`. Otherwise give the `svg_url` or `url` link.

5. **Credit.** Give the user each icon's `credit` line to paste into the figure legend or the
   acknowledgements:
   - CC BY and CC BY-SA require this credit line.
   - CC BY-SA also requires that the figure be shared under the same license.
   - Public domain and CC0 icons need no credit, but it is good practice to give one.

## Notes

- Ids look like `BA001505`: the two letters are the collection, the number is unique and never reused.
- To lay several icons out on a slide, point the user to the BioCartoon editor
  ([app.biocartoon.com](https://app.biocartoon.com)), which also has whole-slide templates
  (`list_templates`).
- `sql_query` (or `biocartoon search --sql "SELECT ..."`) answers counting and grouping questions, e.g.
  how many CC0 icons of cells there are. Run `db_schema` first.
