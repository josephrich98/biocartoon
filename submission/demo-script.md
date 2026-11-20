# BioCartoon review recording

## Walkthrough

| Approximate time | Say / send | Show in the real app |
| --- | --- | --- |
| 0:00–0:20 | “BioCartoon finds open-licensed scientific illustrations, provides credits and download links, and includes an interactive gallery. It is free. This is the catalog app submitted with the find, create, make-figure and upload skills.” | BioCartoon selected in the host; app connection available. Do not claim it is already publicly approved. |
| 0:20–1:40 | **P1:** “Find three illustrations of a pyramidal neuron for a neuroscience lecture slide. Show me the choices with their licenses and credit lines.” | Actual search and preview calls, then the selected gallery. Open a credit line and PNG/SVG link controls. Show distinct returned artwork and its actual license; do not describe the entire library as CC0. |
| 1:40–2:20 | **P2:** “Give me the PNG and SVG download links for BioCartoon illustration BA001505, with the exact credit line I should use.” | `get_asset` output and response. Rehearsed fixture: Pyramidal Neuron, Ryan Kissinger, NIAID NIH BioArt Source, public domain. Open at least one returned image link. |
| 2:20–3:00 | **P3:** “Show me the other color or style variants of BioCartoon illustration BA001505 so I can choose one.” | Real `asset_variants` response and gallery. Rehearsal returned six variants: beige, blue, orange, pink, purple, yellow. The live catalog can change. |
| 3:00–3:45 | **P4:** “Show me a shared BioCartoon slide template that I can use as a starting point. Include a preview, its author and license, and how I can open BioCartoon to use it.” | Actual template preview and attribution. Rehearsal used “Electron transport chain”, by BioCartoon, CC0-1.0. Open `https://app.biocartoon.com/` or an editable-copy URL actually returned by `open_in_biocartoon`; never invent a deep link. |
| 3:45–4:45 | **P5, preview only:** attach `review-cell.svg`, then send the exact first prompt from `review-cases.json`. | Image preview and all proposed metadata, including AI use and CC0, followed by a request for approval. There must be no `submit_artwork` call before approval. This segment demonstrates the confirmation boundary; it does not prove a successful write. |
| 4:45–5:45 | In separate fresh chats send N1, N2 and N3 from `review-cases.json` (or show one here and supply the others as a supplemental clip). | The assistant explains BioCartoon cannot obtain or unwatermark artwork someone else sells, sign in to or delete cloud projects (it points to the home screen and account menu at app.biocartoon.com instead), or bypass human moderation. No tool call should pretend to do those actions. |

If the gallery does not appear, stop and fix the development installation before
recording. A JSON response or staged mockup does not demonstrate the interactive app.
If a call fails or reaches a free-service quota, show the actual error and recovery;
do not replace it with a fabricated successful result.

## Optional full contribution case

Only run the second turn of P5 if you deliberately choose to send the synthetic
fixture to the **real moderation queue**. It is not an isolated sandbox. Keep any
test submission ID for the human moderator to identify later. This preparation
has not submitted the fixture and does not provide a successful-write recording.

The proposed complete metadata is in `review-cell-metadata.json`. After the
assistant shows that image and metadata, the second-turn approval is:

> I confirm I may share this demo artwork under CC0. Submit it now with title Review demo cell, credit Review demo, and generative AI marked yes.

The result must be a real returned submission ID with pending-human-review status.
An error is not success; do not silently retry a write that may have succeeded.
If you skip the final write, label P5 end-to-end **Not run** in the review notes.

## Finish and supply the recording

1. Stop recording and play the entire saved video. Check readable prompts, real
   gallery interactions, visible credits, meaningful boundary handling, and no
   private information. Confirm the recording matches the version being submitted.
2. Host it at a stable link accessible to reviewers without requesting access.
   An unlisted YouTube video or an appropriately shared video file can work.
   Test playback in a signed-out/private browser, not just the hosting account.
3. Supply the actual playback link. After playback and access are verified, add it
   to `review.demo_recording_url` in `submission/listing.json` and rebuild the ZIP.
   A local recording, upload landing page or script alone does not complete that field.

## Fresh-conversation review results

Run all eight cases against the final saved version and update
`review-results.md` with Passed, Failed, Blocked or Not run plus the observed calls
and outcomes. The current tool-level rehearsal does not establish conversational
tool selection, confirmation behavior, or portal acceptance.

## November 18 execution notes

P1–P4 and N1–N3 were executed in separate ChatGPT Work chats; see `review-results.md`. P5 remains Not run. N2 was stopped after it began browser exploration instead of the expected unsupported-action explanation; fix or resolve that boundary before recording a successful review demo. The live read-only suite passed 20 checks on the 19-tool server. There is still no verified recording URL; `review.demo_recording_url` contains only the explicit placeholder requested by the user.
