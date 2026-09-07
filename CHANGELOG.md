# Changelog

## Unreleased

### Added

- Coupon configuration and English localization with the existing sheet schema.
- Deterministic coupon-code detection, source-grounded candidate normalization,
  spreadsheet text escaping, and remote-image URL filtering.
- Complete coupon-token and Gmail-link identity validation, including punctuation
  boundaries, Unicode-aware bounds and evidence for notes; oversized structured
  values are cleared and unknown completeness cannot authorize confirmation.
- Standards-based HTML text/image traversal with malformed-input handling,
  hidden-content exclusions and normalized tracker dimensions.
- Complete HTML character-reference decoding with separate text/attribute rules
  and a reproducible, pinned local parser bundle.
- Reserved internal sheet-name and capacity validation across config reloads.
- Recovery dates based on the latest real coupon import in `Europe/Rome`, with
  calendar validation and explicit technical-row filtering.
- Local unit tests and Apps Script syntax and owner-only manifest checks.
