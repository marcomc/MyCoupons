# MyCoupons TODO

## P0 - Complete the live migration

- [ ] Remove the identified obsolete Script Properties and old AI credential
  through `cleanupMyCouponsLegacyProperties`.
- [ ] Reset only the incomplete baseline cursor and watermark through
  `restartMyCouponsImportFromInitialDate`, then run the complete scan from
  2026-01-01.
- [ ] Audit existing legacy Sheet rows and labeled Inbox messages before any
  cleanup. Preserve verified coupons; remove or repair only rows and labels
  proven to be legacy false positives.

## P1 - Verify production behavior

- [ ] Record the first complete historical scan: scanned messages, imported
  coupons, skipped messages and retained continuation state, without logging
  email content or resource identifiers.
- [ ] Verify one successful scheduled daily run after the historical scan has
  completed.
- [ ] Verify one retention run using a controlled old imported message and
  confirm that it moves the message to Gmail Trash.
- [ ] Review the first imported HTML coupon samples against the Sheet rows,
  labels and archive state to confirm the strict HTML parser remains accurate.

## P2 - Release hygiene

- [ ] Align the package metadata with the adopted first release number
  `0.1.0` before tagging or publishing the release.
- [ ] Create a signed release tag and release notes from `CHANGELOG.md` after
  the live migration and scheduled-run checks are complete.
- [ ] Define a lightweight release checklist: local tests, static check,
  Markdown lint, owner preflight, source comparison and targeted live proof.

## Explicitly out of scope

- AI, OCR, image extraction and Vertex/Gemini inference.
- A manual review UI or a new replacement Google resource.
- Automatic import of generic discounts, app-only coupons, barcodes or
  messages without an explicit code.
