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
      getValues: () => values.slice(row - 1, row - 1 + rowCount)
        .map(item => item.slice(column - 1, column - 1 + columnCount)),
      getDisplayValues: () => values.slice(row - 1, row - 1 + rowCount)
        .map(item => item.slice(column - 1, column - 1 + columnCount)
          .map(value => String(value ?? ''))),
      setValues: next => {
        for (let r = 0; r < rowCount; r++) {
          while (values.length < row + r) values.push([]);
          while (values[row - 1 + r].length < column + columnCount - 1) values[row - 1 + r].push('');
          for (let c = 0; c < columnCount; c++) values[row - 1 + r][column - 1 + c] = next[r][c];
        }
      }
    }),
    _values: values
  };
}

function body(value) {
  const bytes = Buffer.from(value, 'utf8');
  return {data: bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), size: bytes.length};
}

function alternativeMessage(id = 'abc123') {
  return {
    id,
    threadId: 'thread-' + id,
    internalDate: String(Date.parse('2026-05-22T10:15:00Z')),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{name: 'From', value: 'offers@example.com'}, {name: 'Subject', value: 'Save 20%'}],
      parts: [
        {mimeType: 'text/plain; charset=UTF-8', body: body('Plain coupon code SAVE20')},
        {mimeType: 'text/html; charset=UTF-8', body: body('<p>HTML coupon code <strong>SAVE20</strong></p>')}
      ]
    }
  };
}

function installGmail(ctx, list, get) {
  const calls = {list: [], get: []};
  ctx.Gmail.Users.Messages = {
    list: (userId, options) => { calls.list.push({userId, options}); return list(options); },
    get: (userId, id, options) => { calls.get.push({userId, id, options}); return get(id, options); }
  };
  return calls;
}

test('reads bounded Gmail pages and preserves independent canonical MIME representations', () => {
  const {ctx} = harness();
  const journal = sheetMock();
  const label = {id: 'label-1', name: 'Shopping/Coupons'};
  const calls = installGmail(ctx, options => {
    assert.equal(JSON.stringify(options.labelIds), JSON.stringify([label.id]));
    assert.equal(options.maxResults, 50);
    assert.equal(options.q, 'after:2026/05/21');
    assert.equal(options.pageToken, undefined);
    return {messages: [{id: 'abc123'}, {id: 'deadbeef'}]};
  }, id => id === 'abc123' ? alternativeMessage(id) : {
    id,
    threadId: 'thread-' + id,
    internalDate: String(Date.parse('2026-05-23T10:15:00Z')),
    payload: {mimeType: 'text/plain', headers: [], body: body('Another offer')}
  });
  const result = ctx.readGmailMessages_(label, Date.parse('2026-05-21T22:00:00Z'), journal);
  assert.equal(result.errors.length, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.messages[0])), {
    id: 'abc123', threadId: 'thread-abc123', receivedAt: '2026-05-22T10:15:00.000Z',
    receivedAtMs: Date.parse('2026-05-22T10:15:00Z'), sender: 'offers@example.com', subject: 'Save 20%',
    text: 'Plain coupon code SAVE20', html: '<p>HTML coupon code <strong>SAVE20</strong></p>',
    link: 'https://mail.google.com/mail/u/0/#all/abc123', incomplete: false
  });
  assert.equal(result.messages[1].text, 'Another offer');
  assert.equal(result.messages[1].html, '');
  assert.equal(calls.get.length, 2);
});

test('skips confirmed and ignored journal states without fetching or mutating Gmail', () => {
  const {ctx} = harness();
  const journal = sheetMock();
  for (const [id, status] of [['abc123', 'confirmed'], ['deadbeef', 'ignored']]) {
    const state = ctx.newMessageState_(id); state.status = status; ctx.saveMessageState_(journal, state);
  }
  const calls = installGmail(ctx, () => ({messages: [{id: 'abc123'}, {id: 'deadbeef'}]}), () => {
    assert.fail('final messages must not be fetched');
  });
  const result = ctx.readGmailMessages_({id: 'label-1', name: 'Coupons'}, Date.parse('2026-05-21T22:00:00Z'), journal);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {messages: [], errors: [], truncated: false});
  assert.equal(calls.get.length, 0);
});

test('returns retryable errors for message fetch and malformed MIME data', () => {
  const {ctx} = harness();
  const journal = sheetMock();
  const calls = installGmail(ctx, () => ({messages: [{id: 'abc123'}, {id: 'deadbeef'}, {id: 'face'}]}), id => {
    if (id === 'abc123') throw new Error('temporary API failure');
    if (id === 'deadbeef') return {
      id, threadId: 'thread-' + id, internalDate: String(Date.parse('2026-05-22T10:00:00Z')),
      payload: {mimeType: 'text/plain', body: {data: 'not base64'}}
    };
    return {
      id, threadId: 'thread-' + id, internalDate: String(Date.parse('2026-05-22T10:00:00Z')),
      payload: {mimeType: 'application/pdf', body: {size: 12}}
    };
  });
  const result = ctx.readGmailMessages_({id: 'label-1', name: 'Coupons'}, Date.parse('2026-05-21T22:00:00Z'), journal);
  assert.deepEqual(JSON.parse(JSON.stringify(result.errors)), [
    {messageId: 'abc123', code: 'MAIL', retryable: true},
    {messageId: 'deadbeef', code: 'MAIL', retryable: true}
  ]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].incomplete, true);
  assert.equal(result.messages[0].text, '');
  assert.equal(calls.get.length, 3);
});

test('enforces the page bound and detects malformed page tokens', () => {
  const {ctx} = harness();
  const journal = sheetMock();
  let pages = 0;
  const calls = installGmail(ctx, options => {
    pages++;
    return {messages: [], nextPageToken: 'page-' + pages};
  }, () => assert.fail('empty pages must not fetch messages'));
  const result = ctx.readGmailMessages_({id: 'label-1', name: 'Coupons'}, Date.parse('2026-05-21T22:00:00Z'), journal);
  assert.equal(result.truncated, true);
  assert.equal(calls.list.length, 20);

  installGmail(ctx, () => ({messages: [], nextPageToken: 'same'}), () => assert.fail('must not fetch'));
  assert.throws(() => ctx.readGmailMessages_({id: 'label-1', name: 'Coupons'}, Date.parse('2026-05-21T22:00:00Z'), journal), /MAIL/);
});

test('fails closed for malformed message listings and API page failures', () => {
  const {ctx} = harness();
  const journal = sheetMock();
  installGmail(ctx, () => ({messages: [{id: 'not-a-gmail-id'}]}), () => assert.fail('invalid summary must not fetch'));
  assert.throws(() => ctx.readGmailMessages_({id: 'label-1', name: 'Coupons'}, Date.parse('2026-05-21T22:00:00Z'), journal), /MAIL/);
  installGmail(ctx, () => { throw new Error('list failed'); }, () => assert.fail('list failure must not fetch'));
  assert.throws(() => ctx.readGmailMessages_({id: 'label-1', name: 'Coupons'}, Date.parse('2026-05-21T22:00:00Z'), journal), /MAIL/);
});
