const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function bootstrapPayload(config, geminiApiKey = 'AIza12345678901234567890') {
  return JSON.stringify({version: 1, config, geminiApiKey});
}

function crc32c(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = checksum & 1 ? (checksum >>> 1) ^ 0x82f63b78 : checksum >>> 1;
  }
  return (checksum ^ -1) >>> 0;
}

function bootstrapSecret(payload, {name = 'projects/123456789/secrets/mycoupons-bootstrap/versions/7', checksum} = {}) {
  const bytes = Buffer.from(payload);
  return {getResponseCode: () => 200, getContentText: () => JSON.stringify({
    name, payload: {data: bytes.toString('base64'), dataCrc32c: checksum == null ? String(crc32c(bytes)) : checksum}
  })};
}

function bootstrapFetch(payload, {projectId = 'vertex-project', projectNumber = '123456789'} = {}) {
  return url => {
    if (url.startsWith('https://secretmanager.googleapis.com/')) {
      return bootstrapSecret(payload, {name: 'projects/' + projectNumber + '/secrets/mycoupons-bootstrap/versions/7'});
    }
    if (url === 'https://cloudresourcemanager.googleapis.com/v1/projects/' + projectId) {
      return {getResponseCode: () => 200, getContentText: () => JSON.stringify({projectId, projectNumber})};
    }
    assert.fail('unexpected bootstrap request: ' + url);
  };
}

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

test('owner-only bootstrap reads the exact temporary secret and returns no secret data', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const proposed = {...config, vertexProject: 'vertex-project'};
  const requests = [];
  ctx.UrlFetchApp = {fetch: (url, options) => {
    requests.push({url, options});
    return bootstrapFetch(bootstrapPayload(proposed))(url);
  }};
  ctx.beginMyCouponsInstallation = input => {
    assert.equal(JSON.stringify(input), JSON.stringify(proposed));
    return {version: 1, installed: true, resumed: false, spreadsheetId: 'sheet-id', labelId: 'Label_123',
      triggerCreated: true, reviewTriggerCreated: true, locale: 'en', timeZone: 'Europe/Rome', geminiApiKey: 'never-return'};
  };
  const result = ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7');
  assert.equal(properties.GEMINI_API_KEY, 'AIza12345678901234567890');
  assert.equal(JSON.stringify(result), JSON.stringify({version: 1, installed: true, resumed: false, spreadsheetId: 'sheet-id', labelId: 'Label_123',
    triggerCreated: true, reviewTriggerCreated: true, locale: 'en', timeZone: 'Europe/Rome'}));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://secretmanager.googleapis.com/v1/projects/vertex-project/secrets/mycoupons-bootstrap/versions/7:access');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer oauth-token');
  assert.equal(requests[1].url, 'https://cloudresourcemanager.googleapis.com/v1/projects/vertex-project');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer oauth-token');
});

test('bootstrap rejects malformed and foreign resources or payloads without installing', () => {
  const {ctx, config} = harness();
  let requested = 0;
  let installed = 0;
  ctx.UrlFetchApp = {fetch: () => { requested += 1; return bootstrapSecret('{"version":1}'); }};
  ctx.beginMyCouponsInstallation = () => { installed += 1; };
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/other/versions/7'), /RESOURCE/);
  assert.equal(requested, 0);
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/latest'), /RESOURCE/);
  assert.equal(requested, 0);
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /CONFIG/);
  assert.equal(installed, 0);
  ctx.UrlFetchApp.fetch = () => bootstrapSecret(bootstrapPayload({...config, vertexProject: 'foreign-project'}));
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(installed, 0);
});

test('bootstrap rejects a missing or mismatched Secret Manager response identity before mutation', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const payload = bootstrapPayload({...config, vertexProject: 'vertex-project'});
  let installed = 0;
  ctx.beginMyCouponsInstallation = () => { installed += 1; };
  ctx.UrlFetchApp = {fetch: () => bootstrapSecret(payload, {name: 'projects/123456789/secrets/mycoupons-bootstrap/versions/8'})};
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(properties.GEMINI_API_KEY, undefined);
  assert.equal(installed, 0);
  ctx.UrlFetchApp.fetch = () => ({getResponseCode: () => 200, getContentText: () => JSON.stringify({
    payload: {data: Buffer.from(payload).toString('base64'), dataCrc32c: '0'}
  })});
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(properties.GEMINI_API_KEY, undefined);
  assert.equal(installed, 0);
});

test('bootstrap rejects a canonical Secret Manager project number that differs from the resolved project', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const payload = bootstrapPayload({...config, vertexProject: 'vertex-project'});
  let installed = 0;
  ctx.beginMyCouponsInstallation = () => { installed += 1; };
  ctx.UrlFetchApp = {fetch: url => {
    if (url.startsWith('https://secretmanager.googleapis.com/')) {
      return bootstrapSecret(payload, {name: 'projects/999999999/secrets/mycoupons-bootstrap/versions/7'});
    }
    if (url === 'https://cloudresourcemanager.googleapis.com/v1/projects/vertex-project') {
      return {getResponseCode: () => 200, getContentText: () => JSON.stringify({
        projectId: 'vertex-project', projectNumber: '123456789'
      })};
    }
    assert.fail('unexpected bootstrap request: ' + url);
  }};
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(installed, 0);
  assert.equal(properties.GEMINI_API_KEY, undefined);
  assert.equal(properties.MYCOUPONS_CONFIG, undefined);
});

test('bootstrap requires every non-persisted installer configuration field', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const incomplete = {...config, vertexProject: 'vertex-project'};
  delete incomplete.model;
  let installed = 0;
  ctx.beginMyCouponsInstallation = () => { installed += 1; };
  ctx.UrlFetchApp = {fetch: () => bootstrapSecret(bootstrapPayload(incomplete))};
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /CONFIG/);
  assert.equal(installed, 0);
  assert.equal(properties.GEMINI_API_KEY, undefined);
});

test('bootstrap verifies Secret Manager dataCrc32c before parsing or mutation', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const payload = bootstrapPayload({...config, vertexProject: 'vertex-project'});
  let installed = 0;
  ctx.beginMyCouponsInstallation = () => { installed += 1; };
  ctx.UrlFetchApp = {fetch: () => bootstrapSecret(payload, {checksum: '0'})};
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(installed, 0);
  assert.equal(properties.GEMINI_API_KEY, undefined);
});

test('bootstrap rejects duplicate top-level and configuration keys before mutation', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const proposed = {...config, vertexProject: 'vertex-project'};
  const key = 'AIza12345678901234567890';
  const duplicateTopLevel = '{"version":1,"config":' + JSON.stringify(proposed) +
    ',"geminiApiKey":"' + key + '","geminiApiKey":"' + key + '"}';
  const duplicateConfig = '{"version":1,"config":' + JSON.stringify(proposed).replace(
    '"ownerEmail":"owner@example.com"', '"ownerEmail":"owner@example.com","ownerEmail":"owner@example.com"') +
    ',"geminiApiKey":"' + key + '"}';
  let installed = 0;
  ctx.beginMyCouponsInstallation = () => { installed += 1; };
  ctx.UrlFetchApp = {fetch: () => bootstrapSecret(duplicateTopLevel)};
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /CONFIG/);
  ctx.UrlFetchApp.fetch = () => bootstrapSecret(duplicateConfig);
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /CONFIG/);
  assert.equal(installed, 0);
  assert.equal(properties.GEMINI_API_KEY, undefined);
});

test('bootstrap fails closed on an unauthorized caller or Secret Manager HTTP error', () => {
  const {ctx, properties, config} = harness();
  const persisted = {...config, vertexProject: 'vertex-project'};
  properties.MYCOUPONS_CONFIG = JSON.stringify(persisted);
  let requested = 0;
  ctx.UrlFetchApp = {fetch: () => { requested += 1; return {getResponseCode: () => 403, getContentText: () => 'sensitive body'}; }};
  ctx.Session.getEffectiveUser = () => ({getEmail: () => 'other@example.com'});
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /OWNER/);
  assert.equal(requested, 0);
  ctx.Session.getEffectiveUser = () => ({getEmail: () => persisted.ownerEmail});
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(requested, 1);
});

test('bootstrap never reads a version outside the persisted Vertex project', () => {
  const {ctx, properties, config} = harness();
  properties.MYCOUPONS_CONFIG = JSON.stringify({...config, vertexProject: 'vertex-project'});
  let secretRequested = 0;
  ctx.UrlFetchApp = {fetch: (url) => {
    if (url.includes('secretmanager.googleapis.com')) secretRequested += 1;
    return bootstrapSecret('{}');
  }};
  assert.throws(() => ctx.bootstrapFromSecret('projects/foreign-project/secrets/mycoupons-bootstrap/versions/7'), /RESOURCE/);
  assert.equal(secretRequested, 0);
});

test('bootstrap restores the prior key and leaves secret data out of errors when installation fails', () => {
  const {ctx, properties, config} = harness();
  delete properties.MYCOUPONS_CONFIG;
  const secret = 'AIza12345678901234567890';
  const prior = 'AIza98765432109876543210';
  properties.GEMINI_API_KEY = prior;
  ctx.UrlFetchApp = {fetch: bootstrapFetch(bootstrapPayload({...config, vertexProject: 'vertex-project'}, secret))};
  ctx.beginMyCouponsInstallation = () => { throw new Error('INSTALL_FAILED'); };
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), error => {
    assert.equal(error.message, 'INSTALL_FAILED');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(properties.GEMINI_API_KEY, prior);
});

test('bootstrap restores the prior configuration and key when transactional installation fails', () => {
  const {ctx, properties, config} = harness();
  const previous = {...config, vertexProject: 'vertex-project'};
  const replacement = {...previous, model: 'gemini-replacement'};
  const priorKey = 'AIza98765432109876543210';
  properties.MYCOUPONS_CONFIG = JSON.stringify(previous);
  properties.GEMINI_API_KEY = priorKey;
  ctx.UrlFetchApp = {fetch: bootstrapFetch(bootstrapPayload(replacement))};
  ctx.openSpreadsheetById_ = id => ({getId: () => id});
  ctx.assertPrivateSpreadsheet_ = () => {};
  ctx.ensureSheetState_ = input => {
    properties.MYCOUPONS_CONFIG = JSON.stringify({...input, labelId: 'Label_123'});
    return {spreadsheet: {getId: () => input.spreadsheetId}, label: {id: 'Label_123'}};
  };
  ctx.installReviewEditTrigger_ = () => ({created: false});
  ctx.installDailyImportTrigger = () => { throw new Error('TRIGGER'); };
  assert.throws(() => ctx.bootstrapFromSecret('projects/vertex-project/secrets/mycoupons-bootstrap/versions/7'), /TRIGGER/);
  assert.equal(properties.MYCOUPONS_CONFIG, JSON.stringify(previous));
  assert.equal(properties.GEMINI_API_KEY, priorKey);
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
  ctx.openSpreadsheetById_ = id => ({getId: () => id});
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
  ctx.openSpreadsheetById_ = id => ({getId: () => id});
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
  ctx.openSpreadsheetById_ = id => ({getId: () => id});
  ctx.assertPrivateSpreadsheet_ = () => {};
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

test('automation removal recovers one scheduled trigger after its stored ID is lost', () => {
  const {ctx, properties} = harness();
  const trigger = {getHandlerFunction: () => 'runScheduledImport', getEventType: () => 'CLOCK'};
  const removed = [];
  delete properties.MYCOUPONS_TRIGGER_ID;
  ctx.ScriptApp.getProjectTriggers = () => [trigger];
  ctx.ScriptApp.deleteTrigger = value => { removed.push(value); };
  const result = ctx.removeMyCouponsAutomation();
  assert.equal(result.scheduledRemoved, true);
  assert.equal(result.reviewRemoved, 0);
  assert.deepEqual(removed, [trigger]);
});

test('automation removal keeps missing-ID scheduled trigger duplicates ambiguous', () => {
  const {ctx, properties} = harness();
  const first = {getHandlerFunction: () => 'runScheduledImport', getEventType: () => 'CLOCK'};
  const second = {getHandlerFunction: () => 'runScheduledImport', getEventType: () => 'CLOCK'};
  const removed = [];
  delete properties.MYCOUPONS_TRIGGER_ID;
  ctx.ScriptApp.getProjectTriggers = () => [first, second];
  ctx.ScriptApp.deleteTrigger = value => { removed.push(value); };
  assert.throws(() => ctx.removeMyCouponsAutomation(), /RESOURCE/);
  assert.deepEqual(removed, []);
});

test('automation removal retains owner enforcement during missing-ID recovery', () => {
  const {ctx, properties} = harness();
  const trigger = {getHandlerFunction: () => 'runScheduledImport', getEventType: () => 'CLOCK'};
  const removed = [];
  delete properties.MYCOUPONS_TRIGGER_ID;
  ctx.Session.getEffectiveUser = () => ({getEmail: () => 'other@example.com'});
  ctx.Gmail.Users.getProfile = () => ({emailAddress: 'other@example.com'});
  ctx.ScriptApp.getProjectTriggers = () => [trigger];
  ctx.ScriptApp.deleteTrigger = value => { removed.push(value); };
  assert.throws(() => ctx.removeMyCouponsAutomation(), /OWNER/);
  assert.deepEqual(removed, []);
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
