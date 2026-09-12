const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function sheetMock(rows = [['Message ID', 'State JSON']]) {
  const values = rows.map(row => row.slice());
  return {
    getLastRow: () => values.length,
    getLastColumn: () => values.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({getValues: () => values.map(row => row.slice()),
      getDisplayValues: () => values.map(row => row.map(value => String(value ?? '')))}),
    getRange: (row, column, rowCount, columnCount) => ({
      getValues: () => Array.from({length: rowCount}, (_, r) => Array.from({length: columnCount}, (_, c) => values[row - 1 + r]?.[column - 1 + c] ?? '')),
      getDisplayValues: () => values.slice(row - 1, row - 1 + rowCount).map(item => item.slice(column - 1, column - 1 + columnCount).map(value => String(value ?? ''))),
      setValues: next => { for (let r = 0; r < rowCount; r++) { while (values.length < row + r) values.push([]); while (values[row - 1 + r].length < column + columnCount - 1) values[row - 1 + r].push(''); for (let c = 0; c < columnCount; c++) values[row - 1 + r][column - 1 + c] = next[r][c]; } }
    }), _values: values
  };
}

function body(value) { const bytes = Buffer.from(value, 'utf8'); return {data: bytes.toString('base64url'), size: bytes.length}; }
function message(id, receivedAtMs) { return {id, threadId: 'thread-' + id, internalDate: String(receivedAtMs), payload: {mimeType: 'text/plain', headers: [{name: 'From', value: 'offers@example.com'}, {name: 'Subject', value: 'Offer ' + id}], body: body('coupon code SAVE20')}}; }
function installGmail(ctx, list, get) {
  const calls = {list: [], get: []};
  ctx.UrlFetchApp = {fetch: (url, request) => {
    assert.equal(request.followRedirects, false); assert.equal(request.muteHttpExceptions, true);
    assert.equal(request.headers.Authorization, 'Bearer oauth-token');
    const parsed = new URL(url); const options = Object.fromEntries(parsed.searchParams);
    options.maxResults = Number(options.maxResults);
    calls.list.push({userId: 'me', options});
    try { const page = list(options); return {getResponseCode: () => 200, getContentText: () => JSON.stringify(page)}; }
    catch (error) {
      if (!error.code) throw error;
      return {getResponseCode: () => error.code, getContentText: () => JSON.stringify({error: {code: error.code, message: error.message}})};
    }
  }};
  ctx.Gmail.Users.Messages = {get: (userId, id, options) => { calls.get.push({userId, id, options}); return get(id, options); }};
  return calls;
}
function state(journal, startMs, deadlineMs) { return {journalSheet: journal, recoveryStart: startMs, _deadlineMs: deadlineMs}; }

test('discovers all default-search mail in a frozen window without label or unread filters', () => {
  const {ctx} = harness(); const journal = sheetMock();
  const start = Date.parse('2026-05-21T22:00:00Z'); const end = Date.parse('2026-05-23T22:00:00Z');
  ctx.saveMailboxScanState_(ctx.mailboxScanState_(start, end));
  const calls = installGmail(ctx, options => { assert.equal(options.labelIds, undefined); assert.equal(options.q, 'after:1779400799 before:1779573601'); return {messages: [{id: 'abc123'}, {id: 'deadbeef'}, {id: 'face'}]}; }, id => message(id, id === 'abc123' ? start - 1 : id === 'deadbeef' ? start + 1 : end + 1));
  const received = [];
  const result = ctx.scanCouponMessages_(state(journal, start), item => { received.push(item.id); return {messageId: item.id, status: 'review', rows: []}; });
  assert.deepEqual(received, ['deadbeef']); assert.equal(result.errors.length, 0); assert.equal(calls.get.length, 3);
  assert.equal(ctx.getMessageState_(journal, 'abc123').outcome, 'outside-window'); assert.equal(ctx.getMessageState_(journal, 'face').status, 'deferred');
});

test('persists listed IDs before fetching and retains failed reads through journal retry', () => {
  const {ctx, properties} = harness(); const journal = sheetMock();
  const start = Date.parse('2026-05-21T22:00:00Z'); const end = Date.parse('2026-05-23T22:00:00Z');
  ctx.saveMailboxScanState_(ctx.mailboxScanState_(start, end));
  installGmail(ctx, () => ({messages: [{id: 'abc123'}, {id: 'deadbeef'}]}), id => { assert.ok(JSON.parse(properties.MYCOUPONS_MAILBOX_SCAN_STATE).pendingIds.includes(id)); if (id === 'abc123') throw new Error('temporary'); return message(id, start + 1); });
  const result = ctx.scanCouponMessages_(state(journal, start), item => ({messageId: item.id, status: 'review', rows: []}));
  assert.deepEqual(JSON.parse(JSON.stringify(result.errors)), [{messageId: 'abc123', code: 'MAIL', retryable: true}]);
  assert.equal(ctx.getMessageState_(journal, 'abc123').status, 'failed'); assert.equal(ctx.getMessageState_(journal, 'deadbeef').status, 'pending');
});

test('restarts a rejected token only after the identical tokenless query succeeds', () => {
  const {ctx} = harness(); const journal = sheetMock();
  const start = Date.parse('2026-05-21T22:00:00Z'); const end = Date.parse('2026-05-23T22:00:00Z');
  const scan = ctx.mailboxScanState_(start, end); scan.pageToken = 'stale'; ctx.saveMailboxScanState_(scan);
  let listed = 0;
  const calls = installGmail(ctx, options => { listed++; if (listed === 1) { assert.equal(options.pageToken, 'stale'); const error = new Error('Invalid page token'); error.code = 400; throw error; } assert.equal(options.pageToken, undefined); return {messages: [{id: 'abc123'}]}; }, id => message(id, start + 1));
  const result = ctx.scanCouponMessages_(state(journal, start), item => ({messageId: item.id, status: 'review', rows: []}));
  assert.equal(result.messages.length, 1); assert.equal(calls.list.length, 2);
  const fresh = ctx.mailboxScanState_(start, end); fresh.pageToken = 'stale'; ctx.saveMailboxScanState_(fresh);
  installGmail(ctx, () => { throw new Error('permission denied'); }, () => assert.fail('must not fetch'));
  assert.throws(() => ctx.scanCouponMessages_(state(journal, start), () => {}), /MAIL/);
});

test('deadline leaves the frozen cursor and pending message reachable without a fetch', () => {
  const {ctx, properties} = harness(); const journal = sheetMock();
  const start = Date.parse('2026-05-21T22:00:00Z'); const end = Date.parse('2026-05-23T22:00:00Z');
  const scan = ctx.mailboxScanState_(start, end); scan.pendingIds = ['abc123']; ctx.saveMailboxScanState_(scan);
  const calls = installGmail(ctx, () => assert.fail('must not list'), () => assert.fail('must not fetch'));
  const result = ctx.scanCouponMessages_(state(journal, start, Date.now() - 1), () => assert.fail('must not process'));
  assert.equal(result.truncated, true); assert.equal(calls.get.length, 0); assert.deepEqual(JSON.parse(properties.MYCOUPONS_MAILBOX_SCAN_STATE).pendingIds, ['abc123']);
});

test('a completed window advances from its durable end, never from coupon recovery again', () => {
  const {ctx} = harness(); const journal = sheetMock();
  const start = Date.parse('2026-05-21T22:00:00Z'); const end = Date.parse('2026-05-23T22:00:00Z');
  const scan = ctx.mailboxScanState_(start, end); scan.complete = true; ctx.saveMailboxScanState_(scan);
  const resumed = ctx.loadMailboxScanState_(start);
  assert.equal(resumed.startMs, end);
  assert.equal(resumed.complete, false);
  installGmail(ctx, () => ({messages: []}), () => assert.fail('must not fetch'));
  ctx.scanCouponMessages_(state(journal, start), () => {});
});

test('rejects a mismatched fetched identity and rotates durable retries', () => {
  const {ctx} = harness(); const journal = sheetMock();
  const start = Date.parse('2026-05-21T22:00:00Z'); const end = Date.parse('2026-05-23T22:00:00Z');
  ctx.saveMailboxScanState_(ctx.mailboxScanState_(start, end));
  installGmail(ctx, () => ({messages: [{id: 'abc123'}]}), () => message('deadbeef', start + 1));
  const mismatch = ctx.scanCouponMessages_(state(journal, start), () => assert.fail('must not dispatch'));
  assert.deepEqual(JSON.parse(JSON.stringify(mismatch.errors)), [{messageId: 'abc123', code: 'MAIL', retryable: true}]);
  ['aa', 'bb', 'cc', 'dd'].forEach(id => { const failed = ctx.newMessageState_(id); failed.status = 'failed'; failed.failureStage = 'read|' + start + '|' + end; ctx.saveMessageState_(journal, failed); });
  const fetched = [];
  installGmail(ctx, () => ({messages: []}), id => { fetched.push(id); throw new Error('retry'); });
  ctx.scanCouponMessages_(state(journal, start), () => {});
  ctx.scanCouponMessages_(state(journal, start), () => {});
  assert.ok(fetched.includes('dd'));
});

test('owner-only Gmail read diagnostic exposes only stage outcomes', () => {
  const {ctx, properties, config} = harness();
  installGmail(ctx, () => ({messages: []}), id => message(id, Date.parse('2026-05-22T00:00:00Z')));
  const before = JSON.stringify(properties);
  const shape = {idType: 'string', threadIdType: 'string', internalDateType: 'string', payloadType: 'object',
    payloadHeadersType: 'array', payloadPartsType: 'undefined'};
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123'))), {
    rawShape: shape, read: 'ok', mime: 'ok', html: 'ok', imageParts: 'ok', acquisition: 'ok', canonical: 'ok'
  });
  assert.equal(JSON.stringify(properties), before);
  ctx.Gmail.Users.Messages.get = () => { throw new Error('provider detail must not escape'); };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123'))), {
    rawShape: 'not-run', read: 'error', mime: 'not-run', html: 'not-run', imageParts: 'not-run', acquisition: 'not-run', canonical: 'not-run'
  });
  ctx.Gmail.Users.Messages.get = () => message('abc123', Date.parse('2026-05-22T00:00:00Z'));
  ctx.htmlContent_ = () => { throw new Error('provider detail must not escape'); };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123'))), {
    rawShape: shape, read: 'ok', mime: 'ok', html: 'error', imageParts: 'ok', acquisition: 'error', canonical: 'error'
  });
  const fresh = harness();
  installGmail(fresh.ctx, () => ({messages: []}), id => message(id, Date.parse('2026-05-22T00:00:00Z')));
  const freshBefore = JSON.stringify(fresh.properties);
  fresh.ctx.collectImageParts_ = () => { throw new Error('part details must not escape'); };
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.ctx.diagnoseGmailRead('abc123'))), {
    rawShape: shape, read: 'ok', mime: 'ok', html: 'ok', imageParts: 'error', acquisition: 'error', canonical: 'error'
  });
  assert.equal(JSON.stringify(fresh.properties), freshBefore);
  let reads = 0;
  ctx.Gmail.Users.Messages.get = () => { reads++; return message('abc123', Date.parse('2026-05-22T00:00:00Z')); };
  ctx.Gmail.Users.getProfile = () => ({emailAddress: 'other@example.com'});
  assert.throws(() => ctx.diagnoseGmailRead('abc123'), /OWNER/);
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(properties), before);
  ctx.Gmail.Users.getProfile = () => ({emailAddress: config.ownerEmail});
});
