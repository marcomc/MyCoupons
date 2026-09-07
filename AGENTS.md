# MyCoupons contributor rules

## Delivery and validation

- Implement one independently testable increment at a time. The user owns
  commits, pushes, PR creation and merges; stop at those boundaries.
  Exception: during `codex-pr-review-remediation-loop`, the agent may commit
  and push reviewed corrections and continue the review loop.
- Run `npm test` and `npm run check` for runtime changes. Tests must not depend
  on ignored drafts, credentials, or live Google resources.
- Follow the supplied user-wide Markdown and shell validation requirements.

## Source and mutation contracts

- Coupon codes preserve case and full Unicode token identity, including
  punctuation. Extraction and evidence checks share whole-token boundaries;
  never accept a fragment in either the quoted evidence or original source.
- Every proposed factual field, including notes, requires source evidence.
  Direct source copies remain distinct from model-authored text.
- Clear oversized structured values instead of returning prefixes. Bounded
  descriptive text must not split a Unicode surrogate pair. Deterministic
  code length uses code points; storage capacities use UTF-16 units.
- Reserve internal sheet titles using case-insensitive comparison, including
  when loading persisted configuration.
- Parse Gmail URL components before extracting identity. Reject unsupported UI
  tokens; never truncate them or infer an undocumented API-ID conversion.
- Information lost through truncation requires review. Only an explicit
  complete-message state can allow automatic confirmation; unknown or malformed
  candidate states must never grant archive authority.
- Validate calendar fields before constructing dates. Technical-row exclusions
  use explicit schema markers, not words found in merchant names.
- HTML image discovery distinguishes exact attributes from `data-*` attributes
  and text inside other attribute values. Text and image extraction share an
  atomic traversal that excludes comments and script/style bodies.
- Decode references once per original text span or attribute context. Never
  decode concatenated fragments across removed markup or reparse decoded tags.
  Preserve vendored decoder bytes and license; verify their pinned checksums.
- URL evidence may recognize unambiguous prose around an authority, but must
  preserve punctuation within paths, queries and fragments.
