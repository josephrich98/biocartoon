# Notices

Copyright (c) 2026 Joseph Rich. Licensed under the BSD 2-Clause License; see [LICENSE](LICENSE).

## BioCartoon's own work

The code in this repository (the data pipeline, the `biocartoon-catalog` crate and CLI, the
submissions Worker) and the documentation are under the BSD 2-Clause License: anyone may use,
modify and redistribute them, in open or closed software, as long as the copyright notice and license text are kept. They are distributed WITHOUT ANY
WARRANTY; see [LICENSE](LICENSE). The BioCartoon editor, web app and website are in
[biocartoon-app](https://github.com/josephrich98/biocartoon-app), under the GNU AGPL v3.0.

## Third-party illustrations and icons

The illustration and icon libraries BioCartoon searches and displays are **not**
covered by the BioCartoon license. Each asset stays under its own upstream license, and the
asset database (`license`, `license_url`, `credit` columns) records the license and credit for
every item. When you use an asset in a figure, follow that asset's license, e.g. credit the
creator for CC BY items and share adaptations of CC BY-SA items under CC BY-SA.

| source | license |
|---|---|
| [BioCartoon](https://biocartoon.com) | CC0 |
| [Bioicons](https://bioicons.com) | CC0 / CC BY / CC BY-SA / MIT / BSD (per icon) |
| [Health Icons](https://healthicons.org) | CC0 |
| [NIAID NIH BioArt Source](https://bioart.niaid.nih.gov) | Public Domain |
| [OpenMoji](https://openmoji.org) | CC BY-SA 4.0 |
| [Reactome icon library](https://reactome.org/icon-lib) | CC BY 4.0 |
| [SciDraw](https://scidraw.io) | CC BY / CC0 (per item) |
| [Servier Medical Art](https://smart.servier.com) | CC BY 4.0 |

## User-contributed artwork

People who contribute templates, illustrations or icons keep the copyright in their work.
BioCartoon does not own it. Each contribution is published under the license its creator
chose when submitting it (CC0 or CC BY 4.0), and that license, not the BSD license, governs its use.
The BioCartoon license covers only the project's own code and the artwork its author made.

Figures you make with BioCartoon are yours. The BioCartoon license does not restrict what
you do with your own output, including publishing it in commercial journals, but the
third-party assets inside a figure keep their own licenses.

Third-party software dependencies are under their own licenses; see `catalog/Cargo.lock` and
`worker/package.json`.
