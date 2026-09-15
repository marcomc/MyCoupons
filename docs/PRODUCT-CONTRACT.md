# MyCoupons product contract

## Table of contents

- [Outcome](#outcome)
- [Configuration compatibility](#configuration-compatibility)
- [Data contract](#data-contract)
- [Import contract](#import-contract)
- [Retention contract](#retention-contract)
- [Exclusions](#exclusions)
- [Acceptance evidence](#acceptance-evidence)
- [Non-goals](#non-goals)

## Outcome

MyCoupons is a private Google Apps Script automation. It imports explicitly
introduced coupon codes from Gmail into the existing Google Sheet, labels and
archives the source email after a verified write, and later moves imported
emails to Gmail Trash after their configured retention period.

## Configuration compatibility

Configuration remains in the existing `MYCOUPONS_CONFIG` Script Property. The
baseline retains `ownerEmail`, `spreadsheetId`, `spreadsheetName`, `sheetName`,
`labelName` and `timeZone`. Existing AI-related keys remain parseable for a
safe migration but have no runtime effect.

The baseline settings are:

| Key | Default | Meaning |
| --- | --- | --- |
| `initialDate` | `2026-01-01` | First successful scan includes this UTC date boundary. |
| `watermarkOverlapDays` | `1` | Re-scan this overlap before the last successful scan. |
| `retentionDays` | `180` | Age after which imported labeled emails move to Trash. |
| `archiveImported` | `true` | Remove imported messages from Inbox after a verified write. |
| `trashExpiredImported` | `true` | Enable retention cleanup. |
| `dailyHour` | `8` | Approximate local daily trigger hour. |

The configured timezone must be a valid bounded IANA timezone. When installed,
the daily trigger's stable ID, handler, hour, timezone and target identity are
retained as private schedule metadata; a legacy, replaced or mismatched trigger
fails closed rather than being silently adopted or recreated.

## Data contract

The existing coupon tab and its headers remain the database. A baseline row
populates, at minimum, email date, coupon code, source subject, sender, Gmail
link, notes/deduplication key and status. Existing richer columns remain in
place and blank when the baseline cannot establish their values. New Gmail links
select the configured owner account rather than browser slot `u/0`; exact
legacy owner-account message links and `u/0` links remain usable only to verify
rows written by a prior implementation. New links use the Gmail conversation
thread ID, while row deduplication and Gmail mutations retain the message ID.

The durable watermark is stored independently in Script Properties together
with its target identity: owner, Sheet ID, tab and imported Gmail label. It is
the pre-list scan boundary of the latest fully successful scan, not a Sheet-row
date or the completion time. Each query is bounded above by that snapshot, so
messages that arrive while an import is running remain eligible next time. A
watermark missing that identity, or belonging to a changed target or resolved
label ID, is discarded and the next scan restarts from `initialDate`. A separate
validated private scan state retains the fixed range, Gmail page cursor and
pending message IDs when a history scan is interrupted by a Gmail per-user
limit. It is cleared only after that fixed range completes.

## Import contract

1. On first run, search all non-spam/non-trash Gmail messages from the exact
   UTC beginning of `initialDate`. Later runs search from the watermark minus
   its overlap. The result range remains stable while Gmail labels change.
2. Resolve the configured imported label to exactly one user-created Gmail
   label, then exclude messages already carrying it or a Spam, Trash, Sent or
   Draft label.
3. Inspect only subject and non-quoted plain-text message content.
4. Import only a complete code immediately introduced by an explicit form such
   as `coupon code`, `promo code`, `discount code` or `codice sconto`.
5. For every imported code, atomically append and verify a deduplicated Sheet
   row before mutating Gmail; an ambiguous append reservation fails closed.
6. Label the exact source message and, when configured, remove only that
   message from Inbox.
7. Persist the pre-list scan boundary only after every page and message in the
   fixed range completes. A Gmail rate limit preserves the private continuation
   state and resumes later without advancing the watermark or repeating the
   already processed prefix.

## Retention contract

Retention searches only already imported messages older than `retentionDays`.
When enabled, it handles one bounded Gmail page per run and returns whether the
page was complete; already processed messages move to Gmail Trash but are never
permanently deleted. A partial page or Gmail limit is reported as incomplete so
the next daily run can continue safely. The retention action is independent
from code extraction and cannot touch unlabelled, Draft, Sent, Spam or Trash
email; the daily handler still attempts it if the import portion fails.

## Exclusions

The baseline does not mutate email that has no explicit code, contains only a
referral link or referral-campaign wording, is an authentication/OTP message,
requires image/OCR analysis, or is otherwise ambiguous. An extraction miss is
acceptable; a false positive that archives unrelated email is not.

## Acceptance evidence

- Existing Apps Script project, Sheet and label are resolved unambiguously.
- A controlled historical coupon email creates one compatible row, label and
  archive action.
- Re-running the same range creates no duplicate row.
- A new controlled coupon email is imported by the scheduled handler.
- A safely old labeled controlled message moves to Trash, while an unlabelled
  message does not.
- No deployed runtime code, Script Property read or manifest scope depends on
  Gemini, Vertex, Secret Manager, external HTTP or review UI behavior.

## Non-goals

- AI or Gemini/Vertex inference.
- HTML, image, attachment or OCR extraction.
- Manual review UI or spreadsheet edit trigger.
- Automatic interpretation of generic discounts, referral links or prose.
- Creating a replacement Google Sheet, Gmail label, Apps Script project or
  Cloud project.
