const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

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
