# MyCoupons

Private Gmail-to-Google-Sheets coupon importer built with Google Apps Script.

## Table of contents

- [Status](#status)
- [Sheet state](#sheet-state)
- [Core behavior](#core-behavior)
- [Gemini routing](#gemini-routing)
- [Future delivery](#future-delivery)
- [Local provisioner foundation](#local-provisioner-foundation)
- [Local validation](#local-validation)
- [Public information pages](#public-information-pages)

## Status

The current increment provides configuration validation, source-grounded
deterministic and AI coupon extraction, historical recovery dates, safe
spreadsheet and Gmail-label resource setup, a private per-message journal, and
a bounded resumable mailbox scan.
Extraction treats the subject as an independent evidenced source, preserves
exact case/Unicode/punctuation coupon identities, and consolidates a sparse
deterministic code with an evidenced AI description. Fully evidenced complete
offers can be finalized; ambiguous, image-only, invalidated, and incomplete
outcomes remain reviewable.
Review actions now expose an installable-edit-compatible `onReviewEdit` entry
point for Confirm, Ignore, and Retry with AI, with row/source validation and
message-level archive checkpoints. The local provisioner can deploy and
bootstrap the private Apps Script installation; live deployment remains
operator-authorized and unverified.

Private installation identifiers and credentials belong outside version control.
The example configuration contains product defaults only.

## Sheet state

- Resolve one configured spreadsheet identity, or adopt one unambiguous exact
  title match; fail closed on ambiguous or mismatched resources.
- Preserve the existing 26-column coupon schema and create only missing coupon
  and journal tabs. The journal is `_MyCoupons Messages` with `Message ID` and
  `State JSON` columns. New batch payloads use bounded, marked JSON chunks in
  additional unlabelled journal columns; the coupon schema remains unchanged.
- Resolve or create each missing prefix of a nested Gmail label path. This
  setup does not read, label, archive, or otherwise mutate messages.
- Persist the resolved spreadsheet and label identities after verification.
  Journal records retain processing status, attempts, retry metadata, dedupe
  keys, candidate row references, and archive/label checkpoints.
- Recovery starts on the latest real coupon day in `Europe/Rome`; an empty
  coupon tab requires the configured `initialDate`.
  A future recovery date waits without Gmail queries, errors or a persisted
  cursor; a later daily run starts when due, or uses a corrected recovery date.
- Scan all Gmail messages returned by Gmail's default search (including every
  destination label and read state, while retaining Gmail's default spam/trash
  exclusion). The first window starts from the latest real coupon day; later
  windows advance from a durable cursor, never from a newer coupon row.
- Freeze each scan's end before paging and store its page cursor plus every
  listed, unprocessed message ID before fetching message content. Exact
  `internalDate` checks bound the safe epoch-second query overlap. A stale
  provider page token restarts only that frozen window. Listing uses REST:
  only a structured HTTP 400 followed by a valid response to the identical
  tokenless query permits restart. Other failures preserve the cursor; no
  localized Advanced-service error strings are parsed. See the
  [Gmail error contract](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
  and [list parameters](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).
  Read/extraction failures remain journal-backed retries after a window advances.
- Process at most 50 messages per run, streaming one canonical
  message through row persistence before fetching the next. Final journal
  states are skipped before fetching, and Gmail is never mutated by this reader.
  A lock-scoped journal snapshot indexes message states and row locations;
  per-message persistence checks only the target cells and updates the snapshot
  after exact readback. Ambiguous writes invalidate the session until the next
  run reloads durable state. Notification deltas come from that durable state.
- `diagnoseGmailRead(messageId)` is an owner-gated, read-only Execution API
  entrypoint for an operator investigating a Gmail runtime mismatch. It returns
  fixed outcomes for read, MIME, HTML, image-part, acquisition, and canonicalization
  plus primitive raw-shape types. `mimeTrace` retains the latest 64 MIME part
  records (with an omitted count), numbered traversal/parent positions, exact
  failure stages, types, lengths, size equality, and fixed charset classes.
  The trace follows the production parser and does not relax validation or
  establish a runtime repair. For a MIME failure, inspect the deepest retained
  error record; ancestors may also fail while processing their children.
  It never returns message content, identifiers, headers, URLs, bytes, arbitrary
  charset names, or exception text. It performs no Gmail, sheet,
  property, or trigger mutation.
- Canonical message payloads preserve the message ID, thread ID, received time,
  sender, subject, plain text, raw HTML, and canonical Gmail link. MIME
  alternatives remain independent; unsupported content marks the payload
  incomplete and malformed message data produces a retryable error. Text and
  image payloads accept REST base64url strings and Advanced-service byte arrays
  through one validated boundary. Signed and unsigned octets preserve exact
  content; invalid elements, malformed encoding, invalid size types, and missing
  positive-size body data remain errors. A nonempty text body with valid bytes
  but an inconsistent declared size retains its entire decoded text, including
  trailing CRLF, with incomplete coverage. Image and multipart-container size
  validation stays strict. Named files and attachment-disposition parts are
  excluded from body text/HTML; unsupported documents retain incomplete coverage
  and are never fetched or parsed. Supported image attachments remain independently
  acquired. Incomplete sources require review through initial extraction, AI retry,
  and batch replay, including empty results. Explicit Confirm remains available
  after validating all factual fields and the complete persisted candidate batch.
  Empty multipart byte arrays remain valid containers. Utilities
  receive signed bytes, while image signatures and dimensions use unsigned
  octets. The REST representation and byte counts follow the
  [Gmail body contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments);
  blobs and encoding use the
  [Apps Script Byte-array utilities](https://developers.google.com/apps-script/reference/utilities/utilities).
  Image transport canonicalizes Utilities' padded base64url output to the
  unpadded form required at the Gemini request boundary, preserves exact bytes,
  and counts decoded bytes before enforcing per-image and aggregate limits.
  This repair has synthetic regression coverage; deployed import acceptance
  requires a separate live run. Bounded
  image acquisition preserves DOM-order slots, maps only matching inline CIDs,
  fetches only safe HTTPS images, and stores inspected bytes/blob data with
  safe dimensions when known. Rejected, missing, duplicate, redirected,
  oversized, non-image, tracker, and small-pixel resources retain incomplete
  coverage. Acquisition starts no further image reads after a 30-second
  per-message soft budget or the execution's 15-second write reserve. An
  in-flight synchronous provider request cannot be interrupted; any omitted
  images retain incomplete coverage.
- `runImportWorkflow_` consumes canonical reader output and runs the merged
  deterministic and AI extractor. It persists rows, candidate identities, and
  Gmail checkpoints in the private journal. Technical identities stay in the
  journal; `Notes / dedupe key` contains readable evidenced notes and `Currency`
  is projected to its matching column. Failed extraction, writes, and Gmail
  acknowledgements stay retryable without duplicate rows.
- Before writing any coupon row, persist and verify the entire extraction batch
  (at most 12 candidates). Its payload remains immutable; row/mail checkpoints
  update only the metadata cell. Interrupted imports replay pending payloads
  without another model call, preserve reviewed rows, and cannot archive until
  every intended candidate is durably bound. New rows recovered after an
  interruption require review.
- Legacy `awaiting_extraction` records are recovered through full extraction. A
  complete, structurally valid empty model list becomes a non-offer checkpoint
  with no Gmail archive authority. Empty results caused by incomplete coverage or
  validation/filtering remain reachable rather than becoming non-offers.
  Legacy bound batches interrupted before a completed review checkpoint remain
  fail-closed with `STATE` / `legacy_batch`; their missing payloads cannot be
  reconstructed safely from a new model response. Completed legacy review rows
  remain actionable, including their original technical Notes keys.
- Before Gmail mutation, candidate rows and journal state are verified. Only an
  all-confirmed message is labelled and removed from `INBOX`, preserving `UNREAD`
  and unrelated thread messages. A mixed Confirm/Ignore disposition leaves the
  source mail unchanged. Label and archive acknowledgements are checkpointed
  separately so retries recover partial mutation safely.

## Gemini routing

- `callGeminiModel_` provides a bounded generic text-plus-inline-image
  transport; it does not infer coupon fields.
- The configured `gemini-flash-latest` model uses the Gemini Developer API
  first. Its API key is read only from the `GEMINI_API_KEY` Script Property.
- With `autoVertexFallback` enabled and `vertexProject` configured, paid Vertex
  routing activates only for an explicit daily-quota or prepayment-depletion
  HTTP 429 response. The temporary route lasts one hour and then expires.
- Vertex `global` calls use `aiplatform.googleapis.com`; regional locations keep
  their location-prefixed host.
- Network errors, HTTP 408, generic 429 responses, selected 5xx responses, and
  malformed responses retry at most three times on the current backend. Production
  retries sleep with bounded exponential backoff and stop when the execution
  deadline would be exceeded.

## Core behavior

- Preserve the existing 26 English coupon headers. Additional user columns are
  outside the core schema.
- Recover from the latest real coupon email date, including that entire day in
  `Europe/Rome`; exclude technical scan rows and partial discount rows. A real
  offer has a code, website, or both discount type and value. An empty sheet
  needs `initialDate`.
- Detect explicitly introduced coupon codes from independent subject, plain-text,
  and rendered-HTML spans, and retain source text as notes. Sender is provenance
  metadata and cannot support an asserted merchant or offer field.
  Deterministic candidates currently require review. Tokens end at whitespace;
  one matching pair of outer ASCII quotes or angle brackets may wrap a token.
  Internal punctuation is never silently removed. Introducers require whitespace
  or an explicit colon/equal delimiter before the code.
  Complete 3–40 code-point tokens with a Unicode letter, number, or mark remain
  exact identities, including internal and boundary punctuation.
- AI and deterministic descriptions consolidate only when an exact code identity
  enriches a sparse deterministic code. Separate described offers remain separate
  even if they reuse a code. `extractCouponOutcome_` explicitly reports complete
  versus incomplete coverage; an empty outcome never grants archive authority.
  Copied Notes exceeding 3,500 UTF-16 units or more than 12 unique explicit codes
  keep the extraction incomplete after AI enrichment, including on retry.
  Deduplication, row recovery, and retry share descriptive case/whitespace rules,
  preserve numeric zero, and keep code and URL path/query/fragment identity exact.
- Reject unknown candidate or evidence keys and malformed control fields before
  normalizing proposed fields, including notes, against quoted source text.
  Candidate and evidence records must use own properties on plain or null
  prototypes. Unsubstantiated fields become empty; code evidence preserves exact spelling
  and complete tokens, including punctuation, and numeric values cannot be range,
  ratio, Unicode hyphen/minus/dash, fraction-slash, ellipsis or range-dot endpoints, or supported
  word-delimited interval endpoints, including
  Unicode decimal digits, units, currency, the range qualifier `off`, and
  Unicode-space-separated symbols. Range units recognize `EUR`, `USD`, and
  `GBP` in either documented currency position. Discount and minimum-spend fields store a
  scalar Unicode decimal literal; units and currency remain source context. Signed
  source expressions cannot ground an unsigned scalar value, and a lone discount
  component always requires review.
  A discount symbol and its amount must be adjacent in the same source span;
  currencies may precede or follow their amount. Calendar date components with
  supported English or Italian month labels cannot
  ground numeric fields. The same inspected image may evidence a discount pair,
  but it always requires review.
  Oversized
  structured values become empty; bounded notes
  retain complete Unicode characters and require review. A supplied image-evidence
  index must identify an independently inspected image record.
  Image-based proposals and unknown message completeness also require review.
  Website evidence recognizes prose around bare host URLs while preserving
  punctuation in paths and queries. This increment makes no AI requests and does
  not establish completeness of extracted offers.
- Quote formula-like spreadsheet text. Discover HTTPS image URLs while excluding
  recognizable trackers, including percent-encoded path forms, IP literals, and
  local hostnames. Path decoding is only for tracker classification; the fetched
  URL remains byte-for-byte unchanged. This is a lexical filter; it does not
  resolve DNS or download images.
- Extract text and actual image elements with a shared standards-based HTML
  document traversal, preserving `html`/`body` attributes. Exclude comments,
  scripts, styles, metadata, inert templates, non-rendered `datalist`/`rp`
  content, closed dialogs and popovers, closed-details content except its first
  direct `summary`, and `hidden` subtrees; include `noscript` fallback content.
  Rendered blocks and replaced elements retain text boundaries; hidden inputs
  and button controls also split source/evidence spans. Select controls, visible inputs, textareas,
  and active fallback surfaces (audio, canvas, meter,
  object, progress, and video), plus active embeds, are excluded because their
  rendered state is not modeled and therefore force review. Each active
  `img[src]` requires a valid independently inspected image record for complete
  coverage. `message.images` starts with one DOM-order slot for every active
  image; a missing or failed slot forces review, and a later record cannot cover
  an earlier image. Parsed attributes never become image evidence. Sourceless image
  alternatives are projected as visible text. Direct
  image URLs trim only surrounding ASCII attribute whitespace. Responsive
  `srcset`/`picture` resources in active rendered content are not selected and
  force review. No CSS visibility analysis or script execution occurs. Image dimensions follow HTML pixel/percentage
  rules.
  Entire SVG/MathML subtrees are excluded from text/image evidence and mark source
  coverage incomplete, even for text-free graphics or content inside templates.
  Their presence requires review; there is no automatic logo exemption.
- Use stable review action identifiers with English labels: `Confirm`, `Ignore`,
  and `Retry with AI`. Any ignored candidate keeps its source message unchanged;
  archiving requires all candidates to be confirmed through plain records with an own `status`.

Candidate helpers accept optional raw `message.html` alongside independent
`message.text` (plain text and subject) and independently inspected `message.images`.
Each supplied source field must be an own data property; inherited and accessor
fields are rejected before extraction.
Both extraction and normalization derive HTML coverage through the same adapter;
an own enumerable data `incomplete: false` cannot override unsupported HTML
content. Do not premerge an HTML projection into `message.text`, and keep evidence matches within one source
representation, across a rendered block boundary, or from a quote occurrence
that does not contain the asserted field. Suppressed markup also splits source
spans before deterministic extraction and evidence checks. The string-only `htmlText_` and URL-discovery helpers cannot
establish source completeness. Future image processing must retain these coverage
signals rather than treat omitted vector content as processed. Factual fields and
quotes must be well-formed UTF-16, including complete astral characters.

AI extraction is read-only: `extractCouponCandidates_` builds a bounded prompt
from independent text, HTML-derived source spans, and inspected images, then
accepts only a JSON `{ "candidates": [...] }` response. Each candidate may
contain exactly the existing fields plus `confidence`, `review`, and
`evidence`. AI candidates use the same source-grounding rules as deterministic
candidates and are deduplicated by stable offer identity; transport, schema,
evidence, and bound failures remain retryable.

Source identity recovery accepts canonical lowercase hexadecimal Gmail links under
`mail.google.com` (case-insensitive with an optional decimal serialization of
the default HTTPS port) using
`#all/`, `#inbox/`, `#search/<query>/`, or the `th` query parameter.
Unsupported opaque Gmail UI links such as `permmsgid=msg-f:...` return no identity;
they must be resolved before a future importer can use them for deduplication.

`config/example.json` documents product defaults. Copy it to a `*.local.json`
file for private settings. The coupon tab cannot use the reserved internal title
`_MyCoupons Messages`, regardless of case, and its name is limited to 100 UTF-16
units. The manifest declares the intended owner-only Apps
Script runtime; no permissions are granted merely by checking out these files.

## Local provisioner foundation

`python3 -m provisioner.cli` supplies a local, resumable operator provisioner.
It validates complete private installation config, creates mode-0700 state
outside Git, binds that state to its installation identity, validates a source
bundle, and can make harmless authenticated identity/project reads. Its
`provision-cloud` action creates or adopts only explicitly labelled,
owner-verified Gemini Developer API and Vertex fallback projects. The Developer
project must be unbilled; the Vertex project may be linked only from unlinked
state to the configured Generic Billing Account. It then reconciles the limited
required APIs without printing identifiers, raw diagnostics, credentials, or
command output.

`deploy-apps-script` then uses a private isolated clasp authorization to create
or adopt one sole-owner private Apps Script project. A newly created project
returns `apps-script-association-required` before source upload, deployment, or
secret staging; after its operator-managed Cloud association, a rerun uploads
and reads back the exact source digest and creates or recovers only owner-only
Execution API deployments. It passes an in-memory bootstrap payload through an
installation-owned Secret Manager version, validates the non-secret
`bootstrapFromSecret` result, disables that version, and persists only signed
non-secret metadata. Unsafe deployments, ambiguous projects, or foreign sharing
fail closed.

See [the provisioner guide](docs/PROVISIONER.md) for the implemented commands
and deferred steps.

## Local validation

Requires Node.js 22 or later. Run the currently available checks:

```sh
npm run check
npm test
```

The local provisioner test suite uses only Python's standard library:

```sh
python3 -m unittest discover -s tests_python -v
python3 -m compileall -q provisioner tests_python
```

## Scheduled imports and notifications

`installDailyImportTrigger()` installs or reuses one daily clock trigger at
approximately 08:00 in `Europe/Rome`; Apps Script may apply scheduling jitter.
Backlog work uses at most one additional `runMailboxContinuation` clock trigger,
approximately every five minutes, under the same workflow lock. Its durable
metadata binds the verified owner, installation and exact trigger UID. Creation
intent is saved first; unknown/orphan triggers fail closed rather than being
adopted or duplicated. Completion removes the continuation even when individual
read failures remain for a later daily retry.

Daily and continuation runs share fifteen scan slots per rolling 24 hours
(60 minutes of four-minute scan budgets). At exhaustion, the owned continuation
remains as a wake for the rolling reset, independently of the daily schedule.
Paused continuation events validate owner and exact UID but skip spreadsheet,
journal and message access without reserving another slot. These lightweight
polls still incur trigger overhead: the cap does not guarantee protection against
shared Apps Script quotas or arbitrary mailbox arrival rates.
After owner and private-spreadsheet validation, daily lifecycle failures are
notified once and retained if delivery fails; unknown continuation events do
not gain notification authority.

`removeDailyImportTrigger()` preflights both owned clock triggers before deleting
either and refuses to choose between duplicates. When the daily trigger's stored
ID is missing, configured
automation removal can recover exactly one matching scheduled trigger; duplicate
matches remain ambiguous. This exception does not apply to orphan continuations.
Reconfiguration cancels the old continuation; failed reconfiguration leaves the
old daily schedule able to resume. `runScheduledImport()` serializes the import,
notifies the configured owner only for new imports, newly created review rows,
or changed errors. Script Properties store a bounded fingerprint/timestamp
after delivery, plus a bounded pending summary containing validated IDs and
links when delivery fails so the next run can retry it. A successful send is
recorded after `MailApp.sendEmail` returns; failed sends remain retryable.
Review and source links are included only after their identifiers and
authorities are validated.

HTML parsing uses a pinned, bundled parser. See
[third-party provenance and update checks](THIRD-PARTY.md); no dependency download
is needed to run these checks.

## Public information pages

`docs/` contains the application homepage and privacy policy for OAuth
branding. Publish only that directory on an operator-controlled HTTPS domain.
The pages contain no coupon data, installation identifiers, or credentials.

- Application homepage: `index.html`.
- Privacy policy: `privacy.html`.
- Shared presentation: `styles.css`.

Before entering their URLs in Google Auth Platform, verify that both pages load
without authentication and that the homepage links to the same privacy policy
URL configured in Branding. Register the hosting domain under Authorised domains.
Do not enter placeholder or unrelated URLs. GitHub Pages publishes `docs/` from `main` at
<https://marcomc.github.io/MyCoupons/>.

## Future delivery

The importer remains private. For future authenticated coupon access, direct
Google OAuth plus Google Sheets access is the preferred first option: it reuses
the owner-controlled spreadsheet and supports per-user consent, but exposes a
Sheets-shaped client contract and requires careful sharing/refresh-token policy.
A private authenticated API is preferable when a stable product contract,
server-side authorization, rate limits, or application-specific auditing become
necessary; it adds service hosting and identity lifecycle work. Do not expose the
private Sheet or Gmail data through a public endpoint as a shortcut.

See [TODO.md](TODO.md) for separate unimplemented Chrome and Safari extension
deliverables.
