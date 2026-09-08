const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

test('configuration rejects ambiguous or unsupported inputs', () => {
  const {ctx, config} = harness();
  for (const change of [{locale: 'it'}, {ownerEmail: ''}, {timeZone: 'UTC'}, {autoVertexFallback: 'true'},
    {autoVertexFallback: true}, {labelName: 'A//B'}, {initialDate: '2026-02-30'}, {unknown: 1}, {model: 'model/key'},
    {developerProject: false}, {spreadsheetId: 0}, {initialDate: null}, {ownerEmail: ['owner@example.com']}]) {
    assert.throws(() => ctx.validateConfig_({...config, ...change}), /CONFIG/);
  }
});
test('recover full latest real import day in Rome, excluding technical scan rows', () => {
  const {ctx, config} = harness();
  const real = Array(26).fill(''); Object.assign(real, {0: '2026-05-22', 1: 'Shop', 3: 'CODE', 11: 'offer'});
  const scan = [...real]; scan[0] = '2026-09-07'; scan[4] = 'Scan';
  assert.equal(ctx.recoveryStart_([real, scan], config), Date.parse('2026-05-21T22:00:00Z'));
  const whitespace = ' \t\n\u00a0 ';
  for (const [offer, field] of [
    [{3: 'CODE'}, 1], [{3: 'CODE'}, 3], [{2: 'https://shop.example'}, 2],
    [{4: 'percent', 5: '20'}, 4], [{4: 'percent', 5: '20'}, 5],
    [{3: 'CODE'}, 11], [{3: 'CODE', 13: 'https://mail.google.com/mail/#all/18a9b0c7', 11: ''}, 13]
  ]) {
    const row = Array(26).fill(''); Object.assign(row, {0: 'not a date', 1: 'Shop', 11: 'offer'}, offer);
    row[field] = whitespace;
    assert.equal(ctx.realCouponRow_(row), false);
    assert.equal(ctx.recoveryStart_([real, row], config), Date.parse('2026-05-21T22:00:00Z'));
  }
  const trimmed = Array(26).fill('');
  Object.assign(trimmed, {0: '2026-06-30', 1: ' Shop ', 3: ' CODE ', 11: ' offer '});
  assert.equal(ctx.realCouponRow_(trimmed), true);
  assert.equal(ctx.recoveryStart_([real, trimmed], config), Date.parse('2026-06-29T22:00:00Z'));
  for (const partial of [{4: 'percent'}, {5: '20'}]) {
    const row = Array(26).fill(''); Object.assign(row, {0: 'not a date', 1: 'Shop', 11: 'offer'}, partial);
    assert.equal(ctx.realCouponRow_(row), false);
    assert.equal(ctx.recoveryStart_([real, row], config), Date.parse('2026-05-21T22:00:00Z'));
  }
  for (const offer of [{3: 'CODE'}, {2: 'https://shop.example'}, {4: 'percent', 5: '20'}]) {
    const row = Array(26).fill(''); Object.assign(row, {0: '2026-06-30', 1: 'Shop', 11: 'offer'}, offer);
    assert.equal(ctx.realCouponRow_(row), true);
    assert.equal(ctx.recoveryStart_([real, row], config), Date.parse('2026-06-29T22:00:00Z'));
  }
  assert.throws(() => ctx.recoveryStart_([], {...config, initialDate: ''}), /INITIAL_DATE/);
  real[0] = '05/06/2026'; assert.throws(() => ctx.recoveryStart_([real], config), /DATE/);
});
test('date parsing handles DST boundaries and timestamp local day', () => {
  const {ctx, config} = harness();
  const row = Array(26).fill(''); Object.assign(row, {0: '2026-03-29T22:30:00Z', 1: 'Shop', 3: 'CODE', 11: 'offer'});
  assert.equal(ctx.recoveryStart_([row], config), Date.parse('2026-03-29T22:00:00Z'));
  assert.equal(ctx.validDate_('2024-02-29'), true);
  assert.equal(ctx.validDate_('2026-02-29'), false);
  for (const [day, expected] of [['2026-03-29', '2026-03-28T23:00:00Z'], ['2026-10-25', '2026-10-24T22:00:00Z']]) {
    assert.equal(ctx.recoveryStart_([], {...config, initialDate: day}), Date.parse(expected));
  }
});
test('formula injection is quoted, and HTML text preserves conditions', () => {
  const {ctx} = harness();
  for (const x of ['=IMPORTXML("https://bad.test")', ' +cmd', '@test', '-test']) assert.ok(ctx.textCell_(x).startsWith("'"));
  assert.equal(ctx.htmlText_('<style>secret</style><p>Save &amp; use &#67;ODE</p>'), 'Save & use CODE\n');
});
test('remote image discovery excludes trackers, private literals and unsafe schemes', () => {
  const {ctx} = harness();
  for (const url of ['http://shop.com/a', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://foo.local/x', 'https://foo.LOCAL/x', 'https://x.com@evil.com/x', 'https://0x7f000001/x', 'https://example.com:8080/x']) assert.equal(ctx.safeUrl_(url), '');
  const html = '<img src="https://shop.com/promo.jpg"><img src="https://shop.com/pixel.gif"><img width="1" src="https://shop.com/a"><img src="https://shop.com/promo.jpg">';
  assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/promo.jpg']);
  for (const whitespace of [' ', '\t', '\n\f\r ']) {
    assert.deepEqual([...ctx.remoteImageUrls_('<img src="' + whitespace + 'https://shop.com/coupon.jpg' + whitespace + '">')],
      ['https://shop.com/coupon.jpg']);
    assert.deepEqual([...ctx.remoteImageUrls_('<img src="' + whitespace + 'https://shop.com/pixel.gif' + whitespace + '">')], []);
  }
  for (const url of ['https://shop.com/coupon image.jpg', '\u00a0https://shop.com/coupon.jpg\u00a0']) {
    assert.deepEqual([...ctx.remoteImageUrls_('<img src="' + url + '">')], []);
  }
  for (const url of ['https://shop.com/open', 'https://shop.com/open#receipt', 'https://shop.com/open/',
    'https://shop.com/open?receipt=1', 'https://shop.com/open.gif']) {
    assert.deepEqual([...ctx.remoteImageUrls_('<img src="' + url + '">')], [], url);
  }
  assert.deepEqual([...ctx.remoteImageUrls_('<img src="https://shop.com/opener">')], ['https://shop.com/opener']);
});
test('deterministic codes and ungrounded AI fields do not grant archive authority', () => {
  const {ctx} = harness();
  const message = {text: 'Shop: Save 20% with coupon code SAVE20', images: [], incomplete: false};
  assert.equal(ctx.deterministicCandidates_(message)[0].code, 'SAVE20');
  const c = ctx.normalizeCandidate_({merchant: 'Invented', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {code: {quote: 'coupon code SAVE20'}}}, message);
  assert.equal(c.merchant, ''); assert.equal(c.code, 'SAVE20'); assert.equal(c.review, true);
});
test('grounded complete AI text can confirm, OCR alone requires review', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  assert.equal(ctx.normalizeCandidate_(raw, {text: 'Shop SAVE20', images: [], incomplete: false}).review, false);
  raw.evidence.code = {image: 0};
  assert.equal(ctx.normalizeCandidate_(raw, {text: 'Shop', images: [{}], incomplete: false}).review, true);
  const minimal = {merchant: 'Shop', code: 'SAVE20', discountType: '%', discountValue: '1', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, discountType: {quote: '%'}, discountValue: {quote: '1'}}};
  assert.equal(ctx.normalizeCandidate_(minimal, {text: 'Shop SAVE20 1% off', images: [], incomplete: false}).review, false);
  minimal.evidence.discountType = {quote: ' '};
  assert.equal(ctx.normalizeCandidate_(minimal, {text: 'Shop SAVE20 1% off', images: [], incomplete: false}).discountType, '');
  const currency = {...minimal, discountType: '€', discountValue: '20',
    evidence: {...minimal.evidence, discountType: {quote: '€'}, discountValue: {quote: '20'}}};
  assert.equal(ctx.normalizeCandidate_(currency, {text: 'Shop SAVE20 €20 off', images: [], incomplete: false}).review, false);
  for (const [discountType, discountValue, text] of [['%', '20', 'Shop SAVE20 20 % off'], ['€', '20', 'Shop SAVE20 € 20 off'],
    ['$', '20', 'Shop SAVE20 $\t20 off'], ['£', '٢٠', 'Shop SAVE20 £\n٢٠ off']]) {
    const spaced = {merchant: 'Shop', code: 'SAVE20', discountType, discountValue, confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, discountType: {quote: discountType}, discountValue: {quote: discountValue}}};
    assert.equal(ctx.normalizeCandidate_(spaced, {text, images: [], incomplete: false}).review, false, text);
  }
});
test('mixed outcomes consistently leave email unchanged', () => {
  const {ctx} = harness();
  assert.equal(ctx.messageOutcome_([{status: 'confirmed'}, {status: 'ignored'}]), 'unchanged');
  assert.equal(ctx.messageOutcome_([{status: 'confirmed'}, {status: 'review'}]), 'review');
  assert.equal(ctx.messageOutcome_([{status: 'confirmed'}, {status: 'confirmed'}]), 'archive');
  assert.equal(ctx.messageOutcome_([]), 'empty');
});

test('normalized date claimed by AI does not independently establish expiry', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', expiry: '2026-09-30', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, expiry: {quote: 'next month', normalizedDate: '2026-09-30'}}};
  assert.throws(() => ctx.normalizeCandidate_(raw, {text: 'Shop SAVE20 next month', images: [], incomplete: false}), /AI/);
  raw.evidence.expiry = {quote: 'next month'};
  const candidate = ctx.normalizeCandidate_(raw, {text: 'Shop SAVE20 next month', images: [], incomplete: false});
  assert.equal(candidate.expiry, '');
  assert.equal(candidate.review, true);
  raw.expiry = '2026-02-30';
  assert.equal(ctx.normalizeCandidate_(raw, {text: 'Shop SAVE20', images: [], incomplete: false}).review, true);
});

test('owner identity is checked against both Gmail and the effective script user', () => {
  const {ctx, config} = harness();
  assert.doesNotThrow(() => ctx.assertOwner_(config));
  ctx.Gmail.Users.getProfile = () => ({emailAddress: 'different@example.com'});
  assert.throws(() => ctx.assertOwner_(config), /OWNER/);
  ctx.Gmail.Users.getProfile = () => ({emailAddress: config.ownerEmail});
  ctx.Session.getEffectiveUser = () => ({getEmail: () => 'different@example.com'});
  assert.throws(() => ctx.assertOwner_(config), /OWNER/);
});

test('lock is released on failure, and contention never runs the operation', () => {
  const {ctx} = harness();
  let released = 0;
  ctx.LockService.getScriptLock = () => ({tryLock: () => true, releaseLock: () => { released++; }});
  assert.throws(() => ctx.withLock_(() => { throw Error('operation failed'); }), /operation failed/);
  assert.equal(released, 1);
  ctx.LockService.getScriptLock = () => ({tryLock: () => false, releaseLock: () => { released++; }});
  assert.throws(() => ctx.withLock_(() => assert.fail('must not run')), /BUSY/);
  assert.equal(released, 1);
});

test('public example matches validated defaults and review labels use stable keys', () => {
  const {ctx, properties} = harness();
  const example = require('../config/example.json');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.validateConfig_(example))), example);
  assert.equal(ctx.config_().locale, 'en');
  assert.equal(ctx.t_('error', {code: 'WRITE'}), 'Processing failed (WRITE). Correct the cause and retry.');
  assert.throws(() => ctx.t_('not-translated'), /CONFIG/);
  assert.deepEqual(JSON.parse(require('node:vm').runInContext('JSON.stringify(EN.actions)', ctx)),
    {confirm: 'Confirm', ignore: 'Ignore', retry_ai: 'Retry with AI'});
  assert.ok(properties.MYCOUPONS_CONFIG);
});

test('archive eligibility rejects unknown and malformed candidate states', () => {
  const {ctx} = harness();
  for (const items of [null, {}, [null], [{}], new Array(1), [{status: 'confirmed'}, ,], [{status: 'error'}], [{status: 'confirmed'}, {status: 'pending'}]]) {
    assert.throws(() => ctx.messageOutcome_(items), /STATE/);
  }
});

test('evidence must preserve full code tokens, case, numeric magnitude and URL identity', () => {
  const {ctx} = harness();
  for (const [field, value, quote, source] of [
    ['code', 'SAVE2', 'SAVE20', 'SAVE20'], ['code', 'SAVE2', 'SAVE2', 'SAVE20'],
    ['code', 'save20', 'SAVE20', 'SAVE20'], ['code', 'save20', 'save20', 'SAVE20'],
    ['code', 'SAVE20', 'SAVE20-NEW', 'SAVE20-NEW'],
    ['code', 'SAVE20', 'SAVE20é', 'SAVE20é'], ['code', 'SAVE20', 'SAVE20\u0301', 'SAVE20\u0301'],
    ['code', 'SAVE20', 'SAVE20𐐀', 'SAVE20𐐀'],
    ['discountValue', '20', '200', '200'], ['discountValue', '20', '20', '200'],
    ['discountValue', '20', '20.5', '20.5'], ['discountValue', '5', '20,5', '20,5'],
    ['website', 'https://shop.com', 'https://shop.com/terms', 'https://shop.com/terms']
  ]) {
    const raw = {merchant: 'Shop', code: 'REALCODE', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'REALCODE'}}};
    raw[field] = value; raw.evidence[field] = {quote};
    const actual = ctx.normalizeCandidate_(raw, {text: 'Shop REALCODE ' + source, images: [], incomplete: false});
    assert.equal(actual[field], '', field + ': ' + value);
    assert.equal(actual.review, true);
  }
  assert.equal(ctx.fieldInQuote_('code', 'MiXeD20', 'Use MiXeD20 today'), true);
  assert.equal(ctx.fieldInQuote_('discountValue', '20%', 'Save 20% today'), true);
  const upperUrl = 'HTTPS://shop.com/voucher';
  const raw = {merchant: 'Shop', website: upperUrl, confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, website: {quote: upperUrl}}};
  const valid = ctx.normalizeCandidate_(raw, {text: 'Shop ' + upperUrl, images: [], incomplete: false});
  assert.equal(valid.website, upperUrl); assert.equal(valid.review, false);
  raw.website = 'HTTPS://shop.com/Voucher';
  assert.equal(ctx.normalizeCandidate_(raw, {text: 'Shop ' + upperUrl, images: [], incomplete: false}).website, '');
});

test('factual evidence requires well-formed Unicode boundaries', () => {
  const {ctx} = harness();
  for (const half of ['\ud83d', '\ude00']) {
    assert.equal(ctx.fieldInQuote_('merchant', half, '😀'), false);
    assert.equal(ctx.fieldInQuote_('website', half, 'https://shop.com/😀'), false);
    assert.throws(() => ctx.normalizeCandidate_(
      {merchant: half, code: 'SAVE20', confidence: 'high', review: false,
        evidence: {merchant: {quote: half}, code: {quote: 'SAVE20'}}},
      {text: '😀 SAVE20', images: [], incomplete: false}), /AI/);
    assert.throws(() => ctx.normalizeCandidate_(
      {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
        evidence: {merchant: {quote: half}, code: {quote: 'SAVE20'}}},
      {text: 'Shop SAVE20', images: [], incomplete: false}), /AI/);
  }
  const complete = ctx.normalizeCandidate_(
    {merchant: '😀', code: 'SAVE20', confidence: 'high', review: false,
      evidence: {merchant: {quote: '😀'}, code: {quote: 'SAVE20'}}},
    {text: '😀 SAVE20', images: [], incomplete: false});
  assert.equal(complete.review, false);
});

test('only canonical Gmail links provide an identity without partial token collisions', () => {
  const {ctx} = harness();
  const id = '18a9b0c7';
  assert.equal(ctx.sourceId_(ctx.gmailLink_(id)), id);
  for (const url of ['https://mail.google.com/mail/#all/' + id,
    'https://mail.google.com/mail/u/1/#inbox/' + id,
    'https://mail.google.com/mail/#search/coupon/' + id,
    'https://mail.google.com/mail/?th=' + id + '&view=pt']) assert.equal(ctx.sourceId_(url), id);
  for (const url of ['https://MAIL.GOOGLE.COM/mail/#all/' + id,
    'https://mail.google.com:443/mail/u/1/#inbox/' + id,
    'https://MAIL.GOOGLE.COM:443/mail/?th=' + id,
    'https://mail.google.com:0443/mail/#all/' + id,
    'https://MAIL.GOOGLE.COM:000443/mail/?th=' + id]) assert.equal(ctx.sourceId_(url), id);
  for (const url of ['https://other.example/mail/#all/' + id,
    'https://mail.google.com.evil.example/mail/#all/' + id,
    'https://mail.google.com:444/mail/#all/' + id,
    'https://mail.google.com:4430/mail/#all/' + id,
    'https://mail.google.com:04430/mail/#all/' + id,
    'https://mail.google.com:+443/mail/#all/' + id,
    'https://mail.google.com:0x1bb/mail/#all/' + id,
    'https://user@mail.google.com/mail/#all/' + id,
    'https://mail.google.com/Mail/#all/' + id,
    'https://mail.google.com/mail/#all/' + id + '-bad',
    'https://mail.google.com/mail/?permmsgid=msg-f:123456789',
    'https://mail.google.com/mail/?permmsgid=msg-f:987654321',
    'https://mail.google.com/mail/#search/receipt?th=deadbeef',
    'https://mail.google.com/mail/#garbage#all/deadbeef',
    'https://mail.google.com/mail/?th=deadbeef&th=face',
    'https://mail.google.com/mail/?th=' + id + ':bad',
    'https://mail.google.com/mail/#all/ABCD1234',
    'https://mail.google.com/mail/?th=ABCD1234']) assert.equal(ctx.sourceId_(url), '');
});

test('coupon introducers are case-insensitive and never truncate the code token', () => {
  const {ctx} = harness();
  for (const prefix of ['Coupon code', 'COUPON CODE', 'Use the code', 'Codice sconto']) {
    assert.equal(ctx.deterministicCandidates_({text: prefix + ': MiXeD20'})[0].code, 'MiXeD20');
  }
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + 'X'.repeat(41)}).length, 0);
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + 'X'.repeat(39) + '-LONG'}).length, 0);
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code SAVE20é'})[0].code, 'SAVE20é');
});

test('numeric-leading DNS names are distinct from numeric and hexadecimal IP forms', () => {
  const {ctx} = harness();
  for (const host of ['3ds.com', '123.shop.com', '0xservice.example.com']) {
    assert.equal(ctx.safeUrl_('https://' + host + '/offer'), 'https://' + host + '/offer');
  }
  for (const host of ['2130706433', '127.1', '0177.0.0.1', '0x7f.0.0.1', '0x7f000001', '[::1]']) {
    assert.equal(ctx.safeUrl_('https://' + host + '/offer'), '');
  }
});

test('recovery rejects impossible zoned dates and clock values', () => {
  const {ctx} = harness();
  for (const date of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-09-07T24:00:00Z',
    '2026-09-07T10:60:00Z', '2026-09-07T10:00:00+25:00', '2026-09-07T10:00:00+14:01',
    '2026-09-07T10:00:00-14:01', '2026-09-07T10:00:00-23:59', '2026-09-07T10:00:00']) {
    assert.throws(() => ctx.emailDate_(date, 'Europe/Rome'), /DATE/);
  }
  const value = '2026-09-07T10:30:00.123+02:00';
  assert.equal(ctx.emailDate_(value, 'Europe/Rome').getTime(), Date.parse(value));
  for (const offset of ['+14:00', '-14:00']) {
    const timestamp = '2026-09-07T10:30:00' + offset;
    assert.equal(ctx.emailDate_(timestamp, 'Europe/Rome').getTime(), Date.parse(timestamp));
  }
});

test('technical markers do not override legitimate merchant names during recovery', () => {
  const {ctx, config} = harness();
  const real = Array(26).fill('');
  Object.assign(real, {0: '2026-09-07', 1: 'Scan Computers', 3: 'SAVE20', 11: 'Your offer'});
  assert.equal(ctx.realCouponRow_(real), true);
  assert.equal(ctx.recoveryStart_([real], config), Date.parse('2026-09-06T22:00:00Z'));
  for (const marker of ['Scan', 'Scanned', 'Technical', 'No coupons', 'No offers']) {
    const scan = [...real]; scan[4] = marker;
    assert.equal(ctx.realCouponRow_(scan), false);
  }
});

test('losing bounded conditions or notes always requires review', () => {
  const {ctx} = harness();
  for (const field of ['exclusions', 'notes']) {
    const terms = 'x'.repeat(field === 'notes' ? 3500 : 1000) + '; excludes outlet';
    const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, [field]: {quote: terms}}, [field]: terms};
    const actual = ctx.normalizeCandidate_(raw, {text: 'Shop SAVE20 ' + terms, images: [], incomplete: false});
    assert.equal(actual.review, true);
  }
});

test('image discovery distinguishes src and dimensions from data attributes and quoted values', () => {
  const {ctx} = harness();
  for (const html of [
    '<img data-src="https://shop.com/pixel.gif" src="https://shop.com/coupon.jpg">',
    '<img data-width="1" width="600" src="https://shop.com/coupon.jpg">',
    '<img alt="data src=wrong > text" src=https://shop.com/coupon.jpg>',
    '<img title=" width=1 " src="https://shop.com/coupon.jpg">'
  ]) assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/coupon.jpg']);
  assert.deepEqual([...ctx.remoteImageUrls_('<img width=" 1 " src="https://shop.com/coupon.jpg">')], []);
});

test('invalid persisted configuration and inherited error names retain stable error classes', () => {
  const {ctx, properties} = harness();
  for (const raw of ['{broken', 'null', '[]']) {
    properties.MYCOUPONS_CONFIG = raw;
    assert.throws(() => ctx.config_(), e => ctx.errorCode_(e) === 'CONFIG');
  }
  for (const code of ['toString', '__proto__', 'constructor', 'UNKNOWN']) {
    assert.equal(ctx.errorCode_({code}), 'INTERNAL');
  }
});

test('deterministic codes consume the complete lexeme before rejecting punctuation', () => {
  const {ctx} = harness();
  for (const code of ['SAVE+20', 'SAVE.20', 'SAVE/20', 'SAVE:20', 'SAVE@20', 'SAVE&20',
    '+SAVE20', '(SAVE20)', 'SAVE20.', 'SAVE20,']) {
    assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + code}).length, 0, code);
  }
  for (const code of ['SAVE_20', 'SAVE-20', 'MiXeD20', 'SAVE20é', 'SAVE20\u0301', 'SAVE20𐐀']) {
    for (const wrapped of [code, '"' + code + '"', "'" + code + "'", '<' + code + '>']) {
      const text = 'Coupon code ' + wrapped;
      const candidates = ctx.deterministicCandidates_({text});
      assert.equal(candidates[0].code, code);
      assert.equal(candidates[0].notes, text);
      assert.equal(candidates[0].review, true);
    }
  }
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code MiXeD20; Coupon code MiXeD20'}).length, 1);
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code MiXeD20 Coupon code MiXeD20'}).length, 1);
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + 'X'.repeat(41)}).length, 0);
});

test('code evidence cannot use a prefix, suffix or interior of punctuation-bearing lexemes', () => {
  const {ctx} = harness();
  function normalize(code, quote, source) {
    return ctx.normalizeCandidate_({merchant: 'Shop', code, confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote}}},
    {text: 'Shop ' + source, images: [], incomplete: false});
  }
  for (const token of ['SAVE+20', 'SAVE.20', 'SAVE/20', 'SAVE:20', 'SAVE@20', 'SAVE&20', '+SAVE20']) {
    for (const part of [token.slice(0, 4), token.slice(-2), token.slice(1, 4)]) {
      for (const [quote, source] of [[token, token], [part, token], [token, part]]) {
        const actual = normalize(part, quote, source);
        assert.equal(actual.code, '', token + ': ' + part);
        assert.equal(actual.review, true);
      }
    }
    const whole = normalize(token, token, token);
    assert.equal(whole.code, token);
    assert.equal(whole.review, false);
  }
  for (const wrapped of ['"SAVE+20"', "'SAVE+20'", '<SAVE+20>']) {
    assert.equal(normalize('SAVE+20', 'SAVE+20', wrapped).review, false);
  }
  assert.equal(normalize('SAVE20', 'SAVE20', '(SAVE20)').code, '');
  assert.equal(normalize('SAVE20', 'SAVE20', 'SAVE20.').code, '');
});

test('notes require text or image provenance even when other fields are grounded', () => {
  const {ctx} = harness();
  function normalize(notes, evidence, text = 'Shop SAVE20 Valid on outlet', images = []) {
    return ctx.normalizeCandidate_({merchant: 'Shop', code: 'SAVE20', notes,
      confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, notes: evidence}},
    {text, images, incomplete: false});
  }
  for (const evidence of [undefined, {quote: 'Works forever'}, {quote: 'Shop SAVE20'}]) {
    const result = normalize('Works forever', evidence);
    assert.equal(result.notes, ''); assert.equal(result.review, true);
  }
  for (const evidence of [{image: -1}, {image: 0}]) {
    assert.throws(() => normalize('Works forever', evidence), /AI/);
  }
  const grounded = normalize('Valid on outlet', {quote: 'Valid on outlet'});
  assert.equal(grounded.notes, 'Valid on outlet'); assert.equal(grounded.review, false);
  const empty = normalize('', undefined);
  assert.equal(empty.notes, ''); assert.equal(empty.review, false);
  const image = normalize('Image conditions', {image: 0}, 'Shop SAVE20', [{}]);
  assert.equal(image.notes, 'Image conditions'); assert.equal(image.review, true);
  const terms = 'terms '.repeat(590).trim();
  for (const [evidence, text, images] of [[{quote: terms}, 'Shop SAVE20 ' + terms, []],
    [{image: 0}, 'Shop SAVE20', [{}]], [undefined, 'Shop SAVE20', []]]) {
    const result = normalize(terms, evidence, text, images);
    assert.equal(result.review, true);
    assert.ok(result.notes.length <= 3500);
    if (!evidence) assert.equal(result.notes, '');
  }
  const text = 'Coupon code SAVE20 ' + terms;
  const copied = ctx.deterministicCandidates_({text})[0];
  assert.equal(copied.notes, text.slice(0, 3500)); assert.equal(copied.review, true);
});

test('oversized structured fields are cleared rather than changed into prefixes', () => {
  const {ctx} = harness();
  const fields = JSON.parse(require('node:vm').runInContext('JSON.stringify(MC.fields)', ctx));
  for (const field of fields.filter(k => k !== 'notes')) {
    for (const size of [1000, 1001]) {
      const value = field === 'website' ? 'https://shop.com/' + 'x'.repeat(size - 17) : 'X'.repeat(size);
      for (const evidence of [undefined, {quote: value}, {image: 0}]) {
        const actual = ctx.normalizeCandidate_({[field]: value, evidence: {[field]: evidence}},
          {text: value, images: [{}], incomplete: false});
        const retained = size === 1000 && evidence && field !== 'expiry';
        assert.equal(actual[field], retained ? value : '', field + ': ' + size);
        assert.equal(actual.review, true);
      }
    }
  }
  for (const field of ['code', 'merchant']) {
    const value = 'X'.repeat(999) + '𐐀';
    const actual = ctx.normalizeCandidate_({[field]: value, evidence: {[field]: {image: 0}}},
      {text: '', images: [{}], incomplete: false});
    assert.equal(actual[field], '');
  }
});

test('deterministic code bounds count Unicode code points without altering spelling', () => {
  const {ctx} = harness();
  for (const letter of ['A', 'é', '𐐀']) {
    for (const count of [2, 3, 21, 40, 41]) {
      const code = letter.repeat(count);
      const actual = ctx.deterministicCandidates_({text: 'Coupon code ' + code});
      assert.deepEqual(Array.from(actual, c => c.code), count >= 3 && count <= 40 ? [code] : []);
    }
  }
  const code = 'A𐐀\u0301';
  assert.deepEqual(Array.from(ctx.deterministicCandidates_({text: 'Coupon code ' + code + ' Coupon code ' + code}), c => c.code), [code]);
});

test('HTML extraction excludes hidden lexical contexts without losing following visible text', () => {
  const {ctx} = harness();
  const hidden = 'Shop Coupon code HIDDEN';
  const visible = '<p>Visible &amp; Coupon code REAL20</p>';
  const cases = [];
  for (const tag of ['script', 'style']) {
    for (const close of ['</' + tag + ' >', '</' + tag.toUpperCase() + '\n>', '</' + tag + '/>']) {
      cases.push(['<' + tag + '>' + hidden + close + visible, 'Visible & Coupon code REAL20']);
    }
    cases.push([visible + '<' + tag + '>' + hidden, 'Visible & Coupon code REAL20']);
    cases.push(['<' + tag + '>"<!--";' + hidden + '</' + tag + '>' + visible, 'Visible & Coupon code REAL20']);
    cases.push(['Visible 1 < 2 <' + tag + '>' + hidden + '</' + tag + '>', 'Visible 1 < 2']);
  }
  cases.push(['<!-- <b>' + hidden + '</b> <script> -->' + visible, 'Visible & Coupon code REAL20'],
    [visible + '<!-- > <script>' + hidden, 'Visible & Coupon code REAL20'],
    ['<p title="> ' + hidden + '">Visible</p>', 'Visible'],
    ['<script-name>Keep</script-name><script>hidden</script>', 'Keep'],
    ['<style-name>Keep</style-name><style>hidden</style>', 'Keep'],
    ['&lt;script&gt;Visible&lt;/script&gt;', '<script>Visible</script>']);
  for (const [html, expected] of cases) {
    const text = ctx.htmlText_(html);
    assert.equal(text.trim().replace(/\s+/g, ' '), expected, html);
    assert.ok(!ctx.deterministicCandidates_({text}).some(c => c.code === 'HIDDEN'));
    const actual = ctx.normalizeCandidate_({merchant: 'Shop', code: 'HIDDEN', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN'}}}, {text, images: [], incomplete: false});
    assert.equal(actual.code, ''); assert.equal(actual.review, true);
  }
});

test('only explicit boolean completeness can allow automatic confirmation', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  for (const state of [undefined, null, 0, '', 'false', [], {}, true, false]) {
    const message = {text: 'Shop SAVE20', images: []};
    if (state !== undefined) message.incomplete = state;
    assert.equal(ctx.normalizeCandidate_(raw, message).review, state !== false);
  }
});

test('website prose delimiters cannot shorten path or query identities', () => {
  const {ctx} = harness();
  function normalize(value, quote, source) {
    return ctx.normalizeCandidate_({merchant: 'Shop', website: value, confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, website: {quote}}},
    {text: 'Shop ' + source, images: [], incomplete: false});
  }
  const url = 'https://shop.com';
  for (const source of ['Visit ' + url + '.', '(' + url + ')', url + ', next', '[' + url + ']', url + '!']) {
    for (const quote of [url, source]) {
      const actual = normalize(url, quote, source);
      assert.equal(actual.website, url); assert.equal(actual.review, false);
    }
  }
  for (const token of [url + '/path.', url + '/path,', url + '/item_(v1)', url + '/path)',
    url + '/?token=secret.', url + '/?token=secret,', url + '/#section.', url + '?']) {
    assert.equal(normalize(token, token, token).website, token);
    const shortened = token.slice(0, -1);
    for (const quote of [shortened, token]) {
      const actual = normalize(shortened, quote, token);
      assert.equal(actual.website, ''); assert.equal(actual.review, true);
    }
  }
  assert.equal(normalize(url, url, url + '.evil.com').website, '');
  assert.equal(normalize(url, url, url + '/terms').website, '');
  assert.equal(normalize(url + '/path', url + '/path', '"' + url + '/path".').website, url + '/path');
});

test('bounded text never creates half a surrogate pair in notes or cells', () => {
  const {ctx} = harness();
  for (const limit of [3500, 4000]) {
    const text = 'X'.repeat(limit - 1) + '𐐀tail';
    if (limit === 4000) assert.equal(ctx.textCell_(text), 'X'.repeat(limit - 1));
    else {
      const actual = ctx.normalizeCandidate_({notes: text, evidence: {notes: {image: 0}}},
        {text: '', images: [{}], incomplete: false});
      assert.equal(actual.notes, 'X'.repeat(limit - 1)); assert.equal(actual.review, true);
      const intro = 'Coupon code SAVE20 ';
      const source = intro + 'X'.repeat(limit - 1 - intro.length) + '𐐀tail';
      assert.equal(ctx.deterministicCandidates_({text: source})[0].notes, source.slice(0, limit - 1));
    }
  }
  assert.equal(ctx.textCell_('X'.repeat(3998) + '𐐀tail'), 'X'.repeat(3998) + '𐐀');
  const notes = 'X'.repeat(3499) + ' end';
  const actual = ctx.normalizeCandidate_({notes, evidence: {notes: {quote: notes}}},
    {text: notes, images: [], incomplete: false});
  assert.equal(actual.notes, notes.slice(0, 3500)); assert.equal(actual.review, true);
});

test('image discovery shares rawtext and comment exclusion with text extraction', () => {
  const {ctx} = harness();
  const hidden = '<img src="https://shop.com/hidden.jpg">';
  const real = '<img src="https://shop.com/real.jpg">';
  for (const html of ['<!-- > ' + hidden + ' -->' + real,
    '<script>' + hidden + '</script >' + real, '<style>' + hidden + '</style\n>' + real,
    real + '<script>' + hidden, real + '<!-- ' + hidden,
    '<div title=\'' + hidden + '\'>Visible</div>' + real,
    '<script>"<!--";' + hidden + '</script>' + real,
    '<!-- <script>' + hidden + ' -->' + real,
    'Visible 1 < 2 <script>' + hidden + '</script>' + real,
    '<img-other src="https://shop.com/hidden.jpg">' + real]) {
    assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/real.jpg'], html);
  }
});

test('standard named references feed rendered Unicode codes into extraction and evidence', () => {
  const {ctx} = harness();
  for (const [encoded, code] of [['CAF&Eacute;20', 'CAFÉ20'], ['SAVE&Omega;20', 'SAVEΩ20'],
    ['SAVE&Afr;20', 'SAVE𝔄20'], ['SAVE&fjlig;20', 'SAVEfj20']]) {
    const text = ctx.htmlText_('<p>Shop Coupon code ' + encoded + '</p>');
    assert.equal(ctx.deterministicCandidates_({text})[0].code, code);
    const actual = ctx.normalizeCandidate_({merchant: 'Shop', code, confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: code}}}, {text, images: [], incomplete: false});
    assert.equal(actual.code, code); assert.equal(actual.review, false);
  }
  for (const [encoded, expected] of [['&NotEqualTilde;', '\u2242\u0338'], ['&notin;', '∉'],
    ['&notit;', '¬it;'], ['&Eacute;&eacute;', 'Éé'], ['&EACUTE;&unknown;', '&EACUTE;&unknown;'],
    ['&nbsp;', '\u00a0']]) assert.equal(ctx.htmlText_(encoded), expected);
});

test('numeric and nested references decode once using HTML scalar rules', () => {
  const {ctx} = harness();
  for (const [encoded, expected] of [['&#65;&#x41;&#65', 'AAA'], ['&#128;', '€'],
    ['&#0;&#xD800;&#1114112;', '\ufffd\ufffd\ufffd'], ['&#x1D504;', '𝔄'],
    ['&amp;Eacute;', '&Eacute;'], ['&#38;Eacute;', '&Eacute;'], ['&#x26;amp;', '&amp;'],
    ['&amp;#65;', '&#65;'], ['&#38;#65;', '&#65;'],
    ['&lt;script&gt;Visible&lt;/script&gt;', '<script>Visible</script>']]) {
    assert.equal(ctx.htmlText_(encoded), expected, encoded);
  }
});

test('attribute reference context preserves query identity and decoded URL controls', () => {
  const {ctx} = harness();
  for (const [attribute, expected] of [
    ['https&colon;&sol;&sol;shop.com&sol;promo.jpg', 'https://shop.com/promo.jpg'],
    ['https://shop.com/promo?x=1&amp;y=2', 'https://shop.com/promo?x=1&y=2'],
    ['https://shop.com/promo?x=1&copy=2&notit=3', 'https://shop.com/promo?x=1&copy=2&notit=3'],
    ['https://shop.com/promo?x=1&copyx', 'https://shop.com/promo?x=1&copyx'],
    ['https://shop.com/promo?x=1&#38;y=2', 'https://shop.com/promo?x=1&y=2'],
    ['https://shop.com/promo?x=1&amp;amp;y=2', 'https://shop.com/promo?x=1&amp;y=2']
  ]) assert.deepEqual([...ctx.remoteImageUrls_('<img src="' + attribute + '">')], [expected]);
  assert.equal(ctx.htmlText_('&copy=2 &copyx'), '©=2 ©x');
  for (const attribute of ['https://shop.com/&Tab;promo', 'https://shop.com&sol;pixel.gif']) {
    assert.deepEqual([...ctx.remoteImageUrls_('<img src="' + attribute + '">')], []);
  }
});

test('references separated by lexical markup are never manufactured after concatenation', () => {
  const {ctx} = harness();
  for (const separator of ['<!-- hidden -->', '<script>hidden</script>', '<style>hidden</style>']) {
    for (const [start, end, displayed] of [['CAF&Eac', 'ute;20', 'CAF&Eacute;20'],
      ['CAF&#20', '1;20', 'CAF\u00141;20']]) {
      const text = ctx.htmlText_('Shop Coupon code ' + start + separator + end);
      assert.equal(text, 'Shop Coupon code ' + displayed);
      assert.ok(!ctx.deterministicCandidates_({text}).some(c => c.code === 'CAFÉ20'));
      const actual = ctx.normalizeCandidate_({merchant: 'Shop', code: 'CAFÉ20', confidence: 'high', review: false,
        evidence: {merchant: {quote: 'Shop'}, code: {quote: 'CAFÉ20'}}}, {text, images: [], incomplete: false});
      assert.equal(actual.code, ''); assert.equal(actual.review, true);
    }
  }
  assert.equal(ctx.htmlText_('CAF&Eacute;20'), 'CAFÉ20');
});

test('the actual vendored parser loads before or after Core without Node or DOM globals', () => {
  for (const vendorLast of [false, true]) {
    const {ctx} = harness({vendorLast});
    for (const name of ['require', 'module', 'exports', 'window', 'document', 'fetch']) assert.equal(ctx[name], undefined);
    assert.equal(typeof ctx.MC_HTML.parse, 'function');
    assert.equal(ctx.htmlText_('CAF&Eacute;20'), 'CAFÉ20');
    assert.deepEqual([...ctx.remoteImageUrls_('<img src="https://shop.com/promo?x=1&copy=2">')],
      ['https://shop.com/promo?x=1&copy=2']);
  }
});

test('HTML parser EOF states never promote unfinished tag or attribute content', () => {
  const {ctx} = harness();
  const visible = 'Shop Coupon code REAL20 ';
  for (const tail of ['<img', '<img alt', '<img alt=', '<img alt="Coupon code HIDDEN"',
    "<img alt='Coupon code HIDDEN", '<img alt=Coupon code HIDDEN', '<script alt="Coupon code HIDDEN"',
    '<!bogus Coupon code HIDDEN', '<?bogus Coupon code HIDDEN']) {
    const html = visible + tail;
    const text = ctx.htmlText_(html);
    assert.equal(text, visible, tail);
    assert.deepEqual(Array.from(ctx.deterministicCandidates_({text}), c => c.code), ['REAL20']);
    const actual = ctx.normalizeCandidate_({merchant: 'Shop', code: 'HIDDEN', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN'}}}, {text, images: [], incomplete: false});
    assert.equal(actual.code, ''); assert.equal(actual.review, true);
    assert.deepEqual([...ctx.remoteImageUrls_(html)], []);
  }
});

test('HTML content contexts distinguish inert markup from text and real image nodes', () => {
  const {ctx} = harness();
  const image = '<img src="https://shop.com/hidden.jpg">';
  const real = '<img src="https://shop.com/real.jpg">';
  for (const tag of ['script', 'style', 'template', 'title', 'iframe', 'noembed', 'noframes']) {
    const html = '<' + tag + '>Coupon code HIDDEN' + image + '</' + tag + '>Visible' + real;
    assert.equal(ctx.htmlText_(html), 'Visible', tag);
    assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/real.jpg'], tag);
  }
  for (const tag of ['xmp', 'plaintext']) {
    const html = '<' + tag + '>' + image + 'Coupon code TEXT';
    assert.ok(ctx.htmlText_(html).includes(image + 'Coupon code TEXT'));
    assert.deepEqual([...ctx.remoteImageUrls_(html)], []);
  }
  const textarea = '<textarea>' + image + 'Coupon code TEXT';
  assert.equal(ctx.htmlText_(textarea), '');
  assert.equal(ctx.htmlContent_(textarea).incomplete, true);
  assert.deepEqual([...ctx.remoteImageUrls_(textarea)], []);
  assert.equal(ctx.htmlText_('<noscript>Fallback</noscript>'), 'Fallback');
  assert.deepEqual([...ctx.remoteImageUrls_('<noscript>' + real + '</noscript>')], ['https://shop.com/real.jpg']);
  for (const prefix of ['<!-->', '<!--->', '<!bogus>', '<?bogus>']) {
    assert.equal(ctx.htmlText_(prefix + 'Visible'), 'Visible', prefix);
    assert.deepEqual([...ctx.remoteImageUrls_(prefix + real)], ['https://shop.com/real.jpg']);
  }
  assert.deepEqual([...ctx.remoteImageUrls_('<svg><image href="https://shop.com/hidden.jpg"/></svg>' + real)],
    ['https://shop.com/real.jpg']);
  assert.deepEqual([...ctx.remoteImageUrls_('<img src="https://shop.com/real.jpg" src="https://shop.com/hidden.jpg">')],
    ['https://shop.com/real.jpg']);
});

test('HTML inline identity and block boundaries survive iterative deeply nested traversal', () => {
  const {ctx} = harness();
  const text = ctx.htmlText_('Coupon code SAVE<b>20</b><p>Conditions</p>After<br>End');
  assert.equal(text, 'Coupon code SAVE20\nConditions\nAfter\nEnd');
  assert.equal(ctx.deterministicCandidates_({text})[0].code, 'SAVE20');
  const html = '<div>'.repeat(3000) + 'Visible' + '<img src="https://shop.com/real.jpg">' + '</div>'.repeat(3000);
  assert.equal(ctx.htmlText_(html).trim(), 'Visible');
  assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/real.jpg']);
});

test('rendered images split text and factual evidence spans', () => {
  const {ctx} = harness();
  const split = 'Shop Coupon code SAVE<img src="https://shop.com/divider.png">20';
  const content = ctx.htmlContent_(split);
  assert.equal(content.text, 'Shop Coupon code SAVE\n20');
  assert.deepEqual(Array.from(content.evidenceSpans), ['Shop Coupon code SAVE', '20']);
  assert.ok(!ctx.deterministicCandidates_({html: split}).some(function (candidate) { return candidate.code === 'SAVE20'; }));
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  const candidate = ctx.normalizeCandidate_(raw, {html: split, images: [], incomplete: false});
  assert.equal(candidate.code, ''); assert.equal(candidate.review, true);
  const compatible = 'Shop Coupon code SAVE20<img src="https://shop.com/offer.jpg">Terms';
  assert.ok(ctx.deterministicCandidates_({html: compatible}).some(function (item) { return item.code === 'SAVE20'; }));
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(compatible)), ['https://shop.com/offer.jpg']);
});

test('suppressed inline markup splits text and factual evidence spans', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  for (const [markup, incomplete, spans] of [['<span hidden>x</span>', false], ['<span hidden><i>x</i></span>', false],
    ['<template>x</template>', false], ['<select><option>x</option></select>', true], ['<canvas>x</canvas>', true],
    ['<svg><text>x</text></svg>', true], ['<dialog>x</dialog>', false], ['<span popover>x</span>', false],
    ['<details><summary>x</summary>later</details>', false, ['Shop Coupon code SAVE', 'x', '20']]]) {
    const html = 'Shop Coupon code SAVE' + markup + '20';
    const content = ctx.htmlContent_(html);
    assert.deepEqual(Array.from(content.evidenceSpans), spans || ['Shop Coupon code SAVE', '20'], markup);
    assert.equal(content.incomplete, incomplete, markup);
    assert.ok(!ctx.deterministicCandidates_({html}).some(function (candidate) { return candidate.code === 'SAVE20'; }), markup);
    const candidate = ctx.normalizeCandidate_(raw, {html, images: [], incomplete: false});
    assert.equal(candidate.code, '', markup); assert.equal(candidate.review, true, markup);
  }
});

test('unmodeled rendered fallback and sourceless image alternatives preserve source coverage', () => {
  const {ctx} = harness();
  for (const tag of ['audio', 'canvas', 'meter', 'object', 'progress', 'textarea', 'video']) {
    const html = '<' + tag + '>Shop Coupon code HIDDEN20<img src="https://shop.com/hidden.jpg"></' + tag + '><p>Shop Coupon code REAL20</p>';
    const content = ctx.htmlContent_(html);
    assert.equal(content.incomplete, true, tag); assert.ok(!content.text.includes('HIDDEN20'), tag);
    assert.ok(!content.evidenceSpans.some(function (span) { return span.includes('HIDDEN20'); }), tag);
    assert.deepEqual(Array.from(ctx.remoteImageUrls_(html)), [], tag);
    const hidden = ctx.normalizeCandidate_({merchant: 'Shop', code: 'HIDDEN20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN20'}}}, {html, images: [], incomplete: false});
    assert.equal(hidden.code, '', tag); assert.equal(hidden.review, true, tag);
    const visible = ctx.normalizeCandidate_({merchant: 'Shop', code: 'REAL20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'REAL20'}}}, {html, images: [], incomplete: false});
    assert.equal(visible.code, 'REAL20', tag); assert.equal(visible.review, true, tag);
    assert.ok(!ctx.deterministicCandidates_({html: 'Coupon code SAVE<' + tag + '>fallback</' + tag + '>20'}).some(function (item) { return item.code === 'SAVE20'; }), tag);
    for (const suppressed of ['<template><' + tag + '>HIDDEN</' + tag + '></template><p>Shop REAL20</p>',
      '<div hidden><' + tag + '>HIDDEN</' + tag + '></div><p>Shop REAL20</p>', '<dialog><' + tag + '>HIDDEN</' + tag + '></dialog><p>Shop REAL20</p>',
      '<div popover><' + tag + '>HIDDEN</' + tag + '></div><p>Shop REAL20</p>',
      '<details><summary>Shop</summary><' + tag + '>HIDDEN</' + tag + '></details><p>REAL20</p>']) {
      assert.equal(ctx.htmlContent_(suppressed).incomplete, false, suppressed);
    }
  }
  for (const image of ['<img alt="Coupon code ALT20">', '<img src="" alt="Coupon code ALT20">',
    '<img src=" \t" alt="Coupon code ALT20">', '<img data-src="https://shop.com/offer.jpg" alt="Coupon code ALT20">']) {
    const html = '<p>Shop</p>' + image;
    const content = ctx.htmlContent_(html);
    assert.ok(content.text.includes('ALT20'), image); assert.ok(content.evidenceSpans.some(function (span) { return span.includes('ALT20'); }), image);
    assert.deepEqual(Array.from(ctx.remoteImageUrls_(html)), [], image);
    assert.equal(ctx.normalizeCandidate_({merchant: 'Shop', code: 'ALT20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'ALT20'}}}, {html, images: [], incomplete: false}).review, false, image);
  }
  const realImage = '<p>Shop</p><img src="https://shop.com/offer.jpg" alt="Coupon code ALT20">';
  assert.ok(!ctx.htmlText_(realImage).includes('ALT20'));
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(realImage)), ['https://shop.com/offer.jpg']);
  assert.ok(!ctx.deterministicCandidates_({html: 'Coupon code SAVE<img alt="20">'}).some(function (item) { return item.code === 'SAVE20'; }));
  assert.ok(!ctx.deterministicCandidates_({html: 'Coupon code SAVE<img alt="X">20'}).some(function (item) { return item.code === 'SAVE20'; }));
});

test('factual fields bind to the same source occurrence as their quote', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Art', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Art Shop'}, code: {quote: 'SAVE20'}}};
  const split = 'Cart Shop code SAVE20 today. Visit Art exhibition.';
  const rejected = ctx.normalizeCandidate_(raw, {text: split, images: [], incomplete: false});
  assert.equal(rejected.merchant, ''); assert.equal(rejected.code, 'SAVE20'); assert.equal(rejected.review, true);
  const accepted = ctx.normalizeCandidate_(raw, {text: split + ' Art Shop announces a sale.', images: [], incomplete: false});
  assert.equal(accepted.merchant, 'Art'); assert.equal(accepted.review, false);
  const whitespace = ctx.normalizeCandidate_({merchant: 'Shop Outlet', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'SHOP   OUTLET'}, code: {quote: 'SAVE20'}}},
  {text: 'Shop Outlet coupon code SAVE20', images: [], incomplete: false});
  assert.equal(whitespace.review, false);
});

test('quote occurrence binding scans disjoint evidence intervals linearly', () => {
  const {ctx} = harness();
  const source = 'a b '.repeat(20000);
  const started = Date.now();
  assert.equal(ctx.textEvidenceGrounded_('merchant', 'b', 'a', source), false);
  assert.ok(Date.now() - started < 1000);
});

test('numeric quote occurrence binding bounds range context linearly', () => {
  const {ctx} = harness();
  const source = '20% off x '.repeat(20000);
  const started = Date.now();
  assert.equal(ctx.textEvidenceGrounded_('discountValue', '20', '20%', source), true);
  assert.ok(Date.now() - started < 1000);
});

test('remaining rendered blocks and non-rendered controls preserve evidence boundaries', () => {
  const {ctx} = harness();
  const blocks = [
    '<table><caption>20</caption></table>', '<center>20</center>', '<dir><li>20</li></dir>',
    '<hgroup>20</hgroup>', '<fieldset><legend>20</legend></fieldset>', '<listing>20</listing>',
    '<menu><li>20</li></menu>', '<search>20</search>', '<xmp>20</xmp>', '<plaintext>20'
  ];
  for (const suffix of blocks) {
    const text = ctx.htmlText_('<span>Coupon code SAVE</span>' + suffix);
    assert.ok(!text.includes('SAVE20'), suffix);
    assert.ok(!ctx.deterministicCandidates_({text}).some(function (candidate) { return candidate.code === 'SAVE20'; }), suffix);
  }
  const raw = {merchant: 'Shop Outlet', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop Outlet'}, code: {quote: 'SAVE20'}}};
  const candidate = ctx.normalizeCandidate_(raw,
    {html: '<fieldset><legend>Shop</legend><legend>Outlet</legend><p>SAVE20</p></fieldset>', images: [], incomplete: false});
  assert.equal(candidate.merchant, ''); assert.equal(candidate.code, 'SAVE20'); assert.equal(candidate.review, true);
  const hidden = '<datalist><option>Shop Coupon code HIDDEN20<img src="https://shop.com/hidden.jpg"></option></datalist>' +
    '<ruby>Visible<rp> Coupon code RUBY20</rp></ruby><p>Shop Coupon code REAL20<img src="https://shop.com/real.jpg"></p>';
  assert.equal(ctx.htmlContent_(hidden).incomplete, false);
  assert.ok(!ctx.htmlText_(hidden).includes('HIDDEN20')); assert.ok(!ctx.htmlText_(hidden).includes('RUBY20'));
  assert.deepEqual([...ctx.remoteImageUrls_(hidden)], ['https://shop.com/real.jpg']);
  const hiddenCandidate = ctx.normalizeCandidate_(
    {merchant: 'Shop', code: 'HIDDEN20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN20'}}},
    {html: hidden, images: [], incomplete: false});
  assert.equal(hiddenCandidate.code, ''); assert.equal(hiddenCandidate.review, true);
  const select = '<select><option>Shop Coupon code SELECT20</option></select><p>Shop Coupon code REAL20</p>';
  assert.equal(ctx.htmlContent_(select).incomplete, true); assert.ok(!ctx.htmlText_(select).includes('SELECT20'));
  for (const type of ['button', '', 'submit', 'reset', 'image']) {
    const input = '<p>Shop Coupon code REAL20</p><input' + (type ? ' type="' + type + '"' : '') + ' value="SAVE30">';
    const result = ctx.htmlContent_(input);
    assert.equal(result.incomplete, true, type || 'default'); assert.ok(!result.text.includes('SAVE30'), type || 'default');
    assert.equal(ctx.normalizeCandidate_({merchant: 'Shop', code: 'REAL20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'REAL20'}}}, {html: input, images: [], incomplete: false}).review, true);
  }
  for (const html of [
    '<input type="hidden" value="SAVE30"><p>Shop REAL20</p>',
    '<input type="HIDDEN" value="SAVE30"><p>Shop REAL20</p>',
    '<template><input value="SAVE30"></template><p>Shop REAL20</p>',
    '<div hidden><input value="SAVE30"></div><p>Shop REAL20</p>',
    '<dialog><input value="SAVE30"></dialog><p>Shop REAL20</p>',
    '<div popover><input value="SAVE30"></div><p>Shop REAL20</p>',
    '<details><summary>Shop</summary><input value="SAVE30"></details><p>REAL20</p>',
    '<datalist><input value="SAVE30"></datalist><p>Shop REAL20</p>'
  ]) assert.equal(ctx.htmlContent_(html).incomplete, false, html);
  for (const html of [
    '<template><select><option>SELECT20</option></select></template><p>Shop REAL20</p>',
    '<div hidden><select><option>SELECT20</option></select></div><p>Shop REAL20</p>',
    '<dialog><select><option>SELECT20</option></select></dialog><p>Shop REAL20</p>',
    '<details><summary>Shop</summary><select><option>SELECT20</option></select></details><p>REAL20</p>',
    '<datalist><select><option>SELECT20</option></select></datalist><p>Shop REAL20</p>'
  ]) assert.equal(ctx.htmlContent_(html).incomplete, false, html);
  assert.equal(ctx.htmlContent_('<datalist><svg><text>Hidden</text></svg></datalist>').incomplete, true);
  for (const attribute of ['popover', 'popover=""', 'popover="auto"', 'popover="manual"', 'popover="hint"', 'popover="invalid"']) {
    const popover = '<div ' + attribute + '>Shop Coupon code HIDDEN20<img src="https://shop.com/hidden.jpg"></div>' +
      '<p>Shop Coupon code REAL20<img src="https://shop.com/real.jpg"></p>';
    assert.ok(!ctx.htmlText_(popover).includes('HIDDEN20'), attribute);
    assert.deepEqual([...ctx.remoteImageUrls_(popover)], ['https://shop.com/real.jpg'], attribute);
    assert.equal(ctx.normalizeCandidate_(
      {merchant: 'Shop', code: 'HIDDEN20', confidence: 'high', review: false,
        evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN20'}}},
      {html: popover, images: [], incomplete: false}).code, '', attribute);
  }
  assert.ok(ctx.htmlText_('<div data-popover>Shop Coupon code VISIBLE20</div>').includes('VISIBLE20'));
  assert.equal(ctx.htmlContent_('<div popover><picture><img src="https://shop.com/hidden.jpg"></picture></div>').incomplete, false);
  assert.equal(ctx.htmlContent_('<div popover><svg><text>Hidden</text></svg></div>').incomplete, true);
});

test('image dimensions use HTML length parsing without treating responsive percentages as pixels', () => {
  const {ctx} = harness();
  const url = 'https://shop.com/promo.jpg';
  const small = ['0', '01', '0002', '1.0', '0.5', '1px', '1junk', ' 1 ', '\t01\n', '1 %', '1. %', '&#48;1', '1e3%'];
  const preserve = ['1%', '0.5%', '1.%', '+1', '-1', '.5', '', 'unknown', '2.1', '003', '100%', '\u00a01'];
  for (const attr of ['width', 'height']) {
    for (const dimension of [...small, ...preserve]) {
      const html = '<img ' + attr + '="' + dimension + '" src="' + url + '">';
      assert.deepEqual([...ctx.remoteImageUrls_(html)], small.includes(dimension) ? [] : [url], attr + '=' + dimension);
    }
  }
});

test('only the actual HTML hidden attribute excludes a complete subtree', () => {
  const {ctx} = harness();
  const hidden = 'Coupon code HIDDEN<img src="https://shop.com/hidden.jpg">';
  const real = 'Visible<img src="https://shop.com/real.jpg">';
  for (const attribute of ['hidden', 'hidden=""', 'hidden="false"', 'hidden="until-found"']) {
    const html = '<div ' + attribute + '><span>' + hidden + '</span></div>' + real;
    assert.equal(ctx.htmlText_(html), 'Visible');
    assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/real.jpg']);
  }
  for (const attribute of ['', 'data-hidden="true"']) {
    assert.ok(ctx.htmlText_('<div ' + attribute + '>' + hidden + '</div>').includes('HIDDEN'));
    assert.deepEqual([...ctx.remoteImageUrls_('<div ' + attribute + '>' + hidden + '</div>')],
      ['https://shop.com/hidden.jpg']);
  }
  assert.equal(ctx.htmlText_('<svg><text hidden>Foreign visible</text></svg>'), '');
});

test('document wrapper attributes remain authoritative for text and images', () => {
  const {ctx} = harness();
  const offer = 'Shop Coupon code SAVE20<img src="https://shop.com/offer.jpg">';
  for (const doctype of ['', '<!doctype html>']) {
    for (const tag of ['html', 'body']) {
      for (const hidden of ['hidden', 'hidden=""', 'hidden="false"', 'hidden="until-found"']) {
        const html = doctype + (tag === 'html' ? '<html ' + hidden + '><body>' + offer + '</body></html>' :
          '<html><head><title>Metadata</title></head><body ' + hidden + '>' + offer + '</body></html>');
        const text = ctx.htmlText_(html);
        assert.equal(text, '', html);
        assert.deepEqual([...ctx.deterministicCandidates_({text})], []);
        assert.deepEqual([...ctx.remoteImageUrls_(html)], []);
        const actual = ctx.normalizeCandidate_({merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
          evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}}, {text, images: [], incomplete: false});
        assert.equal(actual.code, ''); assert.equal(actual.review, true);
      }
    }
  }
  for (const html of [offer, '<body>' + offer + '</body>', '<!doctype html><html><body>' + offer + '</body></html>',
    '<html data-hidden="true"><body>' + offer + '</body></html>', '<noscript>' + offer + '</noscript>',
    '<table><tr><td>' + offer + '</td><td>Conditions</td></tr></table>']) {
    const text = ctx.htmlText_(html);
    assert.equal(ctx.deterministicCandidates_({text})[0].code, 'SAVE20');
    assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/offer.jpg']);
  }
  assert.equal(ctx.htmlText_('<table><tr><td>First</td><td>Second</td></tr></table>'), 'First\nSecond\n');
});

test('unsupported namespaces retain coverage through hidden and inert ancestors', () => {
  const {ctx} = harness();
  const foreign = [
    '<svg><defs><text>Coupon code HIDDEN</text></defs></svg>',
    '<svg><symbol><text>Coupon code HIDDEN</text></symbol></svg>',
    '<svg><metadata>Coupon code HIDDEN</metadata></svg>',
    '<svg><text>Coupon code HIDDEN</text></svg>', '<svg><path d="M0 0"/></svg>',
    '<math><mtext>Coupon code HIDDEN</mtext></math>',
    '<svg><foreignObject><div>Coupon code HIDDEN<img src="https://shop.com/hidden.jpg"></div><math/></foreignObject></svg>'
  ];
  const raw = {merchant: 'Shop', code: 'REAL20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'REAL20'}}};
  for (const content of foreign) {
    for (const wrap of [s => s, s => '<div hidden>' + s + '</div>', s => '<template>' + s + '</template>',
      s => '<template><div hidden><template>' + s + '</template></div></template>']) {
      const html = wrap(content) + '<p>Shop Coupon code REAL20</p><img src="https://shop.com/real.jpg">';
      const result = ctx.htmlContent_(html);
      assert.equal(result.incomplete, true, html);
      assert.equal(result.text, 'Shop Coupon code REAL20\n');
      assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/real.jpg']);
      const message = {text: '', html, images: [], incomplete: false};
      assert.deepEqual(Array.from(ctx.deterministicCandidates_(message), c => c.code), ['REAL20']);
      const candidate = ctx.normalizeCandidate_(raw, message);
      assert.equal(candidate.code, 'REAL20'); assert.equal(candidate.review, true);
      const hidden = ctx.normalizeCandidate_({...raw, code: 'HIDDEN',
        evidence: {...raw.evidence, code: {quote: 'HIDDEN'}}}, message);
      assert.equal(hidden.code, '');
      assert.equal(ctx.normalizeCandidate_(raw, {...message, text: 'Shop REAL20'}).review, true);
    }
  }
  assert.equal(ctx.htmlContent_('<div hidden>Hidden</div><template>Hidden</template><p>Visible</p>').incomplete, false);
});

test('canonical candidate sources preserve raw HTML coverage and inspected image authority', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'REAL20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'REAL20'}}};
  for (const message of [{text: 'Shop REAL20', incomplete: false},
    {text: 'Shop', html: '<p>REAL20</p>', incomplete: false},
    {html: '<p>Shop REAL20</p>', incomplete: false}]) {
    assert.equal(ctx.normalizeCandidate_(raw, message).review, false);
  }
  for (const incomplete of [undefined, null, 0, '', 'false', true]) {
    assert.equal(ctx.normalizeCandidate_(raw, {html: '<p>Shop REAL20</p>', incomplete}).review, true);
  }
  const imageRaw = {...raw, evidence: {...raw.evidence, code: {image: 0}}};
  const message = {text: 'Shop', html: '<img src="https://shop.com/real.jpg">', incomplete: false};
  assert.throws(() => ctx.normalizeCandidate_(imageRaw, message), /AI/);
  assert.equal(ctx.normalizeCandidate_(imageRaw, {...message, images: [{}]}).code, 'REAL20');
  for (const change of [{html: null}, {html: 4}, {html: {}}, {html: []}, {text: 4}, {images: {}}, {images: null}]) {
    for (const consumer of [ctx.normalizeCandidate_.bind(null, raw), ctx.deterministicCandidates_]) {
      assert.throws(() => consumer({text: 'Shop REAL20', incomplete: false, ...change}), /AI/);
    }
  }
  const source = ctx.candidateSource_({text: 'Coupon code SAVE', html: '<span>20</span>', incomplete: false});
  assert.deepEqual(Array.from(source.spans), ['Coupon code SAVE', '20']);
  const candidates = ctx.deterministicCandidates_({text: 'Coupon code SAVE', html: '<span>20</span>'});
  assert.equal(candidates.length, 1); assert.equal(candidates[0].code, 'SAVE');
  assert.equal(candidates[0].review, true);
});

test('source evidence never crosses message representations', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop Outlet', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop\nOutlet'}, code: {quote: 'SAVE20'}}};
  const split = {text: 'Shop', html: '<p>Outlet SAVE20</p>', images: [], incomplete: false};
  const actual = ctx.normalizeCandidate_(raw, split);
  assert.equal(actual.merchant, ''); assert.equal(actual.review, true);
  for (const message of [{text: 'Shop Outlet SAVE20', images: [], incomplete: false},
    {html: '<p>Shop Outlet SAVE20</p>', images: [], incomplete: false}]) {
    assert.equal(ctx.normalizeCandidate_({...raw, evidence: {merchant: {quote: 'Shop Outlet'}, code: {quote: 'SAVE20'}}}, message).review, false);
  }
});

test('closed dialogs do not contribute text or images to evidence', () => {
  const {ctx} = harness();
  const image = '<img src="https://shop.com/hidden.jpg">';
  const closed = '<dialog>Shop Coupon code HIDDEN' + image + '</dialog><p>Shop REAL20</p>';
  const open = '<dialog open>Shop Coupon code OPEN20' + image + '</dialog>';
  assert.equal(ctx.htmlText_(closed), 'Shop REAL20\n');
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(closed)), []);
  assert.equal(ctx.htmlContent_(closed).incomplete, false);
  assert.ok(ctx.htmlText_(open).includes('OPEN20'));
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(open)), ['https://shop.com/hidden.jpg']);
  const raw = {merchant: 'Shop', code: 'HIDDEN', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN'}}};
  const candidate = ctx.normalizeCandidate_(raw, {html: closed, images: [], incomplete: false});
  assert.equal(candidate.code, ''); assert.equal(candidate.review, true);
});

test('closed details expose only their first direct summary subtree', () => {
  const {ctx} = harness();
  const summaryImage = '<img src="https://shop.com/summary.jpg">';
  const hiddenImage = '<img src="https://shop.com/hidden.jpg">';
  const closed = '<details>leading<summary>Shop Coupon code SUMMARY20' + summaryImage +
    '</summary><p>Coupon code HIDDEN20' + hiddenImage + '</p><summary>Coupon code SECOND20</summary></details>';
  const open = '<details open><summary>Shop Coupon code OPEN20</summary><p>Coupon code BODY20' + hiddenImage + '</p></details>';
  assert.equal(ctx.htmlText_(closed), 'Shop Coupon code SUMMARY20\n');
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(closed)), ['https://shop.com/summary.jpg']);
  assert.equal(ctx.htmlContent_(closed).incomplete, false);
  assert.ok(ctx.htmlText_(open).includes('OPEN20'));
  assert.ok(ctx.htmlText_(open).includes('BODY20'));
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(open)), ['https://shop.com/hidden.jpg']);
  const nested = '<details open><summary>Outer</summary><details><summary>Nested</summary><p>INNERHIDDEN</p></details></details>';
  assert.equal(ctx.htmlText_(nested), 'Outer\nNested\n');
  assert.ok(!ctx.htmlText_(nested).includes('INNERHIDDEN'));
  const raw = {merchant: 'Shop', code: 'HIDDEN20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'HIDDEN20'}}};
  const candidate = ctx.normalizeCandidate_(raw, {html: closed, images: [], incomplete: false});
  assert.equal(candidate.code, ''); assert.equal(candidate.review, true);
});

test('rendered disclosure blocks cannot manufacture a token or factual evidence', () => {
  const {ctx} = harness();
  const split = [
    '<details open>Coupon code SAVE</details><details open>20</details>',
    '<summary>Coupon code SAVE</summary><summary>20</summary>',
    '<dialog open>Coupon code SAVE</dialog><dialog open>20</dialog>',
    '<ul><li>Coupon code SAVE</li><li>20</li></ul>'
  ];
  for (const html of split) {
    const text = ctx.htmlText_(html);
    assert.ok(!text.includes('SAVE20'), html);
    assert.ok(!ctx.deterministicCandidates_({text}).some(function (candidate) { return candidate.code === 'SAVE20'; }), html);
  }
  assert.equal(ctx.htmlText_('<span>Coupon code SAVE</span><b>20</b>'), 'Coupon code SAVE20');
  assert.equal(ctx.deterministicCandidates_({text: 'Coupon code SAVE20'})[0].code, 'SAVE20');
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  const candidate = ctx.normalizeCandidate_(raw, {html: '<p>Shop</p>' + split[0], images: [], incomplete: false});
  assert.equal(candidate.code, ''); assert.equal(candidate.review, true);
  const fieldRaw = {merchant: 'Shop Outlet', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop Outlet'}, code: {quote: 'SAVE20'}}};
  const fieldCandidate = ctx.normalizeCandidate_(fieldRaw,
    {html: '<details open>Shop</details><details open>Outlet</details><p>SAVE20</p>', images: [], incomplete: false});
  assert.equal(fieldCandidate.merchant, ''); assert.equal(fieldCandidate.code, 'SAVE20'); assert.equal(fieldCandidate.review, true);
  const sourceCharacter = ctx.normalizeCandidate_(
    {merchant: 'Shop', code: 'SAVE', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE'}}},
    {html: '<p>Shop SAVE&#xE000;20</p>', images: [], incomplete: false});
  assert.equal(sourceCharacter.code, ''); assert.equal(sourceCharacter.review, true);
});

test('responsive image resources preserve incomplete coverage without selecting a source', () => {
  const {ctx} = harness();
  const srcset = '<img srcset="https://shop.com/small.jpg 1x, https://shop.com/large.jpg 2x">';
  const picture = '<picture><source srcset="https://shop.com/wide.jpg 2x"><img src="https://shop.com/fallback.jpg"></picture>';
  const source = '<source srcset="https://shop.com/source.jpg 1x">';
  assert.equal(ctx.htmlContent_(srcset).incomplete, true);
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(srcset)), []);
  assert.equal(ctx.htmlContent_(picture).incomplete, true);
  assert.deepEqual(Array.from(ctx.remoteImageUrls_(picture)), ['https://shop.com/fallback.jpg']);
  assert.equal(ctx.htmlContent_(source).incomplete, true);
  assert.equal(ctx.htmlContent_('<picture><img src="https://shop.com/picture.jpg"></picture>').incomplete, true);
  assert.equal(ctx.htmlContent_('<img src="https://shop.com/plain.jpg">').incomplete, false);
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  const candidate = ctx.normalizeCandidate_(raw, {html: '<p>Shop SAVE20</p>' + picture, images: [], incomplete: false});
  assert.equal(candidate.code, 'SAVE20'); assert.equal(candidate.review, true);
  for (const html of [
    '<template>' + picture + '</template><p>Shop SAVE20</p>',
    '<div hidden>' + picture + '</div><p>Shop SAVE20</p>',
    '<dialog>' + picture + '</dialog><p>Shop SAVE20</p>',
    '<details><summary>Shop</summary>' + picture + '</details><p>SAVE20</p>'
  ]) {
    assert.equal(ctx.htmlContent_(html).incomplete, false, html);
    assert.equal(ctx.normalizeCandidate_(raw, {html, images: [], incomplete: false}).review, false, html);
  }
  assert.equal(ctx.htmlContent_('<details><summary>' + picture + '</summary></details>').incomplete, true);
  assert.equal(ctx.htmlContent_('<template><svg><text>Hidden</text></svg></template><p>Shop SAVE20</p>').incomplete, true);
});

test('supplied image evidence indexes must denote inspected images', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20', image: -1}}};
  const message = {text: 'Shop SAVE20', images: [], incomplete: false};
  for (const image of [-1, 0, 4]) {
    assert.throws(() => ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, code: {quote: 'SAVE20', image}}}, message), /AI/);
  }
  assert.equal(ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, code: {image: 0}}},
    {text: 'Shop', images: [{}], incomplete: false}).review, true);
  const forgedPrototype = Object.create(null); forgedPrototype.constructor = Object;
  for (const images of [[null], [undefined], new Array(1), [false], [true], [0], [''], ['image'], [[]], [new Date()], [/image/], [new String('image')],
    [Object.create({})], [Object.create(forgedPrototype)], [new (class ImageRecord {})()], [{[Symbol.toStringTag]: 'Object'}]]) {
    assert.throws(() => ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, code: {image: 0}}},
      {text: 'Shop', images, incomplete: false}), /AI/);
  }
  assert.equal(ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, code: {image: 0}}},
    {text: 'Shop', images: [Object.create(null)], incomplete: false}).review, true);
});

test('numeric factual evidence cannot be a range or ratio endpoint', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', discountType: '%', discountValue: '20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, discountType: {quote: '%'}, discountValue: {quote: '20'}}};
  for (const source of ['Shop SAVE20 20-30%', 'Shop SAVE20 20 – 30%', 'Shop SAVE20 20/30', 'Shop SAVE20 20:30']) {
    const candidate = ctx.normalizeCandidate_(raw, {text: source, images: [], incomplete: false});
    assert.equal(candidate.discountValue, '', source); assert.equal(candidate.review, true, source);
  }
  for (const source of ['Shop SAVE20 20%', 'Shop SAVE20 20 euros']) {
    assert.equal(ctx.normalizeCandidate_(raw, {text: source, images: [], incomplete: false}).discountValue, '20', source);
  }
  const spend = {merchant: 'Shop', code: 'SAVE20', minimumSpend: '20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, minimumSpend: {quote: '20'}}};
  assert.equal(ctx.normalizeCandidate_(spend, {text: 'Shop SAVE20 minimum 20-30', images: [], incomplete: false}).minimumSpend, '');
  assert.equal(ctx.normalizeCandidate_(spend, {text: 'Shop SAVE20 minimum 20 euros', images: [], incomplete: false}).minimumSpend, '20');
  function numericCandidate(field, value, source) {
    const data = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
    data[field] = value; data.evidence[field] = {quote: value};
    return ctx.normalizeCandidate_(data, {text: 'Shop SAVE20 ' + source, images: [], incomplete: false})[field];
  }
  for (const source of ['20−30%', '20 to 30%', '20 To 30%', '20 TO 30%', 'between 20 and 30%', 'BETWEEN 20 AND 30%',
    '20% to 30%', '20% off to 30% off', '20% OFF TO 30% OFF', 'between 20% oFf and 30% oFf', '€20 to €30',
    '€20 off to €30 off', '20 euros TO 30 euros', '€ 20 to € 30', '€ 20-€ 30', 'between € 20 and € 30',
    '20 % to € 30', '20 euros off to 30 euros off', '20%-30%', '€20-€30', 'between €20 and €30']) {
    for (const field of ['discountValue', 'minimumSpend']) {
      for (const endpoint of ['20', '30']) {
        assert.equal(ctx.fieldInQuote_(field, endpoint, source), false, field + ': ' + source);
        assert.equal(numericCandidate(field, endpoint, source), '', field + ': ' + source);
      }
    }
  }
  for (const source of ['20%', '20 %', '€20', '€ 20', '20 euros', '20% off today', '€20 off today', '20 euros off today']) {
    for (const field of ['discountValue', 'minimumSpend']) assert.equal(numericCandidate(field, '20', source), '20', source);
  }
  const standalone = 'Save €20 on purchases through today to 30 September';
  assert.equal(ctx.fieldInQuote_('discountValue', '20', standalone), true);
  const standaloneCandidate = ctx.normalizeCandidate_({merchant: 'Shop', code: 'SAVE20', minimumSpend: '20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}, minimumSpend: {quote: standalone}}},
  {text: 'Shop SAVE20 ' + standalone, images: [], incomplete: false});
  assert.equal(standaloneCandidate.minimumSpend, '20'); assert.equal(standaloneCandidate.review, false);
  for (const source of ['20 coffee to 30 tea', '20 offer to 30 people', '20 percentage to 30 percentage']) {
    for (const field of ['discountValue', 'minimumSpend']) assert.equal(numericCandidate(field, '20', source), '20', source);
  }
  for (const source of ['20' + ' '.repeat(97) + '-30%', '20%' + ' '.repeat(97) + 'to 30%',
    '20% OFF TO' + ' '.repeat(97) + '30% OFF', 'BETWEEN' + ' '.repeat(97) + '20% OFF AND 30% OFF',
    'between 20%' + ' '.repeat(97) + 'and 30%']) {
    for (const field of ['discountValue', 'minimumSpend']) {
      for (const endpoint of ['20', '30']) assert.equal(numericCandidate(field, endpoint, source), '', source);
    }
  }
  for (const [low, high, fraction] of [['٢٠', '٣٠', '٥'], ['２０', '３０', '５'], ['𝟚𝟘', '𝟛𝟘', '𝟝']]) {
    for (const source of [low + '-' + high + '%', low + '−' + high + '%', low + '/' + high, low + ':' + high,
      low + '% off to ' + high + '% off', 'between ' + low + '% off and ' + high + '% off',
      '€' + low + ' to €' + high, '€\t' + low + ' to €\n' + high, low + ' % off to ' + high + ' % off', low + ' euros to ' + high + ' euros']) {
      for (const field of ['discountValue', 'minimumSpend']) {
        for (const endpoint of [low, high]) {
          assert.equal(ctx.fieldInQuote_(field, endpoint, source), false, source);
          assert.equal(numericCandidate(field, endpoint, source), '', source);
        }
      }
    }
    for (const source of [low + '% off today', low + ' % off today', '€' + low, '€ ' + low, low + ' euros', low + ' coffee to ' + high + ' tea']) {
      for (const field of ['discountValue', 'minimumSpend']) assert.equal(numericCandidate(field, low, source), low, source);
    }
    for (const separator of ['.', ',', '٫', '．']) {
      for (const value of [low, fraction]) {
        const source = low + separator + fraction + '-' + high + '%';
        assert.equal(ctx.fieldInQuote_('discountValue', value, source), false, source + ': ' + value);
      }
    }
  }
});

test('field boundary checks do not rebuild growing Unicode prefixes', () => {
  const {ctx} = harness();
  const original = ctx.Array.from;
  let calls = 0;
  ctx.Array.from = function () { calls++; return original.apply(this, arguments); };
  try {
    assert.equal(ctx.fieldInQuote_('merchant', 'a', 'a'.repeat(20000) + ' a'), true);
    assert.equal(calls, 0);
  } finally {
    ctx.Array.from = original;
  }
});

test('internal quote and angle characters remain part of complete code identities', () => {
  const {ctx} = harness();
  function normalize(code, quote, source) {
    return ctx.normalizeCandidate_({merchant: 'Shop', code, confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, code: {quote}}},
    {text: 'Shop ' + source, images: [], incomplete: false});
  }
  for (const token of ["SAVE'20", 'SAVE"20', 'SAVE<20', 'SAVE>20', "'SAVE20", 'SAVE20"', '<SAVE20', 'SAVE20>']) {
    assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + token}).length, 0, token);
    assert.equal(normalize(token, token, token).review, false, token);
    for (const part of ['SAVE', 'SAVE20', '20']) {
      for (const [quote, source] of [[part, token], [token, token], [token, part]]) {
        assert.equal(normalize(part, quote, source).code, '', token + ': ' + part);
      }
    }
  }
  for (const token of ['"SAVE20"', "'SAVE20'", '<SAVE20>']) {
    assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + token})[0].code, 'SAVE20');
    assert.equal(normalize('SAVE20', 'SAVE20', token).review, false);
  }
  for (const token of ['"<SAVE20>"', "''SAVE20''", '<<SAVE20>>']) {
    assert.equal(ctx.deterministicCandidates_({text: 'Coupon code ' + token}).length, 0);
    assert.equal(normalize('SAVE20', 'SAVE20', token).code, '');
  }
});

test('coupon introducers require a delimiter after the complete phrase', () => {
  const {ctx} = harness();
  for (const text of ['discount codebase', 'use codependency', 'Coupon codeSAVE20', 'codicesconto',
    'promotional codeword', 'coupon code-SAVE20', 'codice sconto']) {
    assert.deepEqual([...ctx.deterministicCandidates_({text})], [], text);
  }
  for (const phrase of ['Coupon code', 'PROMOTIONAL CODE', 'Use the code', 'codice sconto', 'codice']) {
    for (const prefix of ['x', 'é', '𐐀', '4', '４', '𝟜', '\u0301', '_']) {
      assert.deepEqual([...ctx.deterministicCandidates_({text: prefix + phrase + ' SAVE20'})], [], prefix + phrase);
    }
    for (const prefix of [' ', '\n', '.', '(', '😀']) {
      assert.equal(ctx.deterministicCandidates_({text: prefix + phrase + ' SAVE20'})[0].code, 'SAVE20');
    }
    for (const delimiter of [' ', '\t', '\n', ':', '=', ' : ', ' = ']) {
      assert.equal(ctx.deterministicCandidates_({text: phrase + delimiter + 'MiXeD20'})[0].code, 'MiXeD20');
    }
  }
});

test('candidate schema rejects unknown facts and malformed controls before projection', () => {
  const {ctx} = harness();
  const raw = {merchant: 'Shop', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Shop'}, code: {quote: 'SAVE20'}}};
  const message = {text: 'Shop SAVE20', images: [], incomplete: false};
  for (const key of ['expiryDate', 'minimumSpent', 'unsupported', '__proto__']) {
    for (const value of ['2026-09-30', '', null, undefined]) {
      assert.throws(() => ctx.normalizeCandidate_({...raw, [key]: value}, message), /AI/, key);
      assert.throws(() => ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, [key]: value}}, message), /AI/);
      assert.throws(() => ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, code: {quote: 'SAVE20', [key]: value}}}, message), /AI/);
    }
  }
  for (const change of [{review: null}, {review: 0}, {review: 'false'}, {confidence: null}, {confidence: 4},
    {confidence: 'certain'}, {evidence: null}, {evidence: []}, {evidence: 'SAVE20'},
    {evidence: {code: null}}, {evidence: {code: []}}, {evidence: {code: 'SAVE20'}},
    {evidence: {code: {quote: 4}}}, {evidence: {code: {quote: null}}},
    {evidence: {code: {image: 0.5}}}, {evidence: {code: {image: '0'}}}, {evidence: {code: {image: null}}}]) {
    assert.throws(() => ctx.normalizeCandidate_({...raw, ...change}, message), /AI/);
  }
  for (const partial of [{}, {merchant: null}, {code: 'SAVE20'}, {evidence: {}},
    {evidence: {code: {}}}, {confidence: 'low', review: true}]) {
    assert.equal(ctx.normalizeCandidate_(partial, message).review, true);
  }
  for (const image of [-1, 0, 4]) {
    assert.throws(() => ctx.normalizeCandidate_({...raw, evidence: {...raw.evidence, code: {image}}}, message), /AI/);
  }
});

test('website evidence requires a leading boundary in both quote and complete source', () => {
  const {ctx} = harness();
  const url = 'https://shop.com';
  function normalize(quote, source, website = url) {
    return ctx.normalizeCandidate_({merchant: 'Shop', website, confidence: 'high', review: false,
      evidence: {merchant: {quote: 'Shop'}, website: {quote}}},
    {text: 'Shop ' + source, images: [], incomplete: false});
  }
  for (const source of ['abc' + url, '_' + url, '/' + url, '=' + url, '?' + url, '&' + url,
    'https://outer.com/?next=' + url, 'https://outer.com/' + url]) {
    for (const quote of [url, source]) {
      const actual = normalize(quote, source);
      assert.equal(actual.website, '', source); assert.equal(actual.review, true);
    }
  }
  for (const prefix of ['', ' ', '\n', '"', "'", '(', '[', '{', '<']) {
    assert.equal(normalize(url, prefix + url).review, false, prefix);
  }
  const exact = 'https://shop.com/path?next=https://other.com';
  assert.equal(normalize(exact, exact, exact).review, false);
  assert.equal(normalize(url, url + '/path').website, '');
});
