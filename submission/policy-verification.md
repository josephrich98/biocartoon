# BioCartoon policy verification — November 18, 2026

The privacy update and operational terms were reviewed and published using the existing `biocartoon-site` deployment. Successful website deployment IDs are recorded in `evidence/policy-deployments.json`. No app/server changes, paid plan changes, storage permission changes or moderation writes were made by this preparation run.

## Published pages

- Privacy: https://www.biocartoon.com/privacy (MCP section: https://www.biocartoon.com/privacy#mcp).
- Terms: https://www.biocartoon.com/terms.
- Both were opened in Chrome and their actual content inspected without a BioCartoon login. The effective/update date is November 18, 2026.
- `submission/listing.json` now contains `interface.termsOfServiceURL`.
- The site footer links to terms; the homepage distinguishes local editor storage from hosted MCP processing.
- Source: `/Users/joeyrich/code/biocartoon-app/site/public/privacy.html`, `terms.html`, and `index.html`.
- A Python urllib request received Cloudflare HTTP 403; this was not counted as a successful access check. Real Chrome page access succeeded.

## Cloudflare dashboard evidence

The user’s open Chrome tab was used in the account containing the BioCartoon workers.

| Surface inspected | Observed fact | Policy implication |
| --- | --- | --- |
| biocartoon-mcp, production settings | Logs, Traces and Issues switches off; no telemetry export destinations. Bindings: public CATALOG D1 and SUBMISSIONS service. No Workers AI binding was listed. | Application logging settings are disabled, but this does not establish that Cloudflare never records a request. |
| biocartoon-submit, production overview | Workers Logs and Traces disabled. D1 biocartoon-submissions; R2 pending, public and users bindings. | Contributions and online shares are separate from the public catalog database. |
| biocartoon-review, production settings | Logs and Traces off; daily cron shown at 04:17, next run November 19, 2026. | Rejected-file cleanup is scheduled. This does not prove a particular historical cleanup ran successfully. |
| biocartoon-submissions, D1 Time Travel | Dashboard explicitly states restore within the past **7 days**, with November 11–18 restore window at inspection. No restore was attempted. | Corrected the old generic “up to 30 days” backup language to the observed seven-day window. |
| biocartoon-pending, R2 settings | No custom domain; public development URL disabled. Data Access Logs disabled. Only lifecycle rule: abort incomplete multipart uploads after seven days. No bucket lock rules. | Pending artwork is not publicly exposed through the bucket. The multipart rule is not deletion of completed contributions. |
| biocartoon.com, Security / Analytics | Actual sampled request logs contain source IP, host, path and time. Date picker offers ranges through 30 days. | A blanket “all logs disabled” or “no raw IP ever retained” statement would be wrong. Picker availability is not a certified provider-wide deletion deadline. |

No raw visitor IP addresses or private contribution data are included in this report. The provider’s complete internal security-log retention and any separately managed exports/backups have **not** been certified. The published policy makes no promise of zero host logging or an invented deletion date.

Cloudflare’s generic D1 documentation describes Time Travel and plan-dependent windows; the account’s actual dashboard was used for the seven-day fact: https://developers.cloudflare.com/d1/reference/time-travel/.

## Application-source verification

- `worker/src/mcp_server.ts`: catalog-only cache, max-age=300; hashed cache key; no intentional tool-argument logging. Artwork, optional contacts, status and figure tools are excluded from this cache. Dashboard “Runtime Cache Disabled” is not interpreted as disproving or guaranteeing Workers Cache API behavior.
- `worker/src/mcp_artwork.ts`: image/URL and metadata submission, explicit rights confirmation, optional reviewer email; no BioCartoon account required.
- `worker/src/submit.ts`: stores contribution metadata and files; abuse prevention uses salted request-IP hashes or a shared MCP identifier depending on authentication path. The original draft’s unconditional MCP IP-hash statement was corrected.
- `worker/src/publish.ts`: rejected files become eligible for daily cleanup after 30 days; cleanup empties file references but **does not delete the submission row**, email, credit or abuse identifier. Pending rows and those metadata fields have no automatic expiry in current code.
- Published artwork sidecars omit reviewer email and IP hash; public title, description, tags, author, license and AI disclosure are retained.
- `worker/src/mcp_figure.ts`: server processes figure inputs; it constructs and encrypts projects before creating editor links. It therefore sees plaintext during construction, unlike the editor’s local encryption flow. Optional Workers AI planning is conditional on an AI binding; none was listed in the inspected production MCP settings.
- `worker/src/shares.ts`: encrypted share storage and 90-day inactivity expiry. The P4 generated link actually opened the scRNA-seq workflow template in the editor.
- Existing policy contact: Joseph Rich, josephrich98@gmail.com. Contribution access/correction/deletion requests now explicitly reference that contact and submission ID.

## Terms adopted within the request

The existing operational draft was finalized with the actual operator/contact, current free service and limits, asset-license requirements, confirmation and human-review boundaries, privacy link, rights/removal contact and effective date. No governing law, arbitration clause, liability waiver or unsupported deletion commitment was invented. Optional provisions in the historical outline remain unadopted.

This report records source and dashboard checks; it does not provide a legal compliance certification or a submission-portal attestation.

