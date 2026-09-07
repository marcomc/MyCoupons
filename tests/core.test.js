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
  assert.equal(ctx.htmlText_('<style>secret</style><p>Save &amp; use &#67;ODE</p>'), ' Save & use CODE\n');
});
test('remote image discovery excludes trackers, private literals and unsafe schemes', () => {
  const {ctx} = harness();
  for (const url of ['http://shop.com/a', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://foo.local/x', 'https://foo.LOCAL/x', 'https://x.com@evil.com/x', 'https://0x7f000001/x', 'https://example.com:8080/x']) assert.equal(ctx.safeUrl_(url), '');
  const html = '<img src="https://shop.com/promo.jpg"><img src="https://shop.com/pixel.gif"><img width="1" src="https://shop.com/a"><img src="https://shop.com/promo.jpg">';
  assert.deepEqual([...ctx.remoteImageUrls_(html)], ['https://shop.com/promo.jpg']);
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

test('only canonical Gmail links provide an identity without partial token collisions', () => {
  const {ctx} = harness();
  const id = '18a9b0c7';
  assert.equal(ctx.sourceId_(ctx.gmailLink_(id)), id);
  for (const url of ['https://mail.google.com/mail/#all/' + id,
    'https://mail.google.com/mail/u/1/#inbox/' + id,
    'https://mail.google.com/mail/#search/coupon/' + id,
    'https://mail.google.com/mail/?th=' + id + '&view=pt']) assert.equal(ctx.sourceId_(url), id);
  for (const url of ['https://other.example/mail/#all/' + id,
    'https://mail.google.com.evil.example/mail/#all/' + id,
    'https://mail.google.com/mail/#all/' + id + '-bad',
    'https://mail.google.com/mail/?permmsgid=msg-f:123456789',
    'https://mail.google.com/mail/?permmsgid=msg-f:987654321',
    'https://mail.google.com/mail/#search/receipt?th=deadbeef',
    'https://mail.google.com/mail/#garbage#all/deadbeef',
    'https://mail.google.com/mail/?th=deadbeef&th=face',
    'https://mail.google.com/mail/?th=' + id + ':bad']) assert.equal(ctx.sourceId_(url), '');
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
    '2026-09-07T10:60:00Z', '2026-09-07T10:00:00+25:00', '2026-09-07T10:00:00']) {
    assert.throws(() => ctx.emailDate_(date, 'Europe/Rome'), /DATE/);
  }
  const value = '2026-09-07T10:30:00.123+02:00';
  assert.equal(ctx.emailDate_(value, 'Europe/Rome').getTime(), Date.parse(value));
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
