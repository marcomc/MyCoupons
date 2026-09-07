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
  `Europe/Rome`; exclude technical scan rows. An empty sheet needs `initialDate`.
- Detect explicitly introduced coupon codes and retain source text as notes.
  Deterministic candidates currently require review.
- Normalize proposed fields against quoted source text. Unsubstantiated fields
  become empty; code evidence preserves exact spelling and complete tokens.
  Image-based proposals and truncated conditions require review. This increment makes no
  AI requests and does not establish completeness of extracted offers.
- Quote formula-like spreadsheet text. Discover HTTPS image URLs while excluding
  recognizable trackers, IP literals, and local hostnames. This is a lexical
  filter; it does not resolve DNS or download images.
- Use stable review action identifiers with English labels: `Confirm`, `Ignore`,
  and `Retry with AI`. Any ignored candidate keeps its source message unchanged;
  archiving requires all candidates to be confirmed.

Source identity recovery accepts hexadecimal Gmail links under `mail.google.com`
using `#all/`, `#inbox/`, `#search/<query>/`, or the `th` query parameter.
Unsupported opaque Gmail UI links such as `permmsgid=msg-f:...` return no identity;
they must be resolved before a future importer can use them for deduplication.

`config/example.json` documents product defaults. Copy it to a `*.local.json`
file for private settings. The manifest declares the intended owner-only Apps
Script runtime; no permissions are granted merely by checking out these files.

## Local validation

Requires Node.js 22 or later. Run the currently available checks:

```sh
npm run check
npm test
```

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
