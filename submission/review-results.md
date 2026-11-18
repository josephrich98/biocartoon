# Review preparation evidence — 18 November 2026 UTC

These are mock review cases with limited live **tool-level rehearsals**. No fresh
conversation evaluation, submission-portal test, or recorded walkthrough is
claimed. The contribution fixture has not been sent to production.

| Case | Full conversational case | Tool rehearsal | Evidence / remaining check |
| --- | --- | --- | --- |
| P1 — search, inspect, compare | Not run | Passed | Live search returned pyramidal-neuron candidates. Inspected three preview images; two were readily visible, while the black Bioicons drawing was hard to assess against the host's dark preview. Gallery response returned SD016288, BA001505 and SD016427 with their original credits. BA001505 came from a separate `get_asset` lookup. Verify automatic selection and the actual interactive widget in a fresh chat. |
| P2 — download and credit | Not run | Passed | BA001505 exists, is public domain, credited to Ryan Kissinger / NIAID NIH BioArt Source, and supplies HTTPS PNG and SVG links. Automated image retrieval also succeeded. Verify the final user response and open both returned formats. |
| P3 — variants | Not run | Passed | `asset_variants` returned BA001505–BA001510: beige, blue, orange, pink, purple, yellow. `render_assets` returned all six requested records. Verify visible gallery selection and attribution in the host. |
| P4 — template | Not run | Passed | Six templates returned; `template_image` successfully displayed Electron transport chain, by BioCartoon, CC0-1.0. Verify conversational discovery and opening the editor. |
| P5 — confirmed contribution | Not run | Passed (validation only) | Local SVG safety and metadata validation accepted the fixture. Live `submit_artwork` with rights_confirmed=false refused before writing. This does not test an assistant's confirmation behavior or a successful submission. Final write deliberately not executed. |
| N1 — proprietary provider asset | Not run | Not run | Drafted expected refusal/explanation; run in a fresh chat. |
| N2 — delete cloud projects | Not run | Not run | No account/project deletion tool in the deployed 16-tool contract; conversational boundary still needs a run. |
| N3 — bypass moderation | Not run | Not run | No approval/publication tool in that contract; conversational boundary still needs a run. |

Machine-readable evidence: `evidence/tool-rehearsal.json`,
`evidence/live-tools.json`, and `evidence/live-mcp-check.json`.
The existing read-only `scripts/check_mcp.mjs` passed **20 checks** against
`https://mcp.biocartoon.com/mcp`, server version 0.4.10, 16 tools, 21,183 asset
records. Records include colour variants and must not be described as 21,183
unique drawings. The check exercised public search/data/image/template calls,
the gallery resource and the unconfirmed-upload refusal. It did not publish artwork.

## Tool annotation inspection

All 16 live tools declare boolean `readOnlyHint`, `openWorldHint` and
`destructiveHint`. The 15 read tools are read-only, non-destructive and scoped
to the BioCartoon catalog/template/status domain. Their `openWorldHint=false`
describes that closed domain, including assets served from its catalog storage;
it does not mean the server makes no network requests. `submit_artwork` is
readOnly=false, destructive=false, openWorld=true, idempotent=false: it adds a
review-queue item and can fetch user-supplied public image URLs. No annotation
changes were identified as necessary for this deployed baseline.

The hosted submission tool's `image_base64` property description still mentions
JPEG/WebP/GIF inherited from the local tool, although the overall hosted tool
description and actual validator restrict uploads to PNG/SVG. That property
description has been corrected in the local metadata generator and generated
contract for the next coordinated server release; that source fix was not deployed
during preparation. Do not demonstrate unsupported hosted conversions. Additional
in-progress figure tools need a new annotation, policy, listing and review-case
audit before inclusion.

## Branding and listing checks

The unchanged 1024×1024 PNG from `biocartoon-app/site/public/logo.png` was viewed
at 256 px and 48 px against white and dark backgrounds in Safari using
`logo-preview.html`. The silhouette remains recognizable on both; the same
asset is used for listing and composer icons as requested.

The public website, privacy page and GitHub Issues support page were opened and
their content inspected. The existing privacy page needs the drafted MCP addendum
and retention decisions. A terms page was not found in the website source, so
no invented terms URL is supplied. The intended developer is Joseph Rich;
the organization settings visible during preparation said **Identity in review**,
so verification completion is not claimed.
