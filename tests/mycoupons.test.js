import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/MyCoupons.gs', import.meta.url), 'utf8');

function message({
  id,
  threadId = id,
  attachmentText = '',
  encodedBody = null,
  subject = '',
  body = '',
  date = new Date('2026-01-10T08:00:00.000Z'),
  from = 'offers@example.com',
  labels = [],
} = {}) {
  return {
    attachmentText,
    body,
    date,
    from,
    id,
    labels,
    encodedBody,
    subject,
    threadId,
  };
}

function createRuntime({
  config = {},
  messages = [],
  headers = [
    'Email Date',
    'Coupon Code',
    'Source Subject',
    'Sender',
    'Gmail Link',
    'Notes/Deduplication Key',
    'Status',
  ],
  existingRows = [],
  existingFormulas = [],
  externalAppendRow = null,
  corruptLastWrite = false,
  corruptLastWriteColumns = [],
  coerceLastWrite = false,
  beforeLiveDeduplicationRead = null,
  beforeRetentionRecheck = null,
  formulaLastWriteColumns = [],
  attachmentText = '',
  advanceClockOnList = false,
  fetchFailureAfter = null,
  listFailureAfter = null,
  listPageSize = 100,
  missingMessageIds = [],
  now = new Date('2026-01-11T10:00:00.000Z'),
  labels = [{id: 'Label_Imported', name: 'Coupon Code Discount', type: 'user'}],
  listedMessageIds = messages.map(value => value.id),
  openedSpreadsheetName = undefined,
  profileEmail = 'owner@example.com',
  triggers = [],
  dailyScheduleMetadata = undefined,
  scanState = undefined,
  watermark = null,
  watermarkTargetIdentity = undefined,
} = {}) {
  let clock = now;
  const values = [headers, ...existingRows];
  const formulas = values.map((row, index) => index > 0 && existingFormulas[index - 1] ?
    [...existingFormulas[index - 1]] : row.map(() => ''));
  const mutations = [];
  const trashed = [];
  const queries = [];
  const createdTriggers = [];
  let getMessageCount = 0;
  let listMessageCount = 0;
  const numberFormats = [];
  let externalAppendDone = false;
  let liveDeduplicationReadPending = Boolean(beforeLiveDeduplicationRead);
  let retentionRecheckPending = Boolean(beforeRetentionRecheck);
  let sheetValueReadCount = 0;
  const properties = new Map();
  const installedConfig = {
    ownerEmail: 'owner@example.com',
    spreadsheetId: 'sheet-id',
    spreadsheetName: 'My Coupons',
    sheetName: 'Coupon Manager',
    labelName: 'Coupon Code Discount',
    timeZone: 'Europe/Rome',
    ...config,
  };
  const projectTriggers = triggers.map((trigger, index) => ({
    getHandlerFunction: () => trigger.getHandlerFunction(),
    getUniqueId: () => trigger.getUniqueId ? trigger.getUniqueId() : 'existing-trigger-' + index,
  }));
  properties.set('MYCOUPONS_CONFIG', JSON.stringify(installedConfig));
  if (projectTriggers.length && dailyScheduleMetadata !== null) {
    properties.set('MYCOUPONS_DAILY_SCHEDULE', dailyScheduleMetadata === undefined ? JSON.stringify({
      version: 2,
      identity: JSON.stringify([
        installedConfig.ownerEmail.toLowerCase(), installedConfig.spreadsheetId, installedConfig.sheetName,
        installedConfig.labelName, 'runMyCouponsDaily', installedConfig.dailyHour ?? 8, installedConfig.timeZone,
      ]),
      triggerId: projectTriggers[0].getUniqueId(),
    }) : dailyScheduleMetadata);
  }
  if (watermark) {
    properties.set('MYCOUPONS_WATERMARK', watermark);
    if (watermarkTargetIdentity !== null) {
      properties.set('MYCOUPONS_WATERMARK_TARGET_IDENTITY', watermarkTargetIdentity === undefined ? JSON.stringify([
        installedConfig.ownerEmail.toLowerCase(), installedConfig.spreadsheetId,
        installedConfig.sheetName, installedConfig.labelName, labels[0]?.id,
      ]) : watermarkTargetIdentity);
    }
  }
  if (scanState !== undefined) {
    properties.set('MYCOUPONS_SCAN_STATE', scanState);
  }

  const sheet = {
    getDataRange() {
      return {
        getValues: () => {
          sheetValueReadCount += 1;
          if (liveDeduplicationReadPending && sheetValueReadCount === 2) {
            beforeLiveDeduplicationRead({formulas, values});
            liveDeduplicationReadPending = false;
          }
          return values.map(row => [...row]);
        },
        getFormulas: () => formulas.map(row => [...row]),
      };
    },
    getLastColumn: () => headers.length,
    getLastRow: () => values.length,
    appendRow(row) {
      values.push(row.map(cell => {
        const text = String(cell);
        return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
      }));
      formulas.push(row.map(cell => String(cell).startsWith('=') ? String(cell) : ''));
      if (externalAppendRow && !externalAppendDone) {
        values.push([...externalAppendRow]);
        formulas.push(externalAppendRow.map(() => ''));
        externalAppendDone = true;
      }
      return this;
    },
    getRange(row, column, rowCount, columnCount) {
      return {
        setNumberFormat: format => {
          numberFormats.push({column, columnCount, format, row, rowCount});
          return this;
        },
        setValues: rows => {
          rows.forEach((value, index) => {
            values[row - 1 + index] = value.map(cell => {
              const text = String(cell);
              return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
            });
            formulas[row - 1 + index] = value.map(cell => String(cell).startsWith('=') ? String(cell) : '');
          });
          return this;
        },
        getValues: () => values.slice(row - 1, row - 1 + rowCount)
          .map(value => {
            const copy = value.slice(column - 1, column - 1 + columnCount);
            if (corruptLastWrite && row === values.length) {
              copy[5] = '';
            }
            if (coerceLastWrite && row === values.length) {
              copy[1] = 'SAVE2O';
            }
            if (row === values.length) {
              corruptLastWriteColumns.forEach(column => { copy[column] = ''; });
            }
            return copy;
          }),
        getFormulas: () => formulas.slice(row - 1, row - 1 + rowCount)
          .map(value => {
            const copy = value.slice(column - 1, column - 1 + columnCount);
            if (row === values.length) {
              formulaLastWriteColumns.forEach(column => { copy[column] = '=CORRUPTED'; });
            }
            return copy;
          }),
      };
    },
  };
  const labelIdsByName = new Map(labels.map(label => [label.name, label.id]));
  const gmailMessages = new Map(messages.map(value => [value.id, {
    id: value.id,
    internalDate: String(value.date.getTime()),
    labelIds: value.labels.map(name => labelIdsByName.get(name) || name),
    payload: {
      body: {},
      headers: [
        {name: 'Subject', value: value.subject},
        {name: 'From', value: value.from},
      ],
      mimeType: 'multipart/alternative',
      parts: [{
        body: {data: value.encodedBody ?? Buffer.from(value.body).toString('base64url')},
        mimeType: 'text/plain',
      }].concat(value.attachmentText ? [{
        body: {data: Buffer.from(value.attachmentText).toString('base64url')},
        filename: 'coupon.txt',
        mimeType: 'text/plain',
      }] : []),
    },
    threadId: value.threadId,
  }]));
  const context = {
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [clock]));
      }
      static now() {
        return clock.getTime();
      }
    },
    Gmail: {
      Users: {
        getProfile: () => ({emailAddress: profileEmail}),
        Labels: {list: () => ({labels})},
        Messages: {
          get: (userId, id) => {
            assert.equal(userId, 'me');
            if (retentionRecheckPending && getMessageCount === 1) {
              beforeRetentionRecheck(gmailMessages);
              retentionRecheckPending = false;
            }
            if (missingMessageIds.includes(id)) {
              throw {code: 404, message: 'Requested entity was not found.'};
            }
            if (fetchFailureAfter !== null && getMessageCount >= fetchFailureAfter) {
              throw new Error("Quota exceeded for quota metric 'Total Query Cost'.");
            }
            getMessageCount += 1;
            return gmailMessages.get(id);
          },
          list: (userId, options) => {
            assert.equal(userId, 'me');
            queries.push(options.q);
            if (listFailureAfter !== null && listMessageCount >= listFailureAfter) {
              throw new Error("Quota exceeded for quota metric 'Total Query Cost'.");
            }
            listMessageCount += 1;
            if (advanceClockOnList) {
              clock = new Date(clock.getTime() + 60_000);
            }
            const excludedLabels = [
              options.q.includes('-in:sent') && 'SENT',
              options.q.includes('-in:drafts') && 'DRAFT',
              options.q.includes('-in:spam') && 'SPAM',
              options.q.includes('-in:trash') && 'TRASH',
            ].filter(Boolean);
            const queryMessageIds = listedMessageIds.filter(id => !excludedLabels.some(label =>
              gmailMessages.get(id).labelIds.includes(label),
            ));
            const offset = Number(options.pageToken || 0);
            const page = queryMessageIds.slice(offset, offset + listPageSize).map(id => ({id}));
            const next = offset + page.length;
            return {
              messages: page,
              ...(next < queryMessageIds.length ? {nextPageToken: String(next)} : {}),
            };
          },
          modify: (resource, userId, id) => mutations.push({resource, userId, id}),
          trash: (userId, id) => trashed.push({userId, id}),
        },
      },
    },
    LockService: {
      getScriptLock: () => ({releaseLock() {}, waitLock() {}}),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key) || null,
        setProperty: (key, value) => properties.set(key, value),
        deleteProperty: key => properties.delete(key),
      }),
    },
    ScriptApp: {
      atHour: hour => ({everyDays: () => ({create: () => createdTriggers.push(hour)})}),
      getProjectTriggers: () => projectTriggers,
      newTrigger: handler => ({timeBased: () => ({
        inTimezone: timeZone => ({atHour: hour => ({everyDays: () => ({
          create: () => {
            const record = {handler, hour, timeZone};
            createdTriggers.push(record);
            return {
              getHandlerFunction: () => handler,
              getUniqueId: () => 'created-trigger-' + createdTriggers.length,
            };
          },
        })})}),
      })}),
    },
    SpreadsheetApp: {
      openById: id => {
        assert.equal(id, 'sheet-id');
        return {
          getName: () => openedSpreadsheetName === undefined ? installedConfig.spreadsheetName : openedSpreadsheetName,
          getSheetByName: name => name === 'Coupon Manager' ? sheet : null,
        };
      },
    },
    Utilities: {
      formatDate: (_, timeZone) => {
        if (!['Europe/Rome', 'UTC', 'GMT', 'America/New_York'].includes(timeZone)) {
          throw new Error('Unknown time zone');
        }
        return '2000-01-01';
      },
      base64DecodeWebSafe: encoded => {
        if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) {
          throw new Error('Could not decode string.');
        }
        return Buffer.from(encoded, 'base64url');
      },
      newBlob: bytes => ({getDataAsString: () => Buffer.from(bytes).toString('utf8')}),
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename: 'src/MyCoupons.gs'});
  return {
    context, createdTriggers, formulas, mutations, numberFormats, properties, queries, rows: values, trashed,
    setFetchFailureAfter: value => { fetchFailureAfter = value; },
    setListFailureAfter: value => { listFailureAfter = value; },
  };
}

test('imports an explicitly introduced code, then labels and archives its exact message', () => {
  const runtime = createRuntime({messages: [message({
    id: 'message-1',
    subject: 'Your discount code: SAVE20',
  })]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 1);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.rows[1][1], 'SAVE20');
  assert.equal(runtime.rows[1][5], 'message-1::SAVE20');
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.mutations)), [{
    resource: {addLabelIds: ['Label_Imported'], removeLabelIds: ['INBOX']},
    userId: 'me',
    id: 'message-1',
  }]);
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK'), '2026-01-11T10:00:00.000Z');
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK_TARGET_IDENTITY'), JSON.stringify([
    'owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount', 'Label_Imported',
  ]));
  assert.match(runtime.queries[0], new RegExp(`after:${Math.floor(Date.parse('2025-12-31T23:59:59.000Z') / 1000)}`));
});

test('skips an undecodable MIME text part without aborting later valid messages', () => {
  const runtime = createRuntime({messages: [
    message({id: 'malformed', encodedBody: '%not-base64url%'}),
    message({id: 'valid', body: 'Coupon code: SAVE20'}),
  ]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 1);
  assert.equal(runtime.rows[1][1], 'SAVE20');
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.mutations)), [{
    resource: {addLabelIds: ['Label_Imported'], removeLabelIds: ['INBOX']},
    userId: 'me',
    id: 'valid',
  }]);
});

test('includes a message exactly at the initial UTC boundary', () => {
  const runtime = createRuntime({messages: [message({
    id: 'initial-boundary',
    body: 'Coupon code: MIDNIGHT20',
    date: new Date('2026-01-01T00:00:00.000Z'),
  })]});

  const outcome = runtime.context.runMyCouponsImport();
  assert.equal(outcome.imported, 1);
  assert.match(runtime.queries[0], new RegExp(`after:${Math.floor(Date.parse('2025-12-31T23:59:59.000Z') / 1000)}`));
});

test('keeps the watermark unchanged after a Gmail rate limit while committing the verified partial batch', () => {
  const runtime = createRuntime({
    fetchFailureAfter: 1,
    messages: [
      message({id: 'first', body: 'Coupon code: FIRST20'}),
      message({id: 'second', body: 'Coupon code: SECOND20'}),
    ],
  });

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.complete, false);
  assert.equal(outcome.imported, 1);
  assert.equal(outcome.watermark, null);
  assert.equal(runtime.properties.has('MYCOUPONS_WATERMARK'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.mutations)), [{
    resource: {addLabelIds: ['Label_Imported'], removeLabelIds: ['INBOX']},
    userId: 'me',
    id: 'first',
  }]);
  assert.ok(runtime.properties.has('MYCOUPONS_SCAN_STATE'));
});

test('resumes a durable page cursor after a list rate limit instead of repeating an irrelevant prefix', () => {
  const runtime = createRuntime({
    listFailureAfter: 1,
    listPageSize: 2,
    messages: [
      message({id: 'ordinary-1', body: 'Nothing to import here'}),
      message({id: 'ordinary-2', body: 'Referral link https://example.com/referral'}),
      message({id: 'coupon-after-prefix', body: 'Coupon code: SAVE20'}),
    ],
  });

  const first = runtime.context.runMyCouponsImport();
  assert.equal(first.complete, false);
  assert.equal(first.scanned, 2);
  assert.equal(runtime.properties.has('MYCOUPONS_WATERMARK'), false);
  assert.equal(JSON.parse(runtime.properties.get('MYCOUPONS_SCAN_STATE')).pageToken, '2');

  runtime.setListFailureAfter(null);
  const resumed = runtime.context.runMyCouponsImport();
  assert.equal(resumed.complete, true);
  assert.equal(resumed.imported, 1);
  assert.equal(runtime.rows[1][1], 'SAVE20');
  assert.equal(runtime.properties.has('MYCOUPONS_SCAN_STATE'), false);
  assert.equal(runtime.queries.at(-1), runtime.queries[0]);
});

test('keeps a multi-page import query stable after importing and labeling an earlier page', () => {
  const runtime = createRuntime({
    listPageSize: 1,
    messages: [
      message({id: 'first-page', body: 'Coupon code: FIRST20'}),
      message({id: 'second-page', body: 'Coupon code: SECOND20'}),
    ],
  });

  assert.equal(runtime.context.runMyCouponsImport().imported, 2);
  assert.equal(runtime.queries.length, 2);
  assert.equal(runtime.queries[0], runtime.queries[1]);
  assert.match(runtime.queries[0], /^in:anywhere after:\d+ before:\d+$/u);
  assert.doesNotMatch(runtime.queries[0], /(?:-label:|-in:spam|-in:trash)/u);
  assert.equal(runtime.mutations.length, 2);
});

test('binds a resumable scan to the normalized configured owner identity', () => {
  const runtime = createRuntime({
    config: {ownerEmail: 'OWNER@EXAMPLE.COM'},
    fetchFailureAfter: 0,
    messages: [message({id: 'pending', body: 'Coupon code: SAVE20'})],
  });
  runtime.context.runMyCouponsImport();
  const scan = JSON.parse(runtime.properties.get('MYCOUPONS_SCAN_STATE'));
  assert.deepEqual(JSON.parse(scan.configIdentity).slice(0, 2), ['owner@example.com', 'Coupon Code Discount']);
  assert.equal(scan.labelId, 'Label_Imported');
});

test('resumes pending page IDs after a message read rate limit without duplicating a committed row', () => {
  const runtime = createRuntime({
    fetchFailureAfter: 1,
    messages: [
      message({id: 'first', body: 'Coupon code: FIRST20'}),
      message({id: 'second', body: 'Coupon code: SECOND20'}),
    ],
  });

  const first = runtime.context.runMyCouponsImport();
  assert.equal(first.complete, false);
  assert.equal(first.imported, 1);
  assert.deepEqual(JSON.parse(runtime.properties.get('MYCOUPONS_SCAN_STATE')).pendingIds, ['second']);

  runtime.setFetchFailureAfter(null);
  const resumed = runtime.context.runMyCouponsImport();
  assert.equal(resumed.complete, true);
  assert.equal(resumed.imported, 1);
  assert.deepEqual(runtime.rows.slice(1).map(row => row[1]), ['FIRST20', 'SECOND20']);
});

test('preserves the 26-column legacy sheet layout and writes legacy aliases at their exact indices', () => {
  const headers = [
    'Record ID', 'Merchant', 'Category', 'Email Date', 'Coupon Code',
    'Source email subject', 'Sender', 'Offer description', 'Valid from',
    'Valid until', 'Minimum spend', 'Currency', 'Import batch', 'Email link',
    'Source mailbox', 'Confidence', 'Evidence', 'Review note', 'Tags',
    'Imported at', 'Notes / dedupe key', 'Status', 'Legacy A', 'Legacy B',
    'Legacy C', 'Legacy D',
  ];
  const runtime = createRuntime({
    headers,
    messages: [message({
      id: 'legacy-message',
      subject: 'Your coupon',
      body: 'Coupon code: SAVE20',
    })],
  });

  runtime.context.runMyCouponsImport();

  const row = runtime.rows[1];
  assert.equal(row.length, 26);
  assert.equal(row[4], 'SAVE20');
  assert.equal(row[5], 'Your coupon');
  assert.equal(row[13], 'https://mail.google.com/mail/u/?authuser=owner%40example.com#all/legacy-message');
  assert.equal(row[20], 'legacy-message::SAVE20');
  assert.equal(row[21], 'imported');
  assert.equal(row[25], '');
  assert.deepEqual(runtime.numberFormats.map(format => format.column), [4, 5, 6, 7, 14, 21, 22]);
  assert.ok(runtime.numberFormats.every(format => format.columnCount === 1));
});

test('preserves case, Unicode, and supported punctuation only after an explicit introducer', () => {
  const runtime = createRuntime({messages: [message({
    id: 'unicode-punctuation',
    body: 'Promo code: "MiXeDÈ/20+VIP." Use NOT-A-CODE normally.',
  })]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 1);
  assert.equal(runtime.rows[1][1], 'MiXeDÈ/20+VIP.');
  assert.equal(runtime.rows[1][5], 'unicode-punctuation::MiXeDÈ/20+VIP.');
});

test('does not mutate referral-only, authentication, ambiguous, or already imported messages', () => {
  const runtime = createRuntime({messages: [
    message({id: 'referral', body: 'Share https://example.com/referral'}),
    message({id: 'referral-code', body: 'Share your promo code: FRIEND20 with a friend'}),
    message({id: 'refer-friend', body: 'Refer a friend with promo code: FRIEND20'}),
    message({id: 'invite-friends', body: 'Invite friends with discount code: FRIEND20'}),
    message({id: 'friends-after-code', body: 'Promo code: FRIEND20 — invite friends'}),
    message({id: 'otp', body: 'Your verification code: 123456'}),
    message({id: 'generic', body: 'Use SAVE20 at checkout'}),
    message({id: 'ordinary-prose', body: 'No coupon code is required.'}),
    message({id: 'expiry-prose', body: 'Coupon code expires tomorrow'}),
    message({id: 'needed-prose', body: 'Coupon code is not needed'}),
    message({id: 'available-prose', body: 'Coupon code: available after signup'}),
    message({id: 'expires-prose', body: 'Coupon code: expires tomorrow'}),
    message({id: 'click-prose', body: 'Promo code: click here'}),
    message({id: 'click-here', body: 'Promo code: click-here'}),
    message({id: 'tap-here', body: 'Promo code: "Tap_here"'}),
    message({id: 'learn-more', body: 'Promo code: learn-more'}),
    message({id: 'percentage-discount', body: 'Coupon code: 20% off'}),
    message({id: 'currency-discount', body: 'Coupon code: $20 off'}),
    message({id: 'quoted-percentage-discount', body: 'Coupon code: "20%"'}),
    message({id: 'quoted-currency-discount', body: 'Coupon code: "$20"'}),
    message({id: 'not-available', body: 'Coupon code: not-available'}),
    message({id: 'no-code', body: 'Coupon code: "no-code"'}),
    message({id: 'tbd', body: 'Coupon code: TBD'}),
    message({id: 'uppercase-prose', body: 'Coupon code: FREE shipping'}),
    message({id: 'ambiguous-punctuation', body: 'Coupon code: SAVE20.'}),
    message({
      id: 'imported',
      body: 'Promo code: SAVE20',
      labels: ['Coupon Code Discount'],
    }),
  ]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 0);
  assert.equal(runtime.rows.length, 1);
  assert.deepEqual(runtime.mutations, []);
});

test('does not import coupon codes found only in quoted reply or forward history', () => {
  const runtime = createRuntime({messages: [
    message({
      id: 'on-wrote',
      subject: 'Re: promotion',
      body: 'Thanks for the details.\n\nOn Tue, Jan 6, 2026 at 10:00 AM Offers <offers@example.com> wrote:\nCoupon code: SAVE20',
    }),
    message({
      id: 'leading-quote',
      subject: 'Fwd: promotion',
      body: 'No new offer from me.\n> Coupon code: SAVE20',
    }),
    message({
      id: 'italian-forward',
      subject: 'Inoltro promozione',
      body: 'Nessun nuovo codice.\n\nMessaggio inoltrato\nCoupon code: SAVE20',
    }),
    message({
      id: 'italian-reply',
      subject: 'Re: promozione',
      body: 'Nessun nuovo codice.\n\nIl giorno mar 6 gen 2026 alle 10:00 Offers <offers@example.com> ha scritto:\nCodice sconto: SAVE20',
    }),
    message({
      id: 'new-top-content',
      subject: 'Re: promotion',
      body: 'Coupon code: NEW20\n\n---------- Forwarded Message ----------\nCoupon code: OLD20',
    }),
  ]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 1);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.rows[1][1], 'NEW20');
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.mutations)), [{
    resource: {addLabelIds: ['Label_Imported'], removeLabelIds: ['INBOX']},
    userId: 'me',
    id: 'new-top-content',
  }]);
});

test('requires the opened spreadsheet to have the exact configured name before Gmail mutation', () => {
  const matching = createRuntime({messages: [message({id: 'matching', body: 'Coupon code: SAVE20'})]});
  assert.equal(matching.context.runMyCouponsImport().imported, 1);

  const mismatched = createRuntime({
    openedSpreadsheetName: 'Other spreadsheet',
    messages: [message({id: 'mismatched', body: 'Coupon code: SAVE20'})],
  });
  assert.throws(() => mismatched.context.runMyCouponsImport(), /spreadsheet name did not match/i);
  assert.equal(mismatched.rows.length, 1);
  assert.equal(mismatched.mutations.length, 0);
});

test('rejects overlong and URL-like code forms rather than importing truncated tokens', () => {
  const runtime = createRuntime({messages: [
    message({id: 'overlong', body: 'Coupon code: A' + 'B'.repeat(128)}),
    message({id: 'url', body: 'Promo code: https://example.com/referral'}),
  ]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 0);
  assert.equal(runtime.rows.length, 1);
});

test('rejects absence markers and leading-apostrophe tokens without mutating Gmail or Sheet', () => {
  const runtime = createRuntime({messages: [
    message({id: 'not-required', body: 'Coupon code: not required'}),
    message({id: 'none', body: 'Coupon code: NONE'}),
    message({id: 'apostrophe', body: 'Coupon code: "\'=SAVE20"'}),
  ]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 0);
  assert.equal(runtime.rows.length, 1);
  assert.equal(runtime.mutations.length, 0);
});

test('treats untrusted Gmail text as literal Sheet text rather than a formula', () => {
  const runtime = createRuntime({messages: [message({
    id: 'formula-text',
    subject: '=IMPORTXML("https://example.com")',
    from: '+attacker@example.com',
    body: 'Coupon code: SAVE20',
  })]});

  runtime.context.runMyCouponsImport();

  assert.equal(runtime.rows[1][2], '=IMPORTXML("https://example.com")');
  assert.equal(runtime.rows[1][3], '+attacker@example.com');
  assert.deepEqual(runtime.numberFormats.map(format => [format.column, format.columnCount, format.format]), [
    [1, 1, '@'], [2, 1, '@'], [3, 1, '@'], [4, 1, '@'], [5, 1, '@'], [6, 1, '@'], [7, 1, '@'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.formulas[1].slice(1, 6))), ['', '', '', '', '']);
});

test('deduplicates a previous verified row and repairs its missing Gmail mutation without another row', () => {
  const runtime = createRuntime({
    existingRows: [[
      '2026-01-10T08:00:00.000Z', 'SAVE20', 'Earlier', 'offers@example.com',
      'https://mail.google.com/mail/u/0/#all/message-1', 'message-1::SAVE20', 'imported',
    ]],
    messages: [message({id: 'message-1', subject: 'Earlier', body: 'Coupon code: SAVE20'})],
  });

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 0);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.mutations.length, 1);
  assert.equal(runtime.mutations[0].id, 'message-1');
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK'), '2026-01-11T10:00:00.000Z');
});

test('re-reads the live deduplication row before repairing Gmail and fails closed on concurrent changes', () => {
  const existing = [
    '2026-01-10T08:00:00.000Z', 'SAVE20', 'Earlier', 'offers@example.com',
    'https://mail.google.com/mail/u/?authuser=owner%40example.com#all/message-1', 'message-1::SAVE20', 'imported',
  ];
  const mutations = [
    ({formulas, values}) => { values.splice(1, 1); formulas.splice(1, 1); },
    ({formulas, values}) => { values.push([...values[1]]); formulas.push([...formulas[1]]); },
    ({formulas}) => { formulas[1][1] = '=CHANGED'; },
    ({values}) => { values[1][1] = 'CHANGED'; },
  ];

  mutations.forEach(beforeLiveDeduplicationRead => {
    const runtime = createRuntime({
      beforeLiveDeduplicationRead,
      existingRows: [[...existing]],
      messages: [message({id: 'message-1', subject: 'Earlier', body: 'Coupon code: SAVE20'})],
    });
    assert.throws(() => runtime.context.runMyCouponsImport(), /complete message and code identity|duplicate deduplication key/i);
    assert.equal(runtime.mutations.length, 0);
  });
});

test('requires all existing deduplicated fields and formulas before repairing Gmail mutation', () => {
  const base = [
    '2026-01-10T08:00:00.000Z', 'SAVE20', 'Earlier', 'offers@example.com',
    'https://mail.google.com/mail/u/?authuser=owner%40example.com#all/message-1', 'message-1::SAVE20', 'imported',
  ];
  for (const altered of [0, 2, 3, 6]) {
    const row = [...base];
    row[altered] = 'altered';
    const runtime = createRuntime({
      existingRows: [row],
      messages: [message({id: 'message-1', subject: 'Earlier', body: 'Coupon code: SAVE20'})],
    });
    assert.throws(() => runtime.context.runMyCouponsImport(), /complete message and code identity/i);
    assert.equal(runtime.mutations.length, 0);
  }
  const runtime = createRuntime({
    existingRows: [base],
    existingFormulas: [['', '', '', '', '', '', '=FORMULA']],
    messages: [message({id: 'message-1', subject: 'Earlier', body: 'Coupon code: SAVE20'})],
  });
  assert.throws(() => runtime.context.runMyCouponsImport(), /complete message and code identity/i);
  assert.equal(runtime.mutations.length, 0);
});

test('writes owner-stable Gmail links while accepting exact legacy u/0 rows for migration', () => {
  const runtime = createRuntime({messages: [message({id: 'new-link', body: 'Coupon code: SAVE20'})]});
  runtime.context.runMyCouponsImport();
  assert.equal(runtime.rows[1][4], 'https://mail.google.com/mail/u/?authuser=owner%40example.com#all/new-link');

  const ownerStableLegacy = createRuntime({
    existingRows: [[
      '2026-01-10T08:00:00.000Z', 'SAVE20', '', 'offers@example.com',
      'https://mail.google.com/mail/u/?authuser=owner%40example.com#all/message-id', 'message-id::SAVE20', 'imported',
    ]],
    messages: [message({
      id: 'message-id', threadId: 'thread-id', body: 'Coupon code: SAVE20',
    })],
  });
  assert.equal(ownerStableLegacy.context.runMyCouponsImport().imported, 0);
  assert.equal(ownerStableLegacy.mutations[0].id, 'message-id');
});

test('uses the Gmail thread ID only for links while retaining the message ID for writes and deduplication', () => {
  const runtime = createRuntime({messages: [message({
    id: 'message-id',
    threadId: 'thread-id',
    body: 'Coupon code: SAVE20',
  })]});

  assert.equal(runtime.context.runMyCouponsImport().imported, 1);
  assert.equal(runtime.rows[1][4], 'https://mail.google.com/mail/u/?authuser=owner%40example.com#all/thread-id');
  assert.equal(runtime.rows[1][5], 'message-id::SAVE20');
  assert.equal(runtime.mutations[0].id, 'message-id');

  const malformed = createRuntime({messages: [message({
    id: 'missing-thread',
    threadId: '',
    body: 'Coupon code: SAVE20',
  })]});
  assert.throws(() => malformed.context.runMyCouponsImport(), /incomplete message/i);
  assert.equal(malformed.mutations.length, 0);
});

test('fails closed when an existing dedupe key does not prove its code and Gmail link identity', () => {
  const runtime = createRuntime({
    existingRows: [[
      '2026-01-10T08:00:00.000Z', 'WRONGCODE', 'Earlier', 'offers@example.com',
      'https://mail.google.com/mail/u/0/#all/message-1', 'message-1::SAVE20', 'imported',
    ]],
    messages: [message({id: 'message-1', body: 'Coupon code: SAVE20'})],
  });

  assert.throws(() => runtime.context.runMyCouponsImport(), /does not prove/i);
  assert.equal(runtime.mutations.length, 0);
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK'), undefined);
});

test('fails closed when the coupon sheet contains a duplicate deduplication key', () => {
  const row = [
    '2026-01-10T08:00:00.000Z', 'SAVE20', 'Earlier', 'offers@example.com',
    'https://mail.google.com/mail/u/0/#all/message-1', 'message-1::SAVE20', 'imported',
  ];
  const runtime = createRuntime({
    existingRows: [row, [...row]],
    messages: [message({id: 'message-1', body: 'Coupon code: SAVE20'})],
  });

  assert.throws(() => runtime.context.runMyCouponsImport(), /duplicate deduplication key/i);
  assert.equal(runtime.mutations.length, 0);
});

test('ignores repeated legacy Notes values that are not generated deduplication keys', () => {
  const legacyNoteRow = [
    'legacy date', '', 'legacy subject', 'legacy sender', '', 'Imported manually', 'legacy',
  ];
  const runtime = createRuntime({
    existingRows: [[...legacyNoteRow], [...legacyNoteRow]],
    messages: [message({id: 'new-coupon', body: 'Coupon code: SAVE20'})],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.context.getMyCouponsInstallationStatus())), {
    dailyTrigger: 'missing', importState: 'current', ready: true,
  });
  assert.equal(runtime.context.runMyCouponsImport().imported, 1);
  assert.equal(runtime.rows.length, 4);
  assert.equal(runtime.rows[3][5], 'new-coupon::SAVE20');
});

test('writes all codes before making one exact Gmail mutation for their source message', () => {
  const runtime = createRuntime({messages: [message({
    id: 'message-2',
    body: 'Coupon code: SAVE20 Promo code: FREESHIP',
  })]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 2);
  assert.equal(runtime.rows.length, 3);
  assert.equal(runtime.mutations.length, 1);
  assert.equal(runtime.mutations[0].id, 'message-2');
});

test('uses atomic append reservation without overwriting an interleaved external row', () => {
  const external = [
    'external-date', 'EXTERNAL', 'External subject', 'external@example.com',
    'https://mail.google.com/mail/u/?authuser=external%40example.com#all/external', 'external::EXTERNAL', 'external',
  ];
  const runtime = createRuntime({
    externalAppendRow: external,
    messages: [message({id: 'atomic', body: 'Coupon code: SAFE20'})],
  });

  runtime.context.runMyCouponsImport();
  assert.equal(runtime.rows[1][1], 'SAFE20');
  assert.deepEqual(runtime.rows[2], external);
  assert.equal(runtime.mutations[0].id, 'atomic');
});

test('uses exact epoch boundaries and persists the pre-list snapshot watermark', () => {
  const overlap = createRuntime({
    advanceClockOnList: true,
    config: {watermarkOverlapDays: 1},
    watermark: '2026-01-10T10:00:00.000Z',
  });
  overlap.context.runMyCouponsImport();
  assert.match(overlap.queries[0], new RegExp(`after:${Math.floor(Date.parse('2026-01-09T10:00:00.000Z') / 1000)}`));
  assert.match(overlap.queries[0], new RegExp(`before:${Math.floor(Date.parse('2026-01-11T10:00:00.000Z') / 1000)}`));
  assert.equal(overlap.properties.get('MYCOUPONS_WATERMARK'), '2026-01-11T10:00:00.000Z');

  const legacyBlankInitialDate = createRuntime({config: {initialDate: ''}});
  legacyBlankInitialDate.context.runMyCouponsImport();
  assert.match(legacyBlankInitialDate.queries[0], new RegExp(`after:${Math.floor(Date.parse('2025-12-31T23:59:59.000Z') / 1000)}`));

  const failedWrite = createRuntime({
    corruptLastWrite: true,
    messages: [message({id: 'message-3', body: 'Coupon code: SAVE20'})],
  });
  assert.throws(() => failedWrite.context.runMyCouponsImport(), /verification failed/i);
  assert.deepEqual(failedWrite.mutations, []);
  assert.equal(failedWrite.properties.get('MYCOUPONS_WATERMARK'), undefined);
});

test('covers the watermark boundary even when configured overlap is zero', () => {
  const runtime = createRuntime({
    config: {watermarkOverlapDays: 0},
    watermark: '2026-01-10T10:00:00.000Z',
  });
  runtime.context.runMyCouponsImport();
  assert.match(runtime.queries[0], new RegExp(`after:${Math.floor(Date.parse('2026-01-10T09:59:59.000Z') / 1000)}`));
});

test('restarts from initialDate when a watermark belongs to a different target', () => {
  const runtime = createRuntime({
    config: {labelName: 'Replacement Label'},
    labels: [
      {id: 'Label_Imported', name: 'Coupon Code Discount', type: 'user'},
      {id: 'Label_Replacement', name: 'Replacement Label', type: 'user'},
    ],
    watermark: '2026-01-10T10:00:00.000Z',
    watermarkTargetIdentity: JSON.stringify(['owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount']),
  });

  runtime.context.runMyCouponsImport();
  assert.match(runtime.queries[0], new RegExp(`after:${Math.floor(Date.parse('2025-12-31T23:59:59.000Z') / 1000)}`));
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK_TARGET_IDENTITY'), JSON.stringify([
    'owner@example.com', 'sheet-id', 'Coupon Manager', 'Replacement Label', 'Label_Replacement',
  ]));
});

test('restarts from initialDate when a same-name imported label is replaced', () => {
  const labels = [{id: 'Label_Old', name: 'Coupon Code Discount', type: 'user'}];
  const runtime = createRuntime({
    fetchFailureAfter: 0,
    labels,
    messages: [message({id: 'pending', body: 'No coupon here'})],
    watermark: '2026-01-10T10:00:00.000Z',
  });

  assert.equal(runtime.context.runMyCouponsImport().complete, false);
  assert.equal(JSON.parse(runtime.properties.get('MYCOUPONS_SCAN_STATE')).labelId, 'Label_Old');
  labels[0].id = 'Label_New';
  runtime.setFetchFailureAfter(null);

  assert.equal(runtime.context.runMyCouponsImport().complete, true);
  assert.match(runtime.queries.at(-1), new RegExp(`after:${Math.floor(Date.parse('2025-12-31T23:59:59.000Z') / 1000)}`));
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK_TARGET_IDENTITY'), JSON.stringify([
    'owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount', 'Label_New',
  ]));
});

test('rejects a provider read-back that coerces the coupon code before Gmail mutation', () => {
  const runtime = createRuntime({
    coerceLastWrite: true,
    messages: [message({id: 'coerced-code', body: 'Coupon code: SAVE20'})],
  });

  assert.throws(() => runtime.context.runMyCouponsImport(), /verification failed/i);
  assert.equal(runtime.mutations.length, 0);
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK'), undefined);
});

test('rejects a provider read-back that alters a required date or status field before Gmail mutation', () => {
  for (const column of [0, 6]) {
    const runtime = createRuntime({
      corruptLastWriteColumns: [column],
      messages: [message({id: 'corrupt-' + column, body: 'Coupon code: SAVE20'})],
    });
    assert.throws(() => runtime.context.runMyCouponsImport(), /verification failed/i);
    assert.equal(runtime.mutations.length, 0);
  }
});

test('rejects a provider formula in every required row field before Gmail mutation', () => {
  for (const column of [0, 1, 2, 3, 4, 5, 6]) {
    const runtime = createRuntime({
      formulaLastWriteColumns: [column],
      messages: [message({id: 'formula-' + column, body: 'Coupon code: SAVE20'})],
    });
    assert.throws(() => runtime.context.runMyCouponsImport(), /verification failed/i);
    assert.equal(runtime.mutations.length, 0);
  }
});

test('processes only exact message IDs returned by Gmail search, never unlisted thread neighbours', () => {
  const runtime = createRuntime({
    listedMessageIds: ['listed-message'],
    messages: [
      message({id: 'listed-message', body: 'Coupon code: LISTED20'}),
      message({id: 'unlisted-neighbour', body: 'Coupon code: SKIP20'}),
    ],
  });

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.scanned, 1);
  assert.equal(outcome.imported, 1);
  assert.equal(runtime.rows[1][1], 'LISTED20');
  assert.equal(runtime.mutations[0].id, 'listed-message');
});

test('leaves messages before initialDate and resumed spam/trash messages untouched', () => {
  const runtime = createRuntime({
    fetchFailureAfter: 0,
    messages: [
      message({id: 'before-initial', date: new Date('2025-12-31T23:59:59.500Z'), body: 'Coupon code: BEFORE20'}),
      message({id: 'spam-pending', body: 'Coupon code: SPAM20', labels: ['SPAM']}),
      message({id: 'trash-pending', body: 'Coupon code: TRASH20', labels: ['TRASH']}),
    ],
  });
  const first = runtime.context.runMyCouponsImport();
  assert.equal(first.complete, false);
  runtime.setFetchFailureAfter(null);
  const resumed = runtime.context.runMyCouponsImport();
  assert.equal(resumed.complete, true);
  assert.equal(runtime.rows.length, 1);
  assert.equal(runtime.mutations.length, 0);
});

test('leaves sent replies and resumed sent messages untouched even if they quote a coupon', () => {
  const fresh = createRuntime({messages: [message({
    id: 'sent-reply',
    subject: 'Re: Your offer',
    body: 'Forwarded message: Coupon code: SAVE20',
    labels: ['SENT'],
  })]});

  const freshOutcome = fresh.context.runMyCouponsImport();
  assert.equal(freshOutcome.imported, 0);
  assert.equal(fresh.rows.length, 1);
  assert.equal(fresh.mutations.length, 0);

  const resumed = createRuntime({
    fetchFailureAfter: 0,
    messages: [message({
      id: 'sent-pending',
      subject: 'Fwd: Coupon offer',
      body: 'Coupon code: SAVE20',
      labels: ['SENT'],
    })],
  });
  assert.equal(resumed.context.runMyCouponsImport().complete, false);
  resumed.setFetchFailureAfter(null);
  const resumedOutcome = resumed.context.runMyCouponsImport();
  assert.equal(resumedOutcome.complete, true);
  assert.equal(resumed.rows.length, 1);
  assert.equal(resumed.mutations.length, 0);
});

test('leaves draft messages untouched during fresh, resumed, and retention scans', () => {
  const fresh = createRuntime({messages: [message({
    id: 'draft-fresh', body: 'Coupon code: SAVE20', labels: ['DRAFT'],
  })]});
  assert.equal(fresh.context.runMyCouponsImport().imported, 0);
  assert.equal(fresh.rows.length, 1);
  assert.equal(fresh.mutations.length, 0);

  const resumed = createRuntime({
    fetchFailureAfter: 0,
    messages: [message({id: 'draft-pending', body: 'Coupon code: SAVE20', labels: ['DRAFT']})],
  });
  assert.equal(resumed.context.runMyCouponsImport().complete, false);
  resumed.setFetchFailureAfter(null);
  assert.equal(resumed.context.runMyCouponsImport().complete, true);
  assert.equal(resumed.rows.length, 1);
  assert.equal(resumed.mutations.length, 0);

  const retention = createRuntime({messages: [message({
    id: 'draft-expired',
    date: new Date('2025-01-01T00:00:00.000Z'),
    labels: ['Label_Imported', 'DRAFT'],
  })]});
  assert.equal(retention.context.cleanupExpiredImportedMessages().trashed, 0);
  assert.equal(retention.trashed.length, 0);
});

test('drops only exact not-found pending message IDs and resumes the scan', () => {
  const runtime = createRuntime({
    fetchFailureAfter: 0,
    missingMessageIds: ['deleted'],
    messages: [
      message({id: 'deleted', body: 'Coupon code: GONE20'}),
      message({id: 'surviving', body: 'Coupon code: LIVE20'}),
    ],
  });
  const first = runtime.context.runMyCouponsImport();
  assert.equal(first.complete, false);
  runtime.setFetchFailureAfter(null);
  const resumed = runtime.context.runMyCouponsImport();
  assert.equal(resumed.complete, true);
  assert.equal(resumed.imported, 1);
  assert.equal(runtime.rows[1][1], 'LIVE20');
  assert.equal(runtime.properties.has('MYCOUPONS_SCAN_STATE'), false);
});

test('rejects every mutating entrypoint when the Gmail profile is not the configured owner', () => {
  const runtime = createRuntime({profileEmail: 'other@example.com'});

  assert.throws(() => runtime.context.runMyCouponsImport(), /configured owner/i);
  assert.throws(() => runtime.context.runMyCouponsDaily(), /configured owner/i);
  assert.throws(() => runtime.context.cleanupExpiredImportedMessages(), /configured owner/i);
  assert.throws(() => runtime.context.installMyCouponsDailyTrigger(), /configured owner/i);
  assert.equal(runtime.mutations.length, 0);
  assert.equal(runtime.trashed.length, 0);
  assert.equal(runtime.createdTriggers.length, 0);
});

test('reports only non-secret installation readiness and fails closed for owner or duplicate triggers', () => {
  const installed = createRuntime({triggers: [{getHandlerFunction: () => 'runMyCouponsDaily'}]});
  assert.deepEqual(
    JSON.parse(JSON.stringify(installed.context.getMyCouponsInstallationStatus())),
    {dailyTrigger: 'installed', importState: 'current', ready: true},
  );

  const wrongOwner = createRuntime({profileEmail: 'other@example.com'});
  assert.throws(() => wrongOwner.context.getMyCouponsInstallationStatus(), /configured owner/i);

  const duplicates = createRuntime({triggers: [
    {getHandlerFunction: () => 'runMyCouponsDaily'},
    {getHandlerFunction: () => 'runMyCouponsDaily'},
  ]});
  assert.throws(() => duplicates.context.getMyCouponsInstallationStatus(), /multiple daily triggers/i);
});

test('read-only status validates persisted import state without mutating it', () => {
  const validScan = JSON.stringify({
    boundary: '2026-01-11T10:00:00.000Z',
    configIdentity: JSON.stringify([
      'owner@example.com', 'Coupon Code Discount', 'sheet-id', 'Coupon Manager', true,
      '2026-01-01T00:00:00.000Z', 1,
    ]),
    labelId: 'Label_Imported',
    labelName: 'Coupon Code Discount',
    listedFinalPage: true,
    pageToken: '',
    pendingIds: [],
    start: '2026-01-10T10:00:00.000Z',
    version: 2,
  });
  const runtime = createRuntime({
    scanState: validScan,
    watermark: '2026-01-10T10:00:00.000Z',
  });
  const before = [...runtime.properties.entries()];

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.context.getMyCouponsInstallationStatus())), {
    dailyTrigger: 'missing', importState: 'current', ready: true,
  });
  assert.deepEqual([...runtime.properties.entries()], before);
  assert.equal(runtime.mutations.length, 0);
  assert.equal(runtime.trashed.length, 0);
  assert.equal(runtime.createdTriggers.length, 0);
});

test('read-only status fails closed for malformed persisted scan or watermark state', () => {
  const malformedScan = createRuntime({scanState: '{"version":2}'});
  const malformedScanBefore = [...malformedScan.properties.entries()];
  assert.throws(() => malformedScan.context.getMyCouponsInstallationStatus(), /scan state is invalid/i);
  assert.deepEqual([...malformedScan.properties.entries()], malformedScanBefore);

  const malformedTimestamp = JSON.stringify({
    boundary: '2026-01-11T10:00:00.000Z',
    configIdentity: JSON.stringify([
      'owner@example.com', 'Coupon Code Discount', 'sheet-id', 'Coupon Manager', true,
      '2026-01-01T00:00:00.000Z', 1,
    ]),
    labelId: 'Label_Imported',
    labelName: 'Coupon Code Discount',
    listedFinalPage: true,
    pageToken: '',
    pendingIds: [],
    start: 'not-a-timestamp',
    version: 2,
  });
  const malformedScanTimestamp = createRuntime({scanState: malformedTimestamp});
  const malformedScanTimestampBefore = [...malformedScanTimestamp.properties.entries()];
  assert.throws(() => malformedScanTimestamp.context.getMyCouponsInstallationStatus(), /scan state is invalid/i);
  assert.deepEqual([...malformedScanTimestamp.properties.entries()], malformedScanTimestampBefore);

  const malformedWatermark = createRuntime({
    watermark: 'not-a-timestamp',
  });
  const malformedWatermarkBefore = [...malformedWatermark.properties.entries()];
  assert.throws(() => malformedWatermark.context.getMyCouponsInstallationStatus(), /watermark is invalid/i);
  assert.deepEqual([...malformedWatermark.properties.entries()], malformedWatermarkBefore);
});

test('read-only status reports valid stale import state without clearing it', () => {
  const staleScan = JSON.stringify({
    boundary: '2026-01-11T10:00:00.000Z',
    configIdentity: 'stale-config',
    labelId: 'stale-label',
    labelName: 'Coupon Code Discount',
    listedFinalPage: true,
    pageToken: '',
    pendingIds: [],
    start: '2026-01-10T10:00:00.000Z',
    version: 2,
  });
  const runtime = createRuntime({
    scanState: staleScan,
    watermark: '2026-01-10T10:00:00.000Z',
    watermarkTargetIdentity: 'stale-target',
  });
  const before = [...runtime.properties.entries()];

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.context.getMyCouponsInstallationStatus())), {
    dailyTrigger: 'missing', importState: 'restart-required', ready: true,
  });
  assert.deepEqual([...runtime.properties.entries()], before);
});

test('fails closed for legacy or mismatched daily trigger schedule metadata without mutating triggers', () => {
  const legacy = createRuntime({
    triggers: [{getHandlerFunction: () => 'runMyCouponsDaily'}],
    dailyScheduleMetadata: null,
  });
  assert.throws(() => legacy.context.getMyCouponsInstallationStatus(), /daily schedule/i);
  assert.equal(legacy.createdTriggers.length, 0);

  const mismatched = createRuntime({
    triggers: [{getHandlerFunction: () => 'runMyCouponsDaily'}],
    dailyScheduleMetadata: JSON.stringify({version: 1, identity: 'other-trigger'}),
  });
  assert.throws(() => mismatched.context.installMyCouponsDailyTrigger(), /daily schedule/i);
  assert.equal(mismatched.createdTriggers.length, 0);
});

test('fails closed when a same-handler daily trigger has a different unique ID', () => {
  const runtime = createRuntime({
    triggers: [{
      getHandlerFunction: () => 'runMyCouponsDaily',
      getUniqueId: () => 'replacement-trigger',
    }],
    dailyScheduleMetadata: JSON.stringify({
      version: 2,
      identity: JSON.stringify([
        'owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount',
        'runMyCouponsDaily', 8, 'Europe/Rome',
      ]),
      triggerId: 'original-trigger',
    }),
  });

  assert.throws(() => runtime.context.getMyCouponsInstallationStatus(), /daily schedule/i);
  assert.equal(runtime.createdTriggers.length, 0);
});

test('rejects invalid time zones before trigger creation and accepts valid slashless IANA zones', () => {
  const invalid = createRuntime({config: {timeZone: 'Invalid/Zone'}});
  assert.throws(() => invalid.context.getMyCouponsInstallationStatus(), /valid IANA time zone/i);
  assert.throws(() => invalid.context.installMyCouponsDailyTrigger(), /valid IANA time zone/i);
  assert.equal(invalid.createdTriggers.length, 0);

  const valid = createRuntime({config: {timeZone: 'America/New_York'}});
  assert.deepEqual(JSON.parse(JSON.stringify(valid.context.getMyCouponsInstallationStatus())), {
    dailyTrigger: 'missing', importState: 'current', ready: true,
  });

  const gmt = createRuntime({config: {timeZone: 'GMT'}});
  assert.deepEqual(JSON.parse(JSON.stringify(gmt.context.getMyCouponsInstallationStatus())), {
    dailyTrigger: 'missing', importState: 'current', ready: true,
  });
});

test('requires the imported label to be one unambiguous user label', () => {
  const system = createRuntime({
    config: {labelName: 'INBOX'},
    labels: [{id: 'INBOX', name: 'INBOX', type: 'system'}],
  });
  assert.throws(() => system.context.runMyCouponsImport(), /exactly one user label/i);

  const missingType = createRuntime({
    labels: [{id: 'Label_Imported', name: 'Coupon Code Discount'}],
  });
  assert.throws(() => missingType.context.runMyCouponsImport(), /exactly one user label/i);
});

test('moves only old imported messages to Gmail Trash during retention', () => {
  const runtime = createRuntime({
    config: {retentionDays: 180},
    messages: [
      message({
        id: 'old-imported',
        date: new Date('2025-01-01T00:00:00.000Z'),
        labels: ['Coupon Code Discount'],
      }),
      message({id: 'old-unlabelled', date: new Date('2025-01-01T00:00:00.000Z')}),
      message({
        id: 'recent-imported',
        date: new Date('2026-01-10T00:00:00.000Z'),
        labels: ['Coupon Code Discount'],
      }),
    ],
  });

  const outcome = runtime.context.cleanupExpiredImportedMessages();

  assert.equal(outcome.trashed, 1);
  assert.equal(outcome.complete, true);
  assert.deepEqual(runtime.trashed, [{userId: 'me', id: 'old-imported'}]);
  assert.match(runtime.queries[0], new RegExp(`before:${Math.floor(Date.parse('2025-07-15T10:00:00.000Z') / 1000)}`));
});

test('revalidates each retention candidate immediately before trashing it', () => {
  const transitions = [
    gmailMessages => { gmailMessages.get('old-imported').labelIds = []; },
    gmailMessages => { gmailMessages.get('old-imported').labelIds.push('DRAFT'); },
  ];
  transitions.forEach(beforeRetentionRecheck => {
    const runtime = createRuntime({
      beforeRetentionRecheck,
      messages: [message({
        id: 'old-imported',
        date: new Date('2025-01-01T00:00:00.000Z'),
        labels: ['Coupon Code Discount'],
      })],
    });

    assert.deepEqual(JSON.parse(JSON.stringify(runtime.context.cleanupExpiredImportedMessages())), {
      complete: true, trashed: 0,
    });
    assert.equal(runtime.trashed.length, 0);
  });
});

test('stops retention safely when an immediate candidate recheck is rate limited', () => {
  const runtime = createRuntime({
    fetchFailureAfter: 3,
    messages: [
      message({id: 'old-first', date: new Date('2025-01-01T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
      message({id: 'old-second', date: new Date('2025-01-02T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.context.cleanupExpiredImportedMessages())), {
    complete: false, trashed: 1,
  });
  assert.deepEqual(runtime.trashed, [{userId: 'me', id: 'old-first'}]);
});

test('reports an incomplete retention page after safely trashing its processed messages', () => {
  const runtime = createRuntime({
    listPageSize: 1,
    messages: [
      message({id: 'old-first', date: new Date('2025-01-01T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
      message({id: 'old-second', date: new Date('2025-01-02T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
    ],
  });

  const outcome = runtime.context.cleanupExpiredImportedMessages();
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {complete: false, trashed: 1});
  assert.deepEqual(runtime.trashed, [{userId: 'me', id: 'old-first'}]);
});

test('uses retention system exclusions so an eligible message is not pinned behind protected mail', () => {
  const runtime = createRuntime({
    listPageSize: 1,
    messages: [
      message({id: 'old-sent', date: new Date('2025-01-01T00:00:00.000Z'), labels: ['Coupon Code Discount', 'SENT']}),
      message({id: 'old-eligible', date: new Date('2025-01-02T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
    ],
  });

  const outcome = runtime.context.cleanupExpiredImportedMessages();
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {complete: true, trashed: 1});
  assert.deepEqual(runtime.trashed, [{userId: 'me', id: 'old-eligible'}]);
  assert.match(runtime.queries[0], /-in:sent -in:drafts -in:spam -in:trash/u);
});

test('surfaces incomplete retention through the daily result', () => {
  const runtime = createRuntime({
    listPageSize: 1,
    messages: [
      message({id: 'old-first', date: new Date('2025-01-01T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
      message({id: 'old-second', date: new Date('2025-01-02T00:00:00.000Z'), labels: ['Coupon Code Discount']}),
    ],
  });

  const outcome = runtime.context.runMyCouponsDaily();
  assert.equal(outcome.import.complete, true);
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.retention)), {complete: false, trashed: 1});
});

test('runs retention even when import fails', () => {
  const duplicate = [
    '2026-01-10T08:00:00.000Z', 'SAVE20', 'Earlier', 'offers@example.com',
    'https://mail.google.com/mail/u/0/#all/message-1', 'message-1::SAVE20', 'imported',
  ];
  const runtime = createRuntime({
    existingRows: [duplicate, [...duplicate]],
    messages: [message({
      id: 'old-imported', date: new Date('2025-01-01T00:00:00.000Z'), labels: ['Coupon Code Discount'],
    })],
  });
  assert.throws(() => runtime.context.runMyCouponsDaily(), /duplicate deduplication key/i);
  assert.deepEqual(runtime.trashed, [{userId: 'me', id: 'old-imported'}]);
});

test('does not extract a code found only in a text attachment', () => {
  const runtime = createRuntime({messages: [message({
    id: 'attached-coupon',
    attachmentText: 'Coupon code: ATTACHED20',
  })]});

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 0);
  assert.equal(runtime.mutations.length, 0);
});

test('installs one daily trigger and rejects an ambiguous duplicate trigger set', () => {
  const runtime = createRuntime();

  runtime.context.installMyCouponsDailyTrigger();
  assert.deepEqual(runtime.createdTriggers, [{handler: 'runMyCouponsDaily', hour: 8, timeZone: 'Europe/Rome'}]);
  assert.deepEqual(JSON.parse(runtime.properties.get('MYCOUPONS_DAILY_SCHEDULE')), {
    version: 2,
    identity: JSON.stringify([
      'owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount',
      'runMyCouponsDaily', 8, 'Europe/Rome',
    ]),
    triggerId: 'created-trigger-1',
  });

  const duplicate = createRuntime({triggers: [
    {getHandlerFunction: () => 'runMyCouponsDaily'},
    {getHandlerFunction: () => 'runMyCouponsDaily'},
  ]});
  assert.throws(() => duplicate.context.installMyCouponsDailyTrigger(), /multiple daily triggers/i);
});
