import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/MyCoupons.gs', import.meta.url), 'utf8');

function message({
  id,
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
  corruptLastWrite = false,
  corruptLastWriteColumns = [],
  coerceLastWrite = false,
  formulaLastWriteColumns = [],
  attachmentText = '',
  advanceClockOnList = false,
  fetchFailureAfter = null,
  listFailureAfter = null,
  listPageSize = 100,
  now = new Date('2026-01-11T10:00:00.000Z'),
  labels = [{id: 'Label_Imported', name: 'Coupon Code Discount'}],
  listedMessageIds = messages.map(value => value.id),
  profileEmail = 'owner@example.com',
  triggers = [],
  watermark = null,
  watermarkTargetIdentity = undefined,
} = {}) {
  let clock = now;
  const values = [headers, ...existingRows];
  const formulas = values.map(row => row.map(() => ''));
  const mutations = [];
  const trashed = [];
  const queries = [];
  const createdTriggers = [];
  let getMessageCount = 0;
  let listMessageCount = 0;
  const numberFormats = [];
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
  properties.set('MYCOUPONS_CONFIG', JSON.stringify(installedConfig));
  if (watermark) {
    properties.set('MYCOUPONS_WATERMARK', watermark);
    if (watermarkTargetIdentity !== null) {
      properties.set('MYCOUPONS_WATERMARK_TARGET_IDENTITY', watermarkTargetIdentity === undefined ? JSON.stringify([
        installedConfig.ownerEmail.toLowerCase(), installedConfig.spreadsheetId,
        installedConfig.sheetName, installedConfig.labelName,
      ]) : watermarkTargetIdentity);
    }
  }

  const sheet = {
    getDataRange() {
      return {getValues: () => values.map(row => [...row])};
    },
    getLastColumn: () => headers.length,
    getLastRow: () => values.length,
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
            const offset = Number(options.pageToken || 0);
            const page = listedMessageIds.slice(offset, offset + listPageSize).map(id => ({id}));
            const next = offset + page.length;
            return {
              messages: page,
              ...(next < listedMessageIds.length ? {nextPageToken: String(next)} : {}),
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
      getProjectTriggers: () => triggers,
      newTrigger: handler => ({timeBased: () => ({
        inTimezone: timeZone => ({atHour: hour => ({everyDays: () => ({
          create: () => createdTriggers.push({handler, hour, timeZone}),
        })})}),
      })}),
    },
    SpreadsheetApp: {
      openById: id => {
        assert.equal(id, 'sheet-id');
        return {getSheetByName: name => name === 'Coupon Manager' ? sheet : null};
      },
    },
    Utilities: {
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
    'owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount',
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
  assert.equal(row[13], 'https://mail.google.com/mail/u/0/#all/legacy-message');
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
    message({id: 'otp', body: 'Your verification code: 123456'}),
    message({id: 'generic', body: 'Use SAVE20 at checkout'}),
    message({id: 'ordinary-prose', body: 'No coupon code is required.'}),
    message({id: 'expiry-prose', body: 'Coupon code expires tomorrow'}),
    message({id: 'needed-prose', body: 'Coupon code is not needed'}),
    message({id: 'available-prose', body: 'Coupon code: available after signup'}),
    message({id: 'expires-prose', body: 'Coupon code: expires tomorrow'}),
    message({id: 'click-prose', body: 'Promo code: click here'}),
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
    messages: [message({id: 'message-1', body: 'Coupon code: SAVE20'})],
  });

  const outcome = runtime.context.runMyCouponsImport();

  assert.equal(outcome.imported, 0);
  assert.equal(runtime.rows.length, 2);
  assert.equal(runtime.mutations.length, 1);
  assert.equal(runtime.mutations[0].id, 'message-1');
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK'), '2026-01-11T10:00:00.000Z');
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
      {id: 'Label_Imported', name: 'Coupon Code Discount'},
      {id: 'Label_Replacement', name: 'Replacement Label'},
    ],
    watermark: '2026-01-10T10:00:00.000Z',
    watermarkTargetIdentity: JSON.stringify(['owner@example.com', 'sheet-id', 'Coupon Manager', 'Coupon Code Discount']),
  });

  runtime.context.runMyCouponsImport();
  assert.match(runtime.queries[0], new RegExp(`after:${Math.floor(Date.parse('2025-12-31T23:59:59.000Z') / 1000)}`));
  assert.equal(runtime.properties.get('MYCOUPONS_WATERMARK_TARGET_IDENTITY'), JSON.stringify([
    'owner@example.com', 'sheet-id', 'Coupon Manager', 'Replacement Label',
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
    {dailyTrigger: 'installed', ready: true},
  );

  const wrongOwner = createRuntime({profileEmail: 'other@example.com'});
  assert.throws(() => wrongOwner.context.getMyCouponsInstallationStatus(), /configured owner/i);

  const duplicates = createRuntime({triggers: [
    {getHandlerFunction: () => 'runMyCouponsDaily'},
    {getHandlerFunction: () => 'runMyCouponsDaily'},
  ]});
  assert.throws(() => duplicates.context.getMyCouponsInstallationStatus(), /multiple daily triggers/i);
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
  assert.deepEqual(runtime.trashed, [{userId: 'me', id: 'old-imported'}]);
  assert.match(runtime.queries[0], new RegExp(`before:${Math.floor(Date.parse('2025-07-15T10:00:00.000Z') / 1000)}`));
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

  const duplicate = createRuntime({triggers: [
    {getHandlerFunction: () => 'runMyCouponsDaily'},
    {getHandlerFunction: () => 'runMyCouponsDaily'},
  ]});
  assert.throws(() => duplicate.context.installMyCouponsDailyTrigger(), /multiple daily triggers/i);
});
