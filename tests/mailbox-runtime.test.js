const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function sheet(headers) {
  const rows = [headers];
  return {
    getSheetId: () => 7, getLastRow: () => rows.length,
    getLastColumn: () => Math.max(...rows.map(row => row.length)),
    getDataRange: () => ({getValues: () => rows.map(r => r.slice()),
      getDisplayValues: () => rows.map(r => r.map(v => String(v ?? '')))}),
    getRange: (r, c, nr, nc) => ({
      getValues: () => Array.from({length: nr}, (_, i) => Array.from({length: nc}, (_, j) => rows[r - 1 + i]?.[c - 1 + j] ?? '')),
      getDisplayValues: () => Array.from({length: nr}, (_, i) => (rows[r - 1 + i] || []).slice(c - 1, c - 1 + nc).map(v => String(v ?? ''))),
      setValues: values => values.forEach((row, i) => {
        rows[r - 1 + i] ||= [];
        row.forEach((value, j) => { rows[r - 1 + i][c - 1 + j] = value; });
      })
    }), rows
  };
}

function fixture(count = 0) {
  const {ctx, config, properties} = harness();
  let now = Date.parse('2025-02-02T12:00:00Z');
  ctx.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  const start = now - 86400000;
  const journal = sheet(['Message ID', 'State JSON']);
  const coupons = sheet(Array(26).fill('header'));
  const state = {config, recoveryStart: start, journalSheet: journal, couponSheet: coupons,
    spreadsheet: {getId: () => config.spreadsheetId}};
  const triggers = []; const deleted = []; const sent = []; const fetched = []; const listed = [];
  let uid = 0; let locked = false;
  ctx.LockService = {getScriptLock: () => ({tryLock: () => { assert.equal(locked, false); locked = true; return true; },
    releaseLock: () => { locked = false; }})};
  const trigger = (handler, id) => ({getHandlerFunction: () => handler, getEventType: () => 'CLOCK', getUniqueId: () => id});
  ctx.ScriptApp.getProjectTriggers = () => triggers.slice();
  ctx.ScriptApp.newTrigger = handler => {
    const builder = {timeBased: () => builder, everyMinutes: value => { assert.equal(value, 5); return builder; },
      create: () => {
        assert.equal(locked, true);
        const intent = JSON.parse(properties.MYCOUPONS_MAILBOX_CONTINUATION);
        assert.equal(intent.triggerId, '');
        const item = trigger(handler, 'continuation-' + ++uid); triggers.push(item); return item;
      }};
    return builder;
  };
  ctx.ScriptApp.deleteTrigger = item => { assert.equal(locked, true); deleted.push(item.getUniqueId()); triggers.splice(triggers.indexOf(item), 1); };
  ctx.openSpreadsheetById_ = () => state.spreadsheet;
  ctx.assertPrivateSpreadsheet_ = () => {};
  ctx.ensureSheetState_ = () => { assert.equal(locked, true); return state; };
  ctx.MailApp = {sendEmail: (...args) => sent.push(args)};
  const messages = Array.from({length: count}, (_, i) => ({id: (i + 1).toString(16), at: start + 1000 + i}));
  ctx.UrlFetchApp = {fetch: (url, options) => {
    assert.equal(locked, true); assert.equal(options.followRedirects, false);
    const params = new URL(url).searchParams;
    const query = params.get('q'); listed.push(query);
    const bounds = /^after:(-?\d+) before:(\d+)$/.exec(query);
    const matching = messages.filter(m => m.at > Number(bounds[1]) * 1000 && m.at < Number(bounds[2]) * 1000);
    const offset = Number(params.get('pageToken') || 0);
    const page = {messages: matching.slice(offset, offset + 50).map(m => ({id: m.id}))};
    if (offset + 50 < matching.length) page.nextPageToken = String(offset + 50);
    return response(200, page);
  }};
  ctx.Gmail.Users.Messages = {get: (_, id) => {
    assert.equal(locked, true); fetched.push(id);
    const item = messages.find(m => m.id === id);
    const text = Number.parseInt(id, 16) % 10 === 0 ? 'coupon code SAVE20' : 'An offer without an explicit code';
    const bytes = Buffer.from(text);
    return {id, internalDate: String(item.at), payload: {mimeType: 'text/plain', body: {data: bytes.toString('base64url'), size: bytes.length}}};
  }};
  return {ctx, config, properties, state, triggers, deleted, sent, fetched, listed, messages, trigger,
    advance: ms => { now += ms; }, now: () => now,
    continuation: () => ctx.runMailboxContinuation({triggerUid: triggers[0].getUniqueId()})};
}

function response(code, body) { return {getResponseCode: () => code, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body)}; }

test('693 messages drain through one owned continuation, then later arrivals use a new frozen window', () => {
  const f = fixture(693);
  f.ctx.runScheduledImport();
  assert.equal(f.fetched.length, 50); assert.equal(f.triggers.length, 1);
  const firstQuery = f.listed[0];
  // Arrivals cannot move the active window, even while backlog processing continues.
  f.messages.push(...Array.from({length: 80}, (_, i) => ({id: (1000 + i).toString(16), at: f.now() + 1000 + i})));
  let runs = 1;
  while (f.triggers.length) { f.advance(300000); f.continuation(); runs++; assert.ok(runs <= 15); }
  assert.equal(runs, 14); assert.equal(f.fetched.length, 693);
  assert.equal(new Set(f.fetched).size, 693); assert.ok(f.listed.every(q => q === firstQuery));
  assert.equal(f.deleted.length, 1); assert.equal(f.state.couponSheet.rows.length, 70);
  assert.equal(Object.values(f.ctx.readMessageJournal_(f.state.journalSheet)).filter(j => j.status === 'awaiting_extraction').length, 624);
  f.advance(86400000); f.ctx.runScheduledImport();
  while (f.triggers.length) f.continuation();
  assert.equal(f.fetched.length, 773); assert.equal(new Set(f.fetched).size, 773);
});

test('continuation slot budget survives failures and a later daily run resumes the same window', () => {
  const f = fixture(1);
  f.ctx.UrlFetchApp.fetch = () => response(503, {error: {code: 503, message: 'unavailable'}});
  f.ctx.runScheduledImport();
  const original = f.properties.MYCOUPONS_MAILBOX_SCAN_STATE;
  for (let i = 1; i < 15; i++) f.continuation();
  assert.equal(f.triggers.length, 0);
  assert.equal(JSON.parse(f.properties.MYCOUPONS_MAILBOX_CONTINUATION).runs, 15);
  assert.equal(f.properties.MYCOUPONS_MAILBOX_SCAN_STATE, original);
  f.ctx.runScheduledImport(); assert.equal(f.triggers.length, 0);
  f.advance(86400000); f.ctx.runScheduledImport();
  assert.equal(f.triggers.length, 1); assert.equal(JSON.parse(f.properties.MYCOUPONS_MAILBOX_CONTINUATION).runs, 1);
  assert.equal(f.properties.MYCOUPONS_MAILBOX_SCAN_STATE, original);
});

test('completed discovery removes continuation despite read failures, while a deadline retains pending IDs', () => {
  const failed = fixture(1);
  failed.ctx.Gmail.Users.Messages.get = () => { throw new Error('read failure'); };
  failed.ctx.runScheduledImport(); assert.equal(failed.triggers.length, 0);
  assert.equal(failed.ctx.getMessageState_(failed.state.journalSheet, '1').status, 'failed');
  const timed = fixture(1); const get = timed.ctx.Gmail.Users.Messages.get;
  timed.ctx.Gmail.Users.Messages.get = (...args) => { const value = get(...args); timed.advance(226000); return value; };
  timed.ctx.runScheduledImport(); assert.equal(timed.triggers.length, 1);
  assert.deepEqual(JSON.parse(timed.properties.MYCOUPONS_MAILBOX_SCAN_STATE).pendingIds, ['1']);
  const saved = timed.ctx.getMessageState_(timed.state.journalSheet, '1');
  assert.match(saved.failureStage, /^read\|\d+\|\d+$/);
  timed.ctx.Gmail.Users.Messages.get = get; timed.continuation();
  assert.equal(timed.triggers.length, 0); assert.equal(timed.ctx.getMessageState_(timed.state.journalSheet, '1').status, 'awaiting_extraction');
});

test('continuation rejects wrong event, owner, installation and lock contention without fetching or creating', () => {
  for (const kind of ['event', 'owner', 'installation', 'lock']) {
    const f = fixture(100); f.ctx.runScheduledImport(); const count = f.fetched.length;
    if (kind === 'owner') f.ctx.Session.getEffectiveUser = () => ({getEmail: () => 'foreign@example.com'});
    if (kind === 'installation') f.properties.MYCOUPONS_CONFIG = JSON.stringify({...f.config, sheetName: 'Replacement'});
    if (kind === 'lock') f.ctx.LockService.getScriptLock = () => ({tryLock: () => false});
    const result = kind === 'event' ? f.ctx.runMailboxContinuation({triggerUid: 'unknown'}) : f.continuation();
    assert.equal(result.errors.length, 1, kind); assert.equal(f.fetched.length, count, kind);
    assert.equal(f.triggers.length, 1, kind); assert.equal(f.deleted.length, 0, kind);
  }
});

test('trigger creation persists intent, rejects orphan/duplicate state and recovers an absent exact trigger', () => {
  const f = fixture(150); f.ctx.runScheduledImport();
  const record = JSON.parse(f.properties.MYCOUPONS_MAILBOX_CONTINUATION);
  f.triggers.length = 0; f.ctx.runScheduledImport();
  assert.equal(f.triggers.length, 1); assert.notEqual(f.triggers[0].getUniqueId(), record.triggerId);
  for (const kind of ['missing', 'intent', 'mismatch', 'duplicate']) {
    const bad = fixture(100); bad.ctx.runScheduledImport();
    if (kind === 'missing') delete bad.properties.MYCOUPONS_MAILBOX_CONTINUATION;
    if (kind === 'intent' || kind === 'mismatch') {
      const value = JSON.parse(bad.properties.MYCOUPONS_MAILBOX_CONTINUATION);
      value.triggerId = kind === 'intent' ? '' : 'foreign';
      bad.properties.MYCOUPONS_MAILBOX_CONTINUATION = JSON.stringify(value);
    }
    if (kind === 'duplicate') bad.triggers.push(bad.trigger('runMailboxContinuation', 'duplicate'));
    const count = bad.triggers.length; const gets = bad.fetched.length;
    assert.equal(bad.ctx.runScheduledImport().errors[0].code, 'RESOURCE');
    assert.equal(bad.triggers.length, count); assert.equal(bad.fetched.length, gets); assert.equal(bad.deleted.length, 0);
  }
});

test('removal preflights daily and continuation before deleting either owned trigger', () => {
  for (const bad of [false, 'duplicate', 'mismatch', 'owner', 'orphan', 'intent']) {
    const f = fixture(100); f.ctx.runScheduledImport();
    f.triggers.push(f.trigger('runScheduledImport', 'daily'));
    f.properties.MYCOUPONS_TRIGGER_ID = 'daily';
    if (bad === 'duplicate') f.triggers.push(f.trigger('runMailboxContinuation', 'duplicate'));
    if (bad === 'mismatch') f.properties.MYCOUPONS_TRIGGER_ID = 'foreign';
    if (bad === 'owner') f.ctx.Session.getEffectiveUser = () => ({getEmail: () => 'foreign@example.com'});
    if (bad === 'orphan') delete f.properties.MYCOUPONS_MAILBOX_CONTINUATION;
    if (bad === 'intent') {
      const record = JSON.parse(f.properties.MYCOUPONS_MAILBOX_CONTINUATION); record.triggerId = '';
      f.properties.MYCOUPONS_MAILBOX_CONTINUATION = JSON.stringify(record);
    }
    if (bad) { assert.throws(() => f.ctx.removeDailyImportTrigger()); assert.equal(f.deleted.length, 0, bad); }
    else { assert.equal(f.ctx.removeDailyImportTrigger().removed, true); assert.equal(f.triggers.length, 0); assert.equal(f.deleted.length, 2); }
  }
});

test('failed removal preserves absent daily-trigger identity instead of enabling missing-ID recovery', () => {
  const f = fixture();
  f.properties.MYCOUPONS_TRIGGER_ID = 'original-daily';
  f.triggers.push(f.trigger('runMailboxContinuation', 'orphan'));
  assert.throws(() => f.ctx.removeDailyImportTrigger(), /RESOURCE/);
  assert.equal(f.properties.MYCOUPONS_TRIGGER_ID, 'original-daily');
  f.triggers.push(f.trigger('runScheduledImport', 'unrelated-daily'));
  assert.throws(() => f.ctx.removeDailyImportTrigger(), /RESOURCE/);
  assert.equal(f.deleted.length, 0);
});

test('list adapter only restarts after a structured token-400 and a valid tokenless page', () => {
  const cases = [
    [400, {error: {code: 400, message: 'localized provider text'}}, 200, {messages: [{id: 'abc'}]}, true],
    ...[401, 403, 429, 500, 503, 302].map(code => [code, {error: {code, message: 'Invalid page token'}}, 200, {}, false]),
    [400, {error: {code: 403, message: 'no'}}, 200, {}, false],
    [400, 'invalid JSON', 200, {}, false],
    ...[400, 401, 403, 429, 500, 302].map(code => [400, {error: {code: 400, message: 'no'}}, code, {}, false]),
    ...['invalid JSON', {messages: null}, {messages: [{id: 'bad-id'}]}, {messages: [{id: 'a'}, {id: 'a'}]}, {error: {code: 400}}, {nextPageToken: null}, {nextPageToken: 'stale'}, {unexpected: 'field'}]
      .map(body => [400, {error: {code: 400, message: 'no'}}, 200, body, false])
  ];
  for (const [code, body, probeCode, probeBody, accepted] of cases) {
    const {ctx, properties} = harness(); let count = 0; const requests = [];
    ctx.UrlFetchApp = {fetch: (url, options) => {
      requests.push(new URL(url)); assert.equal(options.followRedirects, false);
      return ++count === 1 ? response(code, body) : response(probeCode, probeBody);
    }};
    const scan = ctx.mailboxScanState_(1000, 2000); scan.pageToken = 'stale'; ctx.saveMailboxScanState_(scan);
    const before = properties.MYCOUPONS_MAILBOX_SCAN_STATE;
    if (accepted) assert.equal(ctx.mailboxListPage_(scan).restarted, true);
    else assert.throws(() => ctx.mailboxListPage_(scan), /MAIL/);
    assert.equal(properties.MYCOUPONS_MAILBOX_SCAN_STATE, before);
    if (requests.length === 2) {
      assert.equal(requests[1].searchParams.has('pageToken'), false);
      requests[0].searchParams.delete('pageToken');
      assert.equal(requests[0].origin + requests[0].pathname, requests[1].origin + requests[1].pathname);
      assert.deepEqual([...requests[0].searchParams], [...requests[1].searchParams]);
    }
  }
});

test('replay and retry selection skip explicit and legacy awaiting-extraction records', () => {
  const f = fixture(2);
  for (const [id, legacy] of [['1', false], ['2', true]]) {
    const entry = f.ctx.newMessageState_(id); entry.status = legacy ? 'failed' : 'awaiting_extraction'; entry.outcome = 'empty';
    f.ctx.saveMessageState_(f.state.journalSheet, entry);
  }
  f.ctx.runScheduledImport(); assert.equal(f.fetched.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.triggers.length, 0);
});

test('short-page writes remain counted and linked when the next page fails', () => {
  const f = fixture(10); let calls = 0;
  f.ctx.UrlFetchApp.fetch = () => ++calls === 1 ? response(200, {messages: [{id: 'a'}], nextPageToken: 'next'}) :
    response(503, {error: {code: 503, message: 'unavailable'}});
  const result = f.ctx.runScheduledImport();
  assert.equal(result.review, 1); assert.equal(result.errors[0].code, 'MAIL');
  assert.ok(result.links.some(link => link.includes('range=A2')));
  assert.equal(f.state.couponSheet.rows.length, 2); assert.equal(f.triggers.length, 1); assert.equal(f.sent.length, 1);
});

test('the page budget resets per invocation and a token cycle cannot loop indefinitely', () => {
  const f = fixture(); let pages = 0;
  f.ctx.UrlFetchApp.fetch = () => response(200, ++pages < 25 ? {nextPageToken: 'p' + pages} : {});
  f.ctx.runScheduledImport(); assert.equal(pages, 20); assert.equal(f.triggers.length, 1);
  f.continuation(); assert.equal(pages, 25); assert.equal(f.triggers.length, 0);
  const cyclic = fixture(); let repeats = 0;
  cyclic.ctx.UrlFetchApp.fetch = () => { repeats++; return response(200, {nextPageToken: 'repeated'}); };
  const result = cyclic.ctx.runScheduledImport();
  assert.equal(result.errors[0].code, 'MAIL'); assert.equal(repeats, 2);
  assert.equal(cyclic.triggers.length, 1);
});

test('read retry retains its originating boundary after the scan window has advanced', () => {
  const f = fixture(1);
  const original = f.ctx.mailboxScanState_(f.state.recoveryStart, f.now(), f.ctx.mailboxInstallationId_(f.config));
  const entry = f.ctx.newMessageState_('1'); entry.status = 'failed'; entry.failureStage = 'read|' + original.startMs + '|' + original.endMs;
  f.ctx.saveMessageState_(f.state.journalSheet, entry);
  original.complete = true; f.ctx.saveMailboxScanState_(original); f.advance(86400000);
  f.ctx.runScheduledImport();
  assert.equal(f.ctx.getMessageState_(f.state.journalSheet, '1').status, 'awaiting_extraction');
  assert.equal(f.fetched.length, 1);
  // An extraction/write retry already passed the boundary. A subsequent read
  // failure must not replace that proof with the newer window's lower bound.
  const retry = f.ctx.newMessageState_('1'); retry.status = 'failed'; retry.failureStage = 'write'; retry.lastError = 'WRITE';
  f.ctx.saveMessageState_(f.state.journalSheet, retry);
  const get = f.ctx.Gmail.Users.Messages.get;
  f.ctx.Gmail.Users.Messages.get = () => { throw new Error('unavailable'); };
  f.ctx.runScheduledImport(); assert.equal(f.ctx.getMessageState_(f.state.journalSheet, '1').failureStage, 'read_validated');
  f.ctx.Gmail.Users.Messages.get = get; f.ctx.runScheduledImport();
  assert.equal(f.ctx.getMessageState_(f.state.journalSheet, '1').status, 'awaiting_extraction');
});

test('image acquisition yields incomplete coverage after its soft budget and still persists the message', () => {
  const f = fixture(10); const get = f.ctx.Gmail.Users.Messages.get; let imageReads = 0;
  f.messages.splice(0, 9);
  f.ctx.Gmail.Users.Messages.get = (...args) => {
    const raw = get(...args);
    const html = Buffer.from('coupon code SAVE20<img src="https://shop.example.com/one.png"><img src="https://shop.example.com/two.png">');
    raw.payload = {mimeType: 'text/html', body: {data: html.toString('base64url'), size: html.length}}; return raw;
  };
  const fetch = f.ctx.UrlFetchApp.fetch;
  f.ctx.UrlFetchApp.fetch = (url, options) => {
    if (url.startsWith('https://gmail.googleapis.com/')) return fetch(url, options);
    imageReads++; f.advance(31000);
    return {getResponseCode: () => 200, getHeaders: () => ({'Content-Type': 'image/png'}), getContent: () => [1, 2, 3]};
  };
  const canonical = f.ctx.canonicalGmailMessage_; let incomplete;
  f.ctx.canonicalGmailMessage_ = (...args) => { const message = canonical(...args); incomplete = message.incomplete; return message; };
  const result = f.ctx.runScheduledImport();
  assert.equal(imageReads, 1); assert.equal(incomplete, true); assert.equal(result.review, 1);
  assert.equal(f.state.couponSheet.rows.length, 2); assert.equal(f.triggers.length, 0);
});

test('installation replacement cancels only the old continuation and rollback preserves the old configuration', () => {
  for (const fail of [false, true]) {
    const f = fixture(100); f.ctx.runScheduledImport();
    const replacement = {...f.config, spreadsheetId: 'replacement-sheet'};
    delete replacement.labelId;
    f.ctx.ensureSheetState_ = input => {
      f.properties.MYCOUPONS_CONFIG = JSON.stringify(input);
      if (fail) throw new Error('STATE');
      return {spreadsheet: {getId: () => input.spreadsheetId}, label: {id: 'label'}};
    };
    f.ctx.installReviewEditTrigger_ = () => ({created: false});
    f.ctx.installDailyImportTrigger = () => ({created: false});
    if (fail) assert.throws(() => f.ctx.installMyCoupons(replacement), /STATE/);
    else assert.equal(f.ctx.installMyCoupons(replacement).spreadsheetId, 'replacement-sheet');
    assert.equal(f.triggers.length, 0); assert.equal(f.deleted.length, 1);
    assert.equal(JSON.parse(f.properties.MYCOUPONS_CONFIG).spreadsheetId, fail ? f.config.spreadsheetId : 'replacement-sheet');
  }
});

test('mixed-case owner identity works across creation resume case-only reconfiguration and removal', () => {
  const f = fixture(150);
  f.config.ownerEmail = 'Owner@Example.COM';
  f.properties.MYCOUPONS_CONFIG = JSON.stringify(f.config);
  assert.equal(f.ctx.runScheduledImport().errors.length, 0);
  let record = JSON.parse(f.properties.MYCOUPONS_MAILBOX_CONTINUATION);
  assert.equal(record.ownerEmail, 'owner@example.com');
  const uid = record.triggerId;
  f.ctx.installReviewEditTrigger_ = () => ({created: false});
  f.ctx.installDailyImportTrigger = () => ({created: false});
  const ensure = f.ctx.ensureSheetState_;
  f.ctx.ensureSheetState_ = input => {
    f.properties.MYCOUPONS_CONFIG = JSON.stringify(input);
    return {...f.state, label: {id: 'label'}};
  };
  const lower = {...f.config, ownerEmail: 'owner@example.com'}; delete lower.labelId;
  f.ctx.installMyCoupons(lower);
  assert.equal(f.deleted.length, 0); assert.equal(f.triggers[0].getUniqueId(), uid);
  f.ctx.ensureSheetState_ = ensure;
  // Comparisons also tolerate an already-persisted mixed-case owner spelling.
  record.ownerEmail = 'OWNER@example.com'; f.properties.MYCOUPONS_MAILBOX_CONTINUATION = JSON.stringify(record);
  assert.equal(f.continuation().errors.length, 0); assert.equal(f.fetched.length, 100);
  f.ctx.removeDailyImportTrigger(); assert.equal(f.triggers.length, 0);
  const completed = fixture(1); completed.config.ownerEmail = 'OWNER@EXAMPLE.COM';
  completed.properties.MYCOUPONS_CONFIG = JSON.stringify(completed.config);
  assert.equal(completed.ctx.runScheduledImport().errors.length, 0); assert.equal(completed.triggers.length, 0);
});

test('scheduled batches use three full journal reads regardless of message slots and existing journal size', () => {
  const f = fixture(100);
  for (let i = 0; i < 2000; i++) {
    const entry = f.ctx.newMessageState_((100000 + i).toString(16)); entry.status = 'ignored';
    f.state.journalSheet.rows.push([entry.messageId, JSON.stringify(entry)]);
  }
  let fullReads = 0; const original = f.state.journalSheet.getDataRange;
  f.state.journalSheet.getDataRange = () => {
    const range = original(); return {...range, getValues: () => { fullReads++; return range.getValues(); }};
  };
  assert.equal(f.ctx.runScheduledImport().errors.length, 0);
  assert.equal(f.fetched.length, 50); assert.equal(fullReads, 3);
  assert.equal(f.continuation().errors.length, 0);
  assert.equal(f.fetched.length, 100); assert.equal(fullReads, 6);
});

test('journal sessions isolate caller mutations, nest by exact sheet and reload after exit', () => {
  const {ctx} = harness(); const first = sheet(['Message ID', 'State JSON']); const second = sheet(['Message ID', 'State JSON']);
  ctx.saveMessageState_(first, ctx.newMessageState_('a'));
  ctx.withMessageJournal_(first, () => {
    const entry = ctx.getMessageState_(first, 'a'); entry.status = 'ignored';
    assert.equal(ctx.getMessageState_(first, 'a').status, 'pending');
    ctx.withMessageJournal_(second, () => ctx.saveMessageState_(second, ctx.newMessageState_('b')));
    ctx.saveMessageState_(first, entry); entry.status = 'failed';
    assert.equal(ctx.getMessageState_(first, 'a').status, 'ignored');
  });
  const modified = JSON.parse(first.rows[1][1]); modified.status = 'review'; first.rows[1][1] = JSON.stringify(modified);
  assert.equal(ctx.getMessageState_(first, 'a').status, 'review');
  assert.equal(ctx.getMessageState_(second, 'b').status, 'pending');
});

test('indexed writes reject reordered rows, changed JSON, new duplicates and occupied append targets', () => {
  for (const kind of ['reorder', 'json', 'duplicate', 'append']) {
    const {ctx} = harness(); const journal = sheet(['Message ID', 'State JSON']);
    ctx.saveMessageState_(journal, ctx.newMessageState_('a')); ctx.saveMessageState_(journal, ctx.newMessageState_('b'));
    ctx.withMessageJournal_(journal, () => {
      const entry = ctx.getMessageState_(journal, 'a'); entry.status = 'ignored';
      if (kind === 'reorder') [journal.rows[1], journal.rows[2]] = [journal.rows[2], journal.rows[1]];
      if (kind === 'json') journal.rows[1][1] = JSON.stringify({...entry, status: 'review'});
      if (kind === 'duplicate') journal.rows.push(journal.rows[1].slice());
      if (kind === 'append') {
        const range = journal.getRange;
        journal.getRange = (...args) => args[0] === 4 ? {...range(...args), getValues: () => [['foreign', 'unseen']]} : range(...args);
      }
      const before = JSON.stringify(journal.rows);
      assert.throws(() => ctx.saveMessageState_(journal, kind === 'append' ? ctx.newMessageState_('c') : entry), /STATE/);
      assert.equal(JSON.stringify(journal.rows), before);
      assert.throws(() => ctx.getMessageState_(journal, 'a'), /STATE/);
      assert.throws(() => ctx.readMessageJournal_(journal), /STATE/);
    });
  }
});

test('ambiguous final journal writes preserve durable outcomes and recover without duplicate rows', () => {
  for (const mode of ['set-then-throw', 'readback-mismatch', 'not-written']) {
    const f = fixture(10); f.messages.splice(0, 9);
    const getRange = f.state.journalSheet.getRange; let failed = false;
    f.state.journalSheet.getRange = (...args) => {
      const range = getRange(...args); let corruptReadback = false;
      return {...range, setValues: values => {
        const final = args[1] === 1 && values[0][1] && JSON.parse(values[0][1]).status === 'review';
        if (final && !failed) {
          failed = true;
          if (mode !== 'not-written') range.setValues(values);
          if (mode === 'readback-mismatch') { corruptReadback = true; return; }
          throw new Error('ambiguous transport');
        }
        range.setValues(values);
      }, getValues: () => corruptReadback ? [['a', 'unexpected readback']] : range.getValues()};
    };
    const result = f.ctx.runScheduledImport();
    assert.equal(f.state.couponSheet.rows.length, 2, mode);
    assert.equal(result.review, mode === 'not-written' ? 0 : 1, mode);
    assert.equal(f.ctx.getMessageState_(f.state.journalSheet, 'a').status, mode === 'not-written' ? 'processing' : 'review', mode);
    assert.equal(f.triggers.length, 1, mode);
    const retried = f.continuation();
    assert.equal(retried.review, mode === 'not-written' ? 1 : 0, mode);
    assert.equal(f.state.couponSheet.rows.length, 2, mode);
    assert.equal(f.ctx.getMessageState_(f.state.journalSheet, 'a').status, 'review', mode);
    assert.equal(f.triggers.length, 0, mode);
  }
});

test('durable summary recovers confirmed counts and failed-review links without callback outcomes', () => {
  const f = fixture();
  const confirmed = f.ctx.newMessageState_('a'); confirmed.status = 'confirmed'; confirmed.rowNumbers = [2, 3];
  const review = f.ctx.newMessageState_('b'); review.status = 'review'; review.rowNumbers = [4];
  f.ctx.saveMessageState_(f.state.journalSheet, confirmed); f.ctx.saveMessageState_(f.state.journalSheet, review);
  const before = {a: {...confirmed, rowNumbers: [2]}, b: {...review, status: 'failed'}};
  const summary = f.ctx.scheduledSummary_(f.state, before, {messages: [], errors: [], imported: 0});
  assert.equal(summary.imported, 1); assert.equal(JSON.stringify(summary.importedIds), '["a"]');
  assert.equal(summary.review, 1); assert.ok(summary.links.some(link => link.endsWith('range=A4')));
  const unchanged = f.ctx.scheduledSummary_(f.state, f.ctx.readMessageJournal_(f.state.journalSheet), {messages: [], errors: []});
  assert.equal(unchanged.imported, 0); assert.equal(unchanged.review, 0);
});
