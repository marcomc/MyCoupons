const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');
const {wireCandidate} = require('./ai-wire-fixtures');

function sheet(headers) {
  const rows = [headers.slice()]; const notes = []; let capacity = 26;
  const width = () => Math.max(...rows.map(row => row.length));
  const values = (r, c, nr, nc) => Array.from({length: nr}, (_, i) =>
    Array.from({length: nc}, (_, j) => rows[r - 1 + i]?.[c - 1 + j] ?? ''));
  const display = rows => rows.map(row => row.map(value => value instanceof Date ? '01/10/2026' : String(value)));
  return {rows, notes, getLastRow: () => rows.length, getLastColumn: width,
    getMaxColumns: () => capacity,
    insertColumnsAfter: (after, count) => { assert.equal(after, capacity); capacity += count; },
    getDataRange: () => ({getValues: () => values(1, 1, rows.length, width()),
      getDisplayValues: () => display(values(1, 1, rows.length, width()))}),
    getRange: (r, c, nr = 1, nc = 1) => {
      assert.ok(c + nc - 1 <= capacity, 'Sheets requires explicit grid expansion');
      return {getValues: () => values(r, c, nr, nc), getDisplayValues: () => display(values(r, c, nr, nc)),
        getFormulas: () => Array.from({length: nr}, () => Array(nc).fill('')),
        setValues: next => next.forEach((row, i) => row.forEach((value, j) => {
          assert.ok(typeof value !== 'string' || value.length <= 50000, 'Sheets cell capacity');
          rows[r - 1 + i] ||= []; rows[r - 1 + i][c - 1 + j] = value;
        })),
        setNote: note => { notes[r - 1] ||= []; notes[r - 1][c - 1] = note; },
        getNote: () => notes[r - 1]?.[c - 1] || '',
        getNotes: () => Array.from({length: nr}, (_, i) => [notes[r - 1 + i]?.[c - 1] || ''])};
    }};
}

function candidate(code = 'Save+20', overrides = {}) {
  return {merchant: 'Brand', website: '', code, discountType: '', discountValue: '', minimumSpend: '',
    validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: 'Members only',
    confidence: 'high', review: true, imageEvidence: {}, ...overrides};
}

function fixture() {
  const initial = harness();
  const coupon = sheet(Array(26).fill('header')); const journal = sheet(['Message ID', 'State JSON']);
  const text = 'Brand coupon code Save+20 and coupon code SAVE+30 ; Members only. Expires 2026-10-01.';
  const raw = {id: 'abc123', internalDate: String(Date.parse('2026-09-01T10:00:00Z')),
    payload: {mimeType: 'text/plain', body: {data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text)},
      headers: [{name: 'Subject', value: 'Brand offer'}, {name: 'From', value: 'offers@brand.example'}]}};
  const mutations = [];
  const f = {coupon, journal, mutations, raw};
  f.boot = (runtime = harness()) => {
    f.ctx = runtime.ctx; f.config = {...runtime.config, labelId: 'coupon-label', timeZone: 'Europe/Rome'};
    f.ctx.Gmail.Users.Messages = {get: () => raw, modify: (body, user, id) => {
      assert.equal(user, 'me'); assert.equal(id, raw.id); mutations.push(body);
      return {id, labelIds: body.addLabelIds ? ['INBOX', 'coupon-label'] : ['coupon-label']};
    }};
    f.ctx.SpreadsheetApp = {openById: () => ({getSheetByName: () => journal})};
    f.message = f.ctx.canonicalGmailMessage_(raw);
    f.state = {config: f.config, couponSheet: coupon, journalSheet: journal, messages: [f.message],
      extractCouponOutcome: () => ({candidates: [candidate(), candidate('SAVE+30')], archiveAllowed: false})};
  };
  f.boot(initial);
  f.run = () => f.ctx.runImportWorkflow_(f.state);
  f.saved = () => f.ctx.getMessageState_(journal, raw.id);
  f.action = (row, action) => f.ctx.processReviewAction_(coupon, row, action, f.config);
  return f;
}

function setSource(f, text) {
  f.raw.payload.body = {data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text)};
  f.boot();
}

function modelResponse(proposals) {
  return {text: JSON.stringify({authentication: null, candidates: proposals.map(proposal => {
    const result = {...proposal}; delete result.imageEvidence;
    result.evidence = Object.fromEntries(Object.entries(result).filter(([key, value]) =>
      typeof value === 'string' && value && key !== 'confidence').map(([key, value]) => [key, {quote: value}]));
    return wireCandidate(result);
  })})};
}

function interruptedAuthenticationBatch(written) {
  const f = fixture();
  setSource(f, f.message.text + '\nYour verification code is 123456');
  // Simulate the pre-policy extractor and an interruption at each checkpoint.
  f.ctx.authenticationMessage_ = () => false;
  f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {review: false}),
    candidate('SAVE+30', {review: false})], archiveAllowed: true});
  const append = f.ctx.appendCouponRow_; let count = 0;
  f.ctx.appendCouponRow_ = (...args) => {
    if (count++ === written) f.ctx.fail_('WRITE');
    return append(...args);
  };
  f.ctx.finalizeImportedMessage_ = () => f.ctx.fail_('MAIL');
  assert.equal(f.run().messages[0].status, 'failed');
  return f;
}

test('R24 ambiguous image-free Confirm and finalization require semantic admission', () => {
  const quote = 'Your verification code is “ABCDEF”';
  for (const final of [false, true]) for (const mode of ['auth', 'ordinary', 'invalid-proof', 'malformed', 'failure']) {
    const f = fixture(); f.run();
    const facts = JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17)));
    const payload = JSON.stringify(f.saved().batchIntent);
    f.ctx.getReviewMessage_ = () => ({...f.message, text: f.message.text + '\n' + quote});
    let calls = 0;
    f.ctx.callGeminiModel_ = () => {
      calls++;
      const deciding = !final || calls === 3;
      if (deciding && mode === 'failure') throw new Error('synthetic text-admission failure');
      if (deciding && mode === 'malformed') return {text: '{"authentication":null}'};
      return {text: JSON.stringify({candidates: [], authentication: deciding && mode !== 'ordinary' ?
        {quote: mode === 'invalid-proof' ? 'Brand coupon code Save+20' : quote, image: null} : null})};
    };
    f.action(2, 'Confirm');
    if (final || mode === 'ordinary') f.action(3, 'Confirm');
    assert.equal(JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17))), facts, mode);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload, mode);
    assert.equal(calls, final || mode === 'ordinary' ? 3 : 1, mode);
    if (mode === 'ordinary') {
      assert.equal(f.coupon.rows[1][17], 'Imported'); assert.equal(f.coupon.rows[2][17], 'Imported');
      assert.equal(f.mutations.length, 2);
    } else {
      assert.equal(f.mutations.length, 0);
      assert.equal(f.saved().outcome, mode === 'auth' ? 'authentication_code_message' : 'review');
      assert.equal(f.coupon.rows[1][17], 'Needs review');
      f.boot();
      if (mode === 'auth') {
        f.ctx.Gmail.Users.Messages.get = () => assert.fail('durable semantic exclusion cannot fetch');
        assert.equal(f.action(2, 'Confirm').excludedReason, 'authentication_code_message');
        f.action(2, 'Ignore'); assert.equal(f.saved().outcome, 'authentication_code_message');
      }
    }
  }
});

test('R24 partial v3 replay resolves image-free ambiguity before any retained row writes', () => {
  const quote = 'Your verification code is “aBcDeF”';
  for (const written of [0, 1]) for (const mode of ['auth', 'ordinary', 'invalid-proof', 'failure']) {
    const f = fixture();
    const append = f.ctx.appendCouponRow_; let count = 0;
    f.ctx.appendCouponRow_ = (...args) => { if (count++ === written) f.ctx.fail_('WRITE'); return append(...args); };
    assert.equal(f.run().messages[0].status, 'failed');
    const original = JSON.stringify(f.saved());
    const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
    const payload = JSON.stringify(f.saved().batchIntent);
    f.boot();
    f.state.messages = [{...f.message, text: f.message.text + '\n' + quote}];
    f.state.extractCouponOutcome = () => assert.fail('retained replay cannot replace facts');
    let calls = 0;
    f.ctx.callGeminiModel_ = () => {
      calls++;
      if (mode === 'failure') throw new Error('synthetic text replay failure');
      return {text: JSON.stringify({candidates: [], authentication: mode === 'ordinary' ? null :
        {quote: mode === 'invalid-proof' ? '“aBcDeF”' : quote, image: null}})};
    };
    if (mode === 'ordinary') { assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 3); }
    else {
      if (mode === 'auth') assert.equal(f.run().messages[0].excludedReason, 'authentication_code_message');
      else { assert.throws(f.run); assert.equal(JSON.stringify(f.saved()), original); }
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
    }
    assert.equal(calls, 1); assert.equal(f.mutations.length, 0);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload);
    f.boot();
    if (mode === 'auth') assert.equal(f.run().messages[0].excludedReason, 'authentication_code_message');
    else if (mode !== 'ordinary') {
      f.state.messages = [{...f.message, text: f.message.text + '\n' + quote}];
      f.ctx.callGeminiModel_ = () => modelResponse([]);
      assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 3);
    }
  }
});

test('R24 complete non-ambiguous image-free manual admission remains model-free', () => {
  const f = fixture(); f.run();
  f.ctx.callGeminiModel_ = () => assert.fail('ordinary complete text needs no semantic admission call');
  f.action(2, 'Confirm'); f.action(3, 'Confirm');
  assert.equal(f.mutations.length, 2);
});

test('R21 direct historical Confirm inspects image authentication before promotion without Retry', () => {
  const {png} = require('./mime-fixtures');
  const f = fixture(); f.run();
  const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
  const payload = JSON.stringify(f.saved().batchIntent);
  f.ctx.getReviewMessage_ = () => ({...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-auth'}]});
  let calls = 0;
  f.ctx.callGeminiModel_ = () => { calls++; return {text: JSON.stringify({candidates: [], authentication: {quote: '', image: 0}})}; };
  f.action(2, 'Confirm');
  assert.equal(f.saved().outcome, 'authentication_code_message');
  assert.equal(calls, 1); assert.equal(f.mutations.length, 0);
  assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
  assert.equal(JSON.stringify(f.saved().batchIntent), payload);
});

test('R21 valid non-auth image admission preserves edited manual facts and confirms normally', () => {
  const {png} = require('./mime-fixtures');
  const f = fixture(); f.run(); f.coupon.rows[1][16] = '';
  const facts = JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17)));
  const payload = JSON.stringify(f.saved().batchIntent);
  f.ctx.getReviewMessage_ = () => ({...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-offer'}]});
  let calls = 0;
  f.ctx.callGeminiModel_ = () => { calls++; return modelResponse([]); };
  f.action(2, 'Confirm'); f.action(3, 'Confirm');
  assert.equal(calls, 3); assert.equal(f.saved().status, 'confirmed'); assert.equal(f.mutations.length, 2);
  assert.equal(JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17))), facts);
  assert.equal(JSON.stringify(f.saved().batchIntent), payload);
});

test('R21 incomplete or invalid image admission cannot promote historical rows', () => {
  const {png} = require('./mime-fixtures');
  for (const mode of ['source-incomplete', 'missing-images', 'unsupported-html', 'prompt-truncated', 'model-failure',
    'malformed', 'invalid-proof', 'invalidated', 'invalid-image', 'sparse-images']) {
    const f = fixture(); f.run();
    const facts = JSON.stringify([f.coupon.rows.slice(1).map(row => row.slice(0, 17)), f.coupon.notes]);
    const payload = JSON.stringify(f.saved().batchIntent);
    const message = {...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-offer'}]};
    if (mode === 'source-incomplete') message.incomplete = true;
    if (mode === 'missing-images') { message.images = []; message.html = '<img src="https://images.example/coupon.png">'; }
    if (mode === 'unsupported-html') message.html = '<svg></svg>';
    if (mode === 'prompt-truncated') message.text += ' x'.repeat(35000);
    if (mode === 'invalid-image') message.images[0].bytes = [1, 2, 3];
    if (mode === 'sparse-images') message.images = Array(1);
    f.ctx.getReviewMessage_ = () => message;
    f.ctx.callGeminiModel_ = () => {
      if (mode === 'model-failure') throw new Error('synthetic model failure');
      if (mode === 'malformed') return {text: '{"authentication":null}'};
      if (mode === 'invalid-proof') return {text: JSON.stringify({candidates: [], authentication: {quote: '', image: 9}})};
      if (mode === 'invalidated') return modelResponse([candidate('UNSUPPORTED99', {merchant: 'Unknown', notes: ''})]);
      return assert.fail('incomplete or invalid images must not reach model');
    };
    f.action(2, 'Confirm');
    assert.equal(f.coupon.rows[1][17], 'Needs review', mode); assert.equal(f.mutations.length, 0, mode);
    assert.equal(f.saved().outcome, 'review', mode);
    assert.equal(JSON.stringify([f.coupon.rows.slice(1).map(row => row.slice(0, 17)), f.coupon.notes]), facts, mode);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload, mode);
  }
});

test('R21 refreshed finalization blocks changed image admission and preserves positive exclusion across restart', () => {
  const {png} = require('./mime-fixtures');
  for (const mode of ['auth', 'incomplete', 'failure']) {
    const f = fixture(); f.run();
    const facts = JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17)));
    const payload = JSON.stringify(f.saved().batchIntent);
    let reads = 0, calls = 0;
    f.ctx.getReviewMessage_ = () => {
      reads++;
      return {...f.message, incomplete: mode === 'incomplete' && reads === 3,
        images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-' + reads}]};
    };
    f.ctx.callGeminiModel_ = () => {
      calls++;
      if (calls === 3 && mode === 'failure') throw new Error('synthetic final model failure');
      return {text: JSON.stringify({candidates: [], authentication: calls === 3 && mode === 'auth' ? {quote: '', image: 0} : null})};
    };
    f.action(2, 'Confirm'); f.action(3, 'Confirm');
    assert.equal(f.mutations.length, 0, mode);
    assert.equal(f.saved().outcome, mode === 'auth' ? 'authentication_code_message' : 'review', mode);
    assert.equal(f.coupon.rows[1][17], 'Needs review'); assert.equal(f.coupon.rows[2][17], 'Needs review');
    assert.equal(JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17))), facts);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload);
    f.boot();
    if (mode === 'auth') {
      f.ctx.Gmail.Users.Messages.get = () => assert.fail('durable exclusion must not fetch');
      assert.equal(f.action(2, 'Confirm').excludedReason, 'authentication_code_message');
      f.action(2, 'Ignore'); assert.equal(f.saved().outcome, 'authentication_code_message');
      assert.equal(f.action(3, 'Confirm').excludedReason, 'authentication_code_message');
    }
  }
});

test('R21 direct and final image-exclusion checkpoint failures never grant Gmail authority', () => {
  const {png} = require('./mime-fixtures');
  for (const final of [false, true]) for (const responseLoss of [false, true]) {
    const f = fixture(); f.run();
    const payload = JSON.stringify(f.saved().batchIntent);
    f.ctx.getReviewMessage_ = () => ({...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-auth'}]});
    let calls = 0;
    f.ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: [],
      authentication: ++calls >= (final ? 3 : 1) ? {quote: '', image: 0} : null})});
    const save = f.ctx.saveMessageState_;
    f.ctx.saveMessageState_ = (sheet, state) => {
      if (state.outcome === 'authentication_code_message') {
        if (responseLoss) save(sheet, state);
        throw new Error('synthetic checkpoint failure');
      }
      return save(sheet, state);
    };
    if (final) f.action(2, 'Confirm');
    assert.throws(() => f.action(final ? 3 : 2, 'Confirm'));
    assert.equal(f.mutations.length, 0);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload);
    f.boot();
    assert.equal(f.saved().outcome === 'authentication_code_message', responseLoss);
    if (responseLoss) {
      f.ctx.Gmail.Users.Messages.get = () => assert.fail('response-loss exclusion remains durable');
      assert.equal(f.action(2, 'Confirm').excludedReason, 'authentication_code_message');
    }
  }
});

test('R21 replay finalization retains refreshed image exclusion in both archive-intent paths', () => {
  const {png} = require('./mime-fixtures');
  for (const fastPath of [false, true]) {
    const f = fixture();
    f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {review: false})], archiveAllowed: true});
    f.ctx.finalizeImportedMessage_ = () => f.ctx.fail_('MAIL');
    assert.equal(f.run().messages[0].status, 'failed');
    const saved = f.saved(); saved.outcome = fastPath ? 'archive' : 'review';
    f.ctx.saveMessageState_(f.journal, saved);
    const payload = JSON.stringify(saved.batchIntent);
    const facts = JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17)));
    f.boot();
    f.state.extractCouponOutcome = () => assert.fail('retained replay must not replace candidate payload');
    f.ctx.getReviewMessage_ = () => ({...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-auth'}]});
    f.ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: [], authentication: {quote: '', image: 0}})});
    assert.equal(f.run().messages[0].excludedReason, 'authentication_code_message');
    assert.equal(f.saved().outcome, 'authentication_code_message'); assert.equal(f.mutations.length, 0);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload);
    assert.equal(JSON.stringify(f.coupon.rows.slice(1).map(row => row.slice(0, 17))), facts);
    f.boot(); assert.equal(f.run().messages[0].excludedReason, 'authentication_code_message');
  }
});

test('R21 partial v3 replay admits images before any missing row and recovers after rejected admission', () => {
  const {png} = require('./mime-fixtures');
  for (const written of [0, 1]) for (const mode of ['auth', 'incomplete', 'invalid-proof', 'model-failure', 'ordinary']) {
    const f = fixture();
    const append = f.ctx.appendCouponRow_; let count = 0;
    f.ctx.appendCouponRow_ = (...args) => { if (count++ === written) f.ctx.fail_('WRITE'); return append(...args); };
    assert.equal(f.run().messages[0].status, 'failed');
    const state = f.saved(); state.labelApplied = true; f.ctx.saveMessageState_(f.journal, state);
    const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
    const payload = JSON.stringify(state.batchIntent);
    const bindings = JSON.stringify([state.candidateKeys, state.rowNumbers, state.dedupeKeys, state.candidateStates]);
    f.boot();
    f.state.extractCouponOutcome = () => assert.fail('partial replay must not replace retained candidates');
    f.state.messages = [{...f.message, incomplete: mode === 'incomplete',
      images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-replay'}]}];
    let calls = 0;
    f.ctx.callGeminiModel_ = () => {
      calls++;
      if (mode === 'model-failure') throw new Error('synthetic replay model failure');
      return {text: JSON.stringify({candidates: [], authentication: mode === 'ordinary' ? null : {quote: '', image: mode === 'invalid-proof' ? 9 : 0}})};
    };
    if (mode === 'ordinary') {
      assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 3);
    } else {
      if (mode === 'auth') assert.equal(f.run().messages[0].excludedReason, 'authentication_code_message');
      else assert.throws(f.run);
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows, mode + written);
      const saved = f.saved();
      assert.equal(JSON.stringify([saved.candidateKeys, saved.rowNumbers, saved.dedupeKeys, saved.candidateStates]), bindings);
    }
    assert.equal(calls, mode === 'incomplete' ? 0 : 1); assert.equal(f.mutations.length, 0);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload);
    assert.equal(f.saved().labelApplied, true); assert.equal(f.saved().archived, false);
    f.boot();
    f.state.extractCouponOutcome = () => assert.fail('restart must use retained candidates');
    if (mode === 'auth') {
      f.ctx.callGeminiModel_ = () => assert.fail('known exclusion must not call model');
      assert.equal(f.run().messages[0].excludedReason, 'authentication_code_message');
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
    } else if (mode !== 'ordinary') {
      f.state.messages = [{...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-replay'}]}];
      f.ctx.callGeminiModel_ = () => modelResponse([]);
      assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 3);
      assert.equal(JSON.stringify(f.saved().batchIntent), payload);
      assert.equal(f.saved().labelApplied, true); assert.equal(f.saved().archived, false);
    }
    assert.equal(f.mutations.length, 0);
  }
});

test('R20 Retry persists image authentication across Ignore, restart and Confirm', () => {
  const {png} = require('./mime-fixtures');
  const f = fixture(); f.run();
  const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
  const payload = JSON.stringify(f.saved().batchIntent);
  const message = {...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-auth'}]};
  f.ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: [], authentication: {quote: '', image: 0}})});
  const saved = f.saved();
  assert.equal(f.ctx.retryReviewCandidate_(f.coupon, 2, saved, saved.candidateStates[0], message, f.journal, f.config).excludedReason,
    'authentication_code_message');
  assert.equal(f.saved().outcome, 'authentication_code_message');
  assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
  assert.equal(JSON.stringify(f.saved().batchIntent), payload);
  f.boot(); f.action(2, 'Ignore');
  assert.equal(f.saved().outcome, 'authentication_code_message');
  assert.equal(f.saved().candidateStates[0].status, 'ignored');
  const checkpoint = JSON.stringify(f.journal.rows);
  f.ctx.Gmail.Users.Messages.get = () => assert.fail('known exclusion must not fetch');
  assert.equal(f.action(3, 'Confirm').excludedReason, 'authentication_code_message');
  assert.equal(JSON.stringify(f.journal.rows), checkpoint);
  assert.equal(f.coupon.rows[2][17], 'Needs review'); assert.equal(f.mutations.length, 0);
});

test('R20 Retry image exclusion survives checkpoint response loss without row writes', () => {
  const {png} = require('./mime-fixtures');
  for (const mode of ['not-written', 'response-loss', 'invalid-proof']) {
    const f = fixture(); f.run();
    const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
    const payload = JSON.stringify(f.journal.rows[1].slice(2));
    const message = {...f.message, images: [{mimeType: 'image/png', bytes: png, sourceId: 'synthetic-auth'}]};
    f.ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: [],
      authentication: {quote: '', image: mode === 'invalid-proof' ? 9 : 0}})});
    const getRange = f.journal.getRange;
    f.journal.getRange = (...args) => {
      const range = getRange(...args);
      return {...range, setValues: values => {
        if (args[1] === 1 && JSON.parse(values[0][1]).outcome === 'authentication_code_message') {
          if (mode === 'response-loss') range.setValues(values);
          throw new Error('checkpoint interrupted');
        }
        range.setValues(values);
      }};
    };
    const state = f.saved();
    const retry = () => f.ctx.retryReviewCandidate_(f.coupon, 2, state, state.candidateStates[0], message, f.journal, f.config);
    if (mode === 'invalid-proof') {
      assert.equal(retry().status, 'failed');
      // Existing review-error behavior exposes Confirm but cannot promote it.
      const expected = JSON.parse(rows); expected[0][1][24] = 'Confirm';
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), JSON.stringify(expected));
    } else {
      assert.throws(retry);
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
    }
    assert.equal(JSON.stringify(f.journal.rows[1].slice(2)), payload);
    assert.equal(f.mutations.length, 0);
    f.journal.getRange = getRange; f.boot();
    assert.equal(f.saved().outcome === 'authentication_code_message', mode === 'response-loss');
    if (mode === 'response-loss') {
      f.ctx.Gmail.Users.Messages.get = () => assert.fail('persisted image exclusion must not fetch');
      assert.equal(f.action(2, 'Confirm').excludedReason, 'authentication_code_message');
    }
  }
});

test('R16 readable authentication stops partial and mail-stage v3 replay without changing retained payload or rows', () => {
  for (const written of [0, 1, 2]) {
    for (const labelApplied of [false, true]) {
      const f = interruptedAuthenticationBatch(written);
      const prior = f.saved(); prior.labelApplied = labelApplied;
      f.ctx.saveMessageState_(f.journal, prior);
      const immutable = JSON.stringify(prior.batchIntent);
      const bindings = JSON.stringify([prior.candidateKeys, prior.dedupeKeys, prior.rowNumbers, prior.candidateStates]);
      const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
      const payload = JSON.stringify(f.journal.rows[1].slice(2));
      f.boot();
      f.state.extractCouponOutcome = () => assert.fail('replay must not re-extract');
      f.ctx.reconcileCandidateRows_ = () => assert.fail('excluded replay must not reconcile');
      f.ctx.appendCouponRow_ = () => assert.fail('excluded replay must not append');
      f.ctx.finalizeImportedMessage_ = () => assert.fail('excluded replay must not finalize');
      const result = f.run();
      assert.equal(result.messages[0].status, 'ignored');
      assert.equal(result.messages[0].excludedReason, 'authentication_code_message');
      const saved = f.saved();
      assert.equal(saved.version, 3); assert.equal(saved.outcome, 'authentication_code_message');
      assert.equal(JSON.stringify(saved.batchIntent), immutable);
      assert.equal(JSON.stringify([saved.candidateKeys, saved.dedupeKeys, saved.rowNumbers, saved.candidateStates]), bindings);
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
      assert.equal(JSON.stringify(f.journal.rows[1].slice(2)), payload);
      assert.equal(saved.labelApplied, labelApplied); assert.equal(saved.archived, false);
      assert.equal(f.ctx.completeCandidateBatch_(saved), written === 2);
      assert.equal(f.mutations.length, 0); assert.equal(result.imported, 0); assert.equal(result.review, 0);
      f.boot();
      const checkpoint = JSON.stringify(f.journal.rows);
      f.ctx.candidateSource_ = () => assert.fail('persisted exclusion must not rescan');
      assert.equal(f.run().messages[0].status, 'ignored');
      assert.equal(JSON.stringify(f.journal.rows), checkpoint);
      f.ctx.Gmail.Users.Messages.get = () => assert.fail('persisted exclusion must not fetch');
      assert.equal(f.ctx.mailboxProcessMessage_(f.state, {}, f.raw.id, false,
        () => assert.fail('persisted exclusion must not invoke callback'), {}), true);
      if (written) {
        const retry = f.ctx.retryReviewCandidate_(f.coupon, 2, f.saved(), f.saved().candidateStates[0],
          f.message, f.journal, f.config);
        assert.equal(retry.excludedReason, 'authentication_code_message');
        assert.equal(JSON.stringify(f.journal.rows), checkpoint);
      }
    }
  }
});

test('R16 exclusion checkpoint failure and response loss cannot authorize replay side effects', () => {
  for (const written of [0, 1, 2]) {
    for (const mode of ['not-written', 'set-then-throw', 'readback-mismatch']) {
      const f = interruptedAuthenticationBatch(written); f.boot();
      const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
      const payload = JSON.stringify(f.journal.rows[1].slice(2));
      const getRange = f.journal.getRange;
      f.journal.getRange = (...args) => {
        const range = getRange(...args); let mismatch = false;
        return {...range, getValues: () => mismatch ? [['abc123', 'mismatch']] : range.getValues(), setValues: values => {
          if (args[1] === 1 && JSON.parse(values[0][1]).outcome === 'authentication_code_message') {
            if (mode === 'not-written') throw new Error('write failed');
            range.setValues(values);
            if (mode === 'set-then-throw') throw new Error('response lost');
            mismatch = true; return;
          }
          range.setValues(values);
        }};
      };
      assert.throws(f.run);
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
      assert.equal(JSON.stringify(f.journal.rows[1].slice(2)), payload);
      assert.equal(f.mutations.length, 0);
      f.journal.getRange = getRange; f.boot();
      assert.equal(f.run().messages[0].status, 'ignored');
      assert.equal(f.saved().outcome, 'authentication_code_message');
      assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
      assert.equal(f.mutations.length, 0);
    }
  }
});

test('R19 malformed replay source fails closed and Confirm cannot bypass authentication exclusion', () => {
  for (const written of [1, 2]) {
    const f = interruptedAuthenticationBatch(written); f.boot();
    const journal = JSON.stringify(f.journal.rows); const rows = JSON.stringify(f.coupon.rows);
    f.state.messages[0].text = {};
    assert.throws(f.run, /AI/);
    assert.equal(JSON.stringify(f.journal.rows), journal); assert.equal(JSON.stringify(f.coupon.rows), rows);
    f.boot(); assert.equal(f.run().messages[0].status, 'ignored');
    const rowsBeforeConfirm = JSON.stringify([f.coupon.rows, f.coupon.notes]);
    assert.equal(f.action(2, 'Confirm').excludedReason, 'authentication_code_message');
    assert.equal(f.saved().candidateStates[0].status, 'confirmed');
    assert.equal(f.saved().outcome, 'authentication_code_message');
    assert.equal(f.ctx.completeCandidateBatch_(f.saved()), written === 2);
    assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rowsBeforeConfirm);
    assert.equal(f.mutations.length, 0);
    assert.equal(f.run().messages[0].status, 'ignored');
  }
});

test('R19 Confirm cannot promote a historical complete review batch from authentication mail', () => {
  for (const issued of ['Use code 123456 to sign in.', 'Sample Bank: Your verification code is 123456.']) {
    const f = fixture(); setSource(f, issued + ' ' + f.message.text);
    f.ctx.authenticationMessage_ = () => false;
    assert.equal(f.run().messages[0].status, 'review');
    f.boot();
    const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
    const payload = JSON.stringify(f.saved().batchIntent);
    const bindings = JSON.stringify(f.saved().candidateStates);
    f.ctx.callGeminiModel_ = () => assert.fail('Confirm must not call model');
    const result = f.action(2, 'Confirm');
    assert.equal(result.excludedReason, 'authentication_code_message');
    assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
    assert.equal(JSON.stringify(f.saved().batchIntent), payload);
    assert.equal(JSON.stringify(f.saved().candidateStates), bindings);
    assert.equal(f.saved().status, 'ignored');
    assert.equal(f.mutations.length, 0);
    assert.equal(f.action(3, 'Confirm').excludedReason, 'authentication_code_message');
  }
});

test('R19 Confirm read and exclusion-checkpoint failures leave rows and Gmail unchanged', () => {
  for (const mode of ['read-failure', 'not-written', 'response-loss']) {
    const f = fixture(); setSource(f, f.message.text + ' Your verification code is 123456');
    f.ctx.authenticationMessage_ = () => false; f.run(); f.boot();
    const rows = JSON.stringify([f.coupon.rows, f.coupon.notes]);
    const payload = JSON.stringify(f.journal.rows[1].slice(2));
    const getRange = f.journal.getRange;
    if (mode === 'read-failure') f.ctx.Gmail.Users.Messages.get = () => { throw new Error('unavailable'); };
    else f.journal.getRange = (...args) => {
      const range = getRange(...args);
      return {...range, setValues: values => {
        if (args[1] === 1 && JSON.parse(values[0][1]).outcome === 'authentication_code_message') {
          if (mode === 'response-loss') range.setValues(values);
          throw new Error('checkpoint interrupted');
        }
        range.setValues(values);
      }};
    };
    assert.throws(() => f.action(2, 'Confirm'));
    assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
    assert.equal(JSON.stringify(f.journal.rows[1].slice(2)), payload);
    assert.equal(f.mutations.length, 0);
    f.journal.getRange = getRange; f.boot();
    assert.equal(f.action(2, 'Confirm').excludedReason, 'authentication_code_message');
    assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes]), rows);
    assert.equal(f.mutations.length, 0);
  }
});

test('R19 finalization re-read cannot grant Gmail authority when authentication becomes visible', () => {
  const f = fixture(); f.run(); f.action(2, 'Confirm');
  const read = f.ctx.Gmail.Users.Messages.get; let reads = 0;
  f.ctx.Gmail.Users.Messages.get = (...args) => {
    const raw = read(...args);
    if (++reads === 1) return raw;
    const text = f.message.text + ' Your verification code is 123456';
    return {...raw, payload: {...raw.payload, body: {data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text)}}};
  };
  f.action(3, 'Confirm');
  assert.equal(reads, 2); assert.equal(f.mutations.length, 0);
  assert.equal(f.saved().status, 'ignored'); assert.equal(f.saved().outcome, 'authentication_code_message');
  assert.deepEqual(f.coupon.rows.slice(1).map(row => row[17]), ['Needs review', 'Needs review']);
});

test('real extraction keeps deterministic Notes and code-count losses in review through import and AI retry', () => {
  for (const mode of ['notes', 'code-count']) {
    const f = fixture();
    const codes = mode === 'notes' ? ['Save+20'] : Array.from({length: 13}, (_, i) => 'SAVE' + i);
    const text = 'Brand ' + codes.map(code => 'coupon code ' + code).join(' ') + (mode === 'notes' ? ' ' + 'x'.repeat(3500) : '');
    setSource(f, text); delete f.state.extractCouponOutcome;
    f.ctx.callGeminiModel_ = () => modelResponse(codes.slice(0, 12).map(code => candidate(code, {notes: '', review: false})));
    assert.equal(f.run().messages[0].status, 'review');
    assert.equal(f.saved().batchIntent.archiveAllowed, false);
    assert.equal(f.coupon.rows.length, Math.min(codes.length, 12) + 1);
    for (let row = 2; row <= f.coupon.rows.length; row++) {
      f.action(row, 'Retry with AI');
      assert.equal(f.coupon.rows[row - 1][17], 'Needs review');
      assert.equal(f.saved().status, 'review'); assert.equal(f.mutations.length, 0);
    }
    assert.equal(f.saved().batchIntent.archiveAllowed, false);
  }
});

test('real AI retry constrains raw numeric zero and rejects a different evidenced minimum without overwriting', () => {
  for (const amount of ['0', '25']) {
    const f = fixture(); setSource(f, 'Brand coupon code Save+20 Minimum 0 Other minimum 25');
    f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {minimumSpend: '0', notes: ''})], archiveAllowed: false});
    f.run(); f.coupon.rows[1][6] = 0;
    const before = JSON.stringify(f.coupon.rows);
    f.ctx.callGeminiModel_ = () => modelResponse([candidate('Save+20', {minimumSpend: amount, notes: '', review: false})]);
    f.action(2, 'Retry with AI');
    if (amount === '0') {
      assert.equal(f.coupon.rows[1][6], '0'); assert.equal(f.saved().status, 'confirmed'); assert.equal(f.mutations.length, 2);
    } else {
      f.coupon.rows[1][24] = '';
      assert.equal(JSON.stringify(f.coupon.rows), before);
      assert.equal(f.saved().status, 'review'); assert.equal(f.mutations.length, 0);
    }
  }
});

test('orphan recovery preserves numeric zero identity rather than adopting a blank-valued row', () => {
  const f = fixture(); const zero = candidate('Save+20', {minimumSpend: '0'});
  f.coupon.rows.push(f.ctx.couponRow_(f.message, candidate()), f.ctx.couponRow_(f.message, zero));
  f.coupon.rows[2][6] = 0;
  assert.equal(f.ctx.candidateRowIdentityFromRow_(f.coupon.rows[2]), f.ctx.candidateRowIdentity_(f.message, zero));
  assert.notEqual(f.ctx.candidateRowIdentityFromRow_(f.coupon.rows[2]), f.ctx.candidateRowIdentity_(f.message, candidate()));
  f.state.extractCouponOutcome = () => ({candidates: [zero], archiveAllowed: false});
  assert.equal(f.run().messages[0].status, 'review');
  assert.equal(f.coupon.rows.length, 3); assert.deepEqual(Array.from(f.saved().rowNumbers), [3]);
  assert.equal(f.mutations.length, 0);
});

test('real AI retry accepts evidenced descriptive case and whitespace variants', () => {
  const f = fixture();
  setSource(f, 'Brand coupon code Save+20 Members only All items Except clearance EUR');
  f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {merchant: ' BRAND ', validOn: 'ALL  ITEMS',
    exclusions: 'EXCEPT  CLEARANCE', currency: 'eur', notes: 'MEMBERS  ONLY'})], archiveAllowed: false});
  f.run();
  f.ctx.callGeminiModel_ = () => modelResponse([candidate('Save+20', {validOn: 'All items',
    exclusions: 'Except clearance', currency: 'EUR', review: false})]);
  f.action(2, 'Retry with AI');
  assert.equal(f.saved().status, 'confirmed'); assert.equal(f.mutations.length, 2);
  assert.equal(f.coupon.rows[1][16], 'Members only');
});

test('retry identity preserves exact code and URL suffixes but folds scheme and authority', () => {
  const f = fixture(); const base = candidate('Save+20', {website: 'https://shop.example/Offer?A=1#X'});
  const row = f.ctx.couponRow_(f.message, base);
  assert.equal(f.ctx.retryCandidateMatchesRow_({...base, website: 'HTTPS://SHOP.EXAMPLE/Offer?A=1#X'}, row), true);
  for (const patch of [{code: 'save+20'}, {code: 'Save20'}, {website: 'https://shop.example/offer?A=1#X'},
    {website: 'https://shop.example/Offer?a=1#X'}, {website: 'https://shop.example/Offer?A=1#x'}]) {
    assert.equal(f.ctx.retryCandidateMatchesRow_({...base, ...patch}, row), false, JSON.stringify(patch));
  }
});

test('partial A+B append keeps B durable through Confirm, Ignore and Retry with AI before replay', () => {
  for (const action of ['Confirm', 'Ignore', 'Retry with AI']) {
    const f = fixture(); const getRange = f.coupon.getRange; let fail = true;
    f.coupon.getRange = (...args) => {
      const range = getRange(...args);
      return {...range, setValues: values => {
        if (args[0] === 3 && args[1] === 1 && fail) throw new Error('B append unavailable');
        range.setValues(values);
      }};
    };
    assert.equal(f.run().messages[0].status, 'failed');
    assert.equal(f.saved().candidateKeys.length, 1);
    assert.equal(f.saved().batchIntent.candidates.length, 2);
    assert.equal(f.ctx.completeCandidateBatch_(f.saved()), false);
    f.boot();
    f.ctx.extractCouponOutcome_ = () => assert.fail('incomplete batch must not ask AI');
    f.action(2, action);
    assert.equal(f.saved().status, 'processing');
    assert.equal(f.saved().batchIntent.candidates[1].code, 'SAVE+30');
    assert.equal(f.mutations.length, 0);
    assert.throws(() => f.ctx.finalizeImportedMessage_(f.state, f.saved()), /STATE/);
    fail = false; f.boot();
    let extractions = 0;
    f.state.extractCouponOutcome = () => { extractions++; return {candidates: [], verifiedNonOffer: true}; };
    assert.equal(f.run().messages[0].status, 'review');
    assert.equal(extractions, 0);
    assert.equal(f.coupon.rows.length, 3);
    assert.equal(f.ctx.completeCandidateBatch_(f.saved()), true);
    assert.equal(f.coupon.rows[1][17], action === 'Confirm' ? 'Imported' : action === 'Ignore' ? 'Ignored' : 'Needs review');
    assert.equal(f.mutations.length, 0);
    f.action(3, 'Confirm');
    if (action === 'Confirm') {
      assert.equal(f.saved().status, 'confirmed'); assert.equal(f.mutations.length, 2);
    } else {
      assert.equal(f.mutations.length, 0);
      if (action === 'Retry with AI') { f.action(2, 'Confirm'); assert.equal(f.saved().status, 'confirmed'); }
    }
  }
});

test('hard interruption after a row write recovers from durable payload without a second extraction', () => {
  for (const phase of ['before-private-key', 'before-row-checkpoint', 'after-row-checkpoint']) {
    const f = fixture(); const couponRange = f.coupon.getRange; const journalRange = f.journal.getRange;
    let interrupted = false;
    f.journal.getRange = (...args) => {
      const range = journalRange(...args);
      return {...range, setValues: values => {
        if (interrupted) throw new Error('execution stopped');
        range.setValues(values);
        const saved = args[1] === 1 && JSON.parse(values[0][1]);
        if (phase === 'after-row-checkpoint' && saved && saved.candidateKeys.length === 1) {
          interrupted = true; throw new Error('execution stopped after durable checkpoint');
        }
      }};
    };
    f.coupon.getRange = (...args) => {
      const range = couponRange(...args);
      return {...range, setNote: note => {
        // The full payload must already be verified before the first row exists.
        assert.equal(f.saved().batchIntent.candidates.length, 2);
        if (phase === 'before-private-key') { interrupted = true; throw new Error('execution stopped'); }
        range.setNote(note);
        if (phase === 'before-row-checkpoint') interrupted = true;
      }};
    };
    assert.throws(f.run);
    assert.equal(f.coupon.rows.length, 2);
    assert.equal(f.mutations.length, 0);
    f.coupon.getRange = couponRange; f.journal.getRange = journalRange;
    f.boot();
    f.state.extractCouponOutcome = () => assert.fail('replay must not depend on AI');
    assert.equal(f.run().messages[0].status, 'review');
    assert.equal(f.coupon.rows.length, 3);
    assert.deepEqual(f.coupon.rows.slice(1).map(row => row[3]), ['Save+20', 'SAVE+30']);
    assert.equal(f.saved().candidateKeys.length, 2);
    assert.equal(f.mutations.length, 0);
  }
});

test('ambiguous batch-intent persistence never permits coupon writes in that invocation', () => {
  for (const mode of ['set-then-throw', 'readback-mismatch', 'not-written']) {
    const f = fixture(); const getRange = f.journal.getRange; let intercepted = false;
    f.journal.getRange = (...args) => {
      const range = getRange(...args); let mismatch = false;
      return {...range, getValues: () => mismatch ? [['abc123', 'mismatch']] : range.getValues(), setValues: values => {
        if (!intercepted && args[1] === 1 && JSON.parse(values[0][1]).version === 3) {
          intercepted = true;
          if (mode !== 'not-written') range.setValues(values);
          if (mode === 'readback-mismatch') { mismatch = true; return; }
          throw new Error('uncertain batch save');
        }
        range.setValues(values);
      }};
    };
    assert.throws(f.run); assert.equal(f.coupon.rows.length, 1); assert.equal(f.mutations.length, 0);
    f.journal.getRange = getRange; f.boot();
    let calls = 0; f.state.extractCouponOutcome = () => { calls++; return {candidates: [candidate(), candidate('SAVE+30')]}; };
    assert.equal(f.run().messages[0].status, 'review');
    assert.equal(calls, mode === 'not-written' ? 1 : 0);
    assert.equal(f.coupon.rows.length, 3);
  }
});

test('deadline between candidate writes preserves the full batch for a fresh invocation', () => {
  const f = fixture(); const getRange = f.coupon.getRange;
  f.coupon.getRange = (...args) => {
    const range = getRange(...args);
    return {...range, setNote: note => { range.setNote(note); f.state._deadlineMs = Date.now() - 1; }};
  };
  assert.equal(f.run().messages[0].status, 'failed');
  assert.equal(f.saved().candidateKeys.length, 1); assert.equal(f.saved().batchIntent.candidates.length, 2);
  f.coupon.getRange = getRange; f.boot(); f.state.extractCouponOutcome = () => assert.fail('no AI on replay');
  assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 3);
});

test('resumed complete row checkpoints revalidate edited evidence before archiving', () => {
  const f = fixture(); const getRange = f.journal.getRange; let stopped = false;
  f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {review: false})], archiveAllowed: true});
  f.journal.getRange = (...args) => {
    const range = getRange(...args);
    return {...range, setValues: values => {
      if (stopped) throw new Error('execution stopped');
      range.setValues(values);
      if (args[1] === 1 && JSON.parse(values[0][1]).candidateKeys.length) { stopped = true; throw new Error('execution stopped'); }
    }};
  };
  assert.throws(f.run); assert.equal(f.saved().outcome, '');
  f.journal.getRange = getRange; f.coupon.rows[1][16] = 'Invented factual note'; f.boot();
  assert.equal(f.run().messages[0].status, 'review');
  assert.equal(f.coupon.rows[1][17], 'Needs review'); assert.equal(f.mutations.length, 0);
});

test('large bounded payloads round-trip as literal verified chunks and retain legacy two-column records', () => {
  const f = fixture(); const state = f.ctx.newMessageState_('abc123'); state.candidateStates = [];
  state.status = 'processing'; f.ctx.saveMessageState_(f.journal, state);
  const candidates = Array.from({length: 12}, (_, i) => {
    const value = candidate(String(i));
    for (const key of Object.keys(value)) if (typeof value[key] === 'string' && key !== 'confidence' && key !== 'code') {
      value[key] = '\u0001'.repeat(key === 'notes' ? 3500 : 1000);
    }
    value.code = '\u0001'.repeat(990) + i;
    return value;
  });
  f.ctx.createBatchIntent_(state, {candidates, archiveAllowed: false});
  f.ctx.saveMessageState_(f.journal, state);
  assert.ok(f.journal.getLastColumn() > 26);
  assert.ok(f.journal.rows[1].slice(2).every(cell => cell.startsWith('mycoupons-json:')));
  assert.equal(JSON.stringify(f.saved()), JSON.stringify(state));
  const legacy = f.ctx.newMessageState_('def456'); f.ctx.saveMessageState_(f.journal, legacy);
  assert.equal(f.ctx.getMessageState_(f.journal, 'def456').version, 1);
  assert.ok(f.journal.rows[2].slice(2).every(cell => cell === ''));
  const payload = f.journal.rows[1].slice(2); const getRange = f.journal.getRange;
  f.journal.getRange = (...args) => {
    const range = getRange(...args);
    return {...range, setValues: values => { assert.equal(args[1], 1, 'committed payload is immutable'); range.setValues(values); }};
  };
  state.attempts++; f.ctx.saveMessageState_(f.journal, state);
  assert.deepEqual(f.journal.rows[1].slice(2), payload);
  const smaller = JSON.parse(JSON.stringify(state)); smaller.batchIntent.candidates.pop();
  assert.throws(() => f.ctx.saveMessageState_(f.journal, smaller), /STATE/);
  assert.deepEqual(f.journal.rows[1].slice(2), payload);
  f.journal.rows[1][2] = ''; assert.throws(f.saved, /STATE/);
});

test('partially staged payloads leave no row authority and can be overwritten on a fresh invocation', () => {
  const f = fixture(); const getRange = f.journal.getRange; let cut = false;
  f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {notes: '\u0001'.repeat(3500)}),
    candidate('SAVE+30', {notes: '\u0001'.repeat(3500)})]});
  f.journal.getRange = (...args) => {
    const range = getRange(...args);
    return {...range, setValues: values => {
      if (args[1] === 3 && !cut) {
        assert.ok(values[0].length > 1); cut = true;
        range.setValues([[values[0][0]]]); throw new Error('only first staging cell saved');
      }
      range.setValues(values);
    }};
  };
  assert.throws(f.run); assert.equal(f.coupon.rows.length, 1); assert.equal(f.saved().version, 1);
  f.journal.getRange = getRange; f.boot();
  assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 3);
  assert.ok(f.journal.rows[1].slice(3).every(cell => cell === ''), 'smaller replacement clears uncommitted chunks');
});

test('batch preflight reserves metadata capacity for all future image-evidence bindings', () => {
  const f = fixture();
  f.state.extractCouponOutcome = () => ({candidates: Array.from({length: 12}, (_, i) => candidate(String(i), {
    imageEvidence: {merchant: {sourceId: 's'.repeat(18000), valueDigest: 'a'.repeat(64), digest: 'b'.repeat(64)}}
  }))});
  assert.throws(f.run, /STATE/);
  assert.equal(f.coupon.rows.length, 1); assert.equal(f.mutations.length, 0);
  assert.equal(f.saved().version, 1);
});

function leaveUnpublishedPayload(f) {
  const getRange = f.journal.getRange;
  f.journal.getRange = (...args) => {
    const range = getRange(...args);
    return {...range, setValues: values => {
      if (args[1] === 1 && JSON.parse(values[0][1]).version === 3) throw new Error('metadata publish interrupted');
      range.setValues(values);
    }};
  };
  assert.throws(f.run); assert.equal(f.saved().version, 1);
  assert.ok(f.journal.rows[1].slice(2).some(Boolean));
  f.journal.getRange = getRange; f.boot();
}

test('abandoned staging is cleared before empty, extraction-error and read-error outcomes', () => {
  for (const mode of ['nonoffer', 'awaiting_extraction', 'extract-error', 'read-error']) {
    const f = fixture(); leaveUnpublishedPayload(f);
    if (mode === 'read-error') {
      f.ctx.mailboxReadFailure_(f.journal, 'abc123', {startMs: 0, endMs: Date.now()}, false);
    } else {
      f.state.extractCouponOutcome = () => {
        if (mode === 'extract-error') throw new Error('model unavailable');
        return {candidates: [], verifiedNonOffer: mode === 'nonoffer'};
      };
      f.run();
    }
    assert.ok(f.journal.rows[1].slice(2).every(cell => cell === ''), mode);
    f.boot(); const saved = f.saved();
    assert.equal(saved.status, mode.endsWith('error') ? 'failed' : mode);
    assert.equal(f.coupon.rows.length, 1); assert.equal(f.mutations.length, 0);
    f.ctx.saveMessageState_(f.journal, f.ctx.newMessageState_('def456'));
    assert.equal(Object.keys(f.ctx.readMessageJournal_(f.journal)).length, 2);
  }
});

test('ambiguous staging clears cannot publish a non-batch outcome before verified cleanup', () => {
  for (const mode of ['not-cleared', 'cleared-then-throw', 'readback-mismatch', 'empty-readback']) {
    const f = fixture(); leaveUnpublishedPayload(f);
    const getRange = f.journal.getRange;
    f.journal.getRange = (...args) => {
      const range = getRange(...args); let mismatch = false;
      return {...range, getValues: () => mismatch ? (mode === 'empty-readback' ? [[]] : [['mycoupons-json:stale']]) : range.getValues(), setValues: values => {
        if (args[1] === 3 && values[0].every(cell => cell === '')) {
          if (mode !== 'not-cleared') range.setValues(values);
          if (mode === 'readback-mismatch' || mode === 'empty-readback') { mismatch = true; return; }
          throw new Error('ambiguous clear');
        }
        range.setValues(values);
      }};
    };
    const next = f.saved(); next.status = 'nonoffer'; next.outcome = 'empty';
    assert.throws(() => f.ctx.saveMessageState_(f.journal, next));
    f.journal.getRange = getRange; f.boot();
    assert.equal(f.saved().status, 'processing'); assert.equal(f.coupon.rows.length, 1);
    const retry = f.saved(); retry.status = 'nonoffer'; retry.outcome = 'empty';
    f.ctx.saveMessageState_(f.journal, retry); f.boot(); assert.equal(f.saved().status, 'nonoffer');
  }
});

test('deployed completed mail failures return to review without re-extraction or repeated Gmail mutations', () => {
  for (const archived of [false, true]) for (const readFailed of [false, true]) {
    const f = fixture(); const key = 'a'.repeat(64);
    const legacy = f.ctx.newMessageState_('abc123');
    Object.assign(legacy, {version: 2, status: 'failed', outcome: 'review', failureStage: 'mail', lastError: 'MAIL',
      labelApplied: true, archived, candidateKeys: [key], dedupeKeys: [key], rowNumbers: [2],
      candidateStates: [{key, rowNumber: 2, status: 'review', imageEvidence: {}}]});
    f.coupon.rows.push(f.ctx.couponRow_(f.message, candidate())); f.coupon.rows[1][16] = key;
    f.ctx.saveMessageState_(f.journal, legacy);
    if (readFailed) f.ctx.mailboxReadFailure_(f.journal, 'abc123', {startMs: 0, endMs: Date.now()}, false);
    f.boot(); f.state.extractCouponOutcome = () => assert.fail('completed legacy batch must not be re-extracted');
    assert.equal(f.ctx.completeCandidateBatch_(f.saved()), true);
    assert.equal(f.run().messages[0].status, 'review'); assert.equal(f.coupon.rows.length, 2);
    assert.equal(f.saved().lastError, ''); assert.equal(f.mutations.length, 0);
    f.action(2, 'Confirm'); assert.equal(f.saved().status, 'confirmed');
    assert.equal(f.mutations.length, archived ? 0 : 1);
    if (!archived) assert.deepEqual(JSON.parse(JSON.stringify(f.mutations)), [{removeLabelIds: ['INBOX']}]);
  }
});

test('deployed v2 interrupted batches stay fail-closed across retry and owner confirmation', () => {
  for (const priorStatus of ['failed', 'processing']) {
    const f = fixture();
    const legacy = f.ctx.newMessageState_('abc123'); legacy.version = 2; legacy.status = priorStatus;
    const key = f.ctx.digest_('abc123|0|brand|Save+20|||');
    legacy.candidateKeys = [key]; legacy.dedupeKeys = [key]; legacy.rowNumbers = [2];
    legacy.candidateStates = [{key, rowNumber: 2, status: 'review', imageEvidence: {}}]; legacy.failureStage = 'extract';
    f.coupon.rows.push(f.ctx.couponRow_(f.message, candidate())); f.coupon.rows[1][16] = key;
    f.ctx.saveMessageState_(f.journal, legacy); f.boot();
    f.state.extractCouponOutcome = () => assert.fail('cannot infer omitted legacy payloads from a new extraction');
    assert.equal(f.run().messages[0].status, 'failed');
    assert.equal(f.saved().failureStage, 'legacy_batch');
    f.action(2, 'Confirm'); assert.equal(f.ctx.completeCandidateBatch_(f.saved()), false);
    assert.equal(f.saved().failureStage, 'legacy_batch'); assert.equal(f.mutations.length, 0);
    assert.equal(f.coupon.rows.length, 2);
  }
});

test('Retry with AI rejects extra, missing or ambiguous candidates without overwriting reviewed rows', () => {
  for (const proposals of [[candidate()], [candidate(), candidate('SAVE+30'), candidate('NEW40')],
    [candidate(), candidate()]]) {
    const f = fixture(); f.run(); const before = JSON.stringify(f.coupon.rows);
    f.ctx.extractCouponOutcome_ = () => ({candidates: proposals, archiveAllowed: true});
    f.action(2, 'Retry with AI');
    // Only the failure action hint is allowed to change.
    f.coupon.rows[1][24] = '';
    assert.equal(JSON.stringify(f.coupon.rows), before); assert.equal(f.mutations.length, 0);
    assert.equal(f.saved().status, 'review');
  }
});

test('Retry with AI migrates deployed Notes keys and normalizes Date expiry on moved sibling rows', () => {
  const f = fixture(); f.state.extractCouponOutcome = () => ({candidates: [candidate('Save+20', {expiry: '2026-10-01'}), candidate('SAVE+30')]});
  f.run();
  const old = f.saved(); delete old.batchIntent; old.version = 2;
  old.candidateStates.forEach(item => { f.coupon.rows[item.rowNumber - 1][16] = item.key; });
  f.coupon.notes.splice(0); f.journal.rows.splice(1); f.ctx.saveMessageState_(f.journal, old);
  f.coupon.rows[1][9] = new Date('2026-09-30T22:00:00Z');
  [f.coupon.rows[1], f.coupon.rows[2]] = [f.coupon.rows[2], f.coupon.rows[1]];
  f.ctx.extractCouponOutcome_ = () => ({candidates: [candidate('Save+20', {expiry: '2026-10-01', review: false}), candidate('SAVE+30')], archiveAllowed: true});
  f.action(3, 'Retry with AI');
  assert.equal(f.coupon.rows[2][16], 'Members only');
  assert.equal(f.coupon.rows[2][9], '2026-10-01');
  assert.equal(f.coupon.rows[2][17], 'Imported');
  assert.match(f.coupon.notes[2][13], /^mycoupons-candidate:/);
  assert.deepEqual(Array.from(f.saved().rowNumbers), [3, 2]);
  assert.equal(f.mutations.length, 0);
  f.action(2, 'Confirm'); assert.equal(f.saved().status, 'confirmed'); assert.equal(f.mutations.length, 2);
});

test('real extraction persists duplicated coded proposals once and distinct URL offers separately', () => {
  for (const mode of ['duplicate-code', 'case-sensitive-url']) {
    const f = fixture();
    const urls = ['https://shop.example.com/Promo?A=1#X', 'https://shop.example.com/promo?a=1#x'];
    const text = mode === 'duplicate-code' ? 'Brand coupon code Save+20 Members only' : 'Brand Members only ' + urls.join(' ');
    f.raw.payload.body = {data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text)};
    f.boot(); delete f.state.extractCouponOutcome;
    const proposals = mode === 'duplicate-code' ? [candidate(), candidate()] : urls.map(website => candidate('', {website}));
    proposals.forEach(proposal => {
      delete proposal.imageEvidence; proposal.review = false;
      proposal.evidence = Object.fromEntries(Object.entries(proposal).filter(([key, value]) =>
        typeof value === 'string' && value && key !== 'confidence').map(([key, value]) => [key, {quote: value}]));
    });
    f.ctx.callGeminiModel_ = () => ({text: JSON.stringify({authentication: null, candidates: proposals.map(wireCandidate)})});
    assert.equal(f.run().messages[0].status, 'confirmed');
    const expected = mode === 'duplicate-code' ? 1 : 2;
    assert.equal(f.coupon.rows.length, expected + 1);
    assert.equal(f.saved().batchIntent.candidates.length, expected);
    assert.equal(f.saved().candidateKeys.length, expected);
    assert.equal(f.mutations.length, 2);
    f.run(); assert.equal(f.coupon.rows.length, expected + 1); assert.equal(f.mutations.length, 2);
  }
});

const mimeFixture = require('./mime-fixtures');
function recoveredMimeFixture(mode, form, source = mimeFixture.text) {
  const f = fixture();
  f.raw.payload = {...mimeFixture.payload(mode, form, source), headers: f.raw.payload.headers};
  f.boot(); delete f.state.extractCouponOutcome;
  f.ctx.callGeminiModel_ = () => modelResponse([candidate('Save+20', {review: false, notes: ''})]);
  f.ctx.Gmail.Users.Messages.Attachments = {get: () => assert.fail('no document reads')};
  return f;
}

test('recovered MIME remains review-only through extraction, Retry, replay and incomplete-admission Confirm', () => {
  for (const mode of ['mismatch', 'files']) {
    for (const form of mimeFixture.forms) {
      const f = recoveredMimeFixture(mode, form);
      assert.equal(f.message.incomplete, true);
      assert.equal(f.run().messages[0].status, 'review');
      assert.equal(f.saved().batchIntent.archiveAllowed, false);
      assert.equal(f.coupon.rows[1][3], 'Save+20');
      f.action(2, 'Retry with AI');
      assert.equal(f.coupon.rows[1][17], 'Needs review');
      assert.equal(f.saved().status, 'review'); assert.equal(f.mutations.length, 0);
      // A restarted execution replays its durable reviewed batch without
      // re-extraction or upgrading the row's disposition.
      const intent = JSON.stringify(f.saved().batchIntent);
      const interrupted = f.saved(); interrupted.status = 'processing'; interrupted.failureStage = 'write';
      f.ctx.saveMessageState_(f.journal, interrupted);
      f.boot(); f.state.extractCouponOutcome = () => assert.fail('no extraction on replay');
      assert.equal(f.run().messages[0].status, 'review');
      assert.equal(JSON.stringify(f.saved().batchIntent), intent);
      assert.equal(f.coupon.rows[1][17], 'Needs review'); assert.equal(f.mutations.length, 0);
      // R21 requires complete admission coverage even for explicit factual review.
      f.action(2, 'Confirm');
      assert.equal(f.saved().status, 'review'); assert.equal(f.mutations.length, 0);
      assert.equal(f.coupon.rows[1][17], 'Needs review');
      assert.equal(JSON.stringify(f.saved().batchIntent), intent);
    }
  }
});

test('recovered MIME with zero AI and deterministic candidates remains reachable and never becomes a non-offer', () => {
  for (const mode of ['mismatch', 'files']) {
    for (const form of mimeFixture.forms) {
      const f = recoveredMimeFixture(mode, form, 'Ordinary message\r\n');
      f.ctx.callGeminiModel_ = () => modelResponse([]);
      assert.equal(f.run().messages[0].status, 'awaiting_extraction');
      assert.equal(f.saved().status, 'awaiting_extraction');
      assert.equal(f.coupon.rows.length, 1); assert.equal(f.mutations.length, 0);
      const saved = f.saved(); saved.nextRetryAt = new Date(Date.now() - 1).toISOString();
      f.ctx.saveMessageState_(f.journal, saved);
      f.boot(); delete f.state.extractCouponOutcome; f.ctx.callGeminiModel_ = () => modelResponse([]);
      assert.equal(f.ctx.awaitingMessageExtraction_(f.saved()), true);
      assert.equal(f.run().messages[0].status, 'awaiting_extraction');
      assert.equal(f.mutations.length, 0);
    }
  }
});

test('recovered MIME Confirm rejects unevidenced fields and Ignore leaves Gmail untouched', () => {
  for (const mode of ['mismatch', 'files']) {
    const f = recoveredMimeFixture(mode, 'rest'); f.run();
    f.coupon.rows[1][3] = 'UNSUPPORTED99';
    f.action(2, 'Confirm');
    assert.equal(f.saved().status, 'review'); assert.equal(f.mutations.length, 0);
    f.coupon.rows[1][3] = 'Save+20';
    f.action(2, 'Ignore'); assert.equal(f.saved().status, 'ignored'); assert.equal(f.mutations.length, 0);
  }
});

test('recovered MIME partial batches cannot append or finalize while admission coverage is incomplete', () => {
  for (const mode of ['mismatch', 'files']) {
    for (const form of ['rest', 'signed']) {
      for (const action of ['Confirm', 'Ignore', 'Retry with AI']) {
        const f = recoveredMimeFixture(mode, form, mimeFixture.text + 'Brand coupon code SAVE+30\r\n');
        f.ctx.callGeminiModel_ = () => modelResponse(['Save+20', 'SAVE+30'].map(code => candidate(code, {review: false, notes: ''})));
        const getRange = f.coupon.getRange; let fail = true;
        f.coupon.getRange = (...args) => {
          const range = getRange(...args);
          return {...range, setValues: values => {
            if (args[0] === 3 && args[1] === 1 && fail) throw Error('synthetic second-row failure');
            range.setValues(values);
          }};
        };
        assert.equal(f.run().messages[0].status, 'failed');
        assert.equal(f.saved().batchIntent.archiveAllowed, false);
        assert.equal(f.saved().batchIntent.candidates.length, 2);
        assert.equal(f.ctx.completeCandidateBatch_(f.saved()), false);
        f.boot(); f.ctx.extractCouponOutcome_ = () => assert.fail('no incomplete-batch extraction');
        f.action(2, action); assert.equal(f.mutations.length, 0);
        assert.throws(() => f.ctx.finalizeImportedMessage_(f.state, f.saved()), /STATE/);
        const retained = JSON.stringify([f.coupon.rows, f.coupon.notes, f.journal.rows]);
        fail = false; f.boot(); f.state.extractCouponOutcome = () => assert.fail('no replay extraction');
        assert.throws(f.run, /REVIEW/);
        assert.equal(JSON.stringify([f.coupon.rows, f.coupon.notes, f.journal.rows]), retained);
        assert.equal(f.coupon.rows.length, 2); assert.equal(f.mutations.length, 0);
      }
    }
  }
});

test('malformed typed responses leave initial imports and AI retries without coupon or Gmail mutations', () => {
  for (const mode of ['missing-evidence', 'array-evidence', 'excess-offers']) {
    const badResponse = () => {
      const proposals = JSON.parse(modelResponse([candidate('Save+20', {review: false})]).text).candidates;
      if (mode === 'missing-evidence') proposals[0].notes = {value: 'Members only', quote: '', image: null};
      if (mode === 'array-evidence') proposals[0].code.quote = ['Save+20'];
      if (mode === 'excess-offers') while (proposals.length < 13) proposals.push(proposals[0]);
      return {text: JSON.stringify({authentication: null, candidates: proposals})};
    };
    const initial = fixture(); delete initial.state.extractCouponOutcome;
    initial.ctx.callGeminiModel_ = badResponse;
    assert.equal(initial.run().messages[0].status, 'failed');
    assert.equal(initial.saved().batchIntent, undefined);
    assert.equal(initial.coupon.rows.length, 1); assert.equal(initial.mutations.length, 0);
    initial.run(); assert.equal(initial.coupon.rows.length, 1); assert.equal(initial.mutations.length, 0);

    const retry = fixture(); retry.run();
    const beforeRows = JSON.stringify(retry.coupon.rows);
    const beforeIntent = JSON.stringify(retry.saved().batchIntent);
    retry.ctx.callGeminiModel_ = badResponse;
    retry.action(2, 'Retry with AI');
    retry.coupon.rows[1][24] = '';
    assert.equal(JSON.stringify(retry.coupon.rows), beforeRows);
    assert.equal(JSON.stringify(retry.saved().batchIntent), beforeIntent);
    assert.equal(retry.saved().status, 'review'); assert.equal(retry.mutations.length, 0);
  }
});
