# Installation and deployment

## Table of contents

- [Prerequisites](#prerequisites)
- [Local preparation](#local-preparation)
- [Apps Script setup](#apps-script-setup)
- [Secret Manager bootstrap](#secret-manager-bootstrap)
- [Recovery](#recovery)
- [Live validation](#live-validation)

## Prerequisites

Cloud provisioning uses two explicit projects: an unbilled Gemini Developer API
project and a Vertex fallback project linked to the selected Generic Billing
Account. The local provisioner verifies owner/label adoption before enabling
its limited services. Gmail, Drive, Sheets, and OAuth consent still require the
operator-owned Apps Script setup described below. The Apps Script manifest
requests Gmail modify, Sheets, read-only Drive, external requests, script
triggers, mail, identity, and cloud-platform scopes. OAuth consent and Branding
must use real, published homepage and privacy-policy URLs before an OAuth app is
published.

For a standard Cloud project associated with Apps Script, enable the Gmail API
and Drive API before using the Gmail v1 and Drive v3 advanced services.

Before entering those URLs or publishing, inspect the current Google Auth
Platform Console prerequisites and disabled-control guidance; do not assume an
older OAuth app or static checklist remains valid.
Open the final homepage and privacy-policy URLs without authentication before
entering them in Branding.

The default Gemini Developer API route needs a key inserted into the
`GEMINI_API_KEY` Script Property through a secure operator workflow. Vertex
fallback requires billing and an eligible Vertex AI project; it can incur
charges.

## Local preparation

Run `scripts/prepare-deployment.sh --auth-json PATH --project-id PROJECT_ID`.
The helper validates inputs and tool availability only. It does not print or
read the secret contents, deploy code, create OAuth clients, or provision cloud
resources. `clasp` authorization must remain in an operator-owned private file.
After Cloud provisioning, run `python3 -m provisioner.cli deploy-apps-script`
with an isolated mode-0600 clasp authorization file and a mode-0600 bootstrap
payload outside the checkout; see [the provisioner guide](PROVISIONER.md#apps-script-deployment-and-bootstrap).

## Apps Script setup

The provisioner creates or adopts one private owner-only Apps Script project.
When it creates a project, the command persists
`apps-script-association-required` and returns before uploading `src`, creating
a deployment, or staging a secret. Associate that project with the intended
standard Cloud project, then rerun the command with
`--acknowledge-association` to upload `src`, verify the immutable owner-only
Execution API deployment, and configure the installer
through its secure bootstrap. The installer creates only missing Sheet tabs,
nested Gmail label prefixes, the owned daily trigger, and the installable
`onReviewEdit` trigger; it rejects ambiguous matches and non-private sharing,
and preserves existing headers and rows. Store secrets only in Script
Properties.

The Apps Script editor does not pass arguments to functions. Do not replace the
provisioner's owner-only bootstrap with a manual editor run that could expose a
credential.

Before the rerun after creation, or before the first command for an adopted
project, associate the project with the intended standard Cloud project in the
Apps Script editor and authorize the isolated OAuth client from that same
project. The Apps Script API cannot make or inspect that association. The CLI
performs a no-op Execution API call before staging a secret and fails if the
caller cannot invoke the owner-only deployment.

## Secret Manager bootstrap

The operator CLI uses the owner-only Execution API function
`bootstrapFromSecret(secretVersion)`. It writes one immutable, numeric Secret
Manager version named
`projects/VERTEX_PROJECT/secrets/mycoupons-bootstrap/versions/NUMBER`; aliases
such as `latest`, other secret names, and other projects are rejected. The
resource project must match the persisted configuration when present, otherwise
the proposed `config.vertexProject` in the secret payload.

The UTF-8 JSON secret payload has exactly these fields:

```json
{"version":1,"config":{...},"geminiApiKey":"AIza..."}
```

`config` must be the complete current `beginMyCouponsInstallation` input and
must specify `vertexProject`. The endpoint fetches the version with its own
Apps Script OAuth token, verifies the exact payload and owner, writes only the
Gemini key to Script Properties, then invokes the normal transactional
installer. It returns only the non-secret installation result. On failure it
restores the prior key and the installer restores its prior configuration; it
does not return or log the key or Secret Manager response. The CLI disables the
temporary version only after a successful call. Do not use
`MYCOUPONS_BOOTSTRAP_CONFIG` for secret-bearing data.

## Recovery

Installation is resumable. Existing resource identities are persisted after
verification, and the importer recovers from the latest real coupon date.
Empty sheets require an explicit `initialDate`. To roll back all automation,
use `removeMyCouponsAutomation`; resource data and labels are not deleted.

Initial and scheduled scans run deterministic and AI extraction together. A
fully evidenced complete offer is persisted before its source message receives
the configured label and is removed from `INBOX`. Incomplete, image-only, or
ambiguous results create review rows. Confirm, Ignore, and Retry with AI operate
on that same journal-backed candidate; Ignore intentionally leaves the source
message unchanged. The journal checkpoints label and archive acknowledgements
individually, so reruns recover partial operations without duplicate rows.

## Live validation

This repository contains no live deployment proof for this increment. After
operator-authorized setup, verify ownership, private Sheet sharing, label and
trigger identity, a minimal AI call, and a manual plus scheduled end-to-end
import. Exercise Confirm, Ignore, and Retry with AI on the same candidate;
verify notification deltas and that a replay has no duplicate row. Confirm that
failed or incomplete imports leave Gmail unchanged and that notifications link
to the private row.
