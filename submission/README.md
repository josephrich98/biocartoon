# BioCartoon submission checklist — November 18, 2026

**Not ready to submit.** Policies are published; actual fresh-chat outcomes are recorded. The live walkthrough was performed while the user reported recording. At the user’s request, the video field now contains an obvious placeholder; video playback remains unverified. N2 failed. P5 is deliberately Not run.

## Checklist items 1–3

1. **Policies completed:** https://www.biocartoon.com/privacy and https://www.biocartoon.com/terms were published and their actual content inspected in Chrome. The listing has the live terms URL. The policy covers MCP calls, catalog caching, contributions, hosted figure processing, encrypted editor links, indefinite metadata retention, rejected-file cleanup and the observed seven-day D1 recovery window. Workers Logs/Traces are disabled, but zone-level sampled request logs exist. No blanket no-logging promise is made. Full audit: `policy-verification.md`.
2. **Demo awaiting capture review and URL:** the Mac recorder failed to launch through available controls; QuickTime access timed out. The user subsequently reported starting a recording and chose YouTube hosting. A real Chrome walkthrough was performed, including P5’s preview-only first turn. No video file or hosted/private-window playback has yet been inspected. `review.demo_recording_url` is the explicit placeholder `https://www.youtube.com/watch?v=REPLACE_WITH_VERIFIED_DEMO_ID`. It is not a real/verified link. `demo-script.md` is updated for the current 19-tool runtime. An actual recording URL and verified playback are still required.
3. **Cases recorded:** seven original fresh ChatGPT Work chats, plus an eighth preview-only P5 chat, used the BioCartoon2 development plugin and unchanged natural prompts. P1–P4, N1 and N3 met the observed user-facing workflow/boundary. N2 began browser exploration instead of explaining that deletion is unsupported and was stopped. P5’s artwork/metadata and approval boundary were shown; no approval was sent and its end-to-end status remains Not run. N2 received an explicit cancellation and then explained its limitation; the original failure remains recorded. Exact raw per-chat MCP requests were not exposed and are not claimed verified. See `review-results.md` and its linked evidence.

## Version and checks

The public endpoint is https://mcp.biocartoon.com/mcp, version 0.4.10, 19 tools. Live tool definitions match the checkout; the served gallery differs from the locally modified gallery. Results apply to the observed production endpoint/development installation, not to uncommitted gallery changes or a future saved portal release. Four skills are packaged: find-icons, create-icon, make-figure and upload.

The live suite passed 20 checks without sending artwork; its unconfirmed-upload check refused before writing. Actual public ZIP inspection passed structural validation. The demo field is now syntactically present but contains an unverified placeholder. A format-only check does not establish a real recording or readiness. This is a draft, not a submission-ready package.

Rebuild with `python3 scripts/prepare_submission.py`. Draft/review-materials ZIPs and build reports are under `dist/submission/`. The old 16-tool baseline remains historical; build reports intentionally continue to show its contract drift. Historical preparation notes are in `evidence/review-results-historical.md`.

Website changes are in `/Users/joeyrich/code/biocartoon-app/site/public/`. Existing unrelated app, worker and gallery edits were preserved. No MCP deployment, artwork moderation submission/approval, submission-portal upload or review submission was performed.

## Remaining work

Resolve N2's Work-mode boundary. Capture a real walkthrough, review its entire playback, host it and verify private/signed-out playback; then set its verified URL and rebuild. If pending gallery changes are deployed, repeat affected cases against that exact release. Portal verification, scans and legal attestations remain separate; this task did not perform them.

## Local N2 guidance update

The shared server instructions and all four skill descriptions/bodies now explicitly exclude account management and prohibit browser, shell, SQL and contribution-tool workarounds for it. Generated metadata and the public draft have been rebuilt; skill validation, MCP tests and package checks passed. The server instructions (now giving the exact in-app deletion steps) were deployed to mcp.biocartoon.com on 2026-11-18 (version 930ae0a7; live check passed 20/20). The skill text still has to be reloaded into the installed development plugin, and no fresh N2 behavioral retest is claimed. The historical failure remains recorded.
