function inspectedImageAt_(images, index) {
  const descriptor = Object.getOwnPropertyDescriptor(images, index);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && inspectedImage_(descriptor.value);
}
function activeHtmlImagesInspected_(count, images) {
  for (let index = 0; index < count; index++) if (!inspectedImageAt_(images, index)) return false;
  return true;
}
function sourceFieldValue_(message, key) {
  const descriptor = Object.getOwnPropertyDescriptor(message, key);
  if (!descriptor) {
    if (key in message) fail_('AI');
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail_('AI');
  return descriptor.value;
}
function candidateSource_(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) fail_('AI');
  const text = sourceFieldValue_(message, 'text');
  const htmlInput = sourceFieldValue_(message, 'html');
  const subject = sourceFieldValue_(message, 'subject');
  const sender = sourceFieldValue_(message, 'sender');
  const suppliedImages = sourceFieldValue_(message, 'images');
  if (text !== undefined && typeof text !== 'string' || htmlInput !== undefined && typeof htmlInput !== 'string' ||
    subject !== undefined && typeof subject !== 'string' || sender !== undefined && typeof sender !== 'string' ||
    suppliedImages !== undefined && !Array.isArray(suppliedImages)) fail_('AI');
  const html = htmlInput === undefined ? {text: '', evidenceSpans: [], activeImageCount: 0, incomplete: false} : htmlContent_(htmlInput);
  const images = suppliedImages === undefined ? [] : suppliedImages;
  const incomplete = ownEnumerableDataValue_(message, 'incomplete');
  // Sender is provenance metadata, never factual offer evidence. Subject is an
  // independent source span so its tokens cannot be joined to body/HTML spans.
  const sourceSpans = [];
  if (subject) sourceSpans.push({kind: 'subject', text: subject});
  if (text) sourceSpans.push({kind: 'text', text: text});
  html.evidenceSpans.forEach(function (span) { if (span) sourceSpans.push({kind: 'html', text: span}); });
  return {spans: sourceSpans.map(function (span) { return span.text; }),
    sourceSpans: sourceSpans,
    evidenceSpans: sourceSpans.map(function (span) { return span.text; }),
    sender: sender || '',
    images: images,
    incomplete: incomplete !== false || html.incomplete ||
      !activeHtmlImagesInspected_(html.activeImageCount, images)};
}
function codeLexemes_(text) {
  // Peel one explicit outer wrapper; punctuation inside a token remains identity.
  return (text.match(/\S+/gu) || []).map(function (token) {
    return /^(?:"[\s\S]*"|'[\s\S]*'|<[\s\S]*>)$/.test(token) ? token.slice(1, -1) : token;
  });
}
function deterministicCandidates_(message) {
  return deterministicCandidateOutcome_(message).candidates;
}
function deterministicCandidateOutcome_(message) {
  // Only unambiguous offer syntax is deterministic. Generic code wording also
  // occurs in authentication messages, so leave it to the grounded AI extractor.
  // Preserve the full bounded terms and require review: a regex cannot establish
  // the completeness of an offer.
  const source = candidateSource_(message);
  if (authenticationMessage_(source)) return {candidates: [], complete: !source.incomplete,
    excludedReason: 'authentication_code_message'};
  const codes = [];
  let complete = true;
  source.spans.forEach(function (text) {
    const re = /(?:^|[^\p{L}\p{N}\p{M}_])(?:coupon\s+code|promo(?:tional)?\s+code|discount\s+code|codice\s+sconto)(?:\s*[:=]\s*|\s+(?:is\b\s+)?)(\S+)/giu;
    let match;
    while ((match = re.exec(text))) {
      const code = codeLexemes_(match[1])[0];
      const length = code ? Array.from(code).length : 0;
      if (length >= 3 && length <= 40 && /[\p{L}\p{N}\p{M}]/u.test(code) &&
        !codes.some(function (candidate) { return candidate.code === code; })) {
        const notes = boundedText_(text, 3500);
        if (notes !== text) complete = false;
        codes.push({code: code, notes: notes, confidence: 'low', review: true});
      }
    }
  });
  return {candidates: codes.slice(0, MC.maxCandidates), complete: complete && codes.length <= MC.maxCandidates};
}
function authenticationMessage_(source) {
  // Admission is message-wide; this is deliberately independent of factual
  // quotes, which still must remain within one original source span.
  let heading = false;
  let example = false;
  const subject = source.sourceSpans.find(function (span) { return span.kind === 'subject'; });
  const subjectPurpose = Boolean(subject && authenticationSubject_(subject.text));
  const subjectHeading = Boolean(subject && !authenticationDiscussion_(subject.text) && authenticationHeading_(subject.text.trim()));
  const subjectExample = Boolean(subject && (authenticationExampleHeading_(subject.text.trim()) ||
    authenticationHeading_(subject.text.trim()) && authenticationDiscussion_(subject.text)));
  let representation;
  for (const sourceSpan of source.sourceSpans) {
    if (sourceSpan.kind !== representation) {
      // Plain text and HTML are independent alternatives. Only explicit subject
      // associations seed each body; transient body frames never cross between them.
      heading = sourceSpan.kind !== 'subject' && subjectHeading;
      example = sourceSpan.kind !== 'subject' && subjectExample;
      representation = sourceSpan.kind;
    }
    const span = sourceSpan.text;
    let offset = 0;
    for (const line of span.split('\n')) {
      const trimmed = line.trim();
      const leadingIndex = line.search(/\S/u);
      const exampleHeading = authenticationExampleHeading_(trimmed);
      const codeHeading = authenticationHeading_(trimmed);
      if (exampleHeading) { example = true; heading = false; }
      else if (codeHeading) {
        example = example || authenticationDiscussion_(trimmed);
        heading = !example;
      }
      const tokens = /\S+/gu;
      let match;
      while (!codeHeading && !exampleHeading && (match = tokens.exec(line))) {
        const grouped = authenticationGroupedLiteral_(line, match.index);
        const code = grouped ? grouped.code : codeLexemes_(match[0])[0];
        if (!authenticationLiteral_(code)) continue;
        const wrapped = code !== match[0];
        const start = offset + (grouped ? grouped.start : match.index + (wrapped ? 1 : 0));
        const end = start + code.length;
        if (grouped) tokens.lastIndex = grouped.next;
        // Fixed context work per literal; never truncate the code identity.
        const before = span.slice(Math.max(0, start - 240), start);
        const after = span.slice(end, Math.min(span.length, end + 240));
        const frame = {heading: heading, subject: subjectPurpose && sourceSpan.kind !== 'subject',
          leading: match.index === leadingIndex};
        if (!example && authenticationInstruction_(before, after, code, frame)) return true;
      }
      // A heading applies to a following value or explicit auth-use instruction,
      // not to a later promotional block. Example frames have the same scope.
      if (trimmed && !exampleHeading && !codeHeading) {
        heading = !example && !authenticationDiscussionClause_(trimmed) && authenticationUseInstruction_(trimmed);
        example = false;
      }
      offset += line.length + 1;
    }
  }
  return false;
}
function authenticationGroupedLiteral_(line, index) {
  // Admission only: inspect at most 80 UTF-16 units for a 40-code-point value.
  // Coupon tokens, factual quotes and stored identities never use this grouping.
  const closing = {'"': '"', "'": "'", '<': '>'}[line.charAt(index)];
  const start = index + (closing ? 1 : 0);
  const match = /^\p{Nd}+(?:[^\S\r\n\u2028\u2029]+\p{Nd}+)+[.!?]?/u.exec(line.slice(start, start + 80));
  if (!match || Array.from(match[0]).length > 40) return null;
  const end = start + match[0].length;
  if (closing && line.charAt(end) !== closing) return null;
  let next = end + (closing ? 1 : 0);
  // Sentence punctuation after a matched quote is presentation, not a suffix
  // attached to the numeric group. It never enters factual code identity.
  if (closing && /[.!?]/u.test(line.charAt(next))) next++;
  if (next < line.length && !/\s/u.test(line.charAt(next))) return null;
  return {code: match[0], start: start, next: next};
}
function authenticationLiteral_(token) {
  // Shape only: purpose and complete issuance are checked separately. Case is
  // never authority; a real issued value may be numeric or alphabetic in any case.
  const length = Array.from(token).length;
  return length >= 3 && length <= 40 && /[\p{L}\p{N}\p{M}]/u.test(token) &&
    !/^[("'[{<]*(?:example|sample|documentation|tutorial|documentazione|esempio|segnaposto|placeholder)[)"'\]}>.!?,;:]*$/iu.test(token) &&
    !/^(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+$/iu.test(token) &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(token) &&
    !/^(?:OTP|CODE|PASSCODE|PIN|XXX+|CODE_HERE)[.!?,;:]*$/iu.test(token);
}
function authenticationLabelPattern_() {
  return '(?:(?:verification|authentication|security|one[ -]?time|password[ -]?reset|log[ -]?in|sign[ -]?in|otp)\\s+(?:code|passcode|pin)|' +
    'passcode|otp|codice\\s+(?:di\\s+)?(?:verifica|autenticazione|sicurezza|accesso|monouso|reimpostazione(?:\\s+password)?))';
}
function authenticationLabelQualifier_() {
  return '(?:\\s+(?:is|è|e[’\x27]|monouso|below|shown\\s+below|riportato\\s+sotto|seguente))*';
}
function authenticationHeading_(text) {
  return new RegExp('^(?:[\\p{L}\\p{N} ._-]{1,60}:\\s*)?(?:(?:your|il\\s+tuo|tuo)\\s+)?' +
    authenticationLabelPattern_() + authenticationLabelQualifier_() + '\\s*[:=]?$','iu').test(text);
}
function authenticationSubject_(text) {
  // Only an explicit authentication request supplies message-level purpose.
  // Promotional login subjects and ordinary account discussion do not.
  if (text.length > 240 || authenticationDiscussion_(text)) return false;
  if (authenticationHeading_(text.trim())) return true;
  if (new RegExp('^' + authenticationConfirmationPattern_() + '[.!]?$', 'iu').test(text.trim())) return true;
  if (new RegExp('^(?:' + authenticationVerificationPattern_() + '|' + authenticationAccessPattern_() + ')[.!]?$', 'iu').test(text.trim())) return true;
  return (
    /^(?:sign[ -]?in|log[ -]?in)(?:\s+to\s+[\p{L}\p{N} ._-]+)?[.!]?$/iu.test(text.trim()) ||
    /^(?:(?:reset|verify|authenticate)\s+(?:(?:your|the)\s+)?(?:password|account|identity)|(?:reimposta|verifica)\s+(?:(?:la|il|il\s+tuo|la\s+tua)\s+)?(?:password|account|identità)|accedi(?:\s+al\s+tuo\s+account)?)[.!]?$/iu.test(text.trim())
  ) && !/\b(?:for|and|per|discount|coupon|promo|off|sconto|risparmia|ottieni)\b/iu.test(text) &&
    !/\bto\s+(?:save|get|receive|redeem|shop|claim|earn)\b/iu.test(text);
}
function authenticationValueTail_(text) {
  return authenticationPurposeTail_(text) || authenticationCompletionTail_(text) ||
    /^\s*(?:for\s+(?:(?:your|the)\s+)?(?:account|order|purchase)|per\s+(?:(?:il\s+tuo|il|la\s+tua|la)\s+)?(?:account|ordine|acquisto))\b/iu.test(text) ||
    /^[^\S\n]*(?:$|\n|[.!?](?:\s|$))/u.test(text);
}
function authenticationCompletionTail_(text) {
  // One matched presentation pair may surround an already-supported clause.
  // Never strip a token's bytes or turn arbitrary parenthesized prose into proof.
  const wrapper = authenticationWrappedTail_(text);
  const clause = wrapper === null ? text : wrapper;
  return (wrapper === null || !authenticationDiscussion_(clause)) && (
    /^[^\S\n]*(?:[,;][^\S\n]*)?(?:(?:and|e)\s+)?(?:(?:should|must)\s+not\s+be\s+shared|(?:do\s+not|never)\s+share|(?:must|should)\s+be\s+kept\s+secret|non\s+(?:deve\s+essere\s+condiviso|condividerlo)|deve\s+rimanere\s+segreto)(?![\p{L}\p{N}\p{M}_])/iu.test(clause) ||
    /^[^\S\n]*(?:(?:[,;]|and|e)\s*)?(?:expires?|is\s+valid|valid\s+(?:for|until)|scad(?:e|rà)|(?:è\s+)?valid[oa]\s+(?:per|fino))(?![\p{L}\p{N}\p{M}_])/iu.test(clause)
  );
}
function authenticationWrappedTail_(text) {
  const match = /^[^\S\n]*(?:\(([^()\n]*)\)|\[([^\[\]\n]*)\])(?=\s|[.!?,;:]|$)/u.exec(text);
  return match ? match[1] === undefined ? match[2] : match[1] : null;
}
function authenticationPurposeTail_(text) {
  // A following label ("your login PIN") is not the verb "log in"; do not
  // mistake the determiner before that label for a nounless imperative value.
  if (new RegExp('^\\s*(?:(?:to|for|per)\\s+)?' + authenticationLabelPattern_() + '(?![\\p{L}\\p{N}\\p{M}_])', 'iu').test(text)) return false;
  return new RegExp('^\\s*(?:(?:to|for|per)\\s+)?' + authenticationActionPattern_() + '(?![\\p{L}\\p{N}\\p{M}_])', 'iu').test(text);
}
function authenticationVerificationPattern_() {
  const identity = '(?:account|identity|e-?mail(?:\\s+address)?|phone(?:\\s+number)?|password|identità|identita|numero\\s+di\\s+telefono)';
  const possessive = '(?:(?:your|the|la\\s+tua|il\\s+tuo|la|il)\\s+)?';
  return '(?:verif(?:y|ying)|verifica(?:re)?)\\s+' + possessive + identity + authenticationTargetEnd_();
}
function authenticationAccessPattern_() {
  return 'access(?:ing)?\\s+(?:(?:your|the)\\s+)?(?:account|profile)' + authenticationTargetEnd_();
}
function authenticationTargetEnd_() {
  // A complete authentication target may end or introduce another clause, but
  // cannot be only the first noun in a different object such as account discount.
  return '(?=\\s*(?:$|[.!?:;,)\\]>"\x27]|(?:using|with|con|usando|and|then|to|for|e|poi|per)\\b))';
}
function authenticationActionPattern_() {
  return '(?:' + authenticationVerificationPattern_() + '|' + authenticationAccessPattern_() +
    '|authenticat(?:e|ing)|reset(?:ting)?|log(?:ging)?[ -]?(?:in|into)|sign(?:ing)?[ -]?(?:in|into)|reimposta(?:re)?|ripristina|acced(?:i|ere)|' + authenticationConfirmationPattern_() + ')';
}
function authenticationConfirmationPattern_() {
  return '(?:confirm(?:ing)?\\s+(?:(?:your|the)\\s+)?(?:e-?mail(?:\\s+address)?|account|identity)|' +
    'conferma(?:re)?\\s+(?:(?:la\\s+tua|il\\s+tuo|la|il)\\s+)?(?:e-?mail|account|identità))';
}
function authenticationCodeNoun_() {
  return '(?:(?:(?:coupon|promo(?:tional)?|discount)\\s+)?(?:code|passcode|pin)|codice(?:\\s+sconto)?)';
}
function authenticationDiscussionClause_(text) {
  const instructionClause = text.slice(Math.max(text.lastIndexOf(','), text.lastIndexOf(';')) + 1);
  if (/\b(?:(?:do\s+not|don[’']t|never|non)\s+(?:enter|type|use|inserisci|digita|usa)|(?:never|not)\s+ask\s+(?:you\s+)?to\s+(?:enter|type|use)|(?:learn|explain)\s+how\s+to\s+(?:enter|type|use))\b/iu.test(instructionClause)) return true;
  // A reference to another example is not an example of this issuance. Keep
  // explicit "For example," and "Example;" clauses intact rather than treating
  // every comma/semicolon as a reset of the discussion state.
  const reference = /\b(?:unlike\s+(?:the\s+)?(?:example|sample|documentation)(?:\s+(?:above|below))?|(?:read|see|consult)\s+(?:the\s+)?(?:example|sample|documentation)\s+above)\s*[,;]\s*/iu.exec(text);
  return reference ? authenticationDiscussion_(text.slice(0, reference.index)) ||
    authenticationDiscussion_(text.slice(reference.index + reference[0].length)) : authenticationDiscussion_(text);
}
function authenticationExampleSuffix_(text) {
  // A qualifier directly attached to this value/label is not an independent
  // later documentation sentence. Do not scan unrelated following blocks.
  const wrapper = authenticationWrappedTail_(text);
  return wrapper !== null && authenticationDiscussion_(wrapper) ||
    /^[^\S\n]*[,;:]?[^\S\n]*[(\[]?[^\S\n]*(?:(?:for|ad)\s+)?(?:example|sample|esempio|placeholder|segnaposto)\b/iu.test(text);
}
function authenticationIssuance_(before, after) {
  // Wrapper bytes are presentation, not purpose. Keep punctuation inside the
  // literal itself out of the context; an exclamation in a code is not a stop.
  if (before.endsWith('"') && after.startsWith('"') || before.endsWith("'") && after.startsWith("'") ||
      before.endsWith('<') && after.startsWith('>')) {
    before = before.slice(0, -1); after = after.slice(1);
  }
  const sentenceValue = authenticationUseInstruction_(before) && /(?:^|[.!?]\s+)$/u.test(before);
  before = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'),
    before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1);
  const label = authenticationLabelPattern_();
  const qualifier = authenticationLabelQualifier_();
  const precedingLabel = new RegExp('\\b' + label + qualifier + '\\s*[:=]?\\s*$', 'iu').exec(before);
  // In "value is your verification code ..." the label belongs to the value
  // before it; its following descriptive words cannot become another value.
  const labelPrefix = precedingLabel ? before.slice(0, precedingLabel.index) : '';
  const instructionLabel = Boolean(precedingLabel && /\b(?:enter|type|use|inserisci|digita|usa)\s+(?:(?:your|the|il|il\s+tuo)\s+)?$/iu.test(labelPrefix));
  const priorValue = /(?:^|\s)(\S+)\s+(?:is|è|e[’'])\s+(?:(?:your|the|il\s+tuo|il|tuo)\s+)?$/iu.exec(labelPrefix);
  const reversed = Boolean(priorValue && !/^(?:here|there|this|below|following|attached|questo|questa)$/iu.test(priorValue[1]));
  const promotional = Boolean(precedingLabel && /^passcode\b/iu.test(precedingLabel[0]) &&
    /\b(?:coupon|promo(?:tional)?|discount|sconto)\s*$/iu.test(labelPrefix));
  const negatedLabel = /\b(?:not|never|non)(?:\s+(?:is|è|e[’']|a|an|the|your|un|uno|una|il|lo|la|tuo|tua))*\s*$/iu.test(labelPrefix);
  const issuingLabel = Boolean(precedingLabel && !reversed && !promotional && !negatedLabel);
  const followingPrefix = '^\\s+(?:is|è|e[’\x27])\\s+(?:(?:your|the|il\\s+tuo|il|tuo)\\s+)?';
  const followingLabel = new RegExp(followingPrefix + label + '(?![\\p{L}\\p{N}\\p{M}_])', 'iu').exec(after);
  const followingGeneric = new RegExp(followingPrefix + '(?:code|passcode|pin|codice)(?![\\p{L}\\p{N}\\p{M}_])', 'iu').exec(after);
  const following = followingLabel || followingGeneric;
  const continuation = following ? after.slice(following[0].length) : after;
  const completeValue = authenticationValueTail_(continuation);
  const generic = /(?:^|\s|:)(?:(?:your|the|il\s+tuo|il|tuo)\s+)?(?:code|passcode|pin|codice)\s*(?:(?:is|è|e[’'])\s*[:=]?\s+|[:=]\s*)$/iu.exec(before);
  const genericIssued = Boolean(generic && !/\b(?:coupon|promo(?:tional)?|discount|sconto|use|enter|type|usa|inserisci|digita)\s*$/iu.test(before.slice(0, generic.index)));
  const noun = authenticationCodeNoun_();
  const introduced = new RegExp('\\b' + noun + '\\s*(?:is\\s*)?[:=]?\\s*$', 'iu').test(before);
  const imperative = new RegExp('\\b(?:use|enter|type|usa|inserisci|digita)\\s+(?:(?:(?:the|your|il|il\\s+tuo)\\s+)?' + noun + '\\s*[:=]?\\s*)?$', 'iu').test(before);
  const purposeAfter = authenticationPurposeTail_(after);
  const usingCode = new RegExp('\\b(?:using|with|con|usando)\\s+(?:(?:the|il)\\s+)?' + noun + '\\s*[:=]?\\s*$', 'iu').test(before);
  const actions = new RegExp('\\b(?:(' + authenticationActionPattern_() + ')|(?:get|receive|save|apply|redeem|use|ottieni|risparmia|applica|usa))(?![\\p{L}\\p{N}\\p{M}_])', 'giu');
  let authAction = false;
  let action;
  while ((action = actions.exec(before))) authAction = Boolean(action[1]);
  return {explicit: issuingLabel || Boolean(followingLabel && completeValue),
    generic: genericIssued || Boolean(followingGeneric && completeValue),
    direct: (introduced || imperative) && purposeAfter || usingCode && authAction,
    imperative: imperative, instructionLabel: instructionLabel, sentenceValue: sentenceValue, valueTail: completeValue,
    descriptive: !completeValue && /^\s*(?:is|are|è|sono|format|mechanism|documentation|example)(?![\p{L}\p{N}\p{M}_])/iu.test(continuation),
    discussion: negatedLabel || authenticationDiscussionClause_(before) || authenticationExampleSuffix_(continuation)};
}
function authenticationInstruction_(before, after, code, frame) {
  const relation = authenticationIssuance_(before, after);
  const purposeConnector = /^(?:for|per)$/iu.test(code) &&
    !/^\s*(?:to|for|per)\s+/iu.test(after) && authenticationPurposeTail_(after);
  const instructionLocation = relation.instructionLabel &&
    /^(?:here|there|now|above|below|qui|qua|ora|sotto|sopra)[.!?,;:]*$/iu.test(code);
  // These are grammatical predicates, not an issued literal. Check independent
  // of capitalization; an imperative use instruction is a different relation.
  const predicate = /^(?:required|necessary|needed|optional|available|unavailable|ready|pending|sent|provided|shown|displayed|requested|enabled|disabled|expires?|expired|invalid|valid|status|confidential|private|personal|secret|sensitive|secure|temporary|unique|necessari[oa]|richiest[oa]|obbligatori[oa]|disponibile|pronto|inviato|scade|scadrà|scadut[oa]|riservat[oa]|personal[ei]|segret[oa]|sensibile|temporane[oa]|unic[oa])[.!?,;:]*$/iu.test(code);
  if (relation.discussion || relation.descriptive || purposeConnector || instructionLocation || predicate && !relation.imperative) return false;
  const valueEnd = relation.valueTail || /[.!?]$/u.test(code);
  return relation.explicit && valueEnd || relation.direct ||
    Boolean(frame && (frame.subject && relation.generic && valueEnd ||
      frame.heading && valueEnd && (frame.leading || relation.sentenceValue || relation.generic)));
}
function authenticationDiscussion_(text) {
  return /\b(?:example|sample|placeholder|tutorial|documentation|esempio|segnaposto)\b/iu.test(text);
}
function authenticationExampleHeading_(text) {
  return /(?:^|\s)(?:example|sample|esempio|placeholder|segnaposto)(?:\s+\d+)?\s*:?\s*$/iu.test(text) ||
    /^(?:documentation|tutorial|documentazione)\s*:?\s*$/iu.test(text);
}
function authenticationUseInstruction_(text) {
  // Only a positive instruction clause can introduce a following value.
  // Negated or conceptual mentions ("never ask you to enter", "learn how to
  // use") are not instructions to the recipient.
  return new RegExp('(?:^|[.!?\\n]\\s+)(?:[\\p{L}\\p{N} ._-]{1,60}:\\s*)?(?:(?:please|per\\s+favore,?)\\s+)?' +
    '(?:enter|type|use|inserisci|digita|usa)\\s+(?:(?:the|your|il|il\\s+tuo)\\s+)?' +
    authenticationLabelPattern_() + '\\b', 'iu').test(text);
}
function authenticationExclusion_(source) {
  if (!authenticationMessage_(source)) return null;
  return authenticationExcludedOutcome_(source);
}
function authenticationExcludedOutcome_(source) {
  return {status: source.incomplete ? 'incomplete' : 'complete', candidates: [],
    empty: true, modelEmpty: false, invalidated: false, verifiedNonOffer: false,
    excludedReason: 'authentication_code_message', archiveAllowed: false};
}
function rawOccurrences_(value, source, normalized) {
  if (!wellFormedUtf16_(value) || !wellFormedUtf16_(source)) return [];
  const query = normalized ? String(value).trim() : String(value);
  if (!query) return [];
  const pattern = normalized ? query.split(/\s+/).map(function (part) {
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('\\s+') : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(pattern, normalized ? 'giu' : 'gu');
  const occurrences = [];
  let match;
  while ((match = re.exec(source))) {
    occurrences.push({start: match.index, end: match.index + match[0].length});
    if (!match[0]) re.lastIndex++;
  }
  return occurrences;
}
function adjacentCodePoint_(source, index, before) {
  if (before) {
    if (!index) return '';
    const start = /[\udc00-\udfff]/.test(source.charAt(index - 1)) ? index - 2 : index - 1;
    return String.fromCodePoint(source.codePointAt(start));
  }
  return index < source.length ? String.fromCodePoint(source.codePointAt(index)) : '';
}
function adjacentNonSpaceCodePoint_(source, index, before) {
  let cursor = index;
  while (before ? cursor > 0 : cursor < source.length) {
    const point = adjacentCodePoint_(source, cursor, before);
    if (!/\s/u.test(point)) return point;
    cursor += before ? -point.length : point.length;
  }
  return '';
}
function inspectedImage_(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function ownEnumerableDataValue_(value, key) {
  const descriptor = value != null ? Object.getOwnPropertyDescriptor(value, key) : null;
  return descriptor && descriptor.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}
function ownValue_(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
function plainObjectWithKeys_(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const names = Object.getOwnPropertyNames(value);
  return (prototype === null || prototype === Object.prototype) && !Object.getOwnPropertySymbols(value).length &&
    names.every(function (key) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return keys.indexOf(key) >= 0 && descriptor.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value');
    });
}
function codeOccurrences_(value, source) {
  const occurrences = [];
  const re = /\S+/gu;
  let match;
  while ((match = re.exec(source))) {
    let token = match[0];
    let start = match.index;
    if (/^(?:"[\s\S]*"|'[\s\S]*'|<[\s\S]*>)$/.test(token)) {
      token = token.slice(1, -1); start++;
    }
    if (token === value) occurrences.push({start: start, end: start + token.length});
  }
  return occurrences;
}
function websiteOccurrences_(value, source) {
  const occurrences = [];
  const re = /(?:^|[\s"'([{<])(https:\/\/[^\s<>"']+)/gi;
  let match;
  while ((match = re.exec(source))) {
    const url = match[1];
    const start = match.index + match[0].length - url.length;
    if (url === value) {
      occurrences.push({start: start, end: start + url.length}); continue;
    }
    if (/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(value) && safeUrl_(value) &&
      url.startsWith(value) && /^[.,;:!?)\]}]+$/.test(url.slice(value.length)) && !safeUrl_(url)) {
      occurrences.push({start: start, end: start + value.length});
    }
  }
  return occurrences;
}
function fieldOccurrences_(field, value, source) {
  if (!wellFormedUtf16_(value) || !wellFormedUtf16_(source)) return [];
  if (['discountValue', 'minimumSpend'].indexOf(field) >= 0 && !scalarNumericValue_(value)) return [];
  if (field === 'code') return codeOccurrences_(value, source);
  if (field === 'website') return websiteOccurrences_(value, source);
  if (field === 'discountType' && /^[%€$£]$/.test(value)) {
    return rawOccurrences_(value, source, false).filter(function (occurrence) {
      const before = adjacentNonSpaceCodePoint_(source, occurrence.start, true);
      const after = adjacentNonSpaceCodePoint_(source, occurrence.end, false);
      return value === '%' ? /\p{Nd}/u.test(before) : /\p{Nd}/u.test(before) || /\p{Nd}/u.test(after);
    });
  }
  const boundary = /[\p{L}\p{N}\p{M}_]/u;
  const numericField = ['discountValue', 'minimumSpend'].indexOf(field) >= 0 && /\p{Nd}/u.test(value);
  const rangeContext = 96;
  const rangeUnit = '(?:' + NUMERIC_RANGE_UNIT_TOKEN + ')?';
  const currencyPrefix = '(?:' + NUMERIC_RANGE_CURRENCY_PREFIX_TOKEN + ')?';
  const trailingCurrencyPrefix = '(?:' + NUMERIC_RANGE_CURRENCY_PREFIX_TOKEN + '|' +
    NUMERIC_RANGE_CURRENCY_CODE_TOKEN + '|' + NUMERIC_RANGE_CURRENCY_CODE_PREFIX_FRAGMENT_TOKEN + ')?';
  return rawOccurrences_(value, source, true).filter(function (occurrence) {
    const before = adjacentCodePoint_(source, occurrence.start, true);
    const after = adjacentCodePoint_(source, occurrence.end, false);
    const beforeStart = Math.max(0, occurrence.start - rangeContext);
    const afterEnd = Math.min(source.length, occurrence.end + rangeContext);
    const beforeText = source.slice(beforeStart, occurrence.start);
    const afterText = source.slice(occurrence.end, afterEnd);
    const truncatedBefore = beforeStart > 0;
    const truncatedAfter = afterEnd < source.length;
    const truncatedBetween = truncatedBefore && new RegExp(currencyPrefix + '[\\p{Nd}]' + rangeUnit +
      '(?:\\s+[oO][fF][fF])?\\s+[aA][nN][dD]\\s+' + currencyPrefix + '$', 'u').test(beforeText);
    const truncatedDelimiter = truncatedBefore && new RegExp('^\\s*(?:' + NUMERIC_RANGE_SEPARATOR + '\\s*|[tT][oO]\\s+|[oO][rR]\\s+|[aA][nN][dD]\\s+|[tT][hH][rR][oO][uU][gG][hH]\\s+|[uU][pP]\\s+[tT][oO]\\s+)' + currencyPrefix + '$', 'u').test(beforeText);
    const truncatedWhitespace = truncatedBefore && new RegExp('^\\s*' + currencyPrefix + '$', 'u').test(beforeText);
    const truncatedFragment = truncatedBefore && truncatedRangeFragment_(beforeText);
    const truncatedFollowing = truncatedAfter && new RegExp('^(?:\\s|' + NUMERIC_RANGE_UNIT_TOKEN +
      '(?:\\s+[oO][fF][fF])?(?:\\s+(?:[tT][oO]|[oO][rR]|[aA][nN][dD]|[tT][hH][rR][oO][uU][gG][hH]|[uU][pP]\\s+[tT][oO]))?|[oO][fF][fF]' +
      '(?:\\s+(?:[tT][oO]|[oO][rR]|[aA][nN][dD]|[tT][hH][rR][oO][uU][gG][hH]|[uU][pP]\\s+[tT][oO]))?|[tT][oO]|[oO][rR]|[aA][nN][dD]|[tT][hH][rR][oO][uU][gG][hH]|[uU][pP]\\s+[tT][oO])*(?:' +
      NUMERIC_RANGE_SEPARATOR + '\\s*)?' + trailingCurrencyPrefix + '$', 'u').test(afterText);
    const dateComponent = numericField && (dateMonthFollows_(source.slice(occurrence.end)) || dateMonthPrecedes_(beforeText) || dateMonthDayPrecedes_(beforeText));
    return utf16Boundary_(source, occurrence.start) && utf16Boundary_(source, occurrence.end) &&
      (!before || !boundary.test(before)) && (!after || !boundary.test(after)) &&
      !(numericField && (signedNumericPrefix_(beforeText) || dateComponent || numericRangeEndpoint_(beforeText, afterText) || truncatedBetween || truncatedDelimiter || truncatedWhitespace || truncatedFragment || truncatedFollowing)) &&
      !(/\p{Nd}$/u.test(value) && /^[.,٫．]\p{Nd}/u.test(source.slice(occurrence.end, occurrence.end + 3))) &&
      !(/^\p{Nd}/u.test(value) && /\p{Nd}[.,٫．]$/u.test(source.slice(Math.max(0, occurrence.start - 3), occurrence.start)));
  });
}
function fieldInQuote_(field, value, quote) {
  return fieldOccurrences_(field, value, quote).length > 0;
}
function groundedFieldOccurrences_(field, value, quote, span) {
  if (!wellFormedUtf16_(quote) || !wellFormedUtf16_(span)) return [];
  const quoteOccurrences = rawOccurrences_(quote, span, field !== 'code' && field !== 'website');
  const fieldOccurrences = fieldOccurrences_(field, value, span);
  const grounded = [];
  for (let quoteIndex = 0, fieldIndex = 0; quoteIndex < quoteOccurrences.length; quoteIndex++) {
    const quoteOccurrence = quoteOccurrences[quoteIndex];
    while (fieldIndex < fieldOccurrences.length && fieldOccurrences[fieldIndex].end <= quoteOccurrence.start) fieldIndex++;
    for (let index = fieldIndex; index < fieldOccurrences.length && fieldOccurrences[index].start < quoteOccurrence.end; index++) {
      if (fieldOccurrences[index].start >= quoteOccurrence.start && fieldOccurrences[index].end <= quoteOccurrence.end) grounded.push(fieldOccurrences[index]);
    }
  }
  return grounded;
}
function textEvidenceGrounded_(field, value, quote, span) {
  return groundedFieldOccurrences_(field, value, quote, span).length > 0;
}
function discountPairTextEvidence_(type, value, typeQuote, valueQuote, span) {
  const values = groundedFieldOccurrences_('discountValue', value, valueQuote, span);
  const types = groundedFieldOccurrences_('discountType', type, typeQuote, span);
  for (let valueIndex = 0, typeIndex = 0; valueIndex < values.length && typeIndex < types.length;) {
    const amount = values[valueIndex]; const symbol = types[typeIndex];
    if (type === '%') {
      if (symbol.start < amount.end) { typeIndex++; continue; }
      if (/^\s*$/u.test(span.slice(amount.end, symbol.start))) return true;
      valueIndex++; continue;
    }
    if (symbol.end <= amount.start) {
      if (/^\s*$/u.test(span.slice(symbol.end, amount.start))) return true;
      typeIndex++; continue;
    }
    if (amount.end <= symbol.start) {
      if (/^\s*$/u.test(span.slice(amount.end, symbol.start))) return true;
      valueIndex++; continue;
    }
    if (amount.start < symbol.start) valueIndex++; else typeIndex++;
  }
  return false;
}
function discountPairImageEvidence_(typeEvidence, valueEvidence, source) {
  const typeImage = typeEvidence && ownValue_(typeEvidence, 'image');
  const valueImage = valueEvidence && ownValue_(valueEvidence, 'image');
  return Number.isInteger(typeImage) && typeImage === valueImage && typeImage >= 0 &&
    typeImage < source.images.length && inspectedImageAt_(source.images, typeImage);
}
function normalizeCandidate_(raw, message) {
  if (!plainObjectWithKeys_(raw, MC.fields.concat(['confidence', 'review', 'evidence'])) ||
    ownValue_(raw, 'confidence') !== undefined && ['high', 'medium', 'low'].indexOf(ownValue_(raw, 'confidence')) < 0 ||
    ownValue_(raw, 'review') !== undefined && typeof ownValue_(raw, 'review') !== 'boolean') fail_('AI');
  const evidence = ownValue_(raw, 'evidence');
  if (evidence !== undefined && !plainObjectWithKeys_(evidence, MC.fields)) fail_('AI');
  const source = candidateSource_(message);
  Object.keys(evidence || {}).forEach(function (key) {
    const ev = ownValue_(evidence, key);
    if (ev === undefined) return;
    if (!plainObjectWithKeys_(ev, ['quote', 'image']) ||
      ownValue_(ev, 'quote') !== undefined && (typeof ownValue_(ev, 'quote') !== 'string' || !wellFormedUtf16_(ownValue_(ev, 'quote'))) ||
      ownValue_(ev, 'image') !== undefined && !Number.isInteger(ownValue_(ev, 'image'))) fail_('AI');
    if (ownValue_(ev, 'image') !== undefined && (ownValue_(ev, 'image') < 0 || ownValue_(ev, 'image') >= source.images.length || !inspectedImageAt_(source.images, ownValue_(ev, 'image')))) fail_('AI');
  });
  const c = {};
  c.imageEvidence = {};
  let truncated = false;
  let invalidNumericValue = false;
  MC.fields.forEach(function (k) {
    const rawValue = ownValue_(raw, k);
    if (rawValue != null && (typeof rawValue !== 'string' || !wellFormedUtf16_(rawValue))) fail_('AI');
    const value = (rawValue || '').trim();
    const limit = k === 'notes' ? 3500 : 1000;
    if (value.length > limit) truncated = true;
    c[k] = value.length > limit && k !== 'notes' ? '' : boundedText_(value, limit);
  });
  ['discountValue', 'minimumSpend'].forEach(function (k) {
    if (c[k] && !scalarNumericValue_(c[k])) { c[k] = ''; invalidNumericValue = true; }
  });
  c.website = safeUrl_(c.website);
  if (c.expiry && !validDate_(c.expiry)) c.expiry = '';
  const confidence = ownValue_(raw, 'confidence');
  const review = ownValue_(raw, 'review');
  c.confidence = ['high', 'medium', 'low'].indexOf(confidence) >= 0 ? confidence : 'low';
  c.review = review !== false || c.confidence !== 'high' || !c.merchant ||
    !(c.code || (c.discountType && c.discountValue) || c.website) || source.incomplete || truncated ||
    invalidNumericValue || Boolean(ownValue_(raw, 'website') && !c.website || ownValue_(raw, 'expiry') && !c.expiry);
  // Every asserted field must be anchored to supplied text or an inspected image.
  MC.fields.filter(function (k) { return c[k]; }).forEach(function (k) {
    const ev = ownValue_(evidence, k);
    const quote = ev && ownValue_(ev, 'quote');
    const image = ev && ownValue_(ev, 'image');
    const groundedText = ev && typeof quote === 'string' && quote.trim().length > 0 &&
      source.evidenceSpans.some(function (span) { return textEvidenceGrounded_(k, c[k], quote, span); });
    const groundedImage = ev && Number.isInteger(image) && image >= 0 && image < source.images.length &&
      inspectedImageAt_(source.images, image);
    if (groundedImage) c.imageEvidence[k] = {sourceId: source.images[image].sourceId, valueDigest: digest_(c[k]), digest: imageEvidenceDigest_(source.images[image])};
    if (!groundedText && !groundedImage) { c[k] = ''; c.review = true; }
    // OCR-only evidence is a proposal, not independently verified import authority.
    if (groundedImage && !groundedText) c.review = true;
  });
  if (Boolean(c.discountType) !== Boolean(c.discountValue)) c.review = true;
  const typeEvidence = ownValue_(evidence, 'discountType');
  const valueEvidence = ownValue_(evidence, 'discountValue');
  const pairedText = source.evidenceSpans.some(function (span) {
    const typeQuote = typeEvidence && ownValue_(typeEvidence, 'quote');
    const valueQuote = valueEvidence && ownValue_(valueEvidence, 'quote');
    return typeof typeQuote === 'string' && typeof valueQuote === 'string' &&
      discountPairTextEvidence_(c.discountType, c.discountValue, typeQuote, valueQuote, span);
  });
  const pairedImage = discountPairImageEvidence_(typeEvidence, valueEvidence, source);
  if (c.discountType && c.discountValue && !pairedText && !pairedImage) {
    c.discountType = ''; c.discountValue = ''; c.review = true;
  } else if (c.discountType && c.discountValue && pairedImage) c.review = true;
  if (!c.merchant || !(c.code || (c.discountType && c.discountValue) || c.website)) c.review = true;
  return c;
}
