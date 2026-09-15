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
  const htmlSpans = html.evidenceSpanRecords || html.evidenceSpans.map(function (span) { return {text: span, quoted: false}; });
  htmlSpans.forEach(function (span) { if (span && span.text) sourceSpans.push({kind: 'html', text: span.text, quoted: !!span.quoted}); });
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
  const source = candidateSource_(message);
  const admission = authenticationAdmission_(source);
  if (admission.kind === 'issued') return {candidates: [], complete: !source.incomplete,
    excludedReason: 'authentication_code_message', admission: admission};
  const codes = [];
  let complete = true;
  source.spans.forEach(function (text) {
    const re = /(?:^|[^\p{L}\p{N}\p{M}_])(?:coupon\s+code|promo(?:tional)?\s+code|discount\s+code|use\s+(?:the\s+)?code|codice\s+sconto|codice(?!\s+sconto(?:\s|[:=]|$)))(?:\s*[:=]\s*|\s+(?:is\b\s+)?)(\S+)/giu;
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

// Authentication admission is intentionally a closed contract. Only the
// relation forms below can produce `issued`; every unsupported construction is
// reviewable but non-deterministic. This parser never returns or rewrites the
// value, so coupon/code identity remains owned by the normal evidence lexer.
const MC_AUTHENTICATION_ADMISSION_KINDS = Object.freeze(['issued', 'ambiguous', 'discussion', 'incomplete']);
const MC_AUTHENTICATION_SOURCE_LIMIT = 60000;

function authenticationAdmissionResult_(kind, authenticationLike) {
  return {kind: kind, deterministic: kind === 'issued', authenticationLike: !!authenticationLike};
}

function authenticationTargetPattern_() {
  return '(?:(?:verification|authentication|security|one[ -]?time|password[ -]?reset|login|log[ -]?in|sign[ -]?in|email|account|identity|two[ -]?factor|multi[ -]?factor|mfa|2fa|otp)\\s+(?:code|passcode|pin|password)|one[ -]?time\\s+password|passcode|otp|pin|account\\s+code|codice\\s+(?:di\\s+)?(?:verifica|autenticazione|sicurezza|accesso|monouso))';
}

function authenticationTargetNounPattern_() {
  return '(?:account|email|e-?mail|identity|password|profil(?:e|o))';
}

function authenticationTargetSearchPattern_() {
  return authenticationWholeTokenPattern_(authenticationTargetPattern_());
}

function authenticationWholeTokenPattern_(pattern) {
  return '(?:^|[\\s([{<\"“‘])(?:' + pattern + ')(?=$|[\\s.,;:?!)}\\]>\"”’])';
}

function authenticationAssignmentPattern_() {
  return '(?:(?:is|are)(?=\\s|$)|è(?=\\s|$)|e[’\\x27](?=\\s|$)|=|:)';
}

function authenticationValue_(value) {
  if (typeof value !== 'string' || !value) return '';
  let token = value;
  const unwrap = function (input) {
    const closing = {'"': '"', "'": "'", '<': '>', '[': ']', '(': ')', '{': '}', '“': '”', '‘': '’'}[input.charAt(0)];
    return closing && input.charAt(input.length - 1) === closing && input.length > 2 ? input.slice(1, -1) : input;
  };
  let removedWrapper = false;
  const first = unwrap(token);
  if (first !== token) removedWrapper = true;
  token = first;
  if (!wellFormedUtf16_(token)) return '';
  token = token.replace(/[.!?,;:]+$/u, '');
  if (!removedWrapper) token = unwrap(token);
  if (!token || !wellFormedUtf16_(token) || Array.from(token).length > 40) return '';
  const points = Array.from(token).length;
  if (points < 1 || points > 40 || !/[\p{L}\p{N}\p{M}]/u.test(token)) return '';
  const numericPart = '[\\p{Nd}][\\p{Nd}.,٫٬]*';
  if (new RegExp('^' + NUMERIC_SIGN_TOKEN + numericPart + '$', 'u').test(token)) return '';
  const numericRangeOrRatioSeparator = '(?:' + NUMERIC_RANGE_SEPARATOR + '|∕|⁄|∶)';
  const signedNumericPart = '(?:' + NUMERIC_SIGN_TOKEN + ')?' + numericPart;
  if (new RegExp('^' + signedNumericPart + '\\s*' + numericRangeOrRatioSeparator + '\\s*' + signedNumericPart + '$', 'u').test(token)) return '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(token)) return '';
  if (/^(?:[a-z][a-z\d+.-]*:|www\.|\/\/)/iu.test(token)) return '';
  if (/^(?:example|sample|placeholder|demo|your[_ -]?code|code[_ -]?here|enter[_ -]?code|value|code|otp|pin|passcode|this|that|it|one|same|above|below|today|yesterday|tomorrow|now|soon|later|already|successfully|immediately|here|there|ready|again|n\/?a|tbd|unknown|undefined|null|none|missing|not\s+available|not\s+applicable|x{3,})$/iu.test(token)) return '';
  if (/^(?:[a-z\d](?:[a-z\d-]{0,62}\.)+[a-z]{2,})(?:[/?#:].*)?$/iu.test(token) || /^(?:\d{1,3}\.){3}\d{1,3}(?:[/?#:].*)?$/u.test(token) || /^(?:\/|\.{1,2}\/|#|\?)/u.test(token)) return '';
  return token;
}

function authenticationIssuerPrefixPattern_() {
  // A leading issuer name is context, not an example/status heuristic. The
  // narrow shape deliberately excludes arbitrary prose and comma clauses.
  return '(?:(?:[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*(?:\\s+[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*){0,3})\\s*:\\s*)?';
}

function authenticationClauseParts_(text) {
  // `!` is not a boundary here: it may be part of a complete Unicode code
  // token. Unsupported punctuation/layout remains ambiguous instead of being
  // reinterpreted as a shorter value.
  return String(text || '').split(/(?<=[.?;])(?=\s|$)|[\r\n\u2028\u2029]/u).map(function (part) {
    return part.trim();
  }).filter(function (part) { return !!part; });
}

function authenticationQuestionMark_() {
  return '[?？؟;⸮՟՞⁇⁈⁉﹖]';
}

function authenticationSubjectPurpose_(text) {
  const value = String(text || '').trim();
  if (!value || /[?;]|(?:for|to)\s+(?:discount|coupon|save|shop|redeem|sconto|risparmiare)\b/iu.test(value)) return false;
  return /^(?:(?:sign[ -]?in|log[ -]?in)(?:\s+to\s+[\p{L}\p{N} ._-]{1,60})?|verify\s+(?:your|the)\s+account|confirm\s+(?:your|the)\s+email|reset\s+(?:your|the)\s+password|accedi(?:\s+al\s+(?:tuo\s+)?account)?|verifica\s+(?:il|la|tuo|tua)\s+(?:account|identità|email))\.?$/iu.test(value);
}

function authenticationGenericAssignment_(clause, bridged) {
  if (!bridged || authenticationDiscussionClause_(clause, true)) return false;
  const noun = '(?:code|passcode|pin|codice)';
  const prefix = authenticationIssuerPrefixPattern_() + '(?:(?:your|the|a|an|il\\s+tuo|tuo|il|la)\\s+)?' + noun;
  const forward = new RegExp('^' + prefix + '\\s*' + authenticationAssignmentPattern_() + '\\s*(\\S+)[.!?,;:]*$', 'iu').exec(clause);
  const reverse = new RegExp('^(\\S+)\\s*' + authenticationAssignmentPattern_() + '\\s*(?:(?:your|the|a|an|il\\s+tuo|tuo|il|la)\\s+)?' + noun + '[.!?,;:]*$', 'iu').exec(clause);
  return bridged && (forward && authenticationValue_(forward[1]) || reverse && authenticationValue_(reverse[1]));
}

function authenticationIssuedClause_(clause, bridged) {
  if (authenticationDiscussionClause_(clause, bridged)) return false;
  const target = authenticationTargetPattern_();
  const label = '(?:(?:your|the|a|an|il\\s+tuo|tuo|il|la)\\s+)?' + target;
  const prefix = authenticationIssuerPrefixPattern_();
  const forward = new RegExp('^' + prefix + label + '\\s*' + authenticationAssignmentPattern_() + '\\s*(\\S+)[.!?,;:]*$', 'iu').exec(clause);
  if (forward && authenticationValue_(forward[1])) return true;
  const reverse = new RegExp('^' + prefix + '(\\S+)\\s*' + authenticationAssignmentPattern_() + '\\s*' + label + '[.!?,;:]*$', 'iu').exec(clause);
  if (reverse && authenticationValue_(reverse[1])) return true;

  const use = new RegExp('^' + prefix + '(?:please\\s+)?(?:use|enter|type|insert|inserisci|digita|usa)\\s+' +
    '(?:(?:your|the|a|an|il\\s+tuo|tuo|il|la)\\s+)?(?:code|passcode|pin|codice)\\s+(\\S+)\\s+' +
    '(?:to|for|per)\\s+(?:verify|confirm|authenticate|access|reset|sign[ -]?in|log[ -]?in|verifica|conferma|accedi)\\s+' +
    '(?:(?:your|the|a|an|il\\s+tuo|tuo|il|la)\\s+)?' + authenticationTargetNounPattern_() + '[.!?,;:]*$', 'iu').exec(clause);
  if (use && authenticationValue_(use[1])) return true;

  const deliveryPrefix = '^' + prefix + '(?:we|i|the\\s+system|the\\s+service|il\\s+sistema)\\s+' +
    '(?:sent|emailed|texted|generated|created|inviato|inviata|generato|generata)\\s+' +
    '(?:(?:your|the|il\\s+tuo|tuo|il|la)\\s+)?' + target + '\\s+';
  const directDelivery = new RegExp(deliveryPrefix + '(\\S+)[.!?,;:]*$', 'iu').exec(clause);
  if (directDelivery && authenticationValue_(directDelivery[1])) return true;
  const addressedDelivery = new RegExp(deliveryPrefix + '(?:to\\s+(?:you|your\\s+(?:email|phone|number|device)|a\\s+(?:you|te|lei))|a\\s+(?:te|lei))\\s*(?:is|è|=|:)\\s*(\\S+)[.!?,;:]*$', 'iu').exec(clause);
  return !!(addressedDelivery && authenticationValue_(addressedDelivery[1]));
}

function authenticationDiscussionClause_(clause, includeGeneric) {
  const target = authenticationTargetPattern_();
  const discussionTarget = includeGeneric ? '(?:code|passcode|pin|codice|' + target + ')' : target;
  return new RegExp(authenticationQuestionMark_(), 'u').test(clause) ||
    /^(?:if|unless|suppose|assuming|maybe|perhaps|for\s+example|(?:an?\s+)?example|(?:an?\s+)?report|user\s+report|documentation|tutorial|according\s+to|they\s+said|it\s+was\s+reported)\b/iu.test(clause) ||
    /^(?:can|could|would|will|do|does|did|is|are|am|have|has|please|why|how|what|when|where|who)\b[\s\S]{0,100}:\s/iu.test(clause) ||
    /^(?:this|that)\s+is\s+(?:only\s+)?(?:an?\s+)?(?:example|illustration|documentation|report)\b/iu.test(clause) ||
    /^(?:the\s+)?(?:documentation|docs?|tutorial)\s+(?:says?|shows?|states?|reads?|uses?)\s*:/iu.test(clause) ||
    /^(?:(?:[\p{L}\p{N}][\p{L}\p{N}._-]{0,39})\s+){1,3}(?:said|reported|recalled|remembered|mentioned|described|referred)\s*:/iu.test(clause) ||
    /^(?:-{2,}\s*forwarded\s+message\s*-*|begin\s+forwarded\s+message)\s*:?$/iu.test(clause) ||
    /^on\s+.{1,100}\s+wrote\s*:/iu.test(clause) ||
    /^(?:question|report(?:ed)?|status\s+report|hypothesis|hypothetical(?:\s+scenario)?|user\s+said|(?:they|we|i|the\s+system)\s+(?:said|reported|recalled|remembered|mentioned|described|referred))\s*:/iu.test(clause) ||
    new RegExp('^(?:not|never|no|non)\\b[\\s\\S]*' + discussionTarget, 'iu').test(clause) ||
    new RegExp(discussionTarget + '\\s*' + authenticationAssignmentPattern_() + '\\s*(?:not|never|no|non)\\b', 'iu').test(clause) ||
    new RegExp(discussionTarget + '\\s*' + authenticationAssignmentPattern_() + '\\s*(?:pending|required|expired|invalid|used|wrong|incorrect|cancelled|canceled|obsolete|inactive|void)\\b', 'iu').test(clause) ||
    new RegExp('\\b(?:not|never|no|non|pending|required|expired|invalid|used)\\b[\\s\\S]*' + discussionTarget, 'iu').test(clause) ||
    new RegExp('\\b(?:mention(?:ed|s|ing)|discuss(?:ed|es|ing)|describ(?:ed|es|ing)|refer(?:red|s|ring))\\b[\\s\\S]*' + discussionTarget, 'iu').test(clause);
}

function authenticationTargetlessDiscussionClause_(clause) {
  return /^(?:it|this|that|code|passcode|pin|codice)\s+(?:is|was|seems?|has|have|had)(?:\s+not)?\s+(?:pending|required|expired|invalid|used|wrong|incorrect|cancelled|canceled|obsolete|inactive|void)\b/iu.test(clause);
}

function authenticationLikeSource_(source) {
  const pattern = new RegExp(authenticationWholeTokenPattern_('(?:verification|authentication|security|one[ -]?time|password[ -]?reset|passcode|otp|pin|mfa|2fa|2[ -]?factor|two[ -]?factor|verify(?:ing)?\\s+(?:your|the)?\\s*(?:account|email|identity)|confirm(?:ing)?\\s+(?:your|the)?\\s*email|sign[ -]?in|log[ -]?in|acced(?:i|ere)\\s+(?:al\\s+)?(?:tuo\\s+)?account)'), 'iu');
  const target = new RegExp('(?:^|[^\\p{L}\\p{N}\\p{M}_])(?:' + authenticationTargetPattern_() +
    ')(?=$|[^\\p{L}\\p{N}\\p{M}_])', 'iu');
  return source.sourceSpans.some(function (span) {
    return span && typeof span.text === 'string' && (pattern.test(span.text) || target.test(span.text));
  });
}

function authenticationAdmission_(source) {
  if (!source || !Array.isArray(source.sourceSpans) || !Array.isArray(source.spans)) return authenticationAdmissionResult_('incomplete');
  if (!MC_AUTHENTICATION_ADMISSION_KINDS.length || source.sourceSpans.length !== source.spans.length) return authenticationAdmissionResult_('incomplete');
  const authenticationLike = authenticationLikeSource_(source);
  if (source.incomplete) return authenticationAdmissionResult_('incomplete', authenticationLike);
  let total = 0;
  for (const span of source.sourceSpans) {
    if (!span || typeof span.text !== 'string') return authenticationAdmissionResult_('incomplete');
    total += span.text.length;
    if (total > MC_AUTHENTICATION_SOURCE_LIMIT) return authenticationAdmissionResult_('incomplete', authenticationLike);
  }
  const subject = source.sourceSpans.find(function (span) { return span && span.kind === 'subject'; });
  const bridge = !!(subject && authenticationSubjectPurpose_(subject.text));
  let discussion = false;
  let discussionFrame = false;
  let issued = false;
  let issuedCount = 0;
  const issuedRelations = [];
  let unsupported = false;
  let forwardedHeaderFrame = 0;
  let representation = '';
  for (const span of source.sourceSpans) {
    if (span.kind !== representation) { discussionFrame = false; forwardedHeaderFrame = 0; representation = span.kind; }
    const clauses = authenticationClauseParts_(span.text);
    const quotedAuthentication = span.quoted && (authenticationLikeSource_({sourceSpans: [span]}) ||
      clauses.some(function (clause) {
        return authenticationIssuedClause_(clause, bridge) ||
          authenticationGenericAssignment_(clause, bridge) ||
          authenticationDiscussionClause_(clause, true);
      }));
    if (quotedAuthentication) { discussion = true; continue; }
    for (const clause of clauses) {
      if (forwardedHeaderFrame) {
        if (forwardedHeaderFrame === 1 && /^sent\s*:/iu.test(clause)) { discussion = true; forwardedHeaderFrame = 2; continue; }
        if (forwardedHeaderFrame === 2 && /^subject\s*:/iu.test(clause)) { discussion = true; forwardedHeaderFrame = 3; continue; }
        if (forwardedHeaderFrame === 3) { discussion = true; forwardedHeaderFrame = 0; continue; }
        forwardedHeaderFrame = 0;
      }
      if (/^from\s*:/iu.test(clause)) { discussion = true; forwardedHeaderFrame = 1; continue; }
      if (discussionFrame) {
        discussion = true;
        discussionFrame = authenticationDiscussionClause_(clause, bridge);
        continue;
      }
      if (authenticationTargetlessDiscussionClause_(clause)) { discussion = true; continue; }
      // Whitespace is grammar; the value's spelling, including case, is its
      // identity. Cross-representation mirrors must not merge case variants.
      const relationKey = clause.replace(/\s+/gu, ' ').trim();
      if (authenticationIssuedClause_(clause, bridge)) {
        issued = true;
        const relation = issuedRelations.find(function (item) { return item.key === relationKey; });
        if (!relation) { issuedRelations.push({key: relationKey, kinds: [span.kind]}); issuedCount++; }
        else if (relation.kinds.indexOf(span.kind) >= 0 ||
            !(span.kind === 'text' || span.kind === 'html') || relation.kinds.some(function (kind) { return kind !== 'text' && kind !== 'html'; })) {
          issuedCount++;
        } else relation.kinds.push(span.kind);
        continue;
      }
      if (span.kind !== 'subject' && authenticationGenericAssignment_(clause, bridge)) {
        issued = true;
        const relation = issuedRelations.find(function (item) { return item.key === relationKey; });
        if (!relation) { issuedRelations.push({key: relationKey, kinds: [span.kind]}); issuedCount++; }
        else if (relation.kinds.indexOf(span.kind) >= 0 ||
            !(span.kind === 'text' || span.kind === 'html') || relation.kinds.some(function (kind) { return kind !== 'text' && kind !== 'html'; })) {
          issuedCount++;
        } else relation.kinds.push(span.kind);
        continue;
      }
      if (authenticationDiscussionClause_(clause)) { discussion = true; discussionFrame = true; continue; }
      if (new RegExp(authenticationTargetSearchPattern_(), 'iu').test(clause) ||
          (!authenticationSubjectPurpose_(clause) && authenticationLikeSource_({sourceSpans: [{text: clause}]}))) unsupported = true;
    }
  }
  return authenticationAdmissionResult_(issued && issuedCount === 1 && !discussion && !unsupported ? 'issued' : discussion ? 'discussion' : 'ambiguous', issued || authenticationLike);
}

function authenticationAdmissionForMessage_(message) {
  const admission = message && message.authenticationAdmission;
  if (admission && admission.kind === 'issued' && admission.deterministic === true && admission.authenticationLike === true) return admission;
  return authenticationAdmission_(candidateSource_(message));
}

function authenticationExclusion_(source) {
  const admission = authenticationAdmission_(source);
  return admission.kind === 'issued' ? {excludedReason: 'authentication_code_message', admission: admission} : null;
}

function authenticationExcludedOutcome_(source, admission) {
  return {status: source.incomplete ? 'incomplete' : 'complete', candidates: [], empty: true,
    modelEmpty: false, invalidated: false, verifiedNonOffer: false, archiveAllowed: false,
    excludedReason: 'authentication_code_message', admission: admission || authenticationAdmission_(source)};
}

function checkpointAuthenticationExclusion_(journalSheet, journal) {
  if (!journal || typeof journal.messageId !== 'string' || !Array.isArray(journal.candidateKeys) ||
      !Array.isArray(journal.rowNumbers)) fail_('STATE');
  journal.status = 'ignored'; journal.outcome = 'authentication_code_message'; journal.failureStage = '';
  journal.lastError = ''; journal.nextRetryAt = ''; journal.updatedAt = new Date().toISOString();
  saveMessageState_(journalSheet, journal);
  return {messageId: journal.messageId, status: 'ignored', rows: journal.rowNumbers.slice(),
    excludedReason: 'authentication_code_message'};
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
