# BioCartoon public submission preparation

**Status: public submission draft; not ready to submit.** No portal upload,
submission for review, or public listing was performed.

The separate public ZIP preserves all current BioCartoon skills and the hosted MCP
connection, including the interactive gallery. It does not contain a private
app binding; the submission portal creates the app from the MCP declaration.
The initial review evidence covers the 0.4.10, 16-tool catalog app. Packages now
track the source commit, including the make-figure skill and figure tools.
`BUILD.md` flags contract differences from that historical evidence; the newer
features need updated review cases, policy coverage and a matching recording.

## Completed

| Item | Prepared value / evidence |
| --- | --- |
| Publisher | Joseph Rich, confirmed by the creator; portal verification still pending |
| Availability | All countries available through the directory (`countries: []`); platform/regional restrictions still apply |
| Commerce | Free, `commerce: false`, confirmed by the creator |
| Listing | BioCartoon; “Open science illustrations” (26 characters); Scientific Research category; supported long description and release notes |
| Branding | Existing unchanged 1024×1024 transparent PNG for both logo and composer; inspected on light and dark backgrounds |
| Website | https://www.biocartoon.com/ — public content verified |
| Support | https://github.com/josephrich98/biocartoon-app/issues — public contact mechanism verified |
| Privacy | https://www.biocartoon.com/privacy — existing page verified; MCP coverage update drafted, not published |
| Review cases | Five positive and three negative cases in `review-cases.json`, also embedded in the ZIP metadata |
| Review fixture | Synthetic cell SVG plus proposed metadata; local safety/metadata validation passed; no artwork sent |
| Live technical checks | Deployed 0.4.10 passed 20 checks; four read workflows rehearsed using the connected plugin |
| Recording materials | `demo-script.md`, with exact prompts, results to show, Mac recording instructions and hosting verification steps; creator will record |

## Mock review coverage

| ID | Scenario | Main expectation |
| --- | --- | --- |
| P1 | Find and compare pyramidal-neuron illustrations | Relevant returned IDs, real gallery, licenses and credit lines |
| P2 | Retrieve BA001505 | Actual PNG/SVG links and exact credit |
| P3 | Explore its variants | Only returned variants, no invented colours |
| P4 | Preview a shared slide template | Real preview, author/license, valid editor link |
| P5 | Contribute the synthetic cell | Preview and explicit confirmation before one write; real ID and pending status afterward |
| N1 | Obtain proprietary BioRender artwork without access | Explain the boundary; no pretend download |
| N2 | Permanently delete cloud projects | Explain unsupported account action; no false deletion |
| N3 | Approve and publish an upload immediately | Explain human moderation; no false approval |

See `review-results.md` for honest Passed / Not run distinctions. Tool rehearsal
is not an end-to-end conversational test. No case is marked passed merely because
its prompt was drafted.

## Finish preparation, in order

1. **Policies:** review `drafts/privacy-mcp-addendum.md`, settle retention and
   deletion handling, and publish the accurate privacy update in `biocartoon-app`.
   Review `drafts/terms-draft.md` and `drafts/terms-outline.md`, resolve the open
   terms decisions and publish a stable terms page. Verify it without signing in,
   then add `interface.termsOfServiceURL` to `listing.json`.
2. **Recording and review:** follow `demo-script.md`, play back and host the real
   recording, verify signed-out playback, then add `review.demo_recording_url`.
   Run all cases in fresh chats against the exact final release and record outcomes.
   P5's final step sends real artwork to the review queue; choose it deliberately.
3. **Release consistency:** coordinate any pending server/UI work, deploy the
   corrected base64-format description, and rerun the annotation/privacy/case audit
   if tools change, then rebuild and inspect the archive.
4. **Portal setup last:** complete individual verification (the visible status
   was Identity in review), verify domain ownership, upload the public ZIP as a
   draft when requested, inspect imported listing/availability/commerce, connect
   the declared MCP server, and run the required scans and review checks. The
   authorized developer must complete legal/policy attestations before submitting.
   Submission and publishing an approved release remain separate actions.

Unknown terms and demo URLs are absent from the manifest; no placeholders are
passed off as real links. No reviewer account is needed for the declared public
MCP endpoint. Any optional editor sign-in is outside these MCP cases. Never put
credentials or private reviewer access data in the public ZIP.

## Rebuild and check

```sh
python3 scripts/prepare_submission.py
python3 scripts/check_plugin_submission.py dist/submission/biocartoon-0.4.10-public-draft.zip --allow-draft
python3 -m unittest discover -s scripts -p 'test_*.py' -v
node --test scripts/check_mcp.test.mjs
```

Run the checker **without** `--allow-draft` for the final package-field gate. It
currently returns exit code 2 for the missing terms and recording URLs. It checks
the actual ZIP, skills, MCP connection, icon bytes and review-field structure;
it does not certify legal coverage, video playback or portal approval.

The ordinary `scripts/package_plugin.py` command keeps producing the separate
development ZIP without public review metadata. Neither command deploys a server
or uploads a plugin. Supporting notes/evidence are not embedded in the public
plugin component archive.

## Automatic builds and deployment checks

Every push and pull request runs the `submission` job in the `test` workflow.
Download its `biocartoon-submission-COMMIT` artifact from GitHub Actions within
14 days. It contains the rebuilt public draft ZIP, a review-materials ZIP,
`package-check.json`, `build-info.json` and `BUILD.md`. The job summary also lists
missing fields and tool-contract drift. Build provenance records the commit,
source hashes, artifact hash, current skills/tools and timestamp.

Invalid package structure fails CI. Missing terms or recording URLs remain
explicit draft gaps so the repository can keep building during preparation.
The build never rewrites curated review cases, historical evidence, policy text
or demo links, and never uploads anything to the OpenAI submission portal.

`cd worker && npm run deploy:mcp` now runs the live read-only check after a
successful Wrangler deployment and returns failure if that check fails. The
deployment itself has already happened at that point; it is not rolled back.
Results are saved to `dist/live-mcp-check.json`, including failures, with the
timestamp and observed server version/tool count. `npm run check:mcp` reruns it
without deploying. The check compares live tool names with the current checkout,
checks annotations and exercises the catalog/gallery workflows without sending
artwork to the review queue.

The `MCP live checks` workflow also runs for a successful GitHub deployment
status whose environment is `biocartoon-mcp`, checking out that deployment's
commit. It can be run manually from Actions. Both paths upload the result JSON
for 14 days. A direct Cloudflare dashboard deployment does not necessarily emit
a GitHub deployment status: use the npm deployment command, configure the deployer
to emit that status, or run the workflow manually. No automatic production deploy
or new paid service is configured by this automation.

Official process: https://developers.openai.com/plugins/deploy/submission
