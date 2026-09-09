const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

test('installer input accepts only validated product configuration', () => {
  const {ctx, config} = harness();
  assert.equal(ctx.validateInstallerInput_(config).ownerEmail, 'owner@example.com');
  assert.throws(() => ctx.validateInstallerInput_({...config, secret: 'never'}), /CONFIG/);
  assert.throws(() => ctx.validateInstallerInput_({...config, ownerEmail: 'not-an-email'}), /CONFIG/);
});

test('installer input rejects oversized bounded settings', () => {
  const {ctx, config} = harness();
  assert.throws(() => ctx.validateInstallerInput_({...config, model: 'gemini-' + 'x'.repeat(8000)}), /CONFIG/);
});

test('persisted label identity is accepted only on the resume path', () => {
  const {ctx, config} = harness();
  const persisted = {...config, labelId: 'Label_123'};
  assert.equal(ctx.validateInstallerInput_(persisted, true).labelId, 'Label_123');
  assert.throws(() => ctx.validateInstallerInput_(persisted, false), /CONFIG/);
  assert.throws(() => ctx.installMyCoupons(false), /CONFIG/);
});

test('installation status reports an unconfigured deployment without masking malformed state', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const status = ctx.getInstallationStatus();
  assert.equal(status.configured, false);
  assert.equal(status.spreadsheetId, '');
  assert.equal(status.labelId, '');
  assert.equal(status.triggerCount, 0);
  assert.equal(status.ready, false);
  properties.MYCOUPONS_CONFIG = JSON.stringify({...config, locale: 'it'});
  assert.throws(() => ctx.getInstallationStatus(), /CONFIG/);
});

test('failed replacement installation restores the prior active configuration', () => {
  const {ctx, properties, config} = harness();
  const previous = properties.MYCOUPONS_CONFIG;
  const replacement = {...config, model: 'gemini-replacement'};
  ctx.ensureSheetState_ = input => {
    properties.MYCOUPONS_CONFIG = JSON.stringify({...input, labelId: 'Label_123'});
    return {spreadsheet: {getId: () => input.spreadsheetId}, label: {id: 'Label_123'}};
  };
  ctx.assertPrivateSpreadsheet_ = () => {};
  ctx.installReviewEditTrigger_ = () => ({created: false});
  ctx.installDailyImportTrigger = () => { throw new Error('TRIGGER'); };
  assert.throws(() => ctx.installMyCoupons(replacement), /TRIGGER/);
  assert.equal(properties.MYCOUPONS_CONFIG, previous);
});

test('failed resumed installation removes a newly created review trigger', () => {
  const {ctx, config} = harness();
  const reviewTrigger = {id: 'new-review-trigger'};
  const removed = [];
  ctx.assertPrivateSpreadsheet_ = () => {};
  ctx.ensureSheetState_ = input => ({spreadsheet: {getId: () => input.spreadsheetId}, label: {id: 'Label_123'}});
  ctx.installReviewEditTrigger_ = () => ({created: true, trigger: reviewTrigger});
  ctx.installDailyImportTrigger = () => { throw new Error('TRIGGER'); };
  ctx.ScriptApp.deleteTrigger = trigger => { removed.push(trigger); };
  assert.throws(() => ctx.installMyCoupons(), /TRIGGER/);
  assert.deepEqual(removed, [reviewTrigger]);
});

test('failed replacement trigger creation restores the prior review trigger', () => {
  const {ctx, properties, config} = harness();
  const previous = {...config, spreadsheetId: 'old-sheet-id'};
  const replacement = {...config, spreadsheetId: 'new-sheet-id', model: 'gemini-replacement'};
  properties.MYCOUPONS_CONFIG = JSON.stringify(previous);
  const triggerSources = [];
  ctx.openSpreadsheetById_ = id => ({getId: () => id});
  ctx.assertPrivateSpreadsheet_ = () => {};
  ctx.ensureSheetState_ = input => {
    properties.MYCOUPONS_CONFIG = JSON.stringify({...input, labelId: 'Label_123'});
    return {spreadsheet: {getId: () => input.spreadsheetId}, label: {id: 'Label_123'}};
  };
  ctx.installReviewEditTrigger_ = spreadsheet => {
    triggerSources.push(spreadsheet.getId());
    if (triggerSources.length === 1) throw new Error('TRIGGER');
    return {created: true};
  };
  assert.throws(() => ctx.installMyCoupons(replacement), /TRIGGER/);
  assert.deepEqual(triggerSources, ['new-sheet-id', 'old-sheet-id']);
  assert.equal(properties.MYCOUPONS_CONFIG, JSON.stringify(previous));
});

test('scheduled import resolves state while holding the workflow lock', () => {
  const {ctx} = harness();
  let depth = 0;
  let resolutionDepth = 0;
  const deadlines = [];
  ctx.withLock_ = (fn, deadlineMs) => {
    deadlines.push(deadlineMs);
    depth += 1;
    try { return fn(); } finally { depth -= 1; }
  };
  ctx.ensureSheetState_ = () => {
    resolutionDepth = depth;
    throw new Error('STATE');
  };
  ctx.notifyScheduledImport_ = () => {};
  ctx.runScheduledImport();
  assert.equal(resolutionDepth, 1);
  assert.equal(typeof deadlines[0], 'number');
});

test('review edits reload configuration after acquiring the lock', () => {
  const {ctx, config} = harness();
  const replacement = {...config, spreadsheetId: 'replacement-sheet-id'};
  let processed = 0;
  ctx.config_ = () => config;
  ctx.withLock_ = fn => {
    ctx.config_ = () => replacement;
    return fn();
  };
  ctx.assertPrivateSpreadsheet_ = () => assert.fail('stale source must be rejected before privacy checks');
  ctx.processReviewAction_ = () => { processed += 1; };
  const oldSheet = {getName: () => config.sheetName, getParent: () => ({getId: () => config.spreadsheetId})};
  ctx.onReviewEdit({value: 'Confirm', range: {getSheet: () => oldSheet, getColumn: () => 25, getRow: () => 2}});
  assert.equal(processed, 0);
});

test('review edits ignore an action that changed before the lock was acquired', () => {
  const {ctx, config} = harness();
  let processed = 0;
  ctx.withLock_ = fn => fn();
  ctx.config_ = () => config;
  ctx.assertPrivateSpreadsheet_ = () => {};
  ctx.processReviewAction_ = () => { processed += 1; };
  const sheet = {
    getName: () => config.sheetName,
    getParent: () => ({getId: () => config.spreadsheetId}),
    getRange: () => ({getValues: () => [['Review', '', '', '', '', '', '', 'Ignore']]})
  };
  ctx.onReviewEdit({value: 'Confirm', range: {getSheet: () => sheet, getColumn: () => 25, getRow: () => 2}});
  assert.equal(processed, 0);
});

test('fresh explicit spreadsheet IDs are privacy-checked before resource setup', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  let privacyChecks = 0;
  ctx.openSpreadsheetById_ = id => ({getId: () => id});
  ctx.assertPrivateSpreadsheet_ = () => { privacyChecks += 1; };
  ctx.ensureSheetState_ = () => {
    assert.equal(privacyChecks, 1);
    throw new Error('STOP');
  };
  assert.throws(() => ctx.installMyCoupons(config), /STOP/);
});

test('review validation ignores the internal dedupe key column', () => {
  const {ctx} = harness();
  const row = Array(26).fill('');
  row[0] = new Date('2026-01-01T00:00:00Z');
  row[1] = 'Merchant';
  row[3] = 'CODE';
  row[11] = 'Subject'; row[12] = 'Sender'; row[13] = 'https://mail.google.com/mail/u/0/#all/abc';
  row[16] = 'sha256-dedupe-key';
  ctx.candidateSource_ = () => ({spans: [{text: 'Merchant CODE'}]});
  ctx.fieldInQuote_ = () => true;
  assert.equal(ctx.validateReviewRow_(row, {receivedAtMs: Date.parse('2026-01-01T00:00:00Z'), subject: 'Subject', sender: 'Sender', link: row[13]}), true);
});

test('review validation rejects an empty offer even when its fields have no evidence', () => {
  const {ctx} = harness();
  ctx.candidateSource_ = () => ({spans: []});
  assert.equal(ctx.validateReviewRow_(Array(26).fill(''), {}), false);
});

test('review validation rejects a numeric discount range endpoint', () => {
  const {ctx} = harness();
  const row = Array(26).fill('');
  row[1] = 'Merchant'; row[3] = 'CODE'; row[4] = '%'; row[5] = '30';
  ctx.candidateSource_ = () => ({spans: ['Merchant CODE Save 20-30%']});
  assert.equal(ctx.validateReviewRow_(row, {}), false);
});

test('review validation rejects an invalid expiry even when quoted', () => {
  const {ctx} = harness();
  const row = Array(26).fill('');
  row[1] = 'Merchant'; row[3] = 'CODE'; row[9] = 'tomorrow';
  ctx.candidateSource_ = () => ({spans: ['Merchant CODE tomorrow']});
  assert.equal(ctx.validateReviewRow_(row, {}), false);
});

test('daily trigger ownership rejects duplicate active handler triggers', () => {
  const {ctx, properties} = harness();
  properties.MYCOUPONS_TRIGGER_ID = 'trigger-one';
  ctx.ScriptApp.getProjectTriggers = () => [
    {getHandlerFunction: () => 'runScheduledImport', getEventType: () => 'CLOCK', getUniqueId: () => 'trigger-one'},
    {getHandlerFunction: () => 'runScheduledImport', getEventType: () => 'CLOCK', getUniqueId: () => 'trigger-two'}
  ];
  assert.throws(() => ctx.ownedImportTriggers_(), /RESOURCE/);
});

test('private spreadsheet permission inspection requests owner email fields', () => {
  const {ctx, config} = harness();
  let options;
  ctx.DriveApp = {
    Access: {PRIVATE: 'PRIVATE'}, Permission: {NONE: 'NONE'},
    getFileById: () => ({getSharingAccess: () => 'PRIVATE', getSharingPermission: () => 'NONE',
      getEditors: () => [], getViewers: () => []})
  };
  ctx.Drive = {Permissions: {list: (_, value) => {
    options = value;
    return {permissions: [{type: 'user', role: 'owner', emailAddress: config.ownerEmail}]};
  }}};
  ctx.assertPrivateSpreadsheet_({getId: () => config.spreadsheetId}, config);
  assert.equal(options.fields, 'nextPageToken,permissions(type,role,emailAddress)');
});

test('review edits from another spreadsheet never reach privacy or action processing', () => {
  const {ctx, config} = harness();
  let privacyChecks = 0;
  ctx.config_ = () => config;
  ctx.assertPrivateSpreadsheet_ = () => { privacyChecks += 1; };
  const foreignSheet = {getName: () => config.sheetName, getParent: () => ({getId: () => 'old-sheet-id'})};
  ctx.onReviewEdit({value: 'Confirm', range: {getSheet: () => foreignSheet, getColumn: () => 25, getRow: () => 2}});
  assert.equal(privacyChecks, 0);
});
