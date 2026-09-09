# Installation and deployment

## Table of contents

- [Prerequisites](#prerequisites)
- [Local preparation](#local-preparation)
- [Apps Script setup](#apps-script-setup)
- [Recovery](#recovery)
- [Live validation](#live-validation)

## Prerequisites

Enable Gmail API, Drive API, Sheets API, Apps Script API, and Vertex AI API in
the operator-owned Google Cloud project. The Apps Script manifest requests Gmail
modify, Sheets, read-only Drive, external requests, script triggers, mail,
identity, and cloud-platform scopes. OAuth consent and Branding must use real,
published homepage and privacy-policy URLs before an OAuth app is published.

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

## Recovery

Installation is resumable. Existing resource identities are persisted after
verification, and the importer recovers from the latest real coupon date.
Empty sheets require an explicit `initialDate`. To roll back automation, use
`removeDailyImportTrigger`; resource data and labels are not deleted.

## Live validation

This repository contains no live deployment proof. After operator-authorized
setup, verify ownership, private Sheet sharing, label identity, trigger
identity, a minimal AI call, and one end-to-end import. Confirm that failed
imports leave Gmail unchanged and that notifications link to the private row.
