const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function sheet(rows, failWrites = 0) {
  const values = rows.map(row => row.slice());
  return {
    getLastRow: () => values.length,
    getLastColumn: () => values.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({getValues: () => values.map(row => row.slice()),
      getDisplayValues: () => values.map(row => row.map(value => String(value ?? '')))}),
    getRange: (r, c, rc, cc) => ({
      getValues: () => Array.from({length: rc}, (_, i) => Array.from({length: cc}, (_, j) => values[r - 1 + i]?.[c - 1 + j] ?? '')),
      getDisplayValues: () => values.slice(r - 1, r - 1 + rc).map(row => row.slice(c - 1, c - 1 + cc).map(value => String(value ?? ''))),
      setValues: next => {
        if (failWrites > 0) { failWrites--; throw new Error('temporary write failure'); }
        while (values.length < r) values.push([]); values[r - 1] = next[0].slice();
      }
    }),
    _values: values
  };
}
const HEADERS = ['Email date', 'Brand / merchant', 'Website', 'Coupon code', 'Discount type', 'Discount value',
  'Minimum spend', 'Valid on', 'Excluded products / limits', 'Expiry date', 'Usage limits', 'Source email subject',
  'Sender', 'Email link', 'Extraction confidence', 'Needs visual check / OCR', 'Notes / dedupe key', 'Status',
  'Priority', 'Category', 'Currency', 'Estimated value', 'Used date', 'Last checked', 'Action needed', 'Days to expiry'];
const JOURNAL = ['Message ID', 'State JSON'];

function deterministicOutcome(ctx, message) {
  const candidates = ctx.deterministicCandidates_(message).map(candidate => ({merchant: '', website: '', code: candidate.code,
    discountType: '', discountValue: '', minimumSpend: '', validOn: '', exclusions: '', expiry: '', usageLimits: '',
    currency: '', notes: candidate.notes, confidence: candidate.confidence, review: true, imageEvidence: {}}));
  return {candidates, verifiedNonOffer: candidates.length === 0};
}

function stateWithExtraction(ctx, state) {
  state.extractCouponOutcome = message => deterministicOutcome(ctx, message);
  return state;
}

function confirmedCandidate(overrides = {}) {
  return Object.assign({merchant: 'Brand', website: 'https://brand.example/coupon', code: 'Save+20', discountType: '%',
    discountValue: '20', minimumSpend: '', validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: 'EUR',
    notes: 'Members only', confidence: 'high', review: false, imageEvidence: {}}, overrides);
}

test('workflow persists deterministic candidates and reruns without duplicates', () => {
  const {ctx} = harness();
  const coupon = sheet([HEADERS]);
  const journal = sheet([JOURNAL]);
  const state = stateWithExtraction(ctx, {couponSheet: coupon, journalSheet: journal, messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'),
    subject: 'Offer', sender: 'shop@example.com', link: 'https://mail.google.com/mail/#all/abc123',
    text: 'Shop coupon code SAVE20', html: '', incomplete: false}]});
  const first = ctx.runImportWorkflow_(state);
  assert.equal(first.messages[0].status, 'review');
  assert.equal(JSON.stringify(first.messages[0].rows), '[2]');
  assert.equal(coupon.getLastRow(), 2);
  const second = ctx.runImportWorkflow_(state);
  assert.equal(second.messages[0].status, 'review');
  assert.equal(JSON.stringify(second.messages[0].rows), '[2]');
  assert.equal(coupon.getLastRow(), 2);
  assert.equal(ctx.getMessageState_(journal, 'abc123').status, 'review');
});

test('workflow checkpoints a verified non-offer without a failure or archive authority', () => {
  const {ctx} = harness();
  const state = stateWithExtraction(ctx, {couponSheet: sheet([HEADERS]), journalSheet: sheet([JOURNAL]),
    messages: [{id: 'deadbeef', receivedAtMs: 0, subject: 'Hello', sender: '', link: 'https://mail.google.com/mail/#all/deadbeef', text: 'Hello', html: '', incomplete: false}]});
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'nonoffer');
  const saved = ctx.getMessageState_(state.journalSheet, 'deadbeef');
  assert.equal(saved.lastError, ''); assert.equal(saved.retryCount, 0);
  assert.equal(saved.archived, false); assert.equal(saved.labelApplied, false);
  const summary = ctx.scheduledSummary_(state, {}, result);
  assert.equal(summary.errors.length, 0); assert.equal(summary.review, 0);
  ctx.MailApp = {sendEmail: () => assert.fail('no false error notification')};
  assert.equal(ctx.notifyScheduledImport_(summary).sent, false);
});

test('workflow persists multiple deterministic candidates with distinct rows and references', () => {
  const {ctx} = harness();
  const coupon = sheet([HEADERS]);
  const journal = sheet([JOURNAL]);
  const state = stateWithExtraction(ctx, {couponSheet: coupon, journalSheet: journal, messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'),
    subject: 'Offers', sender: 'shop@example.com', link: 'https://mail.google.com/mail/#all/abc123',
    text: 'Shop coupon code SAVE20 and coupon code WELCOME30', html: '', incomplete: false}]});
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'review');
  assert.equal(result.review, 2);
  assert.equal(JSON.stringify(result.messages[0].rows), '[2,3]');
  assert.equal(coupon.getLastRow(), 3);
  const saved = ctx.getMessageState_(journal, 'abc123');
  assert.equal(JSON.stringify(saved.rowNumbers), '[2,3]');
  assert.equal(JSON.stringify(saved.candidateKeys), JSON.stringify([...new Set(saved.candidateKeys)]));
});

test('workflow leaves append failures retryable and completes the later rerun without duplication', () => {
  const {ctx} = harness();
  const coupon = sheet([HEADERS], 1);
  const journal = sheet([JOURNAL]);
  const message = {id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'), subject: 'Offer',
    sender: 'shop@example.com', link: 'https://mail.google.com/mail/#all/abc123', text: 'Shop coupon code SAVE20', html: '', incomplete: false};
  const state = stateWithExtraction(ctx, {couponSheet: coupon, journalSheet: journal, messages: [message]});
  const first = ctx.runImportWorkflow_(state);
  assert.equal(first.messages[0].status, 'failed');
  assert.notEqual(ctx.getMessageState_(journal, 'abc123').status, 'confirmed');
  assert.equal(coupon.getLastRow(), 1);
  const second = ctx.runImportWorkflow_(state);
  assert.equal(second.messages[0].status, 'review');
  assert.equal(second.review, 1);
  assert.equal(JSON.stringify(second.messages[0].rows), '[2]');
  assert.equal(coupon.getLastRow(), 2);
  assert.equal(JSON.stringify(ctx.getMessageState_(journal, 'abc123').rowNumbers), '[2]');
});

test('initial full extraction persists readable fields before verified label/archive checkpoints', () => {
  const {ctx, config} = harness();
  config.labelId = 'coupon-label';
  const coupon = sheet([HEADERS]); const journal = sheet([JOURNAL]); const mutations = [];
  ctx.Gmail.Users.Messages = {modify: (body, user, id) => {
    assert.equal(user, 'me'); assert.equal(id, 'abc123'); mutations.push(body);
    return {id, labelIds: body.addLabelIds ? ['INBOX', 'UNREAD', 'coupon-label'] : ['UNREAD', 'coupon-label']};
  }};
  const state = {config, couponSheet: coupon, journalSheet: journal, extractCouponOutcome: () => ({
    candidates: [confirmedCandidate()], archiveAllowed: true, verifiedNonOffer: false
  }), messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'), subject: 'Brand offer',
    sender: 'offers@brand.example', link: 'https://mail.google.com/mail/#all/abc123', text: 'Brand', html: '', incomplete: false}]};
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'confirmed');
  assert.deepEqual(JSON.parse(JSON.stringify(mutations)), [{addLabelIds: ['coupon-label']}, {removeLabelIds: ['INBOX']}]);
  assert.equal(coupon._values[1][16], 'Members only'); assert.equal(coupon._values[1][20], 'EUR');
  assert.doesNotMatch(coupon._values[1][16], /^[a-f0-9]{64}$/);
  const saved = ctx.getMessageState_(journal, 'abc123');
  assert.equal(saved.labelApplied, true); assert.equal(saved.archived, true); assert.equal(saved.status, 'confirmed');
  ctx.runImportWorkflow_(state); assert.equal(mutations.length, 2);
});

test('unverified empty extraction remains reachable and later recovers into the same journal record', () => {
  const {ctx} = harness();
  const coupon = sheet([HEADERS]); const journal = sheet([JOURNAL]); let attempts = 0;
  const state = {couponSheet: coupon, journalSheet: journal, extractCouponOutcome: () => {
    attempts++;
    return attempts === 1 ? {candidates: [], verifiedNonOffer: false, invalidated: true} :
      {candidates: [confirmedCandidate({review: true})], verifiedNonOffer: false};
  }, messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'), subject: 'Brand offer', sender: '',
    link: 'https://mail.google.com/mail/#all/abc123', text: 'Brand', html: '', incomplete: true}]};
  assert.equal(ctx.runImportWorkflow_(state).messages[0].status, 'awaiting_extraction');
  assert.equal(ctx.getMessageState_(journal, 'abc123').archived, false);
  assert.equal(ctx.runImportWorkflow_(state).messages[0].status, 'review');
  assert.equal(coupon.getLastRow(), 2); assert.equal(attempts, 2);
});

test('a surviving candidate cannot archive when the same extraction invalidated another proposal', () => {
  const {ctx, config} = harness(); config.labelId = 'coupon-label';
  const mutations = []; ctx.Gmail.Users.Messages = {modify: body => { mutations.push(body); return {id: 'abc123', labelIds: []}; }};
  const state = {config, couponSheet: sheet([HEADERS]), journalSheet: sheet([JOURNAL]), extractCouponOutcome: () => ({
    candidates: [confirmedCandidate()], invalidated: true, archiveAllowed: false, verifiedNonOffer: false
  }), messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'), subject: 'Brand offer', sender: '',
    link: 'https://mail.google.com/mail/#all/abc123', text: 'Brand', html: '', incomplete: false}]};
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'review'); assert.equal(mutations.length, 0);
  assert.equal(ctx.getMessageState_(state.journalSheet, 'abc123').archived, false);
});
