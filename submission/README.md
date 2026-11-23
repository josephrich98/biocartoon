# BioCartoon plugin submission

Build the submission ZIP with:

```
python3 scripts/package_plugin.py --submission
python3 scripts/check_plugin_submission.py dist/biocartoon-<version>-public-draft.zip
```

The ZIP merges `listing.json` (listing text, policy URLs, review prompts, demo
link, release notes) and `review-cases.json` (five positive and three negative
cases) into the plugin manifest, and bundles `assets/` (logo and the
`review-cell.svg` fallback image for P4). `scripts/prepare_submission.py` also
builds a review-materials ZIP of this folder under `dist/submission/`.

| File | Contents |
| --- | --- |
| `listing.json` | Listing and review fields merged into the manifest |
| `review-cases.json` | The 5 positive and 3 negative review cases, matching the demo video's prompts |
| `demo-script.md` | The script the demo video follows |
| `review-results.md` | What the video shows for each case; history of earlier test runs |
| `policy-verification.md` | Checks of the published privacy policy and terms |
| `evidence/` | Records from the 2026-11-18 test runs (earlier prompts; reference only). `live-tools.json` is the tool baseline `prepare_submission.py` compares against |

Endpoint: https://mcp.biocartoon.com/mcp (19 tools, no sign-in). Policies:
https://www.biocartoon.com/privacy and https://www.biocartoon.com/terms.

The demo video itself is not stored here: host it (for example as an unlisted
YouTube video), check that it plays in a signed-out window, put the link in
`review.demo_recording_url` and rebuild.
