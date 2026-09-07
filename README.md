# MyCoupons

Private Gmail-to-Google-Sheets coupon importer built with Google Apps Script.

## Table of contents

- [Status](#status)
- [Local validation](#local-validation)
- [Public information pages](#public-information-pages)

## Status

Implementation and installation are in progress. The current source includes
email and image extraction, Gemini routing, a processing journal, review actions
and owner-only setup entry points. Deployment and end-to-end operation have not
been validated. Do not treat the current checkout as a completed installation.

Private installation identifiers and credentials belong outside version control.
The example configuration contains product defaults only.

## Local validation

Requires Node.js 22 or later. Run the currently available checks:

```sh
npm run check
node --test tests/*.test.js
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
