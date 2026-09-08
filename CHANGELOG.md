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
- Gmail identity accepts only normalized default HTTPS ports; terminal `/open`
  trackers are excluded; suppressed responsive resources do not force review;
  whitespace-only cells cannot advance recovery; and vendored artifacts have
  stable LF checkout semantics for checksum verification.
- Closed native popovers are excluded from evidence, single-character factual
  quotes can ground valid symbols, timestamp offsets are limited to ±14:00, and
  malformed UTF-16 evidence is rejected before matching.
- Qualified numeric ranges recognize only the supported `off` marker; rendered
  image elements split text/evidence spans, and unmodeled visible inputs force
  review without projecting their attributes as text.
- Hidden HTML inputs split source/evidence spans without forcing incomplete
  coverage.
- Rendered button controls split source/evidence spans without changing their
  projected text.
- Unicode decimal range and ratio endpoints cannot ground numeric facts; unmodeled
  canvas fallback forces review; sourceless-image alternative text is extracted;
  and each factual field must occur inside its located source quote.
- Ellipsis/range-dot endpoints and calendar date components with supported
  English or Italian month labels cannot ground numeric facts.
- Discount and minimum-spend fields accept only scalar Unicode decimal values;
  non-scalar proposals are cleared and require review.
- Discount symbols must bind to the same numeric amount in one source span.
- Standalone `up to` caps and comma-less month-first dates cannot ground numeric
  facts; postfix currency symbols are accepted when they bind to their amount.
- Isolated currency symbols cannot ground a discount type; ordinal and dotted
  month-first dates cannot ground numeric facts; a shared inspected image can
  evidence a discount pair only with review.
- Figure-dash and fullwidth-hyphen ranges cannot ground numeric facts; visible
  inputs split projected text and source-evidence spans.
- Active iframes with a source force review, while inert or hidden frames remain
  excluded from source coverage.
- Nonempty iframe documents force review; semicolon-delimited image trackers are
  excluded; prose punctuation after a bare website authority is handled safely.
- Textual `percent`, dollar and pound range units, plus `EUR`/`USD`/`GBP` code forms, cannot ground numeric discount or spend values; explicit `Coupon code is CODE` introductions preserve whole-token validation.
- Active fallback surfaces and unmodeled text controls preserve incomplete HTML
  coverage; image evidence requires an inspected record; and discount symbols
  support ASCII-separated numeric amounts without admitting range endpoints.
- Suppressed inline HTML content now splits extraction and factual-evidence spans.
- Comments split source spans; active embeds force review; every active image
  requires an independently inspected record for complete coverage; and
  `from … through …` and `from … up to …` numeric intervals cannot ground
  endpoints, including with rendered Unicode spacing.
- Active-image coverage now verifies inspected records by DOM-order slot, and
  evidence-linearity tests use deterministic instrumentation instead of
  wall-clock limits.
- Numeric alternatives with `or` cannot ground scalar factual values; encoded
  tracker paths are rejected without rewriting their URLs; and inherited
  candidate or evidence properties cannot authorize an import.
- Automatic confirmation requires an own enumerable data completeness flag;
  archive outcomes require a plain own status; and valid zoned timestamps accept
  fractional seconds beyond millisecond precision.
- Signed numeric source expressions cannot ground unsigned scalar values; source
  fields must be own data properties; and unpaired discount components require review.
- Reserved internal sheet-name and capacity validation across config reloads.
- Recovery dates based on the latest real coupon import in `Europe/Rome`, with
  calendar validation and explicit technical-row filtering.
- Local unit tests and Apps Script syntax and owner-only manifest checks.
