# Proposed addition to the BioCartoon privacy page

Draft only. This is not published policy. The existing page is
https://www.biocartoon.com/privacy; these additions need the publisher's review before deployment.

## ChatGPT and other MCP clients

When you use BioCartoon through ChatGPT or another MCP client, that client sends
the information needed for the requested tool call to our hosted MCP server.
This can include search words, collection or tag filters, selected illustration
IDs, template IDs, or a read-only catalog query. The client controls what it sends;
using the BioCartoon tools does not itself request a copy of your entire chat.
Your use of ChatGPT is also subject to OpenAI's own terms and privacy policy.

The server runs on Cloudflare. Public catalog tool responses can be cached for
up to five minutes; a cached search response can contain the search words as well
as public illustration metadata. The MCP code does not intentionally log tool
arguments or cache submitted artwork, optional contact details, or submission-status requests.

If you ask to contribute artwork, the client sends the image or a URL from which
it can be downloaded, plus the title, description, tags, category, credit name,
license and whether generative AI was used. An email address is optional and is
for reviewers, not for public attribution. Contributions are held for human review.
Approved artwork and its public metadata are published under the selected license.
The submission service uses a salted hash of the IP address available on the
request for abuse prevention. The existing Contributions and Contact sections
also apply to these submissions.

The public catalog and contribution tools do not require signing into a
BioCartoon account. Opening the BioCartoon editor or choosing to sign in there
uses the separate web-app features already described in this policy.

## Decisions and checks still needed

- Confirm the actual Cloudflare request/security-log retention and backup settings.
  The statements above describe the application code, not a verified host-wide
  retention guarantee.
- Specify retention/deletion handling for pending and rejected contributions,
  credit names, optional reviewer emails and abuse-prevention hashes. The current
  public policy describes their collection but does not give these categories a
  specific retention period.
- Confirm the support contact and how contributors request correction or removal
  of a submitted item and its private contact information.
- Replace the current broad summary about projects never leaving a device with
  wording that clearly distinguishes the editor from MCP tool calls and uploaded
  contributions.
- Recheck this draft if the separate, in-progress figure-composition or
  server-side AI work is included in the submitted release. That code is outside
  this preparation's currently deployed 16-tool baseline.

Do not add a promise that queries are never retained, that all server logs are
disabled, or that submitted data is automatically deleted on a particular date
without confirming the actual deployment and the publisher's policy.
