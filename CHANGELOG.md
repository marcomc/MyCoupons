# Changelog

## Unreleased

### Fixed

- Share factual identity normalization across deduplication, row recovery, and AI
  retry matching, preserving numeric zero and exact code/URL components. Keep
  truncated deterministic Notes and clipped code sets in review after AI enrichment.

- Run full deterministic plus AI extraction during initial and recovered scans;
  keep invalidated or incomplete empty outputs reachable, checkpoint verified
  non-offers without archive authority, and recover legacy awaiting-extraction
  records without hot retries.

- Preserve readable evidenced Notes and Currency columns while keeping technical
  candidate identities in the private journal. Reconcile reordered candidate
  output and append-before-acknowledgement recovery without duplicate rows.

- Persist message-finalization checkpoints before and after label/archive
  operations, preserve unread and unrelated messages, and use bounded production
  Gemini retry delays that respect the runtime deadline.

- Verify the complete immutable candidate batch before row writes, replay
  interrupted imports without re-extraction, and gate every archive entrypoint
  on full-batch persistence. Keep interrupted legacy batches fail-closed and
  preserve completed legacy review, including Notes keys and typed expiry dates.

- Preserve case-sensitive URL paths, queries, and fragments in candidate
  identities. Collapse exact repeated AI offers before sparse-code enrichment
  while retaining distinct conditions for offers sharing a coupon code.

- Honor extraction backoff for retained page IDs, clear abandoned payload staging
  before non-batch checkpoints, and restore acknowledged legacy mail failures to
  review without re-extraction or repeating completed Gmail mutations.

- Treat the email subject as an independent evidence span, preserve exact
  case/Unicode/punctuation coupon identities, prevent sender metadata from
  grounding offer facts, consolidate sparse deterministic codes with their
  evidenced AI descriptions, and use the correct global Vertex endpoint.

- Recognize gcloud's exact owner-pinned missing bootstrap-secret diagnostic and
  either canonical project identity in its ancestor response, while rejecting
  ambiguous aliases, foreign identities, and unrelated diagnostics.

- Send Apps Script deployment updates in the endpoint-required
  `deploymentConfig` envelope and verify the exact updated deployment on
  read-back.

- Persist immutable Apps Script version and deployment creation boundaries so
  an interrupted request recovers verified resources without reposting them.

- Defer localized review-action lookup until execution so Apps Script source
  evaluation cannot fail when the locale module loads later.

### Added

- Trace nested MIME validation and Apps Script decoding stages in the owner-only
  Gmail diagnostic, with bounded metadata-only records for runtime triage.
  Importer validation and behavior remain unchanged; a live MIME repair is not
  yet established.

- Add an owner-gated, read-only Gmail stage diagnostic with fixed opaque results
  and primitive representation types for live triage; it exposes no mailbox
  content or identifiers.

- Finalize fully evidenced complete offers after durable row/journal persistence;
  mixed review dispositions preserve the source email, and retryable Gmail
  acknowledgement failures recover from the indexed journal.

- Document private future authenticated access choices and separate unimplemented
  Chrome and Safari extension deliverables.

- Add a frozen, resumable Gmail mailbox scanner that discovers all default-search
  mail independently of labels and read state, persists pending IDs before
  bounded streaming reads, retries failed IDs durably, and validates token
  rejection through an otherwise identical tokenless REST read without moving
  a scan window. An owned, lock-safe continuation drains backlog in bounded
  execution slots, with installation-scoped lifecycle and image deadlines.
  Indexed journal sessions avoid per-message full-sheet rereads and retain
  fail-closed write verification and recovery after ambiguous writes.
  Future recovery dates wait without querying Gmail or advancing the cursor.
  Paused continuations retain a wake for rolling budget resets, and verified
  daily lifecycle failures reach the owner without authorizing unknown events.
- Retain code-less messages as awaiting extraction, without false failure
  notifications, hot retries or archive authority; automatic AI consumption
  remains a separate increment.

- Add an extraction outcome contract that distinguishes complete and incomplete
  coverage without letting an empty candidate list authorize archiving.

- Harden Apps Script bootstrap deployment: distinguish the automatic HEAD
  deployment, accept canonical Secret Manager project-number resources, reject
  `.js` inputs with unverifiable read-back paths, inspect inherited project
  Secret Accessor grants, and prove Execution API access before staging a
  bootstrap secret.

- Add a resumable Apps Script deployment and bootstrap action that creates or
  adopts only one private owner-only project, verifies uploaded/versioned source
  digests and owner-only Execution API deployment metadata, transfers bootstrap
  data through a labelled Secret Manager version without persisting its payload,
  and disables the exact version after the verified non-secret response.

- Add an idempotent, signed-state Cloud provisioning action that creates or
  adopts only owner-verified labelled Gemini Developer API and Vertex fallback
  projects; keeps the Developer project unbilled; links only an unlinked Vertex
  project to its configured Generic Billing Account; and reconciles the required
  API services with bounded, redacted subprocess diagnostics.

- Add a secure, standard-library local provisioner foundation with strict
  Installer-compatible configuration validation, private atomic resumable
  state, non-blocking locking, deterministic Apps Script source digests, safe
  tool discovery, and read-only gcloud identity/project preflight.

- Add an idempotent Europe/Rome daily scheduler and safe removal of its owned
  trigger, preserving unrelated triggers and rejecting ambiguous duplicates.
- Add delta-based owner email summaries for new imports, new review rows, and
  changed errors, with retryable delivery state and validated direct links.

- Review-action processing for configured coupon-tab edits: strict Confirm,
  Ignore, and Retry with AI handling, source validation, per-candidate journal
  outcomes, and message-level label/archive checkpoints that preserve retryable
  failure state.

- Strict, bounded AI candidate extraction with JSON-only response validation,
  source/image evidence normalization, deterministic-candidate deduplication,
  and fail-closed local transport integration.

- Bounded Gemini Developer API transport with generic text/image requests,
  exact daily-quota and prepayment-gated one-hour Vertex fallback, cooldown
  expiry, fail-closed response validation, and local retry/routing tests.

- Bounded canonical image acquisition for Gmail attachments, inline CID parts,
  and safe HTTPS HTML images, with DOM-order identity, byte/count limits,
  MIME/status/redirect filtering, tracker and small-pixel rejection, and
  incomplete-coverage propagation without Gmail mutations.

- Deterministic import workflow persistence: canonical reader messages become
  source-grounded coupon or review rows, with journal-linked deduplication,
  retryable failures, and no Gmail mutations.

- Bounded read-only Gmail ingestion for the configured label, with final-state
  journal skipping, canonical message identity and timestamps, independent
  plain-text/HTML MIME representations, and retryable malformed-message
  handling.
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
- Safe spreadsheet and nested Gmail-label resource setup, preserved coupon
  headers, and a private per-message journal for retry and deduplication state.
- Local unit tests and Apps Script syntax and owner-only manifest checks.
