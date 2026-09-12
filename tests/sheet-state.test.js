const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function sheetMock(name, rows = []) {
  const values = rows.map(row => row.slice());
  const validations = [];
  return {
    getName: () => name,
    getLastRow: () => values.length,
    getLastColumn: () => values.reduce((max, row) => Math.max(max, row.length), 0),
    getMaxRows: () => 1000,
    getDataRange: () => ({getValues: () => values.map(row => row.slice()),
      getDisplayValues: () => values.map(row => row.map(value => String(value ?? '')))}),
    getRange: (row, column, rowCount, columnCount) => ({
      getValues: () => Array.from({length: rowCount}, (_, r) => Array.from({length: columnCount}, (_, c) => values[row - 1 + r]?.[column - 1 + c] ?? '')),
      getDisplayValues: () => values.slice(row - 1, row - 1 + rowCount)
        .map(item => item.slice(column - 1, column - 1 + columnCount)
          .map(value => String(value ?? ''))),
      setValues: next => {
        for (let r = 0; r < rowCount; r++) {
          while (values.length < row + r) values.push([]);
          while (values[row - 1 + r].length < column + columnCount - 1) values[row - 1 + r].push('');
          for (let c = 0; c < columnCount; c++) values[row - 1 + r][column - 1 + c] = next[r][c];
        }
      },
      setDataValidation: rule => { validations.push({row, column, rowCount, columnCount, rule}); }
    }),
    _values: values, _validations: validations
  };
}

function spreadsheetMock(name, sheets = []) {
  const byName = new Map(sheets.map(sheet => [sheet.getName(), sheet]));
  const insertedNames = [];
  return {
    getId: () => 'sheet-1', getName: () => name,
    getSheetByName: sheetName => byName.get(sheetName) || null,
    insertSheet: sheetName => {
      const sheet = sheetMock(sheetName);
      byName.set(sheetName, sheet); insertedNames.push(sheetName); return sheet;
    },
    get insertedNames() { return insertedNames; }
  };
}

function dataValidationBuilder() {
  return () => {
    const rule = {};
    return {requireValueInList: (values, showDropdown) => {
      rule.values = values; rule.showDropdown = showDropdown; return {setAllowInvalid: allowed => {
        rule.allowInvalid = allowed; return {build: () => rule};
      }};
    }};
  };
}

function installServices(ctx, spreadsheet, files, labels) {
  let createdLabels = [];
  ctx.DriveApp = {getFilesByName: () => {
    let index = 0;
    return {hasNext: () => index < files.length, next: () => files[index++]};
  }};
  ctx.SpreadsheetApp = {
    openById: id => { assert.equal(id, 'sheet-1'); return spreadsheet; },
    create: () => { throw new Error('must not create'); },
    newDataValidation: dataValidationBuilder()
  };
  ctx.Gmail.Users.Labels = {
    list: () => ({labels: labels.concat(createdLabels)}),
    create: resource => {
      const label = {id: 'label-' + (createdLabels.length + 1), name: resource.name};
      createdLabels.push(label); return label;
    }
  };
  return () => createdLabels;
}

test('resource setup adopts one owned spreadsheet, creates missing tabs and nested labels', () => {
  const {ctx, config, properties} = harness();
  const spreadsheet = spreadsheetMock(config.spreadsheetName, []);
  const files = [{getId: () => 'sheet-1', getMimeType: () => 'application/vnd.google-apps.spreadsheet', isTrashed: () => false}];
  const created = installServices(ctx, spreadsheet, files, []);
  const result = ctx.ensureSheetState_({...config, spreadsheetId: '', labelName: 'Shopping/Coupons'});
  assert.deepEqual(spreadsheet.insertedNames, [config.sheetName, '_MyCoupons Messages']);
  assert.equal(result.label.name, 'Shopping/Coupons');
  assert.deepEqual(created().map(label => label.name), ['Shopping', 'Shopping/Coupons']);
  assert.equal(JSON.parse(properties.MYCOUPONS_CONFIG).spreadsheetId, 'sheet-1');
  assert.equal(JSON.parse(properties.MYCOUPONS_CONFIG).labelId, 'label-2');
  assert.equal(result.recoveryStart, Date.parse('2026-05-21T22:00:00Z'));
  assert.deepEqual(JSON.parse(JSON.stringify(result.couponSheet._validations)), [{row: 2, column: 25, rowCount: 999, columnCount: 1,
    rule: {values: ['Confirm', 'Ignore', 'Retry with AI'], showDropdown: true, allowInvalid: false}}]);
});

test('missing spreadsheet is created only when exact-name discovery returns no match', () => {
  const {ctx, config} = harness();
  const spreadsheet = spreadsheetMock(config.spreadsheetName, []);
  ctx.DriveApp = {getFilesByName: () => ({hasNext: () => false})};
  ctx.SpreadsheetApp = {create: () => spreadsheet, newDataValidation: dataValidationBuilder()};
  ctx.Gmail.Users.Labels = {list: () => ({labels: [{id: 'label-1', name: config.labelName}]})};
  const result = ctx.ensureSheetState_({...config, spreadsheetId: ''});
  assert.deepEqual(spreadsheet.insertedNames, [config.sheetName, '_MyCoupons Messages']);
  assert.equal(result.label.id, 'label-1');
});

test('empty missing resources require initialDate before spreadsheet creation', () => {
  const {ctx, config} = harness();
  let creations = 0;
  const spreadsheet = spreadsheetMock(config.spreadsheetName, []);
  ctx.DriveApp = {getFilesByName: () => ({hasNext: () => false})};
  ctx.SpreadsheetApp = {create: () => { creations++; return spreadsheet; }};
  ctx.Gmail.Users.Labels = {list: () => ({labels: []})};
  assert.throws(() => ctx.ensureSheetState_({...config, spreadsheetId: '', initialDate: ''}), /INITIAL_DATE/);
  assert.equal(creations, 0);
  assert.deepEqual(spreadsheet.insertedNames, []);
});

test('label discovery follows pagination before deciding to create a label', () => {
  const {ctx, config} = harness();
  let calls = 0;
  ctx.Gmail.Users.Labels = {list: (userId, options) => {
    calls++;
    if (!options) return {labels: [{id: 'first', name: 'Other'}], nextPageToken: 'page-2'};
    assert.equal(options.pageToken, 'page-2');
    return {labels: [{id: 'target', name: config.labelName}]};
  }};
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.resolveGmailLabel_(config))),
    {id: 'target', name: config.labelName});
  assert.equal(calls, 2);
});

test('ambiguous spreadsheet names fail closed without creating resources', () => {
  const {ctx, config} = harness();
  const spreadsheet = spreadsheetMock(config.spreadsheetName, []);
  const files = [
    {getId: () => 'sheet-1', getMimeType: () => 'application/vnd.google-apps.spreadsheet', isTrashed: () => false},
    {getId: () => 'sheet-2', getMimeType: () => 'application/vnd.google-apps.spreadsheet', isTrashed: () => false}
  ];
  installServices(ctx, spreadsheet, files, []);
  assert.throws(() => ctx.ensureSheetState_({...config, spreadsheetId: ''}), /RESOURCE/);
  assert.deepEqual(spreadsheet.insertedNames, []);
});

test('malformed existing coupon headers are rejected before label creation', () => {
  const {ctx, config} = harness();
  const malformed = sheetMock(config.sheetName, [['wrong']]);
  const spreadsheet = spreadsheetMock(config.spreadsheetName, [malformed]);
  const files = [{getId: () => 'sheet-1', getMimeType: () => 'application/vnd.google-apps.spreadsheet', isTrashed: () => false}];
  const created = installServices(ctx, spreadsheet, files, []);
  assert.throws(() => ctx.ensureSheetState_(config), /RESOURCE/);
  assert.deepEqual(created(), []);
  assert.deepEqual(spreadsheet.insertedNames, []);
});

test('journal states preserve retry and dedupe metadata and reject duplicates', () => {
  const {ctx} = harness();
  const journal = sheetMock('_MyCoupons Messages', [['Message ID', 'State JSON']]);
  const state = ctx.newMessageState_('opaque-message-id');
  state.status = 'failed'; state.attempts = 2; state.retryCount = 1;
  state.dedupeKeys = ['merchant|code']; state.lastError = 'temporary';
  ctx.saveMessageState_(journal, state);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.getMessageState_(journal, 'opaque-message-id'))),
    JSON.parse(JSON.stringify(state)));
  assert.equal(ctx.findMessageStateByDedupeKey_(journal, 'merchant|code').messageId, 'opaque-message-id');
  const updated = ctx.updateMessageState_(journal, 'opaque-message-id', {status: 'processing', attempts: 3});
  assert.equal(updated.status, 'processing');
  assert.throws(() => ctx.updateMessageState_(journal, 'opaque-message-id', {messageId: 'other'}), /STATE/);
  assert.throws(() => ctx.updateMessageState_(journal, 'opaque-message-id', {version: 2}), /STATE/);
  journal._values.push(['opaque-message-id', JSON.stringify(state)]);
  assert.throws(() => ctx.readMessageJournal_(journal), /STATE/);
});
