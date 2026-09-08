const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function sheet(rows) {
  const values = rows.map(row => row.slice());
  return {
    getLastRow: () => values.length,
    getLastColumn: () => values.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({getValues: () => values.map(row => row.slice()),
      getDisplayValues: () => values.map(row => row.map(value => String(value ?? '')))}),
    getRange: (r, c, rc, cc) => ({
      getValues: () => values.slice(r - 1, r - 1 + rc).map(row => row.slice(c - 1, c - 1 + cc)),
      getDisplayValues: () => values.slice(r - 1, r - 1 + rc).map(row => row.slice(c - 1, c - 1 + cc).map(value => String(value ?? ''))),
      setValues: next => { while (values.length < r) values.push([]); values[r - 1] = next[0].slice(); }
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

test('workflow records a no-candidate message as retryable and never final', () => {
  const {ctx} = harness();
  const state = {couponSheet: sheet([HEADERS]), journalSheet: sheet([JOURNAL]),
    messages: [{id: 'deadbeef', receivedAtMs: 0, subject: 'Hello', sender: '', link: 'https://mail.google.com/mail/#all/deadbeef', text: 'Hello', html: '', incomplete: false}]};
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'failed');
  assert.notEqual(ctx.getMessageState_(state.journalSheet, 'deadbeef').status, 'confirmed');
});
