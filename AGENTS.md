# MyCoupons contributor rules

## Product boundary

- MyCoupons runs in Google Apps Script. Gmail imports, Sheet writes, labels,
  archiving, retention, configuration and scheduled triggers must not depend on
  a local computer remaining online.
- Reuse the existing private Apps Script project, Google Sheet, Gmail label and
  Cloud project. Do not create replacement resources unless an audited existing
  resource is missing or ambiguous.
- The baseline imports only explicitly introduced coupon or promotional codes
  from subject and plain-text email content. It has no AI, image processing or
  review UI.
- A no-code, referral-only, authentication or ambiguous message remains
  untouched.
- Write and verify each Sheet row before labeling and archiving its source
  message. Advance the watermark only after a complete successful scan; on a
  Gmail rate-limit failure, commit only verified rows and exact labels, keep
  the watermark unchanged, and let the next scan exclude labeled messages.
- Delete retained imported messages by moving them to Gmail Trash, never by an
  irreversible deletion.

## Delivery and validation

- One remote PR must deliver one complete, verifiable and unambiguous user
  behavior without needing a later PR to make that behavior correct.
- Run `npm test` and `npm run check` for runtime changes. Tests must not depend
  on credentials, live Gmail, Drive, Sheets or Apps Script resources.
- Run markdownlint with `/Users/mmassari/.markdownlint.json` for changed
  Markdown. Run ShellCheck with `--enable=all` for changed shell scripts.
- Before deploying, perform an owner-gated read-only preflight. Keep deploy,
  live import, Git rewrite, remote cleanup and cloud-resource deletion as
  separate, evidence-gated actions.

## Safety

- Do not print or commit project IDs, spreadsheet IDs, label IDs, OAuth tokens,
  API keys, Secret Manager payloads or email contents.
- Preserve unrelated user work. The legacy repository is backed up locally at
  `/Users/mmassari/Backups/MyCoupons-legacy-20260915`.
