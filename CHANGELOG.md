# Changelog

## Unreleased

### Added

- Coupon configuration and English localization with the existing sheet schema.
- Deterministic coupon-code detection, source-grounded candidate normalization,
  spreadsheet text escaping, and remote-image URL filtering.
- Strict coupon-token and Gmail-link identity validation; incomplete proposals
  and unknown review states cannot authorize archiving.
- Recovery dates based on the latest real coupon import in `Europe/Rome`, with
  calendar validation and explicit technical-row filtering.
- Local unit tests and Apps Script syntax and owner-only manifest checks.
