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
function htmlContent_(html) {
  const root = MC_HTML.parse(String(html), {scriptingEnabled: false});
  const stack = [{node: root}];
  const pieces = [];
  const images = [];
  function newline() {
    if (pieces.length && !pieces[pieces.length - 1].endsWith('\n')) pieces.push('\n');
  }
  while (stack.length) {
    const entry = stack.pop();
    if (entry.exit) { newline(); continue; }
    const node = entry.node;
    if (node.nodeName === '#text') { if (node.value) pieces.push(node.value); continue; }
    const tag = node.tagName || '';
    const isHtml = node.namespaceURI === 'http://www.w3.org/1999/xhtml';
    if (/^(?:script|style)$/.test(tag) || isHtml &&
      (/^(?:template|title|head|iframe|noembed|noframes)$/.test(tag) ||
        (node.attrs || []).some(function (attr) { return attr.name === 'hidden'; }))) continue;
    const block = isHtml && /^(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/.test(tag);
    if (block || isHtml && tag === 'br') newline();
    if (block) stack.push({exit: true});
    if (isHtml && tag === 'img') {
      const attrs = Object.create(null);
      (node.attrs || []).forEach(function (attr) { attrs[attr.name] = attr.value; });
      images.push(attrs);
    }
    const children = node.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({node: children[i]});
  }
  return {text: pieces.join(''), images: images};
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
    if (!attrs.src || ['width', 'height'].some(function (key) { return smallImageDimension_(attrs[key]); }) ||
      /(?:pixel|tracking|tracker|beacon|\/open[/.?]|transparent|spacer)/i.test(attrs.src)) return;
    const url = safeUrl_(attrs.src);
    if (url && urls.indexOf(url) < 0) urls.push(url);
  });
  return urls;
}
function couponSignal_(text) {
  return /\b(coupon|voucher|promo(?:tion|code)?|discount|sconto|codice|offert[ae]|redeem|cashback|sale|save|risparmi|buono|buoni|deal)\b|\d\s*%/i.test(text);
}
function codeLexemes_(text) {
  // Other punctuation belongs to the code, never to a silently discarded suffix.
  return text.match(/[^\s"'<>]+/gu) || [];
}
function deterministicCandidates_(message) {
  // Only explicit code syntax is deterministic. Preserve the full bounded terms
  // and require review: a regex cannot establish the completeness of an offer.
  const codes = [];
  const re = /\b(?:coupon\s+code|promo(?:tional)?\s+code|discount\s+code|use\s+(?:the\s+)?code|codice(?:\s+sconto)?)\s*[:=]?\s*(\S+)/giu;
  let match;
  while ((match = re.exec(message.text))) {
    const code = codeLexemes_(match[1])[0];
    const length = code ? Array.from(code).length : 0;
    if (length >= 3 && length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*$/u.test(code) &&
      codes.indexOf(code) < 0) codes.push(code);
  }
  return codes.slice(0, MC.maxCandidates).map(function (code) {
    return {code: code, notes: boundedText_(message.text, 3500), confidence: 'low', review: true};
  });
}
function fieldInQuote_(field, value, quote) {
  if (field === 'code') return codeLexemes_(quote).indexOf(value) >= 0;
  if (field === 'website') {
    const urls = quote.match(/https:\/\/[^\s<>"']+/gi) || [];
    if (urls.indexOf(value) >= 0) return true;
    // Only invalid authority suffixes are prose. Path/query punctuation can be identity.
    if (!/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(value) || !safeUrl_(value)) return false;
    return urls.some(function (url) {
      return url.startsWith(value) && /^[.,;!?)\]}]+$/.test(url.slice(value.length)) && !safeUrl_(url);
    });
  }
  const source = normalized_(quote);
  const needle = normalized_(value);
  let start = source.indexOf(needle);
  while (start >= 0) {
    const before = source.slice(0, start);
    const after = source.slice(start + needle.length);
    const boundary = /[\p{L}\p{N}\p{M}_]/u;
    if ((!before || !boundary.test(Array.from(before).slice(-1)[0])) && (!after || !boundary.test(Array.from(after)[0])) &&
      !( /\d$/.test(needle) && /^[.,]\d/.test(after)) &&
      !( /^\d/.test(needle) && /\d[.,]$/.test(before))) return true;
    start = source.indexOf(needle, start + 1);
  }
  return false;
}
function normalizeCandidate_(raw, message) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail_('AI');
  const c = {};
  let truncated = false;
  MC.fields.forEach(function (k) {
    if (raw[k] != null && typeof raw[k] !== 'string') fail_('AI');
    const value = (raw[k] || '').trim();
    const limit = k === 'notes' ? 3500 : 1000;
    if (value.length > limit) truncated = true;
    c[k] = value.length > limit && k !== 'notes' ? '' : boundedText_(value, limit);
  });
  c.website = safeUrl_(c.website);
  if (c.expiry && !validDate_(c.expiry)) c.expiry = '';
  c.confidence = ['high', 'medium', 'low'].indexOf(raw.confidence) >= 0 ? raw.confidence : 'low';
  c.review = raw.review !== false || c.confidence !== 'high' || !c.merchant ||
    !(c.code || (c.discountType && c.discountValue) || c.website) || message.incomplete !== false || truncated ||
    Boolean(raw.website && !c.website || raw.expiry && !c.expiry);
  // Every asserted field must be anchored to supplied text or an inspected image.
  const evidence = raw.evidence || {};
  MC.fields.filter(function (k) { return c[k]; }).forEach(function (k) {
    const ev = evidence[k];
    const groundedText = ev && typeof ev.quote === 'string' && ev.quote.trim().length > 1 &&
      (k === 'code' || k === 'website' ? message.text.includes(ev.quote) : normalized_(message.text).includes(normalized_(ev.quote))) &&
      fieldInQuote_(k, c[k], ev.quote) && fieldInQuote_(k, c[k], message.text);
    const groundedImage = ev && Number.isInteger(ev.image) && ev.image >= 0 && ev.image < message.images.length;
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
  const link = /^https:\/\/mail\.google\.com\/mail\/(?:u\/\d+\/)?(?:\?([^#]*))?(?:#(.*))?$/.exec(String(value));
  if (!link) return '';
  if (link[2] !== undefined) {
    const fragment = /^(?:all|inbox|search\/[^/#]+)\/([a-f0-9]+)$/i.exec(link[2]);
    return fragment ? fragment[1].toLowerCase() : '';
  }
  const threads = (link[1] || '').split('&').filter(function (param) { return /^th=/.test(param); });
  if (threads.length !== 1) return '';
  const thread = /^th=([a-f0-9]+)$/i.exec(threads[0]);
  return thread ? thread[1].toLowerCase() : '';
}
function realCouponRow_(row) {
  if ([row[4], row[17]].some(function (v) { return /^(?:scan|scanned|technical|no coupons?|no offers?)$/i.test(String(v).trim()); })) return false;
  return Boolean(row[1] && (row[3] || row[4] || row[5] || row[2]) && (row[11] || row[13]));
}
function emailDate_(value, zone) {
  if (value instanceof Date && isFinite(value.getTime())) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value)) {
    if (value.length === 10 && validDate_(value)) return Utilities.parseDate(value, zone, 'yyyy-MM-dd');
    // Only explicitly zoned timestamps are portable. Locale-specific strings
    // require correction in Sheets instead of guessing day/month order.
    if (validDate_(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
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
