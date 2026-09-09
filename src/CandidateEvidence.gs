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
  const suppliedImages = sourceFieldValue_(message, 'images');
  if (text !== undefined && typeof text !== 'string' || htmlInput !== undefined && typeof htmlInput !== 'string' ||
    suppliedImages !== undefined && !Array.isArray(suppliedImages)) fail_('AI');
  const html = htmlInput === undefined ? {text: '', evidenceSpans: [], activeImageCount: 0, incomplete: false} : htmlContent_(htmlInput);
  const images = suppliedImages === undefined ? [] : suppliedImages;
  const incomplete = ownEnumerableDataValue_(message, 'incomplete');
  return {spans: [text || ''].concat(html.evidenceSpans).filter(Boolean),
    evidenceSpans: [text || ''].concat(html.evidenceSpans).filter(Boolean),
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
  // Only explicit code syntax is deterministic. Preserve the full bounded terms
  // and require review: a regex cannot establish the completeness of an offer.
  const source = candidateSource_(message);
  const codes = [];
  source.spans.forEach(function (text) {
    const re = /(?:^|[^\p{L}\p{N}\p{M}_])(?:coupon\s+code|promo(?:tional)?\s+code|discount\s+code|use\s+(?:the\s+)?code|codice\s+sconto|codice(?!\s+sconto(?:\s|[:=]|$)))(?:\s*[:=]\s*|\s+(?:is\b\s+)?)(\S+)/giu;
    let match;
    while ((match = re.exec(text))) {
      const code = codeLexemes_(match[1])[0];
      const length = code ? Array.from(code).length : 0;
      if (length >= 3 && length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*$/u.test(code) &&
        !codes.some(function (candidate) { return candidate.code === code; })) {
        codes.push({code: code, notes: boundedText_(text, 3500), confidence: 'low', review: true});
      }
    }
  });
  return codes.slice(0, MC.maxCandidates);
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
    if (groundedImage) c.imageEvidence[k] = source.images[image].sourceId;
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
