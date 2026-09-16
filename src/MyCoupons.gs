var MYCOUPONS_CONFIG_PROPERTY = 'MYCOUPONS_CONFIG';
var MYCOUPONS_WATERMARK_PROPERTY = 'MYCOUPONS_WATERMARK';
var MYCOUPONS_WATERMARK_IDENTITY_PROPERTY = 'MYCOUPONS_WATERMARK_TARGET_IDENTITY';
var MYCOUPONS_SCAN_STATE_PROPERTY = 'MYCOUPONS_SCAN_STATE';
var MYCOUPONS_SCAN_STATE_VERSION = 3;
var MYCOUPONS_LEGACY_SCAN_STATE_VERSION = 2;
var MYCOUPONS_DAILY_SCHEDULE_PROPERTY = 'MYCOUPONS_DAILY_SCHEDULE';
var MYCOUPONS_DAILY_SCHEDULE_VERSION = 2;
var MYCOUPONS_DAILY_HANDLER = 'runMyCouponsDaily';
var MYCOUPONS_SEARCH_PAGE_SIZE = 100;
var MYCOUPONS_SHEET_CELL_MAX_LENGTH = 50000;

var MYCOUPONS_DEFAULTS = {
  archiveImported: true,
  dailyHour: 8,
  initialDate: '2026-01-01',
  retentionDays: 180,
  trashExpiredImported: true,
  watermarkOverlapDays: 1,
};

var MYCOUPONS_COLUMNS = {
  emailDate: ['email date'],
  couponCode: ['coupon code'],
  sourceSubject: ['source subject', 'source email subject'],
  sender: ['sender', 'from'],
  gmailLink: ['gmail link', 'gmail url', 'email link', 'source link'],
  deduplicationKey: ['notes/deduplication key', 'notes / dedupe key', 'deduplication key', 'dedup key'],
  status: ['status'],
};

/**
 * Imports explicit coupon codes from Gmail, then labels and optionally archives
 * only messages whose Sheet rows were successfully verified.
 *
 * @return {{complete: boolean, imported: number, scanned: number, watermark: string|null}}
 */
function runMyCouponsImport() {
  return withMyCouponsLock_(function() {
    var config = getMyCouponsConfig_();
    assertMyCouponsOwner_(config);
    return runMyCouponsImport_(config);
  });
}

/**
 * Runs the scheduled import and retention cleanup in one serialized execution.
 *
 * @return {{import: {complete: boolean, imported: number, scanned: number, watermark: string|null}, retention: {complete: boolean, trashed: number}}}
 */
function runMyCouponsDaily() {
  return withMyCouponsLock_(function() {
    var config = getMyCouponsConfig_();
    assertMyCouponsOwner_(config);
    var imported;
    var importError = null;
    try {
      imported = runMyCouponsImport_(config);
    } catch (error) {
      importError = error;
    }
    var retention;
    var retentionError = null;
    try {
      retention = cleanupExpiredImportedMessages_(config);
    } catch (error) {
      retentionError = error;
    }
    if (importError) {
      throw importError;
    }
    if (retentionError) {
      throw retentionError;
    }
    return {import: imported, retention: retention};
  });
}

/**
 * Moves only expired, previously imported messages to Gmail Trash.
 *
 * @return {{complete: boolean, trashed: number}}
 */
function cleanupExpiredImportedMessages() {
  return withMyCouponsLock_(function() {
    var config = getMyCouponsConfig_();
    assertMyCouponsOwner_(config);
    return cleanupExpiredImportedMessages_(config);
  });
}

/**
 * Installs one daily Apps Script trigger. A duplicate is an ambiguous state and
 * is deliberately not repaired by deleting triggers automatically.
 *
 * @return {{created: boolean, dailyHour: number}}
 */
function installMyCouponsDailyTrigger() {
  return withMyCouponsLock_(function() {
    var config = getMyCouponsConfig_();
    assertMyCouponsOwner_(config);
    var matching = ScriptApp.getProjectTriggers().filter(function(trigger) {
      return trigger.getHandlerFunction() === MYCOUPONS_DAILY_HANDLER;
    });
    if (matching.length > 1) {
      throw new Error('Multiple daily triggers exist for runMyCouponsDaily. Resolve them manually.');
    }
    if (matching.length === 1) {
      assertDailyScheduleIdentity_(config, matching[0]);
      return {created: false, dailyHour: config.dailyHour};
    }
    if (PropertiesService.getScriptProperties().getProperty(MYCOUPONS_DAILY_SCHEDULE_PROPERTY)) {
      throw new Error('Stored MyCoupons daily schedule does not match a trigger. Resolve it deliberately.');
    }
    var createdTrigger = ScriptApp.newTrigger(MYCOUPONS_DAILY_HANDLER)
      .timeBased()
      .inTimezone(config.timeZone)
      .atHour(config.dailyHour)
      .everyDays(1)
      .create();
    saveDailyScheduleIdentity_(config, createdTrigger);
    return {created: true, dailyHour: config.dailyHour};
  });
}

/**
 * Performs an owner-gated, read-only installation preflight without exposing
 * resource identifiers or changing Gmail, Sheets, or triggers.
 *
 * @return {{dailyTrigger: string, importState: string, ready: boolean}}
 */
function getMyCouponsInstallationStatus() {
  var now = new Date();
  var config = getMyCouponsConfig_();
  assertInitialDateNotFuture_(config, now);
  assertMyCouponsOwner_(config);
  var label = resolveImportedLabel_(config);
  var sheet = resolveCouponSheet_(config);
  var sheetId = resolveCouponSheetId_(sheet);
  assertCouponSheetEditable_(sheet);
  readCouponSheetState_(sheet, config);
  var importState = inspectPersistedImportState_(config, label.id, sheetId, now);
  var matching = ScriptApp.getProjectTriggers().filter(function(trigger) {
      return trigger.getHandlerFunction() === MYCOUPONS_DAILY_HANDLER;
  });
  if (matching.length > 1) {
    throw new Error('Multiple daily triggers exist for runMyCouponsDaily. Resolve them manually.');
  }
  if (matching.length === 1) {
    assertDailyScheduleIdentity_(config, matching[0]);
  } else if (PropertiesService.getScriptProperties().getProperty(MYCOUPONS_DAILY_SCHEDULE_PROPERTY)) {
    throw new Error('Stored MyCoupons daily schedule does not match a trigger. Resolve it deliberately.');
  }
  return {dailyTrigger: matching.length === 1 ? 'installed' : 'missing', importState: importState, ready: true};
}

function runMyCouponsImport_(config) {
  var now = new Date();
  assertInitialDateNotFuture_(config, now);
  var label = resolveImportedLabel_(config);
  var sheet = resolveCouponSheet_(config);
  var sheetId = resolveCouponSheetId_(sheet);
  assertCouponSheetEditable_(sheet);
  var sheetState = readCouponSheetState_(sheet, config);
  var scan = loadOrStartScanState_(config, label.id, sheetId, now);
  var imported = 0;
  var scanned = 0;

  function processMessage_(message) {
    scanned += 1;
    if (message.date.getTime() < config.initialDate.getTime() || messageHasLabel_(message, label.id) ||
        messageHasSystemExclusionLabel_(message)) {
      return true;
    }
    if (hasOversizedSheetMetadata_(message)) {
      return true;
    }
    var expectedCodes = [];
    extractCouponCodes_(message.subject, message.plainText).forEach(function(code) {
      var deduplicationKey = message.id + '::' + code;
      var existingCandidates = inspectDeduplicationCandidates_(sheetState.deduplicationCandidates[deduplicationKey],
        message, code, sheetState.columns, config);
      if (existingCandidates.verified.length > 1) {
        throw new Error('Coupon sheet contains a duplicate deduplication key with verified rows.');
      }
      if (existingCandidates.invalidCorrelated.length) {
        throw new Error('Existing coupon deduplication row does not prove its complete message and code identity.');
      }
      if (existingCandidates.verified.length === 1) {
        expectedCodes.push(code);
        return;
      }
      var row = makeCouponRow_(sheetState.columns, sheetState.columnCount, message, code, deduplicationKey, config);
      appendAndVerifyCouponRow_(sheet, row, sheetState.columns, deduplicationKey);
      expectedCodes.push(code);
      imported += 1;
    });
    if (expectedCodes.length) {
      if (!verifiedLiveExpectedCouponRows_(sheet, message, expectedCodes, config)) {
        throw new Error('Verified coupon rows changed and no longer prove their complete message and code identity before Gmail mutation.');
      }
      var currentMessage;
      try {
        currentMessage = toMyCouponsMessage_(Gmail.Users.Messages.get('me', message.id, {format: 'full'}));
      } catch (error) {
        if (isGmailRateLimitError_(error)) {
          return false;
        }
        if (isExactGmailMessageNotFound_(error)) {
          return true;
        }
        throw error;
      }
      if (currentMessage.id !== message.id) {
        throw new Error('Gmail returned a different message during final import authorization.');
      }
      if (messageHasLabel_(currentMessage, label.id) || messageHasSystemExclusionLabel_(currentMessage)) {
        return true;
      }
      try {
        mutateImportedMessage_(message.id, label.id, config.archiveImported);
      } catch (error) {
        if (isGmailRateLimitError_(error)) {
          return false;
        }
        throw error;
      }
    }
    return true;
  }

  while (true) {
    while (scan.pendingIds.length) {
      var messageId = scan.pendingIds[0];
      var message;
      try {
        message = toMyCouponsMessage_(Gmail.Users.Messages.get('me', messageId, {format: 'full'}));
      } catch (error) {
        if (isGmailRateLimitError_(error)) {
          saveScanState_(scan);
          return {complete: false, imported: imported, scanned: scanned, watermark: null};
        }
        if (isExactGmailMessageNotFound_(error)) {
          scan.pendingIds.shift();
          saveScanState_(scan);
          continue;
        }
        throw error;
      }
      if (!processMessage_(message)) {
        saveScanState_(scan);
        return {complete: false, imported: imported, scanned: scanned, watermark: null};
      }
      scan.pendingIds.shift();
      saveScanState_(scan);
    }

    if (!scan.pageToken && scan.listedFinalPage) {
      var watermark = scan.boundary;
      if (!validScanTimestamp_(watermark, now)) {
        throw new Error('Refusing to commit a future MyCoupons watermark.');
      }
      PropertiesService.getScriptProperties().setProperty(MYCOUPONS_WATERMARK_PROPERTY, watermark);
      PropertiesService.getScriptProperties().setProperty(MYCOUPONS_WATERMARK_IDENTITY_PROPERTY,
        watermarkTargetIdentity_(config, label.id, sheetId));
      PropertiesService.getScriptProperties().deleteProperty(MYCOUPONS_SCAN_STATE_PROPERTY);
      return {complete: true, imported: imported, scanned: scanned, watermark: watermark};
    }

    var page;
    try {
      page = Gmail.Users.Messages.list('me', gmailListOptions_(buildImportQuery_(scan), scan.pageToken));
    } catch (error) {
      if (isGmailRateLimitError_(error)) {
        saveScanState_(scan);
        return {complete: false, imported: imported, scanned: scanned, watermark: null};
      }
      throw error;
    }
    var references = page && Array.isArray(page.messages) ? page.messages : [];
    if (references.some(function(reference) {
      return !reference || typeof reference.id !== 'string' || !reference.id;
    })) {
      throw new Error('Gmail returned an invalid message list.');
    }
    scan.pendingIds = references.map(function(reference) { return reference.id; });
    if (new Set(scan.pendingIds).size !== scan.pendingIds.length) {
      throw new Error('Gmail returned duplicate message IDs in one page.');
    }
    scan.pageToken = page && page.nextPageToken || '';
    if (typeof scan.pageToken !== 'string') {
      throw new Error('Gmail returned an invalid next page token.');
    }
    scan.listedFinalPage = !scan.pageToken;
    saveScanState_(scan);
  }
}

function cleanupExpiredImportedMessages_(config) {
  if (!config.trashExpiredImported) {
    return {complete: true, trashed: 0};
  }
  var threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - config.retentionDays);
  var trashed = 0;
  var label = resolveImportedLabel_(config);
  var listed;
  try {
    listed = listFirstGmailMessagePage_(buildRetentionQuery_(config, threshold));
  } catch (error) {
    if (isGmailRateLimitError_(error)) {
      return {complete: false, trashed: trashed};
    }
    throw error;
  }
  for (var index = 0; index < listed.messageIds.length; index += 1) {
    var message;
    try {
      message = toMyCouponsMessage_(Gmail.Users.Messages.get('me', listed.messageIds[index], {format: 'full'}));
    } catch (error) {
      if (isGmailRateLimitError_(error)) {
        return {complete: false, trashed: trashed};
      }
      if (isExactGmailMessageNotFound_(error)) {
        continue;
      }
      throw error;
    }
    if (!messageHasLabel_(message, label.id) || message.date.getTime() >= threshold.getTime() ||
        messageHasSystemExclusionLabel_(message)) {
      continue;
    }
    try {
      Gmail.Users.Messages.trash('me', message.id);
    } catch (error) {
      if (isGmailRateLimitError_(error)) {
        return {complete: false, trashed: trashed};
      }
      throw error;
    }
    trashed += 1;
  }
  return {complete: listed.complete, trashed: trashed};
}

function getMyCouponsConfig_() {
  var raw = PropertiesService.getScriptProperties().getProperty(MYCOUPONS_CONFIG_PROPERTY);
  if (!raw) {
    throw new Error('MYCOUPONS_CONFIG is required.');
  }
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('MYCOUPONS_CONFIG must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MYCOUPONS_CONFIG must be a JSON object.');
  }
  var config = {};
  Object.keys(MYCOUPONS_DEFAULTS).forEach(function(key) {
    config[key] = parsed[key] === undefined || (key === 'initialDate' && parsed[key] === '') ?
      MYCOUPONS_DEFAULTS[key] : parsed[key];
  });
  ['labelName', 'ownerEmail', 'sheetName', 'spreadsheetId', 'spreadsheetName', 'timeZone'].forEach(function(key) {
    config[key] = parsed[key];
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error('MYCOUPONS_CONFIG.' + key + ' must be a non-empty string.');
    }
  });
  config.initialDate = parseInitialDate_(config.initialDate);
  if (!validIanaTimeZone_(config.timeZone)) {
    throw new Error('MYCOUPONS_CONFIG.timeZone must be a valid IANA time zone.');
  }
  config.watermarkOverlapDays = integerInRange_(config.watermarkOverlapDays, 'watermarkOverlapDays', 0, 30);
  config.retentionDays = integerInRange_(config.retentionDays, 'retentionDays', 1, 3650);
  config.dailyHour = integerInRange_(config.dailyHour, 'dailyHour', 0, 23);
  ['archiveImported', 'trashExpiredImported'].forEach(function(key) {
    if (typeof config[key] !== 'boolean') {
      throw new Error('MYCOUPONS_CONFIG.' + key + ' must be a boolean.');
    }
  });
  return config;
}

function validIanaTimeZone_(value) {
  if (typeof value !== 'string' || value.length > 100 ||
      !/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z][A-Za-z0-9_+\-]*)*$/u.test(value)) {
    return false;
  }
  try {
    var formatted = Utilities.formatDate(new Date('2000-01-01T00:00:00.000Z'), value, 'yyyy-MM-dd');
    return typeof formatted === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(formatted);
  } catch (error) {
    return false;
  }
}

function dailyScheduleIdentity_(config) {
  return JSON.stringify([config.ownerEmail.toLowerCase(), config.spreadsheetId, config.sheetName,
    config.labelName, MYCOUPONS_DAILY_HANDLER, config.dailyHour, config.timeZone]);
}

function saveDailyScheduleIdentity_(config, trigger) {
  var triggerId = trigger && trigger.getUniqueId && trigger.getUniqueId();
  if (typeof triggerId !== 'string' || !triggerId) {
    throw new Error('Created MyCoupons daily trigger has no stable identity. Resolve it deliberately.');
  }
  PropertiesService.getScriptProperties().setProperty(MYCOUPONS_DAILY_SCHEDULE_PROPERTY, JSON.stringify({
    version: MYCOUPONS_DAILY_SCHEDULE_VERSION, identity: dailyScheduleIdentity_(config), triggerId: triggerId,
  }));
}

function assertDailyScheduleIdentity_(config, trigger) {
  var triggerId = trigger && trigger.getUniqueId && trigger.getUniqueId();
  var raw = PropertiesService.getScriptProperties().getProperty(MYCOUPONS_DAILY_SCHEDULE_PROPERTY);
  var schedule;
  try {
    schedule = raw && JSON.parse(raw);
  } catch (error) {
    throw new Error('Stored MyCoupons daily schedule is invalid. Resolve it deliberately.');
  }
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) ||
      Object.keys(schedule).sort().join(',') !== 'identity,triggerId,version' ||
      schedule.version !== MYCOUPONS_DAILY_SCHEDULE_VERSION || schedule.identity !== dailyScheduleIdentity_(config) ||
      typeof schedule.triggerId !== 'string' || !schedule.triggerId || schedule.triggerId !== triggerId) {
    throw new Error('Stored MyCoupons daily schedule does not match the configured trigger. Resolve it deliberately.');
  }
}

function parseInitialDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('MYCOUPONS_CONFIG.initialDate must use YYYY-MM-DD.');
  }
  var parsed = new Date(value + 'T00:00:00.000Z');
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('MYCOUPONS_CONFIG.initialDate must be a real calendar date.');
  }
  return parsed;
}

function assertInitialDateNotFuture_(config, now) {
  if (config.initialDate.getTime() > now.getTime()) {
    throw new Error('MYCOUPONS_CONFIG.initialDate cannot be in the future.');
  }
}

function integerInRange_(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('MYCOUPONS_CONFIG.' + name + ' must be an integer from ' + minimum + ' to ' + maximum + '.');
  }
  return value;
}

function resolveImportedLabel_(config) {
  var labels = (Gmail.Users.Labels.list('me').labels || []).filter(function(label) {
    return label.name === config.labelName;
  });
  if (labels.length !== 1 || typeof labels[0].id !== 'string' || !labels[0].id || labels[0].type !== 'user') {
    throw new Error('Configured imported Gmail label must resolve to exactly one user label.');
  }
  return labels[0];
}

function assertMyCouponsOwner_(config) {
  var profile = Gmail.Users.getProfile('me');
  var actualOwner = profile && profile.emailAddress;
  if (typeof actualOwner !== 'string' || actualOwner.toLowerCase() !== config.ownerEmail.toLowerCase()) {
    throw new Error('MyCoupons must run as the configured owner.');
  }
}

function resolveCouponSheet_(config) {
  var spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  if (spreadsheet.getName() !== config.spreadsheetName) {
    throw new Error('Configured coupon spreadsheet name did not match the opened spreadsheet.');
  }
  var sheet = spreadsheet.getSheetByName(config.sheetName);
  if (!sheet) {
    throw new Error('Configured coupon sheet was not found.');
  }
  return sheet;
}

function resolveCouponSheetId_(sheet) {
  var sheetId = sheet && sheet.getSheetId && sheet.getSheetId();
  if (!Number.isInteger(sheetId) || sheetId < 0) {
    throw new Error('Configured coupon sheet has no valid stable sheet ID.');
  }
  return sheetId;
}

function assertCouponSheetEditable_(sheet) {
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, sheet.getLastColumn());
  if (!range || typeof range.canEdit !== 'function' || range.canEdit() !== true) {
    throw new Error('Configured coupon sheet is not editable by the current user.');
  }
}

function readCouponSheetState_(sheet, config) {
  var values = sheet.getDataRange().getValues();
  var formulas = sheet.getDataRange().getFormulas();
  if (!values.length || !values[0].length) {
    throw new Error('Coupon sheet must contain its existing header row.');
  }
  var columns = resolveCouponColumns_(values[0]);
  var deduplicationCandidates = {};
  values.slice(1).forEach(function(row, index) {
    var key = sheetSemanticText_(row[columns.deduplicationKey]);
    var parsedKey = key && parseDeduplicationKey_(key);
    if (parsedKey) {
      if (!Object.prototype.hasOwnProperty.call(deduplicationCandidates, key)) {
        deduplicationCandidates[key] = [];
      }
      deduplicationCandidates[key].push({row: row, formulas: formulas[index + 1]});
    }
  });
  return {columnCount: values[0].length, columns: columns, deduplicationCandidates: deduplicationCandidates};
}

function parseDeduplicationKey_(key) {
  if (typeof key !== 'string' || !key) {
    return null;
  }
  var separator = key.indexOf('::');
  if (separator <= 0 || separator === key.length - 2) {
    return null;
  }
  var messageId = key.slice(0, separator);
  var code = key.slice(separator + 2);
  if (!validOpaqueGmailId_(messageId) || acceptCouponToken_(code, true, false) !== code) {
    return null;
  }
  return {code: code, messageId: messageId};
}

function resolveCouponColumns_(headers) {
  var normalized = headers.map(function(header) {
    return String(header).trim().toLowerCase();
  });
  var columns = {};
  Object.keys(MYCOUPONS_COLUMNS).forEach(function(field) {
    var matches = [];
    normalized.forEach(function(header, index) {
      if (MYCOUPONS_COLUMNS[field].indexOf(header) !== -1) {
        matches.push(index);
      }
    });
    if (matches.length !== 1) {
      throw new Error('Coupon sheet requires one unambiguous ' + field + ' column.');
    }
    columns[field] = matches[0];
  });
  return columns;
}

function makeCouponRow_(columns, columnCount, message, code, deduplicationKey, config) {
  var row = Array(columnCount).fill('');
  row[columns.emailDate] = message.date.toISOString();
  row[columns.couponCode] = asCouponCodeSheetLiteral_(code);
  row[columns.sourceSubject] = asSheetLiteral_(message.subject);
  row[columns.sender] = asSheetLiteral_(message.from);
  row[columns.gmailLink] = asSheetLiteral_(gmailLinkForMessage_(message.threadId, config));
  row[columns.deduplicationKey] = asSheetLiteral_(deduplicationKey);
  row[columns.status] = 'imported';
  return row;
}

function hasOversizedSheetMetadata_(message) {
  return message.subject.length > MYCOUPONS_SHEET_CELL_MAX_LENGTH ||
    message.from.length > MYCOUPONS_SHEET_CELL_MAX_LENGTH;
}

function gmailLinkForMessage_(threadId, config) {
  return 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(config.ownerEmail) +
    '#all/' + encodeURIComponent(threadId);
}

function legacyGmailLinkForMessage_(messageId) {
  return 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(messageId);
}

function ownerStableLegacyGmailLinkForMessage_(messageId, config) {
  return 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(config.ownerEmail) +
    '#all/' + encodeURIComponent(messageId);
}

function asSheetLiteral_(value) {
  var text = String(value);
  return /^'/.test(text) || /^[=+\-@]/.test(text) ? "'" + text : text;
}

function asCouponCodeSheetLiteral_(code) {
  // Coupon codes are always supplied as text literals before append: formatting
  // after append cannot recover a value that Sheets has already coerced.
  return "'" + code;
}

function sheetSemanticText_(value) {
  var text = String(value);
  return /^'/.test(text) ? text.slice(1) : text;
}

function appendAndVerifyCouponRow_(sheet, row, columns, deduplicationKey) {
  sheet.appendRow(row);
  var reservation = verifiedCurrentCouponReservation_(sheet, row, columns, deduplicationKey);
  setCouponRowTextFormats_(sheet, reservation.rowNumber, populatedCouponColumns_(columns));
  reservation = verifiedCurrentCouponReservation_(sheet, row, columns, deduplicationKey);
  var range = sheet.getRange(reservation.rowNumber, 1, 1, row.length);
  var written = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  if (!verifiedCouponRow_(written, formulas, row, columns, deduplicationKey, null)) {
    throw new Error('Coupon row verification failed before Gmail mutation.');
  }
}

function populatedCouponColumns_(columns) {
  return [
    columns.emailDate,
    columns.couponCode,
    columns.sourceSubject,
    columns.sender,
    columns.gmailLink,
    columns.deduplicationKey,
    columns.status,
  ];
}

function setCouponRowTextFormats_(sheet, rowNumber, columns) {
  var a1Notations = columns.map(function(column) { return columnToA1_(column + 1) + rowNumber; });
  if (typeof sheet.getRangeList === 'function') {
    sheet.getRangeList(a1Notations).setNumberFormat('@');
    return;
  }
  columns.forEach(function(column) {
    sheet.getRange(rowNumber, column + 1, 1, 1).setNumberFormat('@');
  });
}

function columnToA1_(columnNumber) {
  var result = '';
  while (columnNumber > 0) {
    var remainder = (columnNumber - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    columnNumber = Math.floor((columnNumber - 1) / 26);
  }
  return result;
}

function verifiedCurrentCouponReservation_(sheet, row, columns, deduplicationKey) {
  var reservation = findExactAppendedCouponRow_(sheet, row, columns, deduplicationKey);
  if (!reservation || !verifiedCouponRow_(reservation.row, reservation.formulas, row, columns, deduplicationKey, null)) {
    throw new Error('Coupon row reservation changed before its write could be authorized.');
  }
  return reservation;
}

function findExactAppendedCouponRow_(sheet, expectedRow, columns, deduplicationKey) {
  var data = sheet.getDataRange();
  var values = data.getValues();
  var formulas = data.getFormulas();
  var matches = [];
  values.slice(1).forEach(function(existingRow, index) {
    if (sheetSemanticText_(existingRow[columns.deduplicationKey]) === deduplicationKey &&
        verifiedCouponRow_(existingRow, formulas[index + 1], expectedRow, columns, deduplicationKey, null)) {
      matches.push({rowNumber: index + 2, row: existingRow, formulas: formulas[index + 1]});
    }
  });
  return matches.length === 1 ? matches[0] : null;
}

function verifiedExistingCouponRow_(record, message, code, columns, config) {
  if (!record || !Array.isArray(record.row) || !Array.isArray(record.formulas)) {
    return false;
  }
  var deduplicationKey = message.id + '::' + code;
  var expected = makeCouponRow_(columns, record.row.length, message, code, deduplicationKey, config);
  return verifiedCouponRow_(record.row, record.formulas, expected, columns, deduplicationKey,
    [legacyGmailLinkForMessage_(message.id), ownerStableLegacyGmailLinkForMessage_(message.id, config)]);
}

function verifiedLiveExpectedCouponRows_(sheet, message, codes, config) {
  var liveState = readCouponSheetState_(sheet, config);
  return codes.every(function(code) {
    var deduplicationKey = message.id + '::' + code;
    var candidates = inspectDeduplicationCandidates_(liveState.deduplicationCandidates[deduplicationKey], message,
      code, liveState.columns, config);
    return candidates.verified.length === 1 && !candidates.invalidCorrelated.length;
  });
}

function inspectDeduplicationCandidates_(candidates, message, code, columns, config) {
  var verified = [];
  var invalidCorrelated = [];
  (candidates || []).forEach(function(record) {
    if (verifiedExistingCouponRow_(record, message, code, columns, config)) {
      verified.push(record);
    } else if (deduplicationCandidateCorrelatesMessage_(record, message, config, columns)) {
      invalidCorrelated.push(record);
    }
  });
  return {invalidCorrelated: invalidCorrelated, verified: verified};
}

function deduplicationCandidateCorrelatesMessage_(record, message, config, columns) {
  if (!record || !Array.isArray(record.row)) {
    return false;
  }
  var storedLink = sheetSemanticText_(record.row[columns.gmailLink]);
  return storedLink === gmailLinkForMessage_(message.threadId, config) ||
    storedLink === legacyGmailLinkForMessage_(message.id) ||
    storedLink === ownerStableLegacyGmailLinkForMessage_(message.id, config);
}

function verifiedCouponRow_(written, formulas, expected, columns, deduplicationKey, legacyGmailLinks) {
  if (!Array.isArray(written) || !Array.isArray(formulas) ||
      !matchesExpectedSheetValue_(written[columns.deduplicationKey], expected[columns.deduplicationKey]) ||
      !matchesExpectedSheetValue_(written[columns.emailDate], expected[columns.emailDate]) ||
      !matchesForcedCouponCode_(written[columns.couponCode], expected[columns.couponCode]) ||
      !matchesExpectedSheetValue_(written[columns.sourceSubject], expected[columns.sourceSubject]) ||
      !matchesExpectedSheetValue_(written[columns.sender], expected[columns.sender]) ||
      !matchesExpectedSheetValue_(written[columns.status], expected[columns.status]) ||
      formulas[columns.deduplicationKey] || formulas[columns.emailDate] || formulas[columns.couponCode] ||
      formulas[columns.gmailLink] || formulas[columns.sourceSubject] || formulas[columns.sender] || formulas[columns.status]) {
    return false;
  }
  var storedLink = String(written[columns.gmailLink]);
  return storedLink === expectedSheetStoredText_(expected[columns.gmailLink]) || Array.isArray(legacyGmailLinks) &&
    legacyGmailLinks.indexOf(storedLink) !== -1;
}

function matchesExpectedSheetValue_(written, expected) {
  return String(written) === expectedSheetStoredText_(expected);
}

function matchesForcedCouponCode_(written, expected) {
  var text = String(expected);
  return /^'/.test(text) && String(written) === text.slice(1);
}

function expectedSheetStoredText_(expected) {
  var text = String(expected);
  return /^'(?:['=+\-@]|\d)/.test(text) ? text.slice(1) : text;
}

function mutateImportedMessage_(messageId, labelId, archiveImported) {
  Gmail.Users.Messages.modify({
    addLabelIds: [labelId],
    removeLabelIds: archiveImported ? ['INBOX'] : [],
  }, 'me', messageId);
}

function buildImportQuery_(scan) {
  return 'in:anywhere after:' + Math.floor(new Date(scan.start).getTime() / 1000) +
    ' before:' + Math.floor(new Date(scan.boundary).getTime() / 1000);
}

function buildRetentionQuery_(config, threshold) {
  return 'label:"' + escapeGmailQueryString_(config.labelName) + '" before:' +
    Math.floor(threshold.getTime() / 1000) + ' -in:sent -in:drafts -in:spam -in:trash';
}

function scanStart_(config, labelId, sheetId, now) {
  var properties = PropertiesService.getScriptProperties();
  var rawWatermark = properties.getProperty(MYCOUPONS_WATERMARK_PROPERTY);
  if (!rawWatermark) {
    return initialScanStart_(config);
  }
  var watermark = new Date(rawWatermark);
  if (!validScanTimestamp_(rawWatermark, now) || isNaN(watermark.getTime()) ||
      watermark.toISOString() !== rawWatermark) {
    throw new Error('Stored MyCoupons watermark is invalid. Repair it deliberately before importing.');
  }
  if (properties.getProperty(MYCOUPONS_WATERMARK_IDENTITY_PROPERTY) !== watermarkTargetIdentity_(config, labelId, sheetId)) {
    properties.deleteProperty(MYCOUPONS_WATERMARK_PROPERTY);
    properties.deleteProperty(MYCOUPONS_WATERMARK_IDENTITY_PROPERTY);
    return initialScanStart_(config);
  }
  watermark.setUTCDate(watermark.getUTCDate() - config.watermarkOverlapDays);
  if (config.watermarkOverlapDays === 0) {
    watermark.setUTCSeconds(watermark.getUTCSeconds() - 1);
  }
  return watermark;
}

function initialScanStart_(config) {
  var start = new Date(config.initialDate.getTime());
  start.setUTCSeconds(start.getUTCSeconds() - 1);
  return start;
}

function watermarkTargetIdentity_(config, labelId, sheetId) {
  return JSON.stringify([config.ownerEmail.toLowerCase(), config.spreadsheetId, config.sheetName,
    config.labelName, labelId, sheetId]);
}

function scanConfigIdentity_(config, sheetId) {
  return JSON.stringify([config.ownerEmail.toLowerCase(), config.labelName, config.spreadsheetId, config.sheetName,
    sheetId, config.archiveImported, config.initialDate.toISOString(), config.watermarkOverlapDays]);
}

function validScanTimestamp_(value, now) {
  var date = new Date(value);
  return typeof value === 'string' && !isNaN(date.getTime()) && date.toISOString() === value &&
    (!now || date.getTime() <= now.getTime());
}

function loadOrStartScanState_(config, labelId, sheetId, boundary) {
  var properties = PropertiesService.getScriptProperties();
  var raw = properties.getProperty(MYCOUPONS_SCAN_STATE_PROPERTY);
  if (!raw) {
    return newScanState_(config, labelId, sheetId, boundary);
  }
  if (isKnownLegacyScanState_(raw, boundary)) {
    clearPersistedImportState_(properties);
    return newScanState_(config, labelId, sheetId, boundary);
  }
  var scan = parseStoredScanState_(raw, boundary);
  if (scan.configIdentity !== scanConfigIdentity_(config, sheetId) || scan.labelName !== config.labelName ||
      scan.labelId !== labelId || scan.sheetId !== sheetId) {
    clearPersistedImportState_(properties);
    return newScanState_(config, labelId, sheetId, boundary);
  }
  return scan;
}

function clearPersistedImportState_(properties) {
  properties.deleteProperty(MYCOUPONS_SCAN_STATE_PROPERTY);
  properties.deleteProperty(MYCOUPONS_WATERMARK_PROPERTY);
  properties.deleteProperty(MYCOUPONS_WATERMARK_IDENTITY_PROPERTY);
}

function newScanState_(config, labelId, sheetId, boundary) {
  var start = scanStart_(config, labelId, sheetId, boundary);
  if (start.getTime() > boundary.getTime()) {
    throw new Error('MYCOUPONS_CONFIG.initialDate cannot be after the import boundary.');
  }
  return {version: MYCOUPONS_SCAN_STATE_VERSION, configIdentity: scanConfigIdentity_(config, sheetId), labelId: labelId,
    labelName: config.labelName, sheetId: sheetId, start: start.toISOString(), boundary: boundary.toISOString(),
    pageToken: '', pendingIds: [], listedFinalPage: false};
}

function parseStoredScanState_(raw, now) {
  var scan = parseStoredScanStateJson_(raw);
  if (!validStoredScanState_(scan, now)) {
    throw new Error('Stored MyCoupons scan state is invalid. Repair it deliberately before importing.');
  }
  return scan;
}

function parseStoredScanStateJson_(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('Stored MyCoupons scan state is invalid. Repair it deliberately before importing.');
  }
}

function isKnownLegacyScanState_(raw, now) {
  var scan = parseStoredScanStateJson_(raw);
  return !!scan && typeof scan === 'object' && !Array.isArray(scan) &&
    Object.keys(scan).sort().join(',') === 'boundary,configIdentity,labelId,labelName,listedFinalPage,pageToken,pendingIds,start,version' &&
    scan.version === MYCOUPONS_LEGACY_SCAN_STATE_VERSION && typeof scan.configIdentity === 'string' && !!scan.configIdentity &&
    typeof scan.labelName === 'string' && !!scan.labelName && typeof scan.labelId === 'string' && !!scan.labelId &&
    validScanTimestamp_(scan.start, now) && validScanTimestamp_(scan.boundary, now) &&
    new Date(scan.start).getTime() <= new Date(scan.boundary).getTime() && typeof scan.pageToken === 'string' &&
    scan.pageToken.length <= 1000 && Array.isArray(scan.pendingIds) &&
    scan.pendingIds.length <= MYCOUPONS_SEARCH_PAGE_SIZE &&
    !scan.pendingIds.some(function(id) { return typeof id !== 'string' || !id; }) &&
    new Set(scan.pendingIds).size === scan.pendingIds.length && typeof scan.listedFinalPage === 'boolean' &&
    !(scan.listedFinalPage && !!scan.pageToken);
}

function validStoredScanState_(scan, now) {
  return !!scan && typeof scan === 'object' && !Array.isArray(scan) &&
    Object.keys(scan).sort().join(',') === 'boundary,configIdentity,labelId,labelName,listedFinalPage,pageToken,pendingIds,sheetId,start,version' &&
    scan.version === MYCOUPONS_SCAN_STATE_VERSION && typeof scan.configIdentity === 'string' && !!scan.configIdentity &&
    typeof scan.labelName === 'string' && !!scan.labelName && typeof scan.labelId === 'string' && !!scan.labelId &&
    Number.isInteger(scan.sheetId) && scan.sheetId >= 0 &&
    validScanTimestamp_(scan.start, now) && validScanTimestamp_(scan.boundary, now) &&
    new Date(scan.start).getTime() <= new Date(scan.boundary).getTime() && typeof scan.pageToken === 'string' &&
    scan.pageToken.length <= 1000 && Array.isArray(scan.pendingIds) &&
    scan.pendingIds.length <= MYCOUPONS_SEARCH_PAGE_SIZE &&
    !scan.pendingIds.some(function(id) { return typeof id !== 'string' || !id; }) &&
    new Set(scan.pendingIds).size === scan.pendingIds.length && typeof scan.listedFinalPage === 'boolean' &&
    !(scan.listedFinalPage && !!scan.pageToken);
}

function inspectPersistedImportState_(config, labelId, sheetId, now) {
  var properties = PropertiesService.getScriptProperties();
  var watermark = properties.getProperty(MYCOUPONS_WATERMARK_PROPERTY);
  var watermarkIdentity = properties.getProperty(MYCOUPONS_WATERMARK_IDENTITY_PROPERTY);
  if (!watermark && watermarkIdentity) {
    throw new Error('Stored MyCoupons watermark identity has no watermark. Repair it deliberately before importing.');
  }
  var restartRequired = false;
  if (watermark) {
    if (!validScanTimestamp_(watermark, now)) {
      throw new Error('Stored MyCoupons watermark is invalid. Repair it deliberately before importing.');
    }
    restartRequired = watermarkIdentity !== watermarkTargetIdentity_(config, labelId, sheetId);
  }
  var rawScan = properties.getProperty(MYCOUPONS_SCAN_STATE_PROPERTY);
  if (rawScan) {
    if (isKnownLegacyScanState_(rawScan, now)) {
      restartRequired = true;
    } else {
      var scan = parseStoredScanState_(rawScan, now);
      restartRequired = restartRequired || scan.configIdentity !== scanConfigIdentity_(config, sheetId) ||
        scan.labelName !== config.labelName || scan.labelId !== labelId || scan.sheetId !== sheetId;
    }
  }
  return restartRequired ? 'restart-required' : 'current';
}

function saveScanState_(scan) {
  PropertiesService.getScriptProperties().setProperty(MYCOUPONS_SCAN_STATE_PROPERTY, JSON.stringify(scan));
}

function gmailListOptions_(query, pageToken) {
  var options = {maxResults: MYCOUPONS_SEARCH_PAGE_SIZE, q: query};
  if (pageToken) {
    options.pageToken = pageToken;
  }
  return options;
}

function escapeGmailQueryString_(value) {
  return value.replace(/["\\]/g, '\\$&');
}

function listFirstGmailMessagePage_(query) {
  var page = Gmail.Users.Messages.list('me', gmailListOptions_(query));
  var references = page.messages || [];
  if (references.some(function(reference) {
    return !reference || typeof reference.id !== 'string' || !reference.id;
  })) {
    throw new Error('Gmail returned an invalid message list.');
  }
  if (new Set(references.map(function(reference) { return reference.id; })).size !== references.length) {
    throw new Error('Gmail returned duplicate message IDs in one page.');
  }
  return {complete: !page.nextPageToken, messageIds: references.map(function(reference) { return reference.id; })};
}

function isGmailRateLimitError_(error) {
  return error && /(?:quota exceeded|rate limit|user-rate limit|service invoked too many times(?:\s+(?:in a short time|for one day))?\s*:)/iu.test(String(error.message || error));
}

function isExactGmailMessageNotFound_(error) {
  var message = String(error && error.message || '');
  return message === 'Requested entity was not found.' ||
    message === 'API call to gmail.users.messages.get failed with error: Requested entity was not found.';
}

function toMyCouponsMessage_(message) {
  if (!message || !validOpaqueGmailId_(message.id) || !validOpaqueGmailId_(message.threadId) || !message.payload) {
    throw new Error('Gmail returned an incomplete message.');
  }
  var headers = {};
  (message.payload.headers || []).forEach(function(header) {
    if (header && typeof header.name === 'string' && typeof header.value === 'string') {
      headers[header.name.toLowerCase()] = header.value;
    }
  });
  var milliseconds = Number(message.internalDate);
  var date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || isNaN(date.getTime())) {
    throw new Error('Gmail message has an invalid internal date.');
  }
  return {
    date: date,
    from: headers.from || '',
    id: message.id,
    labelIds: message.labelIds || [],
    plainText: extractPlainText_(message.payload, message.id),
    subject: headers.subject || '',
    threadId: message.threadId,
  };
}

function validOpaqueGmailId_(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function extractPlainText_(payload, messageId) {
  var plainText = [];
  collectPlainTextParts_(payload, plainText, messageId);
  return plainText.join('\n');
}

function collectPlainTextParts_(part, plainText, messageId) {
  if (isAttachedPart_(part)) {
    return;
  }
  if (String(part.mimeType || '').toLowerCase() === 'text/plain' && part.body) {
    var encoded = part.body.data;
    if (!encoded && validOpaqueGmailId_(part.body.attachmentId)) {
      var attachment = Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId);
      encoded = attachment && attachment.data;
    }
    var decoded = decodeBase64UrlUtf8_(encoded);
    if (decoded !== null) {
      plainText.push(decoded);
    }
  }
  (part.parts || []).forEach(function(child) {
    collectPlainTextParts_(child, plainText, messageId);
  });
}

function isAttachedPart_(part) {
  if (String(part.mimeType || '').toLowerCase() === 'message/rfc822' || part.filename) {
    return true;
  }
  return (part.headers || []).some(function(header) {
    return header && typeof header.name === 'string' && typeof header.value === 'string' &&
      header.name.toLowerCase() === 'content-disposition' && /(?:^|;)\s*attachment\b/i.test(header.value);
  });
}

function decodeBase64UrlUtf8_(encoded) {
  try {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(encoded)).getDataAsString('UTF-8');
  } catch (error) {
    return null;
  }
}

function messageHasLabel_(message, labelId) {
  return message.labelIds.indexOf(labelId) !== -1;
}

function messageHasSystemExclusionLabel_(message) {
  return message.labelIds.indexOf('DRAFT') !== -1 || message.labelIds.indexOf('SENT') !== -1 ||
    message.labelIds.indexOf('SPAM') !== -1 ||
    message.labelIds.indexOf('TRASH') !== -1;
}

function extractCouponCodes_(subject, plainText) {
  var unquoted = stripQuotedReplyHistory_(plainText);
  var content = [unquoted.hadQuotedHistory ? '' : subject || '', unquoted.text];
  var messageContext = content.join('\n');
  if (/\b(?:otp|one[- ]time password|verification code|authentication code)\b|\bcodice\s+(?:di\s+)?verifica\b|\bcodice\s+otp\b/iu.test(messageContext) ||
      hasReferralCouponContext_(messageContext)) {
    return [];
  }
  var found = [];
  content.forEach(function(text) {
    collectExplicitCouponTokens_(text, found);
  });
  return found;
}

function hasReferralCouponContext_(text) {
  var introducer = /\b(?:coupon|promo(?:tional)?|discount)\s+code\b|\bcodice\s+sconto\b/iu;
  if (!introducer.test(text)) {
    return false;
  }
  return /\b(?:share|refer|invite)\s+(?:your\s+)?(?:promo(?:tional)?|referral)\s+code\b/iu.test(text) ||
    /\breferral\b/iu.test(text) ||
    /\b(?:share|refer|invite)\b/iu.test(text) && /\bfriends?\b/iu.test(text) ||
    /\b(?:invita|condividi|presenta)\s+(?:un\s+)?amic(?:o|a|i|he)\b/iu.test(text);
}

function stripQuotedReplyHistory_(plainText) {
  if (typeof plainText !== 'string') {
    return {hadQuotedHistory: false, text: ''};
  }
  var lines = plainText.replace(/\r\n?/gu, '\n').split('\n');
  var retained = [];
  for (var index = 0; index < lines.length; index += 1) {
    if (isQuotedReplyHistoryMarker_(lines[index]) || isOutlookQuotedHeaderBlock_(lines, index)) {
      return {hadQuotedHistory: true, text: retained.join('\n')};
    }
    retained.push(lines[index]);
  }
  return {hadQuotedHistory: false, text: retained.join('\n')};
}

function isOutlookQuotedHeaderBlock_(lines, index) {
  var required = ['from', 'sent', 'to'];
  if (!required.every(function(name, offset) {
    return new RegExp('^\\s*' + name + '\\s*:\\s*\\S', 'iu').test(lines[index + offset] || '');
  })) {
    return false;
  }
  var subjectIndex = index + required.length;
  while (/^\s*(?:cc|bcc|reply-to)\s*:\s*\S/iu.test(lines[subjectIndex] || '')) {
    subjectIndex += 1;
  }
  return /^\s*subject\s*:\s*\S/iu.test(lines[subjectIndex] || '');
}

function isQuotedReplyHistoryMarker_(line) {
  return /^\s*>/u.test(line) ||
    /^\s*On\s+.+\bwrote:\s*$/iu.test(line) ||
    /^\s*Il\s+giorno\s+.{1,500}\s+ha\s+scritto:\s*$/iu.test(line) ||
    /^\s*(?:-+\s*)?(?:Original Message|Forwarded Message|Messaggio inoltrato)(?:\s*-+)?\s*:?\s*$/iu.test(line) ||
    /^\s*Begin forwarded message:\s*$/iu.test(line);
}

function collectExplicitCouponTokens_(text, found) {
  var introducer = '(?:\\b(?:coupon|promo(?:tional)?|discount)\\s+code\\b|\\bcodice\\s+sconto\\b)';
  var quoted = new RegExp(introducer + '\\s*(?::|=|-|–)?\\s*["“]([^\\s<>{}\\[\\]"“”]{1,64})["”](?=$|\\s|[.!?,;:])', 'giu');
  var delimited = new RegExp(introducer + '\\s*(?::|=|-|–)\\s*([^\\s<>{}\\[\\]"“”]{1,64})(?=$|\\s)', 'giu');
  [quoted, delimited].forEach(function(expression) {
    var match;
    while ((match = expression.exec(text)) !== null) {
      if (hasNoCodeContextBeforeIntroducer_(text, match.index)) {
        continue;
      }
      var code = acceptCouponToken_(match[1], expression === quoted, /\s+\p{L}/u.test(text.slice(expression.lastIndex)));
      if (code && found.indexOf(code) === -1) {
        found.push(code);
      }
    }
  });
}

function hasNoCodeContextBeforeIntroducer_(text, introducerIndex) {
  var sameSentence = text.slice(0, introducerIndex).split(/[\n.!?]+/u).pop();
  var context = sameSentence.slice(-160);
  return /\b(?:no(?:\s+need\s+for)?|without|none|do(?:es)?\s+not\s+(?:need|require)|do(?:es)?n['’]t\s+(?:need|require)|not\s+require)(?:\s+(?:an?|the))?\s*$/iu.test(context) ||
    /\b(?:nessun[oa]?(?:\s+bisogno\s+di)?|senza|non\s+richiede|non\s+serve)(?:\s+(?:un[oa]?|il|lo))?\s*$/iu.test(context);
}

function acceptCouponToken_(token, quoted, hasFollowingWord) {
  if (!quoted) {
    token = normalizeUnquotedCouponToken_(token);
  }
  if (!token || isLinkLikeCouponToken_(token) || isEmailAddressCouponToken_(token) || !/[\p{L}\p{N}]/u.test(token)) {
    return null;
  }
  if (/^'/u.test(token) || isCouponPlaceholder_(token)) {
    return null;
  }
  if (!/^[\p{L}\p{N}\p{P}\p{S}]+$/u.test(token) || Array.from(token).length < 3 || Array.from(token).length > 64) {
    return null;
  }
  if (/[.!?,;:]$/u.test(token)) {
    return null;
  }
  if (/^(?:[$€£¥]\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?[%‰])$/u.test(token)) {
    return null;
  }
  if (!quoted && !/[\p{N}\p{P}\p{S}]/u.test(token) && (token === token.toLowerCase() || hasFollowingWord)) {
    return null;
  }
  return token;
}

function normalizeUnquotedCouponToken_(token) {
  if (!/[()[\]{}]/u.test(token)) {
    return token;
  }
  var matching = {'(': ')', '[': ']', '{': '}'};
  var first = token.charAt(0);
  if (!Object.prototype.hasOwnProperty.call(matching, first) || token.charAt(token.length - 1) !== matching[first]) {
    return null;
  }
  var inner = token.slice(1, -1);
  return inner && !/[()[\]{}]/u.test(inner) ? inner : null;
}

function isLinkLikeCouponToken_(token) {
  var normalized = token.replace(/[.!?,;:]+$/u, '');
  return /^(?:https?:\/\/|www\.)/iu.test(normalized) ||
    /^(?:[\p{L}\p{N}-]+\.)+[A-Za-z]{2,63}(?:[/?#].*)?$/u.test(normalized);
}

function isEmailAddressCouponToken_(token) {
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(token);
}

function isCouponPlaceholder_(token) {
  return /^(?:not|none|n\/?a|no|null|empty|required|tbd|not[-_]?available|no[-_]?code|(?:click|tap)[-_]?(?:here|link)|learn[-_]?more|shop[-_]?now|sign[-_]?up|copy[-_]?code|view[-_]?offer)[.!?,;:]*$/iu.test(token);
}

function withMyCouponsLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
