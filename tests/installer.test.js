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
