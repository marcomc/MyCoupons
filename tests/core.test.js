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
