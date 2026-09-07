function validDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function digest_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (v) { return ('0' + ((v + 256) % 256).toString(16)).slice(-2); }).join('');
}
function textCell_(s) {
  const value = String(s == null ? '' : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 4000);
  return /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
}
function normalized_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function decodeHtml_(s) {
  return String(s).replace(/&#(x[0-9a-f]+|\d+);/gi, function (_, n) {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, function (_, n) {
    return {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '}[n.toLowerCase()];
  });
}
function htmlText_(html) {
  return decodeHtml_(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' '));
}
function safeUrl_(s) {
  if (typeof s !== 'string' || s.length > 2048 || /[\s\\\x00-\x1f]/.test(s)) return '';
  const m = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i.exec(s);
  if (!m || m[1].indexOf('.') < 0 || /^(?:\d|0x)/i.test(m[1]) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|arpa|onion)$/i.test(m[1]) ||
    !m[1].split('.').every(function (p) { return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(p); })) return '';
  return s;
}
function remoteImageUrls_(html) {
  const urls = [];
  String(html).replace(/<img\b[^>]*>/gi, function (tag) {
    const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!m || /\b(?:width|height)\s*=\s*["']?[012](?:px)?["'\s>]/i.test(tag) ||
      /(?:pixel|tracking|tracker|beacon|\/open[/.?]|transparent|spacer)/i.test(m[1])) return tag;
    const url = safeUrl_(decodeHtml_(m[1]));
    if (url && urls.indexOf(url) < 0) urls.push(url);
    return tag;
  });
  return urls;
}
function couponSignal_(text) {
  return /\b(coupon|voucher|promo(?:tion|code)?|discount|sconto|codice|offert[ae]|redeem|cashback|sale|save|risparmi|buono|buoni|deal)\b|\d\s*%/i.test(text);
}
function deterministicCandidates_(message) {
  // Only explicit code syntax is deterministic. Preserve the full bounded terms
  // and require review: a regex cannot establish the completeness of an offer.
  const codes = [];
  const re = /\b(?:coupon\s+code|promo(?:tional)?\s+code|discount\s+code|use\s+(?:the\s+)?code|codice(?:\s+sconto)?)\s*[:=]?\s*["']?([A-Z0-9][A-Z0-9_-]{2,39})\b/g;
  let match;
  while ((match = re.exec(message.text))) {
    if (codes.indexOf(match[1]) < 0) codes.push(match[1]);
  }
  return codes.slice(0, MC.maxCandidates).map(function (code) {
    return {code: code, notes: message.text.slice(0, 3500), confidence: 'low', review: true};
  });
}
function normalizeCandidate_(raw, message) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail_('AI');
  const c = {};
  MC.fields.forEach(function (k) {
    if (raw[k] != null && typeof raw[k] !== 'string') fail_('AI');
    c[k] = (raw[k] || '').trim().slice(0, k === 'notes' ? 3500 : 1000);
  });
  c.website = safeUrl_(c.website);
  if (c.expiry && !validDate_(c.expiry)) c.expiry = '';
  c.confidence = ['high', 'medium', 'low'].indexOf(raw.confidence) >= 0 ? raw.confidence : 'low';
  c.review = raw.review !== false || c.confidence !== 'high' || !c.merchant ||
    !(c.code || (c.discountType && c.discountValue) || c.website) || message.incomplete ||
    Boolean(raw.website && !c.website || raw.expiry && !c.expiry);
  // Every asserted field must be anchored to supplied text or an inspected image.
  const evidence = raw.evidence || {};
  MC.fields.filter(function (k) { return k !== 'notes' && c[k]; }).forEach(function (k) {
    const ev = evidence[k];
    const groundedText = ev && typeof ev.quote === 'string' && ev.quote.trim().length > 1 &&
      normalized_(message.text).includes(normalized_(ev.quote)) &&
      normalized_(ev.quote).includes(normalized_(c[k]));
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
  const m = /(?:#(?:all|inbox|search\/[^/]+)\/|[?&](?:th|permmsgid)=)([a-zA-Z0-9_-]+)/.exec(String(value));
  return m ? m[1].replace(/^msg-f:/, '') : '';
}
function realCouponRow_(row) {
  if (/\b(?:scan|scanned|technical|no coupons?|no offers?)\b/i.test([row[1], row[4], row[17]].join(' '))) return false;
  return Boolean(row[1] && (row[3] || row[4] || row[5] || row[2]) && (row[11] || row[13]));
}
function emailDate_(value, zone) {
  if (value instanceof Date && isFinite(value.getTime())) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value)) {
    if (value.length === 10 && validDate_(value)) return Utilities.parseDate(value, zone, 'yyyy-MM-dd');
    // Only explicitly zoned timestamps are portable. Locale-specific strings
    // require correction in Sheets instead of guessing day/month order.
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
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
  if (items.some(function (x) { return x.status === 'review'; })) return 'review';
  if (items.some(function (x) { return x.status === 'ignored'; })) return 'unchanged';
  return items.length ? 'archive' : 'empty';
}
