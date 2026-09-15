const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');
const {wireCandidate} = require('./ai-wire-fixtures');

function admission(ctx, message) {
  return ctx.authenticationAdmission_(ctx.candidateSource_(Object.assign({images: [], incomplete: false}, message)));
}

function journalSheet() {
  const rows = [['Message ID', 'State JSON']];
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => 2,
    getDataRange: () => ({getValues: () => rows.map(row => row.slice()),
      getDisplayValues: () => rows.map(row => row.map(value => String(value))) }),
    getRange: (row, column, rowCount = 1, columnCount = 1) => ({
      getValues: () => Array.from({length: rowCount}, (_, rowOffset) =>
        Array.from({length: columnCount}, (_, columnOffset) => rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? '')),
      getDisplayValues: () => Array.from({length: rowCount}, (_, rowOffset) =>
        Array.from({length: columnCount}, (_, columnOffset) => String(rows[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ''))),
      getFormulas: () => Array.from({length: rowCount}, () => Array(columnCount).fill('')),
      getNote: () => '',
      setValues: values => values.forEach((valueRow, rowOffset) => {
        rows[row - 1 + rowOffset] ||= [];
        valueRow.forEach((value, columnOffset) => { rows[row - 1 + rowOffset][column - 1 + columnOffset] = value; });
      })
    }),
    _rows: rows
  };
}

test('closed admission accepts only complete affirmative authentication relations', () => {
  const {ctx} = harness();
  const accepted = [
    {text: 'Your verification code is 123456.'},
    {text: 'aBcDeF is your authentication passcode.'},
    {text: 'Use code ÈTÉ+20! to verify your account.'},
    {text: 'We sent your security code 123456.'},
    {text: 'We sent your security code to you: 123456.'},
    {subject: 'Your verification code is 123456.'},
    {subject: 'Sign in to Acme', text: 'Your code is 123456.'},
    {text: 'Sample Bank: your verification code is 123456.'},
    {html: '<!-- <blockquote>template</blockquote> --><p>Your verification code is 123456.</p>'},
    {html: '<blockquote>Terms apply.</blockquote><p>Your verification code is 123456.</p>'}
  ];
  accepted.forEach(message => assert.equal(admission(ctx, message).kind, 'issued', JSON.stringify(message)));
  accepted.forEach(message => assert.equal(admission(ctx, message).deterministic, true));
});

test('questions, hypotheses, reports, examples, negations and unsupported clauses never issue', () => {
  const {ctx} = harness();
  const cases = [
    ['discussion', {text: 'Is your verification code 123456?'}],
    ['discussion', {text: 'Maybe your verification code is 123456.'}],
    ['discussion', {text: 'They said your verification code is 123456.'}],
    ['discussion', {text: 'For example, your verification code is 123456.'}],
    ['discussion', {text: 'Your verification code is not 123456.'}],
    ['ambiguous', {text: 'Your verification code is. 123456.'}],
    ['ambiguous', {text: 'Your verification code is ' + 'A'.repeat(41) + '.'}],
    ['ambiguous', {text: 'The verification code appears as 123456.'}],
    ['discussion', {text: 'For example. Your verification code is 123456.'}],
    ['discussion', {text: 'For example. Documentation. Your verification code is 123456.'}],
    ['discussion', {text: 'Your verification code is 123456. This is only an example.'}],
    ['discussion', {html: '<p>For example.</p><p>Your verification code is 123456.</p>'}],
    ['ambiguous', {text: 'Your verification code is YOUR_CODE.'}],
    ['ambiguous', {text: 'Your verification code is N/A.'}],
    ['ambiguous', {text: 'Your verification code is TBD.'}],
    ['ambiguous', {text: 'Your verification code is unknown.'}],
    ['ambiguous', {text: 'Your verification code is [CODE].'}],
    ['ambiguous', {text: 'We sent your verification code to your email.'}],
    ['ambiguous', {text: 'We sent your security code to you yesterday.'}],
    ['discussion', {text: 'Your verification code is expired.'}],
    ['discussion', {text: 'Status report: your verification code is 123456.'}],
    ['discussion', {text: 'An example: your verification code is 123456.'}],
    ['discussion', {text: 'User report: your verification code is 123456.'}],
    ['discussion', {text: 'Hypothetical scenario: your verification code is 123456.'}],
    ['discussion', {text: 'User said: your verification code is 123456.'}],
    ['discussion', {text: 'Can you confirm: your verification code is 123456.'}],
    ['discussion', {text: 'The documentation says: your verification code is 123456.'}],
    ['ambiguous', {text: 'Your verification code is 1,000-2,000.'}],
    ['ambiguous', {text: 'Your verification code is 1,000‑2,000.'}],
    ['ambiguous', {text: 'Your verification code is 1,000‒2,000.'}],
    ['ambiguous', {text: 'Your verification code is 1,000－2,000.'}],
    ['ambiguous', {text: 'Your verification code is 12.3/45.6.'}],
    ['ambiguous', {text: 'Your verification code is 123∶456.'}],
    ['ambiguous', {text: 'Your verification code is ' + 'A'.repeat(40) + '!'}],
    ['ambiguous', {text: 'Your verification code is −123.'}],
    ['ambiguous', {text: 'Your verification code is [[' + 'A'.repeat(40) + ']].'}],
    ['ambiguous', {text: 'Your verification code is ftp://example.com/code.'}],
    ['ambiguous', {text: 'Your verification code is tel:+15551234567.'}],
    ['ambiguous', {text: 'This is your verification code.'}],
    ['ambiguous', {text: 'Your verification code is this.'}],
    ['ambiguous', {text: 'Use it to verify your account.'}],
    ['ambiguous', {text: 'Your verification code is example.com/reset.'}],
    ['ambiguous', {text: 'Your verification code is /verify/123.'}],
    ['ambiguous', {text: 'Use Chrome to access your account.'}],
    ['ambiguous', {text: 'Shopping savings: Acme coupon code SAVE20.'}],
    ['ambiguous', {text: 'Acme coupon code ÉPINÉ.'}],
    ['discussion', {html: '<p>Coupon code SAVE20</p><blockquote>Your verification code is 123456.</blockquote>'}],
    ['discussion', {text: 'Coupon code SAVE20\n---------- Forwarded message ---------\nYour verification code is 123456.'}],
    ['discussion', {text: 'Your verification code is 123456？'}],
    ['discussion', {text: 'Your verification code is 123456՞'}],
    ['discussion', {text: 'Your verification code is 123456⁉'}],
    ['discussion', {text: 'Your verification code is 123456⁈'}],
    ['discussion', {text: 'Your verification code is 123456﹖'}],
    ['discussion', {text: 'Your verification code is 123456. It is expired.'}],
  ];
  cases.forEach(([kind, message]) => {
    const result = admission(ctx, message);
    assert.notEqual(result.kind, 'issued', JSON.stringify(message));
    assert.equal(result.kind, kind, JSON.stringify(message));
    assert.equal(result.deterministic, false);
  });
});

test('source bounds and bridge guards fail closed before deterministic exclusion', () => {
  const {ctx} = harness();
  const oversized = admission(ctx, {subject: 'Sign in to Acme', text: 'Your code is 123456.' + 'x'.repeat(60001)});
  assert.equal(oversized.kind, 'incomplete');
  assert.equal(oversized.deterministic, false);

  [
    {subject: 'Sign in to Acme', text: 'Your code is 123456?'},
    {subject: 'Sign in to Acme', text: 'Your code is expired.'},
    {subject: 'Sign in to Acme', text: 'Maybe your code is 123456.'}
  ].forEach(message => assert.notEqual(admission(ctx, message).kind, 'issued', JSON.stringify(message)));
});

test('incomplete coverage dominates an otherwise affirmative relation', () => {
  const {ctx} = harness();
  const result = admission(ctx, {text: 'Your verification code is 123456.', incomplete: true});
  assert.equal(result.kind, 'incomplete');
  assert.equal(result.deterministic, false);
  assert.equal(result.authenticationLike, true);
});

test('complete issued authentication bypasses model and image transport', () => {
  const {ctx} = harness();
  let modelCalls = 0;
  ctx.callGeminiModel_ = () => { modelCalls++; throw new Error('model must not run'); };
  const outcome = ctx.extractCouponOutcome_({text: 'Your verification code is 123456.', images: [{mimeType: 'image/png', bytes: [1]}], incomplete: false});
  assert.equal(modelCalls, 0);
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(outcome.admission.kind, 'issued');
  assert.equal(outcome.candidates.length, 0);
  assert.equal(outcome.archiveAllowed, false);
  assert.equal(outcome.verifiedNonOffer, false);
});

test('ambiguous authentication remains on the model/manual path', () => {
  const {ctx} = harness();
  let modelCalls = 0;
  ctx.callGeminiModel_ = () => {
    modelCalls++;
    return {text: JSON.stringify({candidates: []})};
  };
  const outcome = ctx.extractCouponOutcome_({text: 'Maybe your verification code is 123456.', incomplete: false});
  assert.equal(modelCalls, 1);
  assert.equal(outcome.excludedReason, undefined);
  assert.equal(outcome.admission.kind, 'discussion');
  assert.equal(outcome.archiveAllowed, false);
});

test('empty ambiguous authentication remains reachable for manual review', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: []})});
  const outcome = ctx.extractCouponOutcome_({text: 'Maybe your verification code is 123456.', incomplete: false});
  assert.equal(outcome.admission.kind, 'discussion');
  assert.equal(outcome.verifiedNonOffer, false);
  assert.equal(outcome.archiveAllowed, false);
});

test('a model proposal cannot turn ambiguous authentication into automatic archive authority', () => {
  const {ctx} = harness();
  const candidate = {merchant: 'Acme', website: '', code: 'SAVE20', discountType: '', discountValue: '',
    minimumSpend: '', validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: '',
    confidence: 'high', review: false, evidence: {merchant: {quote: 'Acme'}, code: {quote: 'SAVE20'}}};
  ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: [wireCandidate(candidate)]})});
  const outcome = ctx.extractCouponOutcome_({text: 'The verification code appears as SAVE20. Acme coupon code SAVE20', incomplete: false});
  assert.equal(outcome.admission.kind, 'ambiguous');
  assert.equal(outcome.admission.authenticationLike, true);
  assert.equal(outcome.candidates[0].review, false);
  assert.equal(outcome.archiveAllowed, false);
});

test('workflow checkpoints exclusion without rows or Gmail mutation', () => {
  const {ctx, config} = harness();
  const journal = journalSheet();
  const coupon = journalSheet();
  const mutations = [];
  ctx.Gmail.Users.Messages = {modify: body => { mutations.push(body); throw new Error('Gmail must not mutate'); }};
  const state = {
    config, couponSheet: coupon, journalSheet: journal,
    messages: [{id: 'abc123', receivedAtMs: 0, subject: 'Sign in to Acme', sender: 'acme@example.com',
      link: 'https://mail.google.com/mail/#all/abc123', text: 'Your code is 123456.', html: '', incomplete: false}]
  };
  const result = ctx.runImportWorkflow_(state);
  assert.equal(result.messages[0].status, 'ignored');
  assert.equal(result.messages[0].excludedReason, 'authentication_code_message');
  assert.equal(coupon.getLastRow(), 1);
  assert.deepEqual(mutations, []);
  const saved = ctx.getMessageState_(journal, 'abc123');
  assert.equal(saved.status, 'ignored');
  assert.equal(saved.outcome, 'authentication_code_message');
  assert.equal(saved.archived, false);
  assert.equal(saved.labelApplied, false);
});

test('existing archive intent is rechecked before any Gmail mutation', () => {
  const {ctx, config} = harness();
  const journal = journalSheet();
  const coupon = journalSheet();
  const mutations = [];
  const key = 'a'.repeat(64);
  const prior = Object.assign(ctx.newMessageState_('abc123'), {
    version: 2, status: 'failed', candidateKeys: [key], rowNumbers: [2],
    dedupeKeys: [key], failureStage: 'mail', outcome: 'archive'
  });
  journal._rows.push(['abc123', JSON.stringify(prior)]);
  const row = Array(26).fill('');
  row[13] = 'https://mail.google.com/mail/#all/abc123'; row[16] = key; row[17] = 'Needs review';
  coupon._rows.push(row);
  ctx.Gmail.Users.Messages = {modify: body => { mutations.push(body); throw new Error('Gmail must not mutate'); }};
  const result = ctx.runImportWorkflow_({config, couponSheet: coupon, journalSheet: journal,
    messages: [{id: 'abc123', receivedAtMs: 0, subject: 'Sign in to Acme', sender: 'acme@example.com',
      link: 'https://mail.google.com/mail/#all/abc123', text: 'Your code is 123456.', html: '', incomplete: false}]});
  assert.equal(result.messages[0].status, 'ignored');
  assert.deepEqual(mutations, []);
  const saved = ctx.getMessageState_(journal, 'abc123');
  assert.equal(saved.outcome, 'authentication_code_message');
  assert.equal(saved.archived, false);
});
