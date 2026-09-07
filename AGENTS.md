# MyCoupons contributor rules

## Delivery and validation

- Implement one independently testable increment at a time. The user owns
  commits, pushes, PR creation and merges; stop at those boundaries.
  Exception: during `codex-pr-review-remediation-loop`, the agent may commit
  and push reviewed corrections and continue the review loop.
- Run `npm test` and `npm run check` for runtime changes. Tests must not depend
  on ignored drafts, credentials, or live Google resources.
- When changing the parser bundle or build inputs, run `npm run check:html-build`
  after installing locked dependencies with `npm ci --ignore-scripts`.
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
- Parse Gmail URL components before extracting identity, normalizing only the
  supported Gmail hostname and default HTTPS port. Reject unsupported UI tokens;
  preserve canonical opaque-ID serialization; never truncate them or infer an
  undocumented API-ID conversion.
- Information lost through truncation requires review. Only an explicit
  complete-message state can allow automatic confirmation; unknown or malformed
  candidate states must never grant archive authority.
- Validate calendar fields before constructing dates. Technical-row exclusions
  use explicit schema markers, not words found in merchant names.
- HTML image discovery distinguishes exact attributes from `data-*` attributes
  and text inside other attribute values. Text and image extraction share a
  standards-parsed traversal that preserves boundaries between rendered blocks,
  excludes comments, non-content containers, closed dialogs, closed-details
  content other than the first direct `summary`, and HTML `hidden` subtrees.
  Normalize only surrounding ASCII whitespace in exact `img[src]` values.
  Responsive `srcset`/`picture` resources are not selected; they retain
  incomplete coverage. Never recover malformed markup with separate regexes.
- Exclude foreign SVG/MathML subtrees from evidence and retain incomplete
  coverage, including text-free graphics and presence inside hidden/templates.
  Candidate consumers must derive coverage from raw `message.html`; keep
  `message.text` independent of HTML projections and images independently inspected.
  A factual quote must match wholly within one original source span and cannot
  cross a rendered block boundary. A numerical value cannot be only a range,
  ratio, Unicode-minus, or supported word-delimited interval endpoint. A supplied image
  index must identify a present inspected image. A caller-provided complete flag
  cannot erase unsupported coverage.
- Validate complete candidate/evidence key sets before projection. Internal code
  punctuation remains identity; only one matching outer wrapper may be removed.
- Decode references once per original text span or attribute context. Never
  decode concatenated fragments across removed markup or reparse decoded tags.
  Rebuild the vendored parser from locked dependencies; verify the artifact and
  license checksums and run it without Node or browser globals.
- Parse image dimensions using HTML length/percentage semantics before applying
  the small-pixel filter; spelling variants must not bypass it.
- URL evidence may recognize unambiguous prose around an authority, but must
  preserve punctuation within paths, queries and fragments.
