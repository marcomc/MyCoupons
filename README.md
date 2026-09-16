# MyCoupons

Private Gmail-to-Google-Sheets coupon importer built with Google Apps Script.

## Table of contents

- [Purpose](#purpose)
- [Runtime](#runtime)
- [Behavior](#behavior)
- [Configuration](#configuration)
- [Development](#development)
- [Status](#status)

## Purpose

MyCoupons stores explicitly introduced coupon and promotional codes from Gmail
in an existing private Google Sheet. It labels and archives successfully
imported source messages, retains them for a configurable period, then moves
them to Gmail Trash.

## Runtime

The deployed Google Apps Script project runs scheduled and manual imports in
Google's cloud. This repository is only the source and local test environment;
the computer used to edit or deploy it is not part of the production runtime.

## Behavior

- Reuse the existing Apps Script project, Sheet and Gmail label.
- Scan from a configurable initial date on first import, then from the last
  successful watermark with a small configurable overlap. Historical scans
  retain a private continuation cursor when Gmail enforces a per-user quota.
- Import only explicitly introduced coupon/promo/discount codes on a standalone
  line, or an equivalent non-reply subject. Letter-only codes require a strong
  coupon context and an uppercase token, while referral-only,
  authentication, ambiguous and no-code emails stay untouched.
- Avoid duplicate rows for the same Gmail message and exact code.
- Apply the configured label and archive only after the Sheet write succeeds.
- Move labeled imported messages older than the configured retention period to
  Gmail Trash.

The baseline deliberately excludes AI, image extraction and a review UI.

## Configuration

The private `MYCOUPONS_CONFIG` Script Property retains existing resource
identities and adds baseline settings. See
[example.json](config/example.json) and
[PRODUCT-CONTRACT.md](docs/PRODUCT-CONTRACT.md).

## Development

```sh
npm test
npm run check
```

Local tests use mocked Google Apps Script services. They never access live
email, Drive, Sheets or credentials.

Release management uses [CHANGELOG.md](CHANGELOG.md) for shipped
functionality and [TODO.md](TODO.md) for pending work.

## Status

The baseline is deployed to the existing private Google resources. Its source
was matched to `main`, the owner-gated preflight and a manual import completed
successfully, and one baseline-managed daily trigger is installed. The previous
repository history has a verified local-only backup and is not present on the
remote.
