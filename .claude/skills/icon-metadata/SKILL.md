---
name: icon-metadata
description: Write the title, description, category and tags for local BioCartoon icons that haven't been submitted yet, into icons/metadata.json, by looking at each drawing and its embedded notes. Use when asked to "assign icon metadata", "tag the new icons", "describe the unpublished icons", or when data/sync_icons.py reports icons with no metadata. Does not submit anything.
---

# Assign icon metadata

`data/sync_icons.py` won't submit a new icon until `icons/metadata.json` has an entry for it. This fills those entries in. It only edits that file: submitting is a separate step that the user runs or asks for.

## Steps

1. List the work. From the repo root, in the `biocartoon` conda env:

   ```bash
   python data/sync_icons.py --todo
   ```

   Each line is `name<TAB>the SVG's <desc>`. If the user named particular icons, add them as arguments.

2. Work in batches of about 40, keeping an animal's poses in the same batch. For each batch, render a contact sheet into the scratchpad and read the image:

   ```bash
   python icons/generators/09_animals_objects/sheet.py "$SCRATCH/sheet.png" icons/NAME.svg ...
   ```

   Look at every icon. The `<desc>` was written before the drawing was made, so where they disagree, describe the drawing and tell the user the icon may be wrong.

3. Learn the house style from what is already published, for the same kind of icon:

   ```bash
   sqlite3 -readonly data/assets.sqlite "select title, category, tags, description from assets where source='user' and category='Animals' limit 15"
   biocartoon --categories
   ```

4. Add one entry per icon to `icons/metadata.json`, keyed by file name without `.svg`. Never change or drop `_defaults` or an existing entry unless the user asks. Write the file after each batch, so stopping loses nothing.

   ```json
   "bald_eagle_flying": {
     "title": "Bald Eagle (Flying)",
     "description": "Bald eagle soaring on flat, broad wings with finger-like primaries, seen from below with the head in profile. Gray by default and recolorable; pairs with the perched and fishing bald eagle icons.",
     "category": "organisms.animals",
     "tags": ["bald eagle", "haliaeetus leucocephalus", "eagle", "raptor", "bird of prey", "bird", "flying", "soaring", "wings"]
   }
   ```

5. After each batch, run `python data/sync_icons.py` and fix every `!!` line for the icons you just wrote.

6. Report how many entries you wrote, any icon whose drawing looks wrong, and any category you were unsure of. Offer `python data/sync_icons.py --apply` as the next step, and run it only if the user says to. It sends files to the live review queue.

## What to write

- **title** (80 characters at most): title case, the plain name a person would search for. Put a pose or state in parentheses, as in `Wolf (Howling)` or `Book (Open)`. The default pose has no parentheses. Titles must be unique.
- **description** (500 at most): one or two sentences on what the picture shows: the subject, pose or state, and view. Keep real identifying detail and the Latin name where the `<desc>` gives it. Leave out drawing instructions such as "shank is fill, flukes shade" or "the fish is context". If the icon has sibling poses or states, end by saying what it pairs with.
- **category**: a slug from `biocartoon --categories`, the most specific that fits. Animals go in `organisms.animals`, except insects, spiders and other arthropods (`organisms.insects_and_arthropods`) and true lab models such as the mouse, rat or zebrafish (`organisms.model_organisms`). Everyday things go under `everyday.*`: `everyday.food_and_drink`, `everyday.clothing`, `everyday.places_and_travel` for vehicles and buildings, `everyday.objects` for the rest. A lab or clinical object belongs in `lab_and_techniques.*` or `medicine_and_health.*`.
- **tags** (up to 20, 40 characters each, no commas, lowercase): the common name, scientific name, group (`mammal`, `rodent`, `raptor`), the pose, and words someone would search for instead, including what a scientist would use the icon to show (`virus reservoir` for a bat). Don't pad with words that don't help find it.

The submit server has a profanity filter, and some animal names can trip it (`ass`, for instance). Prefer `donkey` and similar. If a submission is refused for a word, reword that entry.

Don't add credit, license or AI fields to an entry: those come from `_defaults`. Colour layer names are also separate: they need a catalog id, so run `python data/name_layers.py --sources user` after the icons are published.
