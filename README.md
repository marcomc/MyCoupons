# MyCoupons

Private Gmail-to-Google-Sheets coupon importer built with Google Apps Script.

## Table of contents

- [Status](#status)
- [Core behavior](#core-behavior)
- [Local validation](#local-validation)
- [Public information pages](#public-information-pages)

## Status

The first implementation increment provides configuration validation, coupon
candidate parsing and normalization, historical recovery dates, and English
localization. It is a tested foundation; Gmail ingestion, AI requests,
spreadsheet writes, review triggers, and installation are subsequent increments.
There is no active importer or deployment in this increment.

Private installation identifiers and credentials belong outside version control.
The example configuration contains product defaults only.

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
  Unsubstantiated fields become empty; code evidence preserves exact spelling
  and complete tokens, including punctuation, and numeric values cannot be range,
  ratio, Unicode-minus, or supported word-delimited interval endpoints, including
  Unicode decimal digits, units, currency, and the range qualifier `off`. Oversized
  structured values become empty; bounded notes
  retain complete Unicode characters and require review. A supplied image-evidence
  index must identify an independently inspected image record.
  Image-based proposals and unknown message completeness also require review.
  Website evidence recognizes prose around bare host URLs while preserving
  punctuation in paths and queries. This increment makes no AI requests and does
  not establish completeness of extracted offers.
- Quote formula-like spreadsheet text. Discover HTTPS image URLs while excluding
  recognizable trackers, IP literals, and local hostnames. This is a lexical
  filter; it does not resolve DNS or download images.
- Extract text and actual image elements with a shared standards-based HTML
  document traversal, preserving `html`/`body` attributes. Exclude comments,
  scripts, styles, metadata, inert templates, non-rendered `datalist`/`rp`
  content, closed dialogs and popovers, closed-details content except its first
  direct `summary`, and `hidden` subtrees; include `noscript` fallback content.
  Rendered blocks and replaced elements retain text boundaries. Select controls,
  visible inputs, textareas, and active fallback surfaces (audio, canvas, meter,
  object, progress, and video) are excluded because their rendered state is not
  modeled and therefore force review. Sourceless image alternatives are projected
  as visible text. Direct
  image URLs trim only surrounding ASCII attribute whitespace. Responsive
  `srcset`/`picture` resources in active rendered content are not selected and
  force review. No CSS visibility analysis or script execution occurs. Image dimensions follow HTML pixel/percentage
  rules.
  Entire SVG/MathML subtrees are excluded from text/image evidence and mark source
  coverage incomplete, even for text-free graphics or content inside templates.
  Their presence requires review; there is no automatic logo exemption.
- Use stable review action identifiers with English labels: `Confirm`, `Ignore`,
  and `Retry with AI`. Any ignored candidate keeps its source message unchanged;
  archiving requires all candidates to be confirmed.

Candidate helpers accept optional raw `message.html` alongside independent
`message.text` (plain text and subject) and independently inspected `message.images`.
Both extraction and normalization derive HTML coverage through the same adapter;
`incomplete: false` cannot override unsupported HTML content. Do not premerge an
HTML projection into `message.text`, and keep evidence matches within one source
representation, across a rendered block boundary, or from a quote occurrence
that does not contain the asserted field. Suppressed markup also splits source
spans before deterministic extraction and evidence checks. The string-only `htmlText_` and URL-discovery helpers cannot
establish source completeness. Future image processing must retain these coverage
signals rather than treat omitted vector content as processed. Factual fields and
quotes must be well-formed UTF-16, including complete astral characters.

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

## Local validation

Requires Node.js 22 or later. Run the currently available checks:

```sh
npm run check
npm test
```

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
