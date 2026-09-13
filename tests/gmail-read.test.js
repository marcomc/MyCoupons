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

test('canonical authentication admission precedes all image acquisition and retains original source', () => {
  const {authenticationMessages, ordinaryMessages} = require('./authentication-fixtures');
  const {ctx} = harness();
  let images = 0;
  ctx.acquireMessageImages_ = () => { images++; return {images: [], incomplete: false}; };
  for (const source of authenticationMessages.concat(ordinaryMessages)) {
    const raw = {id: 'abc123', internalDate: '0', payload: {mimeType: source.html ? 'text/html' : 'text/plain',
      headers: [{name: 'Subject', value: source.subject || ''}], body: body(source.html || source.text || '')}};
    const before = images;
    const canonical = ctx.canonicalGmailMessage_(raw);
    const excluded = authenticationMessages.includes(source);
    assert.equal(images - before, excluded ? 0 : 1, JSON.stringify(source));
    assert.equal(canonical.subject, source.subject || '');
    assert.equal(canonical.text, source.html ? '' : source.text || '');
    assert.equal(canonical.html, source.html || '');
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(canonical)), excluded);
  }
});

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
  const trace = {parts: [{index: 0, parent: null, stage: 'complete', status: 'ok',
    partType: 'object', mimeTypeType: 'string', mimeClass: 'plain', headersType: 'array', headerIndex: 1,
    headerType: 'object', headerNameType: 'string', headerValueType: 'string',
    bodyType: 'object', dataType: 'string', dataLength: 24, dataLengthRemainder: 0, dataSyntaxValid: true,
    paddingLength: 0, sizeType: 'number', sizeValid: true, bytesType: 'array',
    bytesLengthType: 'number', bytesLength: 18, sizeMatches: true, charsetClass: 'utf8', decodedType: 'string'}], omitted: 0};
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123'))), {
    mimeTrace: trace, rawShape: shape, read: 'ok', mime: 'ok', html: 'ok', imageParts: 'ok', acquisition: 'ok', canonical: 'ok'
  });
  assert.equal(JSON.stringify(properties), before);
  ctx.Gmail.Users.Messages.get = () => { throw new Error('provider detail must not escape'); };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123'))), {
    mimeTrace: {parts: [], omitted: 0}, rawShape: 'not-run', read: 'error', mime: 'not-run', html: 'not-run', imageParts: 'not-run', acquisition: 'not-run', canonical: 'not-run'
  });
  ctx.Gmail.Users.Messages.get = () => message('abc123', Date.parse('2026-05-22T00:00:00Z'));
  ctx.htmlContent_ = () => { throw new Error('provider detail must not escape'); };
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123'))), {
    mimeTrace: trace, rawShape: shape, read: 'ok', mime: 'ok', html: 'error', imageParts: 'ok', acquisition: 'error', canonical: 'error'
  });
  const fresh = harness();
  installGmail(fresh.ctx, () => ({messages: []}), id => message(id, Date.parse('2026-05-22T00:00:00Z')));
  const freshBefore = JSON.stringify(fresh.properties);
  fresh.ctx.collectImageParts_ = () => { throw new Error('part details must not escape'); };
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.ctx.diagnoseGmailRead('abc123'))), {
    mimeTrace: trace, rawShape: shape, read: 'ok', mime: 'ok', html: 'ok', imageParts: 'error', acquisition: 'error', canonical: 'error'
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


test('MIME trace identifies each production validation and runtime failure without leaking source data', () => {
  const cases = [
    ['part-validation', raw => { raw.payload.parts[0] = null; }],
    ['part-validation', raw => { raw.payload.parts[0].mimeType = 123; }],
    ['headers-validation', raw => { raw.payload.parts[0].headers = {}; }],
    ['attachment-classification', raw => { raw.payload.parts[0].filename = 1; }],
    ['headers-validation', raw => { raw.payload.parts[0].headers = [{name: 'Secret header', value: 1}]; }],
    ['multipart-validation', raw => { raw.payload.parts[0] = {mimeType: 'multipart/mixed', body: body('SECRET')}; }],
    ['body-validation', raw => { raw.payload.parts[0].body = null; }],
    ['data-validation', raw => { raw.payload.parts[0].body.data = 'SECRET!'; }],
    ['size-validation', raw => { raw.payload.parts[0].body.size = '6'; }],
    ['empty-body-validation', raw => { raw.payload.parts[0].body.data = ''; }],
    ['base64-decode', (_, ctx) => { ctx.Utilities.base64DecodeWebSafe = () => { throw Error('SECRET provider detail'); }; }],
    ['bytes-validation', (_, ctx) => { ctx.Utilities.base64DecodeWebSafe = () => ({length: 6, 0: 83}); }],
    ['bytes-validation', (_, ctx) => { ctx.Utilities.base64DecodeWebSafe = () => null; }],
    ['charset-validation', raw => { raw.payload.parts[0].headers = [{name: 'Content-Type', value: 'text/plain; charset="SECRET!"'}]; }],
    ['blob-create', (_, ctx) => { ctx.Utilities.newBlob = () => { throw Error('SECRET blob detail'); }; }],
    ['string-decode', (_, ctx) => { ctx.Utilities.newBlob = () => ({getDataAsString: () => { throw Error('SECRET charset detail'); }}); }],
    ['multipart-composition', (_, ctx) => { ctx.appendMimeText_ = () => { throw Error('SECRET composition detail'); }; }]
  ];
  for (const [stage, inject] of cases) {
    const {ctx, properties} = harness();
    const raw = message('abc123', 0);
    raw.payload = {mimeType: 'multipart/alternative', parts: [{mimeType: 'text/plain', body: body('SECRET')}]};
    inject(raw, ctx);
    let reads = 0;
    ctx.Gmail.Users.Messages = {get: () => { reads++; return raw; }, modify: () => assert.fail('no Gmail writes')};
    ctx.SpreadsheetApp = {openById: () => assert.fail('no sheet access')};
    ctx.ScriptApp.newTrigger = () => assert.fail('no trigger writes');
    ctx.ScriptApp.deleteTrigger = () => assert.fail('no trigger writes');
    ctx.PropertiesService.getScriptProperties = () => ({getProperty: key => properties[key] ?? null,
      setProperty: () => assert.fail('no property writes'), deleteProperty: () => assert.fail('no property writes')});
    ctx.acquireMessageImages_ = () => assert.fail('must stop at MIME failure');
    const report = JSON.parse(JSON.stringify(ctx.diagnoseGmailRead('abc123')));
    assert.equal(reads, 1);
    assert.match(report.mime, /^error/);
    assert.equal(report.html, 'not-run');
    assert.ok(report.mimeTrace.parts.some(part => part.stage === stage && part.status === 'error'), stage);
    if (stage !== 'multipart-composition') {
      assert.equal(report.mimeTrace.parts.at(-1).parent, 0);
      assert.equal(report.mimeTrace.parts.at(-1).stage, stage);
    }
    assert.doesNotMatch(JSON.stringify(report), /SECRET|abc123|offers@example|Offer|U0VDUkVU/);
  }
});

test('MIME tracing preserves successful parser outputs and bounds late-failure records', () => {
  const {ctx} = harness();
  const plain = {mimeType: 'text/plain', body: body('synthetic')};
  const payload = {mimeType: 'multipart/alternative', parts: [plain,
    {mimeType: 'text/html', headers: [{name: 'Content-Type', value: 'text/html; charset=iso-8859-1'}], body: body('<b>synthetic</b>')},
    {mimeType: 'application/octet-stream'}, {mimeType: 'multipart/mixed'}]};
  const trace = {parts: [], omitted: 0};
  const normal = ctx.parseMimePayload_(payload);
  const observed = ctx.parseMimePayload_(payload, trace);
  assert.deepEqual(observed, normal);
  assert.equal(observed.incomplete, true);
  assert.equal(trace.parts[2].charsetClass, 'latin1');
  assert.ok(trace.parts.every(part => part.stage === 'complete' && part.status === 'ok'));
  const many = {mimeType: 'multipart/mixed', parts: Array.from({length: 100}, () => plain)};
  many.parts.push({mimeType: 'text/plain', body: {data: 'broken!'}});
  const bounded = {parts: [], omitted: 0};
  assert.throws(() => ctx.parseMimePayload_(many, bounded), /MAIL/);
  assert.equal(bounded.parts.length, 64);
  assert.equal(bounded.omitted, 38);
  assert.equal(bounded.parts.at(-1).index, 101);
  assert.equal(bounded.parts.at(-1).parent, 0);
  assert.equal(bounded.parts.at(-1).stage, 'data-validation');
  const nested = {mimeType: 'multipart/mixed', parts: [many]};
  const deep = {parts: [], omitted: 0};
  assert.throws(() => ctx.parseMimePayload_(nested, deep), /MAIL/);
  assert.equal(deep.parts.at(-1).parent, 1);
});

test('MIME trace observes byte representation, size equality and charset classes without relaxing validation', () => {
  const {ctx} = harness();
  const payload = {mimeType: 'text/plain', body: body('SECRET')};
  const trace = {parts: [], omitted: 0};
  ctx.Utilities.base64DecodeWebSafe = () => new Int8Array([83, 69, 67, 82, 69, 84]);
  assert.throws(() => ctx.parseMimePayload_(payload, trace), /MAIL/);
  assert.equal(trace.parts[0].bytesType, 'object');
  assert.equal(trace.parts[0].bytesLength, 6);
  assert.equal(trace.parts[0].sizeMatches, true);
  const fresh = harness().ctx;
  for (const [charset, classification] of [['UTF-8', 'utf8'], ['US-ASCII', 'ascii'],
    ['windows-1252', 'windows1252'], ['SECRET-CHARSET', 'other']]) {
    const next = {parts: [], omitted: 0};
    fresh.Utilities.newBlob = () => ({getDataAsString: actual => { assert.equal(actual, charset); return 'SECRET'; }});
    fresh.parseMimePayload_({...payload, headers: [{name: 'Content-Type', value: 'text/plain; charset=' + charset}]}, next);
    assert.equal(next.parts[0].charsetClass, classification);
    assert.doesNotMatch(JSON.stringify(next), /SECRET/);
  }
});

const mimeFixture = require('./mime-fixtures');

test('MIME recovery preserves original text and HTML with explicit size mismatch coverage', () => {
  for (const form of mimeFixture.forms) {
    const {ctx} = harness();
    const payload = mimeFixture.payload('mismatch', form);
    const original = JSON.stringify(payload);
    const trace = {parts: [], omitted: 0};
    const result = ctx.parseMimePayload_(payload, trace);
    assert.equal(result.text, mimeFixture.text);
    assert.equal(result.html, '<p>' + mimeFixture.text + '</p>\r\n');
    assert.equal(result.incomplete, true);
    assert.equal(trace.parts[1].sizeMatches, false);
    assert.equal(trace.parts[2].sizeMatches, false);
    assert.equal(JSON.stringify(payload), original);
    for (const size of [0, 1, payload.parts[0].body.size + 10]) {
      const part = {...payload.parts[0], body: {...payload.parts[0].body, size}};
      assert.equal(ctx.parseMimePayload_(part).text, mimeFixture.text);
      assert.equal(ctx.parseMimePayload_(part).incomplete, true);
      assert.throws(() => ctx.decodeBytePayload_(part.body.data, size), /MAIL/);
    }
    for (const mutate of [p => { p.body.data = [256]; }, p => { p.body.data = 'bad!'; },
      p => { p.body.data = false; }, p => { p.body.data = []; },
      p => { delete p.body.data; }, p => { p.body.size = '10'; }, p => { p.body.size = -1; }]) {
      const part = JSON.parse(JSON.stringify(payload.parts[0])); mutate(part);
      assert.throws(() => ctx.parseMimePayload_(part), /MAIL/);
    }
  }
});

test('unsupported file attachments never enter body evidence or trigger document reads', () => {
  for (const form of mimeFixture.forms) {
    for (const identity of ['filename', 'disposition', 'inline-filename']) {
      const {ctx} = harness();
      const source = mimeFixture.text + ' '.repeat(415 - Buffer.byteLength(mimeFixture.text)) + '\r\n';
      assert.equal(Buffer.byteLength(source), 417);
      const payload = mimeFixture.payload('files', form, source);
      const file = payload.parts[1];
      if (identity === 'disposition') { delete file.filename; file.headers = [{name: 'Content-Disposition', value: 'ATTACHMENT; filename="document.txt"'}]; }
      if (identity === 'inline-filename') file.headers = [{name: 'Content-Disposition', value: 'inline'}];
      for (const inlineData of [false, true]) {
        if (inlineData) file.body = mimeFixture.body('Unrelated coupon code FILE99', form);
        const raw = {id: 'abc123', internalDate: '0', payload};
        ctx.Gmail.Users.Messages = {Attachments: {get: () => assert.fail('no document fetch')}, modify: () => assert.fail('no Gmail mutation')};
        const original = JSON.stringify(raw);
        const result = ctx.canonicalGmailMessage_(raw);
        assert.equal(result.text, source); assert.equal(result.html, ''); assert.equal(result.incomplete, true);
        assert.equal(JSON.stringify(raw), original);
        assert.doesNotMatch(JSON.stringify(ctx.candidateSource_(result).spans), /FILE99/);
      }
    }
  }
});

test('recovered MIME messages still acquire image attachments and preserve HTML coverage boundaries', () => {
  for (const mode of ['mismatch', 'files']) {
    for (const form of mimeFixture.forms) {
      const {ctx} = harness();
      const payload = mimeFixture.payload(mode, form);
      payload.parts.push({mimeType: 'image/png', filename: 'offer.png', body: {size: mimeFixture.png.length, attachmentId: 'image-file'}});
      payload.parts.push({mimeType: 'text/html', body: mimeFixture.body('<p>first</p><p>second</p><div hidden>HIDDEN99</div><svg>FOREIGN99</svg>', form)});
      const reads = [];
      ctx.Gmail.Users.Messages = {Attachments: {get: (_, id, attachment) => {
        reads.push(attachment); return mimeFixture.body(mimeFixture.png, form);
      }}};
      const result = ctx.canonicalGmailMessage_({id: 'abc123', internalDate: '0', payload});
      assert.deepEqual(reads, ['image-file']); assert.equal(result.images.length, 1);
      assert.equal(result.images[0].dimensions.width, 200); assert.equal(result.incomplete, true);
      const source = ctx.candidateSource_(result);
      assert.equal(source.incomplete, true);
      assert.ok(source.spans.includes('first')); assert.ok(source.spans.includes('second'));
      assert.doesNotMatch(JSON.stringify(source.spans), /HIDDEN99|FOREIGN99/);
    }
  }
});

test('omitted document bodies and containers reject malformed metadata and inline bytes without fetching', () => {
  const {ctx} = harness();
  ctx.Gmail.Users.Messages = {Attachments: {get: () => assert.fail('no document fetch')}};
  const malformed = [
    {body: []}, {body: null}, {body: {size: '7164', attachmentId: 'file'}},
    {body: {size: -1, attachmentId: 'file'}}, {body: {size: Infinity, attachmentId: 'file'}},
    {body: {size: 0.5, attachmentId: 'file'}}, {body: {size: 7164, attachmentId: 123}},
    {body: {size: 7164}}, {body: {data: false}}, {body: {data: [256]}},
    {body: {data: 'bad!'}}, {body: {data: [65], size: 2}},
    {mimeType: 'multipart/mixed', parts: {}},
    {mimeType: 'multipart/mixed', parts: [null]},
    {mimeType: 'multipart/mixed', body: {data: [65], size: 1}, parts: []}
  ];
  for (const patch of malformed) {
    const part = {mimeType: 'text/plain', filename: 'document.txt', body: {size: 1, attachmentId: 'file'}, ...patch};
    const payload = {mimeType: 'multipart/mixed', parts: [{mimeType: 'text/plain', body: body('Actual body')}, part]};
    assert.throws(() => ctx.parseMimePayload_(payload), /MAIL/);
  }
  // Validate recursively without treating nested document text as body content.
  for (const form of mimeFixture.forms) {
    const part = {mimeType: 'multipart/mixed', filename: 'document.mime', body: {size: 0}, parts: [
      {mimeType: 'text/plain', body: mimeFixture.body('Unrelated coupon code FILE99', form)},
      {mimeType: 'text/csv', body: {attachmentId: 'file', size: 10}}]};
    const result = ctx.parseMimePayload_({mimeType: 'multipart/mixed', parts: [
      {mimeType: 'text/plain', body: body('Actual body')}, part]});
    assert.equal(result.text, 'Actual body'); assert.equal(result.incomplete, true);
    part.parts[0].body.data = [256];
    assert.throws(() => ctx.parseMimePayload_(part), /MAIL/);
  }
});
