function validDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (v) { return ('0' + ((v + 256) % 256).toString(16)).slice(-2); }).join('');
}
function boundedText_(text, limit) {
  const prefix = text.slice(0, limit);
  return /[\ud800-\udbff]$/.test(prefix) && /[\udc00-\udfff]/.test(text.charAt(limit)) ? prefix.slice(0, -1) : prefix;
}
function textCell_(s) {
  const value = boundedText_(String(s == null ? '' : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''), 4000);
  return /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
}
function normalized_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function wellFormedUtf16_(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= value.length || value.charCodeAt(i + 1) < 0xdc00 || value.charCodeAt(i + 1) > 0xdfff) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function utf16Boundary_(value, index) {
  return !(index > 0 && index < value.length && value.charCodeAt(index - 1) >= 0xd800 &&
    value.charCodeAt(index - 1) <= 0xdbff && value.charCodeAt(index) >= 0xdc00 && value.charCodeAt(index) <= 0xdfff);
}
function numericRangeEndpoint_(before, after) {
  const space = '[\\t\\n\\f\\r ]*';
  const unit = '(?:[\\t\\n\\f\\r ]*[%€$£]|[\\t\\n\\f\\r ]+[eE][uU][rR][oO][sS]?)?';
  const qualifier = '(?:[\\t\\n\\f\\r ]+[oO][fF][fF])?';
  const to = '[tT][oO]';
  const and = '[aA][nN][dD]';
  const between = '[bB][eE][tT][wW][eE][eE][nN]';
  const digit = '\\p{Nd}';
  const decimal = '[.,٫．]';
  const amount = '[€$£]?' + digit + '+(?:' + decimal + digit + '+)?' + unit;
  const separator = '[-−–—/:]';
  const nextAmount = '[€$£]?' + digit;
  return new RegExp('^' + unit + space + separator + space + nextAmount, 'u').test(after) ||
    new RegExp(amount + space + separator + space + '[€$£]?$', 'u').test(before) ||
    new RegExp('^' + unit + qualifier + '[\\t\\n\\f\\r ]+' + to + '[\\t\\n\\f\\r ]+' + nextAmount, 'u').test(after) ||
    new RegExp(amount + qualifier + '[\\t\\n\\f\\r ]+' + to + '[\\t\\n\\f\\r ]+[€$£]?$', 'u').test(before) ||
    new RegExp('^' + unit + qualifier + '[\\t\\n\\f\\r ]+' + and + '[\\t\\n\\f\\r ]+' + nextAmount, 'u').test(after) &&
      new RegExp('\\b' + between + '[\\t\\n\\f\\r ]*[€$£]?$', 'u').test(before) ||
    new RegExp('\\b' + between + '[\\t\\n\\f\\r ]+' + amount + qualifier + '[\\t\\n\\f\\r ]+' + and + '[\\t\\n\\f\\r ]+[€$£]?$', 'u').test(before);
}
function htmlContent_(html) {
  const root = MC_HTML.parse(String(html), {scriptingEnabled: false});
  const stack = [{node: root}];
  const pieces = [];
  const evidenceSpans = [];
  let evidence = '';
  const images = [];
  let incomplete = false;
  let pendingImageBoundary = false;
  function flushEvidence() {
    if (evidence) evidenceSpans.push(evidence);
    evidence = '';
  }
  function newline(block) {
    if (pieces.length && !pieces[pieces.length - 1].endsWith('\n')) pieces.push('\n');
    pendingImageBoundary = false;
    if (block) {
      flushEvidence();
    } else if (evidence && !evidence.endsWith('\n')) evidence += '\n';
  }
  function replacementBoundary() {
    flushEvidence();
    pendingImageBoundary = pendingImageBoundary || pieces.length && !pieces[pieces.length - 1].endsWith('\n');
  }
  function appendProjectedText(value) {
    if (pendingImageBoundary) { pieces.push('\n'); pendingImageBoundary = false; }
    pieces.push(value); evidence += value;
  }
  while (stack.length) {
    const entry = stack.pop();
    if (entry.exit) { newline(true); continue; }
    const node = entry.node;
    if (node.nodeName === '#text') {
      if (!entry.suppressed && node.value) appendProjectedText(node.value);
      continue;
    }
    const tag = node.tagName || '';
    const isHtml = node.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const foreign = Boolean(tag && !isHtml);
    if (foreign) incomplete = true;
    const nodeAttrs = node.attrs || [];
    const closedDialog = isHtml && tag === 'dialog' && !nodeAttrs.some(function (attr) { return attr.name === 'open'; });
    const closedDetails = isHtml && tag === 'details' && !nodeAttrs.some(function (attr) { return attr.name === 'open'; });
    const closedPopover = isHtml && nodeAttrs.some(function (attr) { return attr.name === 'popover'; });
    const contextSuppressed = entry.suppressed || foreign || isHtml &&
      (/^(?:script|style|template|title|head|iframe|noembed|noframes|datalist|rp)$/.test(tag) ||
        closedDialog || closedPopover || nodeAttrs.some(function (attr) { return attr.name === 'hidden'; }));
    if (!contextSuppressed && isHtml && (tag === 'picture' || (tag === 'img' || tag === 'source') &&
      nodeAttrs.some(function (attr) { return attr.name === 'srcset'; }))) incomplete = true;
    if (isHtml && tag === 'select' && !contextSuppressed) incomplete = true;
    if (isHtml && tag === 'input' && !contextSuppressed && !nodeAttrs.some(function (attr) {
      return attr.name === 'type' && String(attr.value).toLowerCase() === 'hidden';
    })) incomplete = true;
    const activeCanvas = isHtml && tag === 'canvas' && !contextSuppressed;
    if (activeCanvas) incomplete = true;
    const suppressed = contextSuppressed || activeCanvas || isHtml && /^(?:select|optgroup|option)$/.test(tag);
    const block = !suppressed && isHtml && /^(?:address|article|aside|blockquote|caption|center|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|legend|li|listing|main|menu|nav|ol|p|plaintext|pre|search|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|xmp)$/.test(tag);
    if (block || !suppressed && isHtml && tag === 'br') newline(block);
    if (block) stack.push({exit: true});
    if (activeCanvas) replacementBoundary();
    if (!suppressed && isHtml && tag === 'img') {
      replacementBoundary();
      const imageAttrs = Object.create(null);
      nodeAttrs.forEach(function (attr) { imageAttrs[attr.name] = attr.value; });
      images.push(imageAttrs);
      const hasSrc = nodeAttrs.some(function (attr) {
        return attr.name === 'src' && /[^\t\n\f\r ]/.test(String(attr.value));
      });
      const alt = nodeAttrs.find(function (attr) { return attr.name === 'alt'; });
      if (!hasSrc && alt && /\S/u.test(String(alt.value))) {
        appendProjectedText(alt.value);
        flushEvidence();
        pendingImageBoundary = pieces.length && !pieces[pieces.length - 1].endsWith('\n');
      }
    }
    // Suppressed and inert subtrees still contribute unsupported-namespace coverage.
    const children = node.content ? node.content.childNodes : node.childNodes || [];
    let visibleSummary = null;
    if (!suppressed && closedDetails) {
      for (let i = 0; i < children.length; i++) {
        if (children[i].namespaceURI === 'http://www.w3.org/1999/xhtml' && children[i].tagName === 'summary') {
          visibleSummary = children[i]; break;
        }
      }
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({node: children[i], suppressed: suppressed || closedDetails && children[i] !== visibleSummary});
    }
  }
  flushEvidence();
  return {text: pieces.join(''), evidenceSpans: evidenceSpans, images: images, incomplete: incomplete};
}
function htmlText_(html) {
  return htmlContent_(html).text;
}
function safeUrl_(s) {
  if (typeof s !== 'string' || s.length > 2048 || /[\s\\\x00-\x1f]/.test(s)) return '';
  const m = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i.exec(s);
  if (!m || m[1].indexOf('.') < 0 || /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(m[1]) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|arpa|onion)$/i.test(m[1]) ||
    !m[1].split('.').every(function (p) { return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(p); })) return '';
  return s;
}
function smallImageDimension_(value) {
  // HTML dimension rules: digit-led decimal; only an immediately following % is relative.
  const match = /^[\t\n\f\r ]*([0-9]+(?:\.[0-9]*)?)(%?)/.exec(value || '');
  return Boolean(match && !match[2] && Number(match[1]) <= 2);
}
function remoteImageUrls_(html) {
  const urls = [];
  htmlContent_(html).images.forEach(function (attrs) {
    const src = typeof attrs.src === 'string' ? attrs.src.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '') : '';
    if (!src || ['width', 'height'].some(function (key) { return smallImageDimension_(attrs[key]); }) ||
      /(?:pixel|tracking|tracker|beacon|\/open(?:[/.?#]|$)|transparent|spacer)/i.test(src)) return;
    const url = safeUrl_(src);
    if (url && urls.indexOf(url) < 0) urls.push(url);
  });
  return urls;
}
function couponSignal_(text) {
  return /\b(coupon|voucher|promo(?:tion|code)?|discount|sconto|codice|offert[ae]|redeem|cashback|sale|save|risparmi|buono|buoni|deal)\b|\d\s*%/i.test(text);
}
function candidateSource_(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
    message.text !== undefined && typeof message.text !== 'string' ||
    Object.prototype.hasOwnProperty.call(message, 'html') && typeof message.html !== 'string' ||
    message.images !== undefined && !Array.isArray(message.images)) fail_('AI');
  const html = message.html === undefined ? {text: '', evidenceSpans: [], incomplete: false} : htmlContent_(message.html);
  return {spans: [message.text || '', html.text].filter(Boolean),
    evidenceSpans: [message.text || ''].concat(html.evidenceSpans).filter(Boolean),
    images: message.images === undefined ? [] : message.images,
    incomplete: message.incomplete !== false || html.incomplete};
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
    const re = /(?:^|[^\p{L}\p{N}\p{M}_])(?:coupon\s+code|promo(?:tional)?\s+code|discount\s+code|use\s+(?:the\s+)?code|codice\s+sconto|codice(?!\s+sconto(?:\s|[:=]|$)))(?:\s*[:=]\s*|\s+)(\S+)/giu;
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
      url.startsWith(value) && /^[.,;!?)\]}]+$/.test(url.slice(value.length)) && !safeUrl_(url)) {
      occurrences.push({start: start, end: start + value.length});
    }
  }
  return occurrences;
}
function fieldOccurrences_(field, value, source) {
  if (!wellFormedUtf16_(value) || !wellFormedUtf16_(source)) return [];
  if (field === 'code') return codeOccurrences_(value, source);
  if (field === 'website') return websiteOccurrences_(value, source);
  if (field === 'discountType' && /^[%€$£]$/.test(value)) {
    return rawOccurrences_(value, source, false).filter(function (occurrence) {
      const before = adjacentCodePoint_(source, occurrence.start, true);
      const after = adjacentCodePoint_(source, occurrence.end, false);
      return source === value || value === '%' && /\p{Nd}/u.test(before) || value !== '%' && /\p{Nd}/u.test(after);
    });
  }
  const boundary = /[\p{L}\p{N}\p{M}_]/u;
  const numericField = ['discountValue', 'minimumSpend'].indexOf(field) >= 0 && /\p{Nd}/u.test(value);
  const rangeContext = 96;
  return rawOccurrences_(value, source, true).filter(function (occurrence) {
    const before = adjacentCodePoint_(source, occurrence.start, true);
    const after = adjacentCodePoint_(source, occurrence.end, false);
    const beforeStart = Math.max(0, occurrence.start - rangeContext);
    const afterEnd = Math.min(source.length, occurrence.end + rangeContext);
    const beforeText = source.slice(beforeStart, occurrence.start);
    const afterText = source.slice(occurrence.end, afterEnd);
    const truncatedBefore = beforeStart > 0;
    const truncatedAfter = afterEnd < source.length;
    const truncatedBetween = truncatedBefore && new RegExp('[\\p{Nd}](?:[\\t\\n\\f\\r ]*[%€$£]|[\\t\\n\\f\\r ]+[eE][uU][rR][oO][sS]?)?(?:[\\t\\n\\f\\r ]+[oO][fF][fF])?[\\t\\n\\f\\r ]+[aA][nN][dD][\\t\\n\\f\\r ]+[€$£]?$', 'u').test(beforeText);
    const truncatedDelimiter = truncatedBefore && /[\t\n\f\r ]*(?:[-−–—/:][\t\n\f\r ]*|[tT][oO][\t\n\f\r ]+|[aA][nN][dD][\t\n\f\r ]+)[€$£]?$/.test(beforeText);
    const truncatedWhitespace = truncatedBefore && /^[\t\n\f\r ]*$/.test(beforeText);
    const truncatedFollowing = truncatedAfter && new RegExp('^(?:[\\t\\n\\f\\r ]|(?:[\\t\\n\\f\\r ]*[%€$£]|[\\t\\n\\f\\r ]+[eE][uU][rR][oO][sS]?)(?:[\\t\\n\\f\\r ]+[oO][fF][fF])?(?:[\\t\\n\\f\\r ]+(?:[tT][oO]|[aA][nN][dD]))?)*$', 'u').test(afterText);
    return utf16Boundary_(source, occurrence.start) && utf16Boundary_(source, occurrence.end) &&
      (!before || !boundary.test(before)) && (!after || !boundary.test(after)) &&
      !(numericField && (numericRangeEndpoint_(beforeText, afterText) || truncatedBetween || truncatedDelimiter || truncatedWhitespace || truncatedFollowing)) &&
      !(/\p{Nd}$/u.test(value) && /^[.,٫．]\p{Nd}/u.test(source.slice(occurrence.end, occurrence.end + 3))) &&
      !(/^\p{Nd}/u.test(value) && /\p{Nd}[.,٫．]$/u.test(source.slice(Math.max(0, occurrence.start - 3), occurrence.start)));
  });
}
function fieldInQuote_(field, value, quote) {
  return fieldOccurrences_(field, value, quote).length > 0;
}
function textEvidenceGrounded_(field, value, quote, span) {
  if (!wellFormedUtf16_(quote) || !wellFormedUtf16_(span)) return false;
  const quoteOccurrences = rawOccurrences_(quote, span, field !== 'code' && field !== 'website');
  const fieldOccurrences = fieldOccurrences_(field, value, span);
  let fieldIndex = 0;
  for (let quoteIndex = 0; quoteIndex < quoteOccurrences.length; quoteIndex++) {
    const quoteOccurrence = quoteOccurrences[quoteIndex];
    while (fieldIndex < fieldOccurrences.length && fieldOccurrences[fieldIndex].end <= quoteOccurrence.start) fieldIndex++;
    while (fieldIndex < fieldOccurrences.length && fieldOccurrences[fieldIndex].start < quoteOccurrence.start) fieldIndex++;
    if (fieldIndex < fieldOccurrences.length && fieldOccurrences[fieldIndex].end <= quoteOccurrence.end) return true;
  }
  return false;
}
function normalizeCandidate_(raw, message) {
  function objectWithKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).every(function (key) { return keys.indexOf(key) >= 0; });
  }
  if (!objectWithKeys(raw, MC.fields.concat(['confidence', 'review', 'evidence'])) ||
    raw.confidence !== undefined && ['high', 'medium', 'low'].indexOf(raw.confidence) < 0 ||
    raw.review !== undefined && typeof raw.review !== 'boolean') fail_('AI');
  const evidence = raw.evidence === undefined ? {} : raw.evidence;
  if (!objectWithKeys(evidence, MC.fields)) fail_('AI');
  const source = candidateSource_(message);
  Object.keys(evidence).forEach(function (key) {
    const ev = evidence[key];
    if (ev === undefined) return;
    if (!objectWithKeys(ev, ['quote', 'image']) ||
      ev.quote !== undefined && (typeof ev.quote !== 'string' || !wellFormedUtf16_(ev.quote)) ||
      ev.image !== undefined && !Number.isInteger(ev.image)) fail_('AI');
    if (ev.image !== undefined && (ev.image < 0 || ev.image >= source.images.length || source.images[ev.image] == null)) fail_('AI');
  });
  const c = {};
  let truncated = false;
  MC.fields.forEach(function (k) {
    if (raw[k] != null && (typeof raw[k] !== 'string' || !wellFormedUtf16_(raw[k]))) fail_('AI');
    const value = (raw[k] || '').trim();
    const limit = k === 'notes' ? 3500 : 1000;
    if (value.length > limit) truncated = true;
    c[k] = value.length > limit && k !== 'notes' ? '' : boundedText_(value, limit);
  });
  c.website = safeUrl_(c.website);
  if (c.expiry && !validDate_(c.expiry)) c.expiry = '';
  c.confidence = ['high', 'medium', 'low'].indexOf(raw.confidence) >= 0 ? raw.confidence : 'low';
  c.review = raw.review !== false || c.confidence !== 'high' || !c.merchant ||
    !(c.code || (c.discountType && c.discountValue) || c.website) || source.incomplete || truncated ||
    Boolean(raw.website && !c.website || raw.expiry && !c.expiry);
  // Every asserted field must be anchored to supplied text or an inspected image.
  MC.fields.filter(function (k) { return c[k]; }).forEach(function (k) {
    const ev = evidence[k];
    const groundedText = ev && typeof ev.quote === 'string' && ev.quote.trim().length > 0 &&
      source.evidenceSpans.some(function (span) { return textEvidenceGrounded_(k, c[k], ev.quote, span); });
    const groundedImage = ev && Number.isInteger(ev.image) && ev.image >= 0 && ev.image < source.images.length &&
      source.images[ev.image] != null;
    if (!groundedText && !groundedImage) { c[k] = ''; c.review = true; }
    // OCR-only evidence is a proposal, not independently verified import authority.
    if (groundedImage && !groundedText) c.review = true;
  });
  if (!c.merchant || !(c.code || (c.discountType && c.discountValue) || c.website)) c.review = true;
  return c;
}
function gmailLink_(id) { return 'https://mail.google.com/mail/u/0/#all/' + id; }
function sourceId_(value) {
  // Gmail's opaque UI tokens (including msg-f:) are not REST message IDs.
  // Accept only the canonical hexadecimal links used by this importer.
  const link = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i.exec(String(value));
  if (!link) return '';
  const authority = /^mail\.google\.com(?::(\d+))?$/i.exec(link[1]);
  if (!authority || authority[1] !== undefined && Number(authority[1]) !== 443 ||
    !/^\/mail\/(?:u\/\d+\/)?$/.test(link[2] || '')) return '';
  if (link[4] !== undefined) {
    const fragment = /^(?:all|inbox|search\/[^/#]+)\/([a-f0-9]+)$/.exec(link[4]);
    return fragment ? fragment[1] : '';
  }
  const threads = (link[3] || '').split('&').filter(function (param) { return /^th=/.test(param); });
  if (threads.length !== 1) return '';
  const thread = /^th=([a-f0-9]+)$/.exec(threads[0]);
  return thread ? thread[1] : '';
}
function realCouponRow_(row) {
  function present(value) { return String(value == null ? '' : value).trim() !== ''; }
  if ([row[4], row[17]].some(function (v) { return /^(?:scan|scanned|technical|no coupons?|no offers?)$/i.test(String(v).trim()); })) return false;
  return present(row[1]) && (present(row[3]) || present(row[2]) || present(row[4]) && present(row[5])) &&
    (present(row[11]) || present(row[13]));
}
function emailDate_(value, zone) {
  if (value instanceof Date && isFinite(value.getTime())) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value)) {
    if (value.length === 10 && validDate_(value)) return Utilities.parseDate(value, zone, 'yyyy-MM-dd');
    // Only explicitly zoned timestamps are portable. Locale-specific strings
    // require correction in Sheets instead of guessing day/month order.
    if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(value) && validDate_(value.slice(0, 10))) {
      const d = new Date(value); if (isFinite(d.getTime())) return d;
    }
  }
  fail_('DATE');
}
function recoveryStart_(rows, c) {
  let max = null;
  rows.filter(realCouponRow_).forEach(function (row) {
    const date = emailDate_(row[0], c.timeZone);
    if (!max || date > max) max = date;
  });
  const day = max ? Utilities.formatDate(max, c.timeZone, 'yyyy-MM-dd') : c.initialDate;
  if (!day) fail_('INITIAL_DATE');
  return Utilities.parseDate(day, c.timeZone, 'yyyy-MM-dd').getTime();
}
function messageOutcome_(items) {
  if (!Array.isArray(items) || Array.from(items).some(function (x) { return !x || ['confirmed', 'review', 'ignored'].indexOf(x.status) < 0; })) fail_('STATE');
  if (items.some(function (x) { return x.status === 'review'; })) return 'review';
  if (items.some(function (x) { return x.status === 'ignored'; })) return 'unchanged';
  return items.length ? 'archive' : 'empty';
}
