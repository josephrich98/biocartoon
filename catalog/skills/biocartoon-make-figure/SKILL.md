---
name: biocartoon-make-figure
description: Make a whole scientific figure (a process, pathway, life cycle, experiment workflow, cell-cell interaction or comparison) from BioCartoon's open-licensed icons, laid out with labels, arrows and a title, then hand it over as an editable BioCartoon project with PNG/SVG downloads and credits. Use when asked to "make a figure / diagram / schematic / graphical abstract of X", "illustrate how X works", "draw the pathway from A to B", "a figure for my slide or paper showing ...", or to change such a figure ("swap the virus icon", "add a step", "make the arrow an inhibitor"). Not for data charts.
---

# Make a BioCartoon figure

`compose_figure` builds the figure on the BioCartoon server. It finds a catalog icon for each element, lays
the figure out, draws the arrows and labels, shows the result in the BioCartoon gallery, and returns a link
that opens it in the BioCartoon editor as the user's own copy. You plan the figure and check the result.

## 1. Plan it

Turn the request into elements and connections:

- **elements**: the 2–12 things to depict, each with a short `label` (printed under the picture) and a
  `query` of one to three plain words naming the thing ("T cell", "mitochondrion", "lab mouse",
  "centrifuge"). Use concrete, drawable things. "Activation" is a verb, so it belongs on an arrow;
  "G1 phase" is a stage, so pick what it looks like, or accept a box.
- **connections**: `from` → `to`, with `kind` set to `arrow` (default), `inhibit` (flat bar head), `double`,
  `line`, `equilibrium` or `dashed`, and an optional short `label` ("secretes", "binds").
- **layout**: leave it at `auto`. It picks `flow` (left to right) for a pathway, `cycle` for one closed loop,
  `hub` when one element connects to all the others, and `grid` with no arrows. Set it only to override that.
- **title**: optional, short.
- **sources**: optional. One collection (`["bioart"]`, `["servier"]`, ...) keeps the style consistent.

```json
{"title": "Antigen presentation",
 "elements": [{"id": "v", "label": "Virus"}, {"id": "d", "label": "Dendritic cell"},
              {"id": "t", "label": "Helper T cell", "query": "T cell"}, {"id": "b", "label": "B cell"}],
 "connections": [{"from": "v", "to": "d", "label": "engulfed"}, {"from": "d", "to": "t", "label": "presents antigen"},
                 {"from": "t", "to": "b", "label": "activates"}]}
```

A bare `prompt` also works (the server plans it), but your own plan is better.

## 2. Check what it picked

The reply lists each element with the icon chosen and how well it matched:
- `strong`: every word of the query was found in the icon's title or tags.
- `weak`: only some were. Look at the icon (`asset_image`) before you trust it.
- `placeholder`: the library has nothing that fits, so the figure has an empty labelled box.

Fix weak or wrong picks by calling `compose_figure` again with `figure` set to the returned `figure.spec`,
edited: change that element's `query`, or set its `asset_id` to an icon you found with `search_assets`.
Keep `asset_id` on the elements that are fine, so they stay the same. Tell the user plainly about
placeholder boxes. Offer to draw the missing icon (the `biocartoon-create-icon` skill), then use it by its
`asset_id` once it is in the library, or let the user fill the box in the editor.

## 3. Hand it over

- The gallery shows the figure. Its **Edit** button sends the user's change request back to you with the
  figure's spec. **Download** gives an SVG or PNG. **Open in BioCartoon** opens the editable project.
- Without the gallery, give the user the `open_url` link from the reply. `open_in_biocartoon` makes a new
  link for a figure spec, a single icon (`asset_id`) or a template (`template_id`).
- Always give the credit lines (in the reply). Each icon keeps its own license, and CC BY icons must be
  credited wherever the figure is used.

## Edits

For "swap X", "add a step", "make it an inhibitor" or "change the title": take the last `figure.spec`,
change only what was asked, and call `compose_figure` with it as `figure`. For finer work (moving things,
fonts, colours), point the user to Open in BioCartoon.
