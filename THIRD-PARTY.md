# Third-party source

## HTML character references

`src/vendor/He.gs` is the unmodified standalone JavaScript build of
[he 1.2.0](https://github.com/mathiasbynens/he/tree/36afe179392226cf1b6ccdb16ebbb7a5a844d93a),
by Mathias Bynens. Its complete MIT license is in `src/vendor/LICENSE-he.txt`.
The `.gs` extension makes the same source available to Apps Script.

The decoder handles standard named and numeric references, including distinct
text and attribute rules. It runs locally without Node, a DOM or network access.
The full upstream build is retained unchanged for provenance and integrity;
MyCoupons uses its decoder API only.

Pinned source commit: `36afe179392226cf1b6ccdb16ebbb7a5a844d93a`.
The build is 100,899 bytes. `npm run check` validates the source and license
SHA-256 checksums and loads the actual artifact without CommonJS/browser globals.
The test harness also loads this exact file, including both source load orders.

All 2,231 entries in the [WHATWG character-reference table](https://html.spec.whatwg.org/entities.json)
were compared successfully against the pinned decoder on 2026-09-07.
The regular test suite covers text/attribute differences, numeric replacements,
single decoding and integration with coupon evidence and image attributes.

For an upgrade, replace both files from a reviewed immutable upstream revision,
update the checksums in `scripts/check.mjs`, repeat the complete WHATWG table
comparison, and run the normal tests and syntax/integrity checks. Keep the
upstream source unchanged; apply application behavior in `decodeHtml_`.
