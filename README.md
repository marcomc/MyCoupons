# MyCoupons

Private Gmail-to-Google-Sheets coupon importer built with Google Apps Script.

## Table of contents

- [Status](#status)
- [Sheet state](#sheet-state)
- [Core behavior](#core-behavior)
- [Gemini routing](#gemini-routing)
- [Local provisioner foundation](#local-provisioner-foundation)
- [Local validation](#local-validation)
- [Public information pages](#public-information-pages)

## Status

The current increment provides configuration validation, coupon candidate
parsing and normalization, historical recovery dates, safe spreadsheet and
Gmail-label resource setup, a private per-message journal, bounded read-only
Gmail message ingestion, and local deterministic import-row persistence.
Review actions now expose an installable-edit-compatible `onReviewEdit` entry
point for Confirm, Ignore, and Retry with AI, with row/source validation and
message-level archive checkpoints. There is no deployment.

Private installation identifiers and credentials belong outside version control.
The example configuration contains product defaults only.

## Sheet state

- Resolve one configured spreadsheet identity, or adopt one unambiguous exact
  title match; fail closed on ambiguous or mismatched resources.
- Preserve the existing 26-column coupon schema and create only missing coupon
  and journal tabs. The journal is `_MyCoupons Messages` with `Message ID` and
  `State JSON` columns.
- Resolve or create each missing prefix of a nested Gmail label path. This
  setup does not read, label, archive, or otherwise mutate messages.
- Persist the resolved spreadsheet and label identities after verification.
  Journal records retain processing status, attempts, retry metadata, dedupe
  keys, candidate row references, and archive/label checkpoints.
- Recovery starts on the latest real coupon day in `Europe/Rome`; an empty
  coupon tab requires the configured `initialDate`.
- Read messages assigned to the configured label from the recovery date in
  bounded pages, irrespective of read state. Final journal states are skipped
  before fetching message contents, and Gmail is never mutated by this reader.
- Canonical message payloads preserve the message ID, thread ID, received time,
  sender, subject, plain text, raw HTML, and canonical Gmail link. MIME
  alternatives remain independent; unsupported content marks the payload
  incomplete and malformed message data produces a retryable error. Bounded
  image acquisition preserves DOM-order slots, maps only matching inline CIDs,
  fetches only safe HTTPS images, and stores inspected bytes/blob data with
  safe dimensions when known. Rejected, missing, duplicate, redirected,
  oversized, non-image, tracker, and small-pixel resources retain incomplete
  coverage.
- `runImportWorkflow_` consumes canonical reader output, derives deterministic
  candidates, persists bounded 26-column rows, and records candidate row
  references in the journal. Dedupe keys make reruns idempotent while retaining
  user-entered columns. Failed extraction or writes remain retryable; no Gmail
  mutation is performed.

## Gemini routing

- `callGeminiModel_` provides a bounded generic text-plus-inline-image
  transport; it does not infer coupon fields.
- The configured `gemini-flash-latest` model uses the Gemini Developer API
  first. Its API key is read only from the `GEMINI_API_KEY` Script Property.
- With `autoVertexFallback` enabled and `vertexProject` configured, paid Vertex
  routing activates only for an explicit daily-quota or prepayment-depletion
  HTTP 429 response. The temporary route lasts one hour and then expires.
- Network errors, HTTP 408, generic 429 responses, selected 5xx responses, and
  malformed responses retry at most three times on the current backend.

## Core behavior

- Preserve the existing 26 English coupon headers. Additional user columns are
  outside the core schema.
- Recover from the latest real coupon email date, including that entire day in
  `Europe/Rome`; exclude technical scan rows and partial discount rows. A real
  offer has a code, website, or both discount type and value. An empty sheet
  needs `initialDate`.
- Detect explicitly introduced coupon codes and retain source text as notes.
  Deterministic candidates currently require review. Tokens end at whitespace;
  one matching pair of outer ASCII quotes or angle brackets may wrap a token.
  Internal punctuation is never silently removed. Introducers require whitespace
  or an explicit colon/equal delimiter before the code.
  The deterministic parser skips complete tokens outside its supported Unicode
  letter/number/mark, underscore and hyphen syntax and 3–40 code-point length.
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

It does not create API keys, OAuth clients, secrets, Apps Script projects, or
deployments. See the provisioner guide for the label/adoption and retry
contract.

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
`removeDailyImportTrigger()` removes only that owned trigger and refuses to
choose between duplicates. When its stored trigger ID is missing, configured
automation removal can recover exactly one matching scheduled trigger; duplicate
matches remain ambiguous. `runScheduledImport()` serializes the import,
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
