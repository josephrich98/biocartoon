<p align="center">
  <img src="https://raw.githubusercontent.com/josephrich98/biocartoon-app/main/app/assets/logo.svg" alt="BioCartoon logo" width="160">
</p>

# BioCartoon

BioCartoon is a free and open-source tool for creating biology figures with illustrations. It
compiles existing open biology-focused illustration resources, along with its own illustrations,
into a single database with a graphical interface for search and figure generation.

This package is the `biocartoon` command-line interface and MCP server, which search and download
the database from a shell, a script, or an assistant such as Claude.

## Usage

Web application: [app.biocartoon.com](https://app.biocartoon.com)

Install Desktop application: [www.biocartoon.com/download](https://www.biocartoon.com/download)

## Resources

15,335 icons and 6 templates across 8 resources.

| source | icons | license |
|---|---|---|
| [BioCartoon](https://www.biocartoon.com) | 1 | CC0 |
| [Bioicons](https://bioicons.com) | 2,793 | CC BY / CC0 / CC BY-SA / MIT / BSD |
| [Health Icons](https://healthicons.org) | 749 | CC0 |
| [NIAID NIH BioArt Source](https://bioart.niaid.nih.gov) | 936 | Public Domain |
| [OpenMoji](https://openmoji.org) | 4,495 | CC BY-SA 4.0 |
| [Reactome icon library](https://reactome.org/icon-lib) | 2,569 | CC BY 4.0 |
| [SciDraw](https://scidraw.io) | 772 | CC BY 4.0 / CC0 |
| [Servier Medical Art](https://smart.servier.com) | 3,020 | CC BY 4.0 |

## Command-Line Interface and MCP server

```bash
pip install biocartoon        # or: pipx install biocartoon / uv tool install biocartoon
```

The package is the compiled program alone, with no Python dependencies. The first command that
needs the catalog downloads it; `biocartoon sync` updates it. This build searches icons; its MCP
server also lists the shared slide templates. The BioCartoon desktop editor ships a fuller
`biocartoon` that adds templates to `search` and the `app` command.

- `biocartoon search "TERM"`: icons and templates matching TERM, best first. With no TERM it pages
  through everything.
    - `--icons` / `--templates`: only that kind
    - `--source S`: icons from one collection (a code or name from `biocartoon --sources`)
    - `--category C`: icons in one category (a slug from `biocartoon --categories`)
    - `--sql`: run TERM as read-only SQL on the catalog
- `biocartoon get ID`: everything about one icon: license, credit, PNG/SVG URLs, colour variants
- `biocartoon fetch ID`: download the PNG (`--svg` for the SVG, `--out FILE|DIR`, `--max-side N`)
- `biocartoon sync`: download the newest published catalog
- `biocartoon upload FILE...`: submit image files/folders to the database (approval required to merge in)
- `biocartoon mcp`: serve the same tools over MCP, mostly for agents (e.g., `claude mcp add biocartoon -- biocartoon mcp`)
- `biocartoon --version`: the program's version, and when the local catalog was published and downloaded
- `biocartoon --sources`: list icon sources for `biocartoon search --source S`
- `biocartoon --categories`: list icon categories for `biocartoon search --category C`

Run `biocartoon --help` for everything.

## Examples

Find an icon, check its license, and download it:

```bash
$ biocartoon search mitochondria --icons --limit 2
bioart/353_641587                  bioart       Mitochondria  (Cells and Organelles; 2084x2084)  matched: title,description
bioart/101_628750                  bioart       Damaged Mitochondria  (Cells and Organelles; 1705x1174)  matched: title,tags,description

$ biocartoon get bioart/424_633913              # credit, license, PNG/SVG URLs, colour variants
$ biocartoon fetch bioart/424_633913 --svg --out ~/Desktop
$ biocartoon fetch bioart/424_633913 --max-side 512 --out neuron.png   # a smaller PNG
```

Contribute your own illustrations (held for review before they are published):

```bash
biocartoon upload figures/ --license CC-BY-4.0 --credit "Your Name" --dry-run   # check first
biocartoon upload figures/ --license CC-BY-4.0 --credit "Your Name" --category cells
```

Narrow a search by collection or category:

```bash
biocartoon --sources                                       # codes: BA, BI, SV, SD, HI, RE, OM, ...
biocartoon --categories                                    # slugs: cells, cells.cell_types, ...
biocartoon search "pyramidal neuron" --source BA           # NIH BioArt only
biocartoon search neuron --source BA --source SD           # BioArt or SciDraw
biocartoon search mitochondria --category cells.organelles_and_cell_components
biocartoon search --category viruses --sort az --limit 40 --offset 40   # page 2 of all viruses
biocartoon --categories --source SD                        # what SciDraw covers
```

Query the catalog with SQL (read-only):

```bash
biocartoon search --sql                                    # the schema
biocartoon search "select license, count(*) as n from assets group by license order by n desc"
biocartoon search --sql "select id, title from assets where svg_key is not null and title like '%ribosome%'"
biocartoon search "with dendrites" --no-sql                # words, even though it starts with WITH
```

From a script: every command takes `--json`, and search results come back as
`{"icons": [...], "templates": [...]}`:

```bash
# download the SVG of the best match that has one (Servier and uploads are PNG only)
mkdir -p icons
for t in neuron astrocyte microglia; do
  id=$(biocartoon search "$t" --icons --limit 10 --json | jq -r '[.icons[] | select(.svg_url)][0].id')
  biocartoon fetch "$id" --svg --out icons/
done
biocartoon get bioart/424_633913 --json | jq -r .credit     # the attribution line to print
```

Keep the local catalog current, and connect an assistant:

```bash
biocartoon sync
claude mcp add biocartoon -- biocartoon mcp
```

The database schema is documented in the
[repository](https://github.com/josephrich98/biocartoon#database-structure).

## License

Copyright (c) 2026 Joseph Rich. The program is open source under the
[BSD 2-Clause License](https://github.com/josephrich98/biocartoon/blob/main/LICENSE). Every
illustration keeps its own upstream license (public domain, CC0, CC BY, CC BY-SA, ...): credit it
as its `credit` field says. See
[NOTICE.md](https://github.com/josephrich98/biocartoon/blob/main/NOTICE.md).

## Other Links

Website: [www.biocartoon.com](https://www.biocartoon.com)

Database and CLI source code: [github.com/josephrich98/biocartoon](https://github.com/josephrich98/biocartoon)

Application and website source code: [github.com/josephrich98/biocartoon-app](https://github.com/josephrich98/biocartoon-app)

Icon SQLite database: [assets.biocartoon.com/catalog/assets.sqlite.gz](https://assets.biocartoon.com/catalog/assets.sqlite.gz)

Template SQLite database: [assets.biocartoon.com/catalog/templates.sqlite.gz](https://assets.biocartoon.com/catalog/templates.sqlite.gz)
