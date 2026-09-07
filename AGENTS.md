# MyCoupons contributor rules

## Delivery and validation

- Implement one independently testable increment at a time. The user owns
  commits, pushes, PR creation and merges; stop at those boundaries.
- Run `npm test` and `npm run check` for runtime changes. Tests must not depend
  on ignored drafts, credentials, or live Google resources.
- Follow the supplied user-wide Markdown and shell validation requirements.

## Source and mutation contracts

- Coupon codes preserve case and full Unicode token identity. Evidence checks
  must validate both the quoted fragment and its occurrence in the source.
- Parse Gmail URL components before extracting identity. Reject unsupported UI
  tokens; never truncate them or infer an undocumented API-ID conversion.
- Information lost through truncation requires review. Unknown or malformed
  candidate states must never grant archive authority.
- Validate calendar fields before constructing dates. Technical-row exclusions
  use explicit schema markers, not words found in merchant names.
- HTML image discovery distinguishes exact attributes from `data-*` attributes
  and text inside other attribute values.
