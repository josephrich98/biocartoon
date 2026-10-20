# biocartoon

Search and download the [BioCartoon](https://biocartoon.com) catalog of over 13,000
open-licensed scientific illustrations (NIH BioArt, Bioicons, Servier Medical Art, SciDraw,
Health Icons, Reactome, OpenMoji) from a shell, a script, or an MCP client such as Claude.

```bash
pip install biocartoon        # or: pipx install biocartoon / uv tool install biocartoon
```

This installs the `biocartoon` command, a single compiled program with no Python dependencies.
The first command that needs the catalog downloads it (about 19 MB); `biocartoon sync` updates it.

```bash
biocartoon search "pyramidal neuron" --source BA            # best matches, one per title
biocartoon search mitochondria --category cells.organelles_and_cell_components
biocartoon --sources                                        # collection codes (BA, BI, SV, ...)
biocartoon --categories                                     # category slugs (cells.cell_types, ...)
biocartoon get bioart/424_633913                            # license, credit, PNG/SVG URLs, variants
biocartoon fetch bioart/424_633913 --svg --out ~/Desktop    # download the SVG (or the PNG)
biocartoon search "select license, count(*) from assets group by 1"   # read-only SQL
biocartoon --version                                        # when the local catalog was published
claude mcp add biocartoon -- biocartoon mcp                 # serve the tools (icons and shared templates) to an assistant
```

Every command takes `--json`. Run `biocartoon --help` for everything, and see the
[repository](https://github.com/josephrich98/biocartoon#command-line-interface-and-mcp-server)
for more examples. The BioCartoon desktop editor ships a fuller `biocartoon` that also searches
slide templates and drives the running editor (`biocartoon app ...`).

Every illustration keeps its own upstream license (public domain, CC0, CC BY, CC BY-SA, ...):
credit it as its `credit` field says. The program itself is BSD-2-Clause.
