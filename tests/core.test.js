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
  for (const evidence of [undefined, {quote: 'Works forever'}, {quote: 'Shop SAVE20'},
    {image: -1}, {image: 0}, {image: 0.5}, {image: '0'}]) {
    const result = normalize('Works forever', evidence);
    assert.equal(result.notes, ''); assert.equal(result.review, true);
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
