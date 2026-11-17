---
name: biocartoon-upload
description: Upload image files (SVG, PNG, JPEG, WebP, GIF, BMP, TIFF), one or a whole folder, to the shared BioCartoon library with the `biocartoon upload` command, with a good title, description, tags, category, credit and license for each, after a dry run the user approves. Also submits a new version of an earlier upload (--update) or changes its details. Use when asked to "upload this to BioCartoon", "submit my drawings/icons to BioCartoon", "contribute this folder of illustrations", "publish my SVG to the BioCartoon library", "update my BioCartoon upload", or "fix the title/tags of my upload".
---

# Upload artwork to BioCartoon

`biocartoon upload` sends image files to the shared library. Each one waits for a human reviewer and
joins the catalog (and the BioCartoon app) after the next publish once approved, usually within a few
days. Uploading licenses the artwork to everyone, so **never upload without the user's clear yes**.

To make a new illustration first, use the `biocartoon-create-icon` skill, then come back here to upload
the file. In a chat with no shell, use the MCP tool `submit_artwork` instead (the create skill covers it).

## 0. Check the command

Run `biocartoon --version`. If it isn't installed, install it with `pip install biocartoon` (or
`pipx install biocartoon`).

## 1. Look at what will be uploaded

- List the files. A folder is searched recursively, skipping hidden files.
- Look at each image, so the title and tags describe what it actually shows. Read the text in an SVG
  (`<title>`, `<desc>`, layer names) for hints.
- Leave out files that aren't finished illustrations: screenshots, photos of people, figures with text
  labels, near-duplicates. Ask when unsure.
- Check the library for the same thing (`biocartoon search "TERM" --icons --limit 5`). An icon the user
  uploaded before is better updated (step 5) than uploaded again.

## 2. Settle the details with the user

Propose values and show them to the user:

- **title** (`--title`): what people would search for ("Pyramidal neuron", not "neuron_final_v2").
  Without it, the title comes from the file name (`red_blood_cell.svg` becomes "red blood cell").
- **description** (`--description`): one or two sentences on what it shows (up to 500 characters).
- **tags** (`--tags "neuron, cortex, pyramidal cell"`): 3–10 search words, such as synonyms, the
  organism and the cell type (up to 20, 40 characters each).
- **category** (`--category`): a slug from `biocartoon --categories`, e.g. `cells.cell_types`,
  `anatomy_and_physiology.nervous_system`, `lab_and_techniques.lab_equipment`.
- **credit** (`--credit`): the name to credit. The default is anonymous.
- **license and generative AI**: ask the user how the artwork was made. Don't guess.
  - Made with generative AI, even in part: `--ai` (license CC0-1.0, which `--ai` sets), plus
    `--ai-description "..."` saying how (the model, and what was edited by hand).
  - Made without generative AI: `--no-ai`, and the user's choice of `--license CC0-1.0` (anyone may use
    it, no credit needed) or `--license CC-BY-4.0` (users must credit them; give a `--credit` name).
- **adapted from a library icon**: the original's license decides whether the adaptation may be uploaded
  (see the `biocartoon-create-icon` skill, step 2). If it may, end the description with "Adapted from
  CREDIT (BioCartoon ID)." using the original's `credit` line from `biocartoon get ID`.
- **files the user didn't make**: only upload them if the user may license them (their own work, or the
  original's license allows it). Ask.

Options apply to every file in one command, and `--title` only works with one file. For files that need
different details, run one command per file.

Optional:
- `--layer-color-map "#ff0000:#3366cc"` recolours an SVG's colour layers before uploading.
- `--official-biocartoon` asks for the official BioCartoon library rather than the User-Generated one. A
  reviewer decides.

## 3. Dry run, then confirm

Run the command with `--dry-run` first. It checks the files and options and lists what would be
submitted, without sending anything:

```bash
biocartoon upload neuron.svg --title "Pyramidal neuron" \
  --description "A cortical pyramidal neuron with apical and basal dendrites." \
  --tags "neuron, cortex, pyramidal cell, brain" --category cells.cell_types \
  --credit "Ada Lovelace" --no-ai --license CC-BY-4.0 --dry-run
```

Show the user the dry run and the details. Ask them to confirm two things: they may share the files under
that license, and they want them uploaded. Then run the same command without `--dry-run`. Add `--json`
for the submission ids.

## 4. Report

Give the user each submission id and say what happens next: a reviewer looks at it, and it appears in the
library after the next publish. Check on it with:

```bash
curl "https://api.biocartoon.com/status?ids=ID1,ID2"
```

Each id reports pending, approved or rejected. With MCP, `submission_status` does the same.

## 5. Update an earlier upload

`--update ID` submits a new version of an approved upload (ids like `UG000123`, `BC000123` or
`user/<id>`). Once approved, it replaces the old one and keeps its catalog id. Projects that used the old
image keep it.

```bash
biocartoon upload neuron_v2.svg --update UG000123 --dry-run      # new image, details kept
biocartoon upload --update UG000123 --tags "neuron, cortex" --dry-run   # details only
```

The details not given stay as they were. This needs an upload key that may update that asset:
`--key KEY` or `BIOCARTOON_UPLOAD_KEY`. Never print or store the key. Ask the user to set it in their
own shell if it isn't already set.

## If the upload is refused

The error says why. Common causes:
- **CC-BY-4.0 without `--no-ai`**: ask how it was made, then use `--no-ai` or switch to CC0-1.0.
- **A title or tag the language filter caught**: reword it.
- **An SVG with a forbidden element** (scripts, external links, web fonts, `foreignObject`): remove it, or
  upload a PNG export.
- **An image too large**: shrink it, or use SVG.
- **The daily limit** (20 a day without a key): wait until tomorrow, or upload the rest with a key.

Fix what the error names and run the dry run again. Don't resubmit unchanged.
