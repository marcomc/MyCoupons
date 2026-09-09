# Installation and deployment

## Table of contents

- [Prerequisites](#prerequisites)
- [Local preparation](#local-preparation)
- [Apps Script setup](#apps-script-setup)
- [Secret Manager bootstrap](#secret-manager-bootstrap)
- [Recovery](#recovery)
- [Live validation](#live-validation)

## Prerequisites

Enable Gmail API, Drive API, Sheets API, Apps Script API, and Vertex AI API in
the operator-owned Google Cloud project. The Apps Script manifest requests Gmail
modify, Sheets, read-only Drive, external requests, script triggers, mail,
identity, and cloud-platform scopes. OAuth consent and Branding must use real,
published homepage and privacy-policy URLs before an OAuth app is published.
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

## Apps Script setup

Create or select the private Apps Script project, upload `src/`, inspect the
manifest scopes, and configure the owner email, private Sheet name/ID, Gmail
label, locale, time zone, model, and optional Vertex fallback through the
installer. On a fresh project, call `beginMyCouponsInstallation` with the
validated fields from `config/example.json`; it persists non-secret
configuration and continues through the installer. On later runs,
`installMyCoupons` resumes from persisted configuration. The installer creates
only missing Sheet tabs, nested Gmail label prefixes, the owned daily trigger,
and the installable `onReviewEdit` trigger; it rejects ambiguous matches and
non-private sharing, and preserves existing headers and rows. Store secrets
only in Script Properties.

The Apps Script editor does not pass arguments to functions. For direct manual
setup, deploy the owner-only Execution API deployment, authenticate as the
owner, and invoke `beginMyCouponsInstallation` with the non-secret fields from
`config/example.json`.

## Secret Manager bootstrap

The future operator CLI uses the owner-only Execution API function
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

## Live validation

This repository contains no live deployment proof. After operator-authorized
setup, verify ownership, private Sheet sharing, label identity, trigger
identity, a minimal AI call, and one end-to-end import. Confirm that failed
imports leave Gmail unchanged and that notifications link to the private row.
