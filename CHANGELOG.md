# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-09-16

### Added

- Google Apps Script runtime that operates independently of a local computer.
- Owner-gated Gmail scans of Inbox and archived mail from a configurable
  initial date, then from a persisted watermark with a configurable overlap.
- Resumable, bounded Gmail pagination that preserves scan state when Gmail
  rate limits an import.
- Coupon extraction from non-reply subjects, plain text and visible HTML text.
- Support for explicit numeric and strongly contextual uppercase letter-only
  coupon codes.
- Safeguards that exclude referral, authentication, OTP, ambiguous, sent,
  draft, spam and trashed messages.
- Verified Google Sheet writes with message-and-code deduplication before
  applying Gmail changes.
- Configurable Gmail label and archive action after a verified import.
- Configurable retention process that moves expired imported messages to Gmail
  Trash without permanent deletion.
- Daily cloud trigger installation with stable schedule identity validation.
- Read-only installation preflight and compatibility with the existing Apps
  Script project, Google Sheet and Gmail label.
