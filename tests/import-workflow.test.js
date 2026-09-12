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

test('workflow persists deterministic candidates and reruns without duplicates', () => {
  const {ctx} = harness();
  const coupon = sheet([HEADERS]);
  const journal = sheet([JOURNAL]);
  const state = {couponSheet: coupon, journalSheet: journal, messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'),
    subject: 'Offer', sender: 'shop@example.com', link: 'https://mail.google.com/mail/#all/abc123',
    text: 'Shop coupon code SAVE20', html: '', incomplete: false}]};
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

test('workflow retains a no-code message awaiting extraction without a failure or archive authority', () => {
  const {ctx} = harness();
  const state = {couponSheet: sheet([HEADERS]), journalSheet: sheet([JOURNAL]),
    messages: [{id: 'deadbeef', receivedAtMs: 0, subject: 'Hello', sender: '', link: 'https://mail.google.com/mail/#all/deadbeef', text: 'Hello', html: '', incomplete: false}]};
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'awaiting_extraction');
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
  const state = {couponSheet: coupon, journalSheet: journal, messages: [{id: 'abc123', receivedAtMs: Date.parse('2026-09-01T10:00:00Z'),
    subject: 'Offers', sender: 'shop@example.com', link: 'https://mail.google.com/mail/#all/abc123',
    text: 'Shop coupon code SAVE20 and coupon code WELCOME30', html: '', incomplete: false}]};
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
  const state = {couponSheet: coupon, journalSheet: journal, messages: [message]};
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
