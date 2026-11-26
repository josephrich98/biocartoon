---
name: biocartoon-create-icon
description: Make an original scientific illustration (a cell, organelle, protein, organ, organism, lab tool or process) when the BioCartoon library has nothing that fits, in a clean style that matches it, and, if the user wants, submit it to the shared BioCartoon library for review, all from the chat. Use when asked to "draw/make/create an icon of X", "make a BioCartoon-style illustration", "there's no icon for X, make one", "make something like icon BA001505 but with ...", "change the colours / add a nucleus to this icon", "upload/submit/contribute this image to BioCartoon", or "add my drawing to the library". Not for account sign-in, private saved projects, or project/account deletion.
---

# Create a BioCartoon icon and contribute it

## Account-management boundary

BioCartoon's tools cannot sign anyone in, see private saved projects, or delete projects or accounts.
When asked to, answer directly without calling any tool: say the plugin can't do this, and that the user
can delete a project from its menu on the home screen of https://app.biocartoon.com/, or delete their
account and all its projects with "Delete account" in the account menu (top right of that screen).
Do not open a browser, use computer control, run shell commands, or query the catalog to try it, even
when those tools are available, and never claim that a project was accessed or deleted.

The user gets a new illustration for their figure, and everyone else gets it too once a reviewer
approves it. Work in this order: check the library, make the image, confirm the details with the user,
then submit.

## 1. Check the library first

Search for the subject first (see the `biocartoon-find-icons` skill: `search_assets` or
`biocartoon search`).
- If something suitable already exists, offer it instead.
- If something close exists (right subject, wrong colours or angle), show it and ask whether to adapt it
  or start fresh. Check its colour variants (`asset_variants`) first: the colour the user wants may already
  exist.
- Look at two or three neighbouring icons (`preview_assets`) to match the library's style.

## 2. Make the illustration

Choose by what you can do:

- **Draw it as SVG** (any assistant that writes code, like Claude). This is the best format: it scales,
  and the editor can recolour it.
  - Write one self-contained `<svg>` with `xmlns="http://www.w3.org/2000/svg"`, a `viewBox`, and no
    fixed `width`/`height`.
  - Leave a transparent background.
  - Use flat fills with a darker outline (stroke 1.5–3% of the size), a small palette (3–6 colours), and
    simple shapes.
  - Don't use `<script>`, `<foreignObject>`, event handlers, external `href`s, web fonts or embedded
    raster images. The server rejects these.
  - Leave out text labels: users add their own.
  - Show the drawing to the user (an artifact or rendered preview where you can), and refine it until
    they are happy.
- **Adapt a library icon** ("like BA001505 but with ..."):
  - Get its markup with `asset_svg` (or `biocartoon fetch ID --svg --out icon.svg` and read the file).
    Edit that markup rather than redrawing: change only what the user asked for (colours, a part added or
    removed, a different pose), and keep the outline weight, palette and level of detail.
  - `asset_svg` also says whether an adaptation may be submitted, which depends on the original's license:
    - **public domain or CC0** (all NIH BioArt and Health Icons, some Bioicons, SciDraw, PhyloPic and uploads): yes,
      under either license.
    - **CC BY, MIT or BSD**: only as CC-BY-4.0 by a person, without generative AI. So an adaptation you made
      can't be submitted: AI-made submissions must be CC0, and the original's credit requirement rules that
      out.
    - **CC BY-SA** (OpenMoji, some PhyloPic, a few Bioicons): no.
    In every case the user can use the adaptation in their own figure, with the original's `credit` line.
    Tell them this before they put work into an adaptation they hope to contribute.
  - Servier icons and some uploads are PNG only, and some drawings are too detailed to edit as code
    (`asset_svg` says so). Then look at the icon with `asset_image` and draw a simpler version in its style.
    Treat that the same way for licensing: a close copy of the drawing is still an adaptation.
  - With image generation instead of SVG, show the icon (`asset_image`) and ask for the same subject and
    style with the changes. The same license rules apply.
- **Generate an image** (an assistant with image generation, like ChatGPT).
  - Ask for "a flat scientific illustration of X, isolated on a plain white or transparent background,
    no text, no shadow, centered".
  - One subject per image.
  - Show it, and regenerate until the user is happy.
- **The user's own artwork:** they can attach an image, or (with the local server or the command line)
  name a file.

To use the new picture in a figure right away, you don't need to submit it. Pass it to `compose_figure`
as an element's `svg`, `image_file` or `file_path` (see the `biocartoon-make-figure` skill). Submitting
shares it with everyone, after review.

## 3. Confirm the submission details

Collect these, propose sensible values, and **show them to the user together with the final image**:

- **title**: what people would search for ("Pyramidal neuron", not "My neuron v2")
- **description**: one or two sentences on what it shows
- **tags**: 3–10 search words, such as synonyms, the organism and the cell type
- **category**: a category slug, e.g. `cells.cell_types`, `anatomy_and_physiology.nervous_system`, `lab_and_techniques.lab_equipment`. Run
  `biocartoon --categories` for the list, or write free text.
- **credit**: the name the user wants credited (default: anonymous)
- **license** and **generative AI**:
  - Anything you drew or generated is made with generative AI. Submit it with
    `generative_ai_used: true` and license **CC0-1.0**, and describe how it was made in
    `generative_ai_details` (e.g. "SVG drawn by Claude from the user's description; colours chosen by
    the user").
  - CC-BY-4.0 is only for artwork the user made without generative AI, and needs a credit name.
- **email** (optional): only if the user wants reviewers to be able to contact them. It is never
  published.
- **derived_from**: for an adaptation, the original's id. The server checks the license and adds the
  original's credit line to the description, so reviewers and users can see where it came from.

Ask the user explicitly whether they want it submitted and whether they may share it under that license.
**Don't submit without a clear yes.** Submitting publishes the image to everyone under that license once
approved.

## 4. Submit

- **MCP:** `submit_artwork` with the details above, `rights_confirmed: true`, and the image as exactly
  one of:
  - `svg`: the markup itself
  - `image`: a file from the conversation; ChatGPT passes generated or attached images this way
  - `image_url`: a public https link
  - `image_base64`
  - `file_path`: with the local `biocartoon mcp` server only

  plus `derived_from` for an adaptation.
- **Command line** (save the SVG or image to a file first; the `biocartoon-upload` skill has the details,
  including folders and updates):

  ```bash
  biocartoon upload neuron.svg --title "Pyramidal neuron" --description "..." \
    --tags "neuron, cortex, pyramidal cell" --category cells.cell_types \
    --credit "Ada Lovelace" --ai --ai-description "SVG drawn by Claude" --dry-run   # check first
  # then the same command without --dry-run
  ```

  The command line has no `derived_from`. For an adaptation, check the license yourself (step 2) and end
  `--description` with "Adapted from CREDIT (BioCartoon ID)."

Give the user the submission id. Tell them it waits for a human reviewer and appears in the library
(and the BioCartoon app) after the next catalog publish, usually within a few days.
`submission_status` (or `curl "https://api.biocartoon.com/status?ids=ID"`) reports whether it is
pending, approved or rejected.

## If a submission is refused

The error message says why. Common causes:
- a title or tag the language filter caught
- an SVG with a forbidden element
- an image over 2 MB as PNG: make it smaller, or use SVG
- CC-BY-4.0 with generative AI
- an adaptation whose original's license doesn't allow it (see step 2)
- the day's submission limit

Fix what the error names and try again. Don't resubmit the same image unchanged.
