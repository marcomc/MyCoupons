const MC_MESSAGE_STATE_STATUSES = Object.freeze([
  'pending', 'processing', 'review', 'confirmed', 'ignored', 'failed'
]);
const MC_MESSAGE_STATE_KEYS = Object.freeze([
  'version', 'messageId', 'status', 'attempts', 'retryCount', 'dedupeKeys',
  'candidateKeys', 'rowNumbers', 'candidateStates', 'lastAttemptAt', 'nextRetryAt', 'lastError',
  'failureStage', 'outcome', 'labelApplied', 'archived', 'updatedAt'
]);
const MC_LEGACY_MESSAGE_STATE_KEYS = Object.freeze([
  'version', 'messageId', 'status', 'attempts', 'retryCount', 'dedupeKeys',
  'candidateKeys', 'rowNumbers', 'lastAttemptAt', 'nextRetryAt', 'lastError',
  'failureStage', 'outcome', 'labelApplied', 'archived', 'updatedAt'
]);

function ensureSheetState_(input, deadlineMs) {
  const c = validateConfig_(input || config_());
  return withLock_(function () {
    assertOwner_(c);
    const spreadsheet = resolveSpreadsheet_(c);
    let couponSheet = spreadsheet.getSheetByName(c.sheetName);
    if (couponSheet) validateExistingCouponSheet_(couponSheet);
    const recoveryStart = couponSheet ? recoveryStartForSheet_(couponSheet, c) :
      recoveryStart_([], c);
    if (!couponSheet) couponSheet = ensureCouponSheet_(spreadsheet, c.sheetName);
    ensureReviewActionValidation_(couponSheet);
    const journalSheet = ensureJournalSheet_(spreadsheet);
    const label = resolveGmailLabel_(c);
    const resolvedConfig = persistResourceIdentity_(c, spreadsheet.getId(), label.id);
    return {
      config: resolvedConfig,
      spreadsheet: spreadsheet,
      couponSheet: couponSheet,
      journalSheet: journalSheet,
      recoveryStart: recoveryStart,
      label: label
    };
  }, deadlineMs);
}

function resolveSpreadsheet_(c) {
  let spreadsheet;
  if (c.spreadsheetId) {
    spreadsheet = openSpreadsheetById_(c.spreadsheetId);
  } else {
    const matches = findSpreadsheetsByName_(c.spreadsheetName);
    if (matches.length > 1) fail_('RESOURCE');
    if (!matches.length && !c.initialDate) fail_('INITIAL_DATE');
    spreadsheet = matches.length ? openSpreadsheetById_(matches[0]) : createSpreadsheet_(c.spreadsheetName);
  }
  assertSpreadsheetIdentity_(spreadsheet, c);
  return spreadsheet;
}

function findSpreadsheetsByName_(name) {
  const files = DriveApp.getFilesByName(name);
  const ids = [];
  while (files.hasNext()) {
    const file = files.next();
    if (typeof file.isTrashed === 'function' && file.isTrashed()) continue;
    if (typeof file.getMimeType === 'function' &&
      file.getMimeType() !== 'application/vnd.google-apps.spreadsheet') continue;
    const id = typeof file.getId === 'function' ? String(file.getId()) : '';
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  return ids;
}

function openSpreadsheetById_(id) {
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    fail_('RESOURCE');
  }
}

function createSpreadsheet_(name) {
  try {
    return SpreadsheetApp.create(name);
  } catch (e) {
    fail_('RESOURCE');
  }
}

function assertSpreadsheetIdentity_(spreadsheet, c) {
  if (!spreadsheet || typeof spreadsheet.getId !== 'function' ||
    String(spreadsheet.getId()) !== (c.spreadsheetId || String(spreadsheet.getId())) ||
    typeof spreadsheet.getName !== 'function' || spreadsheet.getName() !== c.spreadsheetName) {
    fail_('RESOURCE');
  }
  if (typeof spreadsheet.getOwner === 'function') {
    const owner = spreadsheet.getOwner();
    if (owner && typeof owner.getEmail === 'function' &&
      String(owner.getEmail()).toLowerCase() !== String(c.ownerEmail).toLowerCase()) {
      fail_('OWNER');
    }
  }
}

function persistResourceIdentity_(c, spreadsheetId, labelId) {
  const resolved = validateConfig_(Object.assign({}, c, {
    spreadsheetId: String(spreadsheetId), labelId: String(labelId)
  }));
  props_().setProperty(MC.configKey, JSON.stringify(resolved));
  return resolved;
}

function ensureCouponSheet_(spreadsheet, name) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    setHeaderRow_(sheet, MC.headers);
    return sheet;
  }
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.some(function (row) { return row.some(function (value) { return String(value).trim(); }); })) {
    setHeaderRow_(sheet, MC.headers);
    return sheet;
  }
  assertHeaderRow_(sheet, MC.headers, false);
  return sheet;
}

function validateExistingCouponSheet_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.some(function (row) { return row.some(function (value) { return String(value).trim(); }); })) {
    assertHeaderRow_(sheet, MC.headers, false);
  }
}

function ensureJournalSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(MC.journalName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(MC.journalName);
    setHeaderRow_(sheet, MC.journalHeaders);
    return sheet;
  }
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.some(function (row) { return row.some(function (value) { return String(value).trim(); }); })) {
    setHeaderRow_(sheet, MC.journalHeaders);
    return sheet;
  }
  assertHeaderRow_(sheet, MC.journalHeaders, true);
  return sheet;
}

function setHeaderRow_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function ensureReviewActionValidation_(sheet) {
  if (!sheet || typeof sheet.getMaxRows !== 'function') fail_('RESOURCE');
  const actionColumn = MC.headers.indexOf('Action needed') + 1;
  if (actionColumn < 1 || !SpreadsheetApp || typeof SpreadsheetApp.newDataValidation !== 'function') fail_('RESOURCE');
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([EN.actions.confirm, EN.actions.ignore, EN.actions.retry_ai], true)
    .setAllowInvalid(false).build();
  sheet.getRange(2, actionColumn, Math.max(1, sheet.getMaxRows() - 1), 1).setDataValidation(rule);
}

function assertHeaderRow_(sheet, headers, exactWidth) {
  if (exactWidth && sheet.getLastColumn() !== headers.length ||
    !exactWidth && sheet.getLastColumn() < headers.length) fail_('RESOURCE');
  const actual = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  if (actual.length !== headers.length || actual.some(function (value, index) {
    return value !== headers[index];
  })) fail_('RESOURCE');
}

function recoveryStartForSheet_(sheet, c) {
  const rows = sheet.getDataRange().getValues();
  return recoveryStart_(rows.length ? rows.slice(1) : [], c);
}

function listGmailLabels_() {
  const labels = [];
  const seenTokens = Object.create(null);
  let pageToken = '';
  do {
    let result;
    try {
      result = pageToken ? Gmail.Users.Labels.list('me', {pageToken: pageToken}) :
        Gmail.Users.Labels.list('me');
    } catch (e) {
      fail_('RESOURCE');
    }
    if (!result || !Array.isArray(result.labels)) fail_('RESOURCE');
    result.labels.forEach(function (label) {
      if (!label || typeof label.id !== 'string' || !label.id ||
        typeof label.name !== 'string' || !label.name) fail_('RESOURCE');
      const existing = labels.filter(function (item) { return item.id === label.id; });
      if (existing.length && existing[0].name !== label.name) fail_('RESOURCE');
      if (!existing.length) labels.push({id: label.id, name: label.name});
    });
    const nextToken = result.nextPageToken;
    if (nextToken != null && typeof nextToken !== 'string') fail_('RESOURCE');
    if (!nextToken) pageToken = '';
    else if (seenTokens[nextToken]) fail_('RESOURCE');
    else { seenTokens[nextToken] = true; pageToken = nextToken; }
  } while (pageToken);
  return labels;
}

function resolveGmailLabel_(c) {
  let labels = listGmailLabels_();
  if (c.labelId) {
    const configured = labels.filter(function (label) { return label.id === c.labelId; });
    if (configured.length !== 1 || configured[0].name !== c.labelName) fail_('RESOURCE');
    return configured[0];
  }
  const exact = labels.filter(function (label) { return label.name === c.labelName; });
  if (exact.length > 1) fail_('RESOURCE');
  if (exact.length === 1) return exact[0];

  const parts = c.labelName.split('/');
  let prefix = '';
  for (let index = 0; index < parts.length; index++) {
    prefix = prefix ? prefix + '/' + parts[index] : parts[index];
    const matches = labels.filter(function (label) { return label.name === prefix; });
    if (matches.length > 1) fail_('RESOURCE');
    if (!matches.length) {
      const created = createGmailLabel_(prefix);
      if (!created || typeof created.id !== 'string' || created.name !== prefix) fail_('RESOURCE');
      labels = listGmailLabels_();
    }
  }
  const resolved = labels.filter(function (label) { return label.name === c.labelName; });
  if (resolved.length !== 1) fail_('RESOURCE');
  return resolved[0];
}

function createGmailLabel_(name) {
  try {
    return Gmail.Users.Labels.create({name: name}, 'me');
  } catch (e) {
    fail_('RESOURCE');
  }
}

function newMessageState_(messageId) {
  if (typeof messageId !== 'string' || !messageId) fail_('STATE');
  return {
    version: 1, messageId: messageId, status: 'pending', attempts: 0,
    retryCount: 0, dedupeKeys: [], candidateKeys: [], rowNumbers: [],
    lastAttemptAt: '', nextRetryAt: '', lastError: '', failureStage: '',
    outcome: '', labelApplied: false, archived: false, updatedAt: ''
  };
}

function validMessageState_(state) {
  const isLegacy = recordWithExactKeys_(state, MC_LEGACY_MESSAGE_STATE_KEYS);
  if ((!isLegacy && !recordWithExactKeys_(state, MC_MESSAGE_STATE_KEYS)) ||
    (state.version !== 1 && state.version !== 2) || typeof state.messageId !== 'string' || !state.messageId ||
    MC_MESSAGE_STATE_STATUSES.indexOf(state.status) < 0 ||
    !nonNegativeInteger_(state.attempts) || !nonNegativeInteger_(state.retryCount) ||
    !stringArray_(state.dedupeKeys) || !stringArray_(state.candidateKeys) ||
    (state.version === 2 && !isLegacy && !candidateStates_(state.candidateStates, state.candidateKeys, state.rowNumbers)) ||
    !nonNegativeIntegerArray_(state.rowNumbers) ||
    !stringValue_(state.lastAttemptAt) || !stringValue_(state.nextRetryAt) ||
    !stringValue_(state.lastError) || !stringValue_(state.failureStage) ||
    !stringValue_(state.outcome) || typeof state.labelApplied !== 'boolean' ||
    typeof state.archived !== 'boolean' || !stringValue_(state.updatedAt)) return false;
  return true;
}

function candidateStates_(value, keys, rows) {
  return Array.isArray(value) && value.length === keys.length && keys.length === rows.length && value.every(function (item) {
    return item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.key === 'string' && !!item.key &&
      typeof item.rowNumber === 'number' && Number.isInteger(item.rowNumber) && item.rowNumber > 1 &&
      ['review', 'confirmed', 'ignored'].indexOf(item.status) >= 0 &&
      (item.imageEvidence === undefined || imageEvidence_(item.imageEvidence)) &&
      keys.indexOf(item.key) >= 0 && rows[keys.indexOf(item.key)] === item.rowNumber &&
      value.filter(function (other) { return other.key === item.key; }).length === 1;
  });
}

function imageEvidence_(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(function (field) { return MC.fields.indexOf(field) >= 0 && value[field] &&
      typeof value[field].sourceId === 'string' && value[field].sourceId && typeof value[field].valueDigest === 'string' && /^[a-f0-9]{64}$/.test(value[field].valueDigest) &&
      typeof value[field].digest === 'string' && /^[a-f0-9]{64}$/.test(value[field].digest); });
}

function recordWithExactKeys_(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length) return false;
  const names = Object.getOwnPropertyNames(value);
  return names.length === keys.length && names.every(function (key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return keys.indexOf(key) >= 0 && descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value');
  });
}

function nonNegativeInteger_(value) { return Number.isInteger(value) && value >= 0; }
function stringValue_(value) { return typeof value === 'string'; }
function stringArray_(value) {
  return Array.isArray(value) && value.every(function (item) { return typeof item === 'string'; });
}
function nonNegativeIntegerArray_(value) {
  return Array.isArray(value) && value.every(nonNegativeInteger_);
}

function readMessageJournal_(sheet) {
  assertHeaderRow_(sheet, MC.journalHeaders, true);
  const rows = sheet.getDataRange().getValues();
  const states = Object.create(null);
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const messageId = row[0];
    if (messageId === '' && row[1] === '') continue;
    if (typeof messageId !== 'string' || !messageId || typeof row[1] !== 'string' || !row[1]) fail_('STATE');
    let state;
    try { state = JSON.parse(row[1]); } catch (e) { fail_('STATE'); }
    if (!validMessageState_(state) || state.messageId !== messageId || states[messageId]) fail_('STATE');
    states[messageId] = state;
  }
  return states;
}

function getMessageState_(sheet, messageId) {
  if (typeof messageId !== 'string' || !messageId) fail_('STATE');
  return readMessageJournal_(sheet)[messageId] || null;
}

function saveMessageState_(sheet, state) {
  if (!validMessageState_(state)) fail_('STATE');
  return withLock_(function () { return saveMessageStateUnlocked_(sheet, state); });
}

function saveMessageStateUnlocked_(sheet, state) {
  readMessageJournal_(sheet);
  const row = findJournalRow_(sheet, state.messageId);
  const values = [[state.messageId, JSON.stringify(state)]];
  if (row) sheet.getRange(row, 1, 1, 2).setValues(values);
  else sheet.getRange(Math.max(2, sheet.getLastRow() + 1), 1, 1, 2).setValues(values);
  const persisted = getMessageState_(sheet, state.messageId);
  if (!persisted) fail_('STATE');
  return persisted;
}

function findJournalRow_(sheet, messageId) {
  const rows = sheet.getDataRange().getValues();
  let found = 0;
  for (let index = 1; index < rows.length; index++) {
    if (rows[index][0] === messageId) {
      if (found) fail_('STATE');
      found = index + 1;
    }
  }
  return found;
}

function updateMessageState_(sheet, messageId, patch) {
  if (!plainObjectWithKeys_(patch, MC_MESSAGE_STATE_KEYS) ||
    ownValue_(patch, 'version') !== undefined || ownValue_(patch, 'messageId') !== undefined) fail_('STATE');
  return withLock_(function () {
    const current = getMessageState_(sheet, messageId) || newMessageState_(messageId);
    const next = Object.assign({}, current, patch);
    return saveMessageStateUnlocked_(sheet, next);
  });
}

function findMessageStateByDedupeKey_(sheet, dedupeKey) {
  if (typeof dedupeKey !== 'string' || !dedupeKey) fail_('STATE');
  const states = readMessageJournal_(sheet);
  const matches = Object.keys(states).filter(function (messageId) {
    return states[messageId].dedupeKeys.indexOf(dedupeKey) >= 0;
  });
  if (matches.length > 1) fail_('STATE');
  return matches.length ? states[matches[0]] : null;
}
