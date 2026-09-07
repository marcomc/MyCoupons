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
  hidden-content exclusions and normalized tracker dimensions. Unsupported
  SVG/MathML coverage propagates to review through the raw-HTML source adapter.
- Complete HTML character-reference decoding with separate text/attribute rules
  and a reproducible, pinned local parser bundle.
- Strict candidate/evidence schemas and complete introducer, code-token and URL
  evidence boundaries, including valid inspected-image indexes and one-source-span
  factual evidence.
- Closed native dialogs and non-summary closed-details content are excluded from
  HTML evidence; unselected responsive resources force review. Gmail identity
  normalizes the supported authority/default port, supplied image slots must be
  present, and numeric range endpoints cannot ground factual values.
- Rendered disclosure blocks preserve text boundaries; direct image URL attributes
  trim surrounding ASCII whitespace; opaque Gmail IDs remain canonical; and numeric
  evidence rejects Unicode-minus and supported word-delimited intervals.
- Remaining default-rendered HTML blocks preserve evidence boundaries; non-rendered
  control content is excluded, unmodeled selections force review, numeric interval
  units cannot ground an endpoint, and recovery ignores partial discount rows.
- Reserved internal sheet-name and capacity validation across config reloads.
- Recovery dates based on the latest real coupon import in `Europe/Rome`, with
  calendar validation and explicit technical-row filtering.
- Local unit tests and Apps Script syntax and owner-only manifest checks.
