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
- Unicode decimal range endpoints cannot ground numeric facts; unmodeled canvas
  fallback forces review; sourceless-image alternative text is extracted; and each
  factual field must occur inside its located source quote.
- Active fallback surfaces and unmodeled text controls preserve incomplete HTML
  coverage; image evidence requires an inspected record; and discount symbols
  support ASCII-separated numeric amounts without admitting range endpoints.
- Suppressed inline HTML content now splits extraction and factual-evidence spans.
- Comments split source spans; active embeds force review; every active image
  requires an independently inspected record for complete coverage; and
  `from … through …` numeric intervals cannot ground endpoints.
- Reserved internal sheet-name and capacity validation across config reloads.
- Recovery dates based on the latest real coupon import in `Europe/Rome`, with
  calendar validation and explicit technical-row filtering.
- Local unit tests and Apps Script syntax and owner-only manifest checks.
