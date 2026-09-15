var MYCOUPONS_CONFIG_PROPERTY = 'MYCOUPONS_CONFIG';
var MYCOUPONS_WATERMARK_PROPERTY = 'MYCOUPONS_WATERMARK';
var MYCOUPONS_SEARCH_PAGE_SIZE = 100;

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
 * @return {{import: Object, retention: Object}}
 */
function runMyCouponsDaily() {
  return withMyCouponsLock_(function() {
    var config = getMyCouponsConfig_();
    assertMyCouponsOwner_(config);
    return {
      import: runMyCouponsImport_(config),
      retention: cleanupExpiredImportedMessages_(config),
    };
  });
}

/**
 * Moves only expired, previously imported messages to Gmail Trash.
 *
 * @return {{trashed: number}}
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
      return trigger.getHandlerFunction() === 'runMyCouponsDaily';
    });
    if (matching.length > 1) {
      throw new Error('Multiple daily triggers exist for runMyCouponsDaily. Resolve them manually.');
    }
    if (matching.length === 1) {
      return {created: false, dailyHour: config.dailyHour};
    }
    ScriptApp.newTrigger('runMyCouponsDaily')
      .timeBased()
      .atHour(config.dailyHour)
      .everyDays(1)
      .create();
    return {created: true, dailyHour: config.dailyHour};
  });
}

/**
 * Performs an owner-gated, read-only installation preflight without exposing
 * resource identifiers or changing Gmail, Sheets, or triggers.
 *
 * @return {{dailyTrigger: string, ready: boolean}}
 */
function getMyCouponsInstallationStatus() {
  var config = getMyCouponsConfig_();
  assertMyCouponsOwner_(config);
  resolveImportedLabel_(config);
  readCouponSheetState_(resolveCouponSheet_(config));
  var matching = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'runMyCouponsDaily';
  });
  if (matching.length > 1) {
    throw new Error('Multiple daily triggers exist for runMyCouponsDaily. Resolve them manually.');
  }
  return {dailyTrigger: matching.length === 1 ? 'installed' : 'missing', ready: true};
}

function runMyCouponsImport_(config) {
  var label = resolveImportedLabel_(config);
  var sheet = resolveCouponSheet_(config);
  var sheetState = readCouponSheetState_(sheet);
  var boundary = new Date();
  var listing = listGmailMessages_(buildImportQuery_(config, boundary));
  var messages = listing.messages;
  var imported = 0;

  messages.forEach(function(message) {
    if (messageHasLabel_(message, label.id)) {
      return;
    }
    var hasVerifiedCode = false;
    extractCouponCodes_(message.subject, message.plainText).forEach(function(code) {
      var deduplicationKey = message.id + '::' + code;
      if (sheetState.deduplicationRecords[deduplicationKey]) {
        if (!sheetState.deduplicationRecords[deduplicationKey].valid) {
          throw new Error('Existing coupon deduplication row does not prove its message and code identity.');
        }
        hasVerifiedCode = true;
        return;
      }
      var row = makeCouponRow_(sheetState.columns, sheetState.columnCount, message, code, deduplicationKey);
      appendAndVerifyCouponRow_(sheet, row, sheetState.columns, deduplicationKey);
      sheetState.deduplicationRecords[deduplicationKey] = {valid: true};
      hasVerifiedCode = true;
      imported += 1;
    });
    if (hasVerifiedCode) {
      mutateImportedMessage_(message.id, label.id, config.archiveImported);
    }
  });

  var watermark = null;
  if (listing.complete) {
    watermark = boundary.toISOString();
    PropertiesService.getScriptProperties().setProperty(MYCOUPONS_WATERMARK_PROPERTY, watermark);
  }
  return {complete: listing.complete, imported: imported, scanned: messages.length, watermark: watermark};
}

function cleanupExpiredImportedMessages_(config) {
  if (!config.trashExpiredImported) {
    return {trashed: 0};
  }
  var threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - config.retentionDays);
  var trashed = 0;
  var label = resolveImportedLabel_(config);
  listGmailMessages_(buildRetentionQuery_(config)).messages.forEach(function(message) {
    if (!messageHasLabel_(message, label.id) || message.date.getTime() >= threshold.getTime()) {
      return;
    }
    Gmail.Users.Messages.trash('me', message.id);
    trashed += 1;
  });
  return {trashed: trashed};
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
  if (labels.length !== 1 || !labels[0].id) {
    throw new Error('Configured imported Gmail label must resolve exactly once.');
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
  var sheet = spreadsheet.getSheetByName(config.sheetName);
  if (!sheet) {
    throw new Error('Configured coupon sheet was not found.');
  }
  return sheet;
}

function readCouponSheetState_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (!values.length || !values[0].length) {
    throw new Error('Coupon sheet must contain its existing header row.');
  }
  var columns = resolveCouponColumns_(values[0]);
  var deduplicationRecords = {};
  values.slice(1).forEach(function(row) {
    var key = sheetSemanticText_(row[columns.deduplicationKey]);
    if (key) {
      var parsedKey = parseDeduplicationKey_(key);
      var valid = parsedKey !== null && sheetSemanticText_(row[columns.couponCode]) === parsedKey.code &&
        sheetSemanticText_(row[columns.gmailLink]) === gmailLinkForMessage_(parsedKey.messageId);
      deduplicationRecords[key] = {valid: valid};
    }
  });
  return {columnCount: values[0].length, columns: columns, deduplicationRecords: deduplicationRecords};
}

function parseDeduplicationKey_(key) {
  var separator = key.indexOf('::');
  if (separator <= 0 || separator === key.length - 2) {
    return null;
  }
  return {code: key.slice(separator + 2), messageId: key.slice(0, separator)};
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

function makeCouponRow_(columns, columnCount, message, code, deduplicationKey) {
  var row = Array(columnCount).fill('');
  row[columns.emailDate] = message.date.toISOString();
  row[columns.couponCode] = asSheetLiteral_(code);
  row[columns.sourceSubject] = asSheetLiteral_(message.subject);
  row[columns.sender] = asSheetLiteral_(message.from);
  row[columns.gmailLink] = asSheetLiteral_(gmailLinkForMessage_(message.id));
  row[columns.deduplicationKey] = asSheetLiteral_(deduplicationKey);
  row[columns.status] = 'imported';
  return row;
}

function gmailLinkForMessage_(messageId) {
  return 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(messageId);
}

function asSheetLiteral_(value) {
  var text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function sheetSemanticText_(value) {
  var text = String(value);
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

function appendAndVerifyCouponRow_(sheet, row, columns, deduplicationKey) {
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
  range.setNumberFormat('@');
  range.setValues([row]);
  var written = range.getValues()[0];
  var formulas = range.getFormulas()[0];
  if (sheetSemanticText_(written[columns.deduplicationKey]) !== deduplicationKey ||
      sheetSemanticText_(written[columns.couponCode]) !== sheetSemanticText_(row[columns.couponCode]) ||
      sheetSemanticText_(written[columns.gmailLink]) !== gmailLinkForStoredRow_(row, columns) ||
      sheetSemanticText_(written[columns.sourceSubject]) !== sheetSemanticText_(row[columns.sourceSubject]) ||
      sheetSemanticText_(written[columns.sender]) !== sheetSemanticText_(row[columns.sender]) ||
      formulas[columns.deduplicationKey] || formulas[columns.couponCode] || formulas[columns.gmailLink] ||
      formulas[columns.sourceSubject] || formulas[columns.sender]) {
    throw new Error('Coupon row verification failed before Gmail mutation.');
  }
}

function gmailLinkForStoredRow_(row, columns) {
  return sheetSemanticText_(row[columns.gmailLink]);
}

function mutateImportedMessage_(messageId, labelId, archiveImported) {
  Gmail.Users.Messages.modify({
    addLabelIds: [labelId],
    removeLabelIds: archiveImported ? ['INBOX'] : [],
  }, 'me', messageId);
}

function buildImportQuery_(config, boundary) {
  return 'after:' + Math.floor(scanStart_(config).getTime() / 1000) +
    ' before:' + Math.floor(boundary.getTime() / 1000) +
    ' -in:spam -in:trash -label:"' + escapeGmailQueryString_(config.labelName) + '"';
}

function buildRetentionQuery_(config) {
  return 'label:"' + escapeGmailQueryString_(config.labelName) + '" -in:trash';
}

function scanStart_(config) {
  var rawWatermark = PropertiesService.getScriptProperties().getProperty(MYCOUPONS_WATERMARK_PROPERTY);
  if (!rawWatermark) {
    return config.initialDate;
  }
  var watermark = new Date(rawWatermark);
  if (isNaN(watermark.getTime()) || watermark.toISOString() !== rawWatermark) {
    throw new Error('Stored MyCoupons watermark is invalid. Repair it deliberately before importing.');
  }
  watermark.setUTCDate(watermark.getUTCDate() - config.watermarkOverlapDays);
  return watermark;
}

function escapeGmailQueryString_(value) {
  return value.replace(/["\\]/g, '\\$&');
}

function listGmailMessages_(query) {
  var messages = [];
  var pageToken;
  do {
    var options = {
      maxResults: MYCOUPONS_SEARCH_PAGE_SIZE,
      q: query,
    };
    if (pageToken) {
      options.pageToken = pageToken;
    }
    var page = Gmail.Users.Messages.list('me', options);
    var references = page.messages || [];
    for (var index = 0; index < references.length; index += 1) {
      try {
        messages.push(toMyCouponsMessage_(Gmail.Users.Messages.get('me', references[index].id, {format: 'full'})));
      } catch (error) {
        if (isGmailRateLimitError_(error)) {
          return {complete: false, messages: messages};
        }
        throw error;
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return {complete: true, messages: messages};
}

function isGmailRateLimitError_(error) {
  return error && /(?:quota exceeded|rate limit|user-rate limit)/iu.test(String(error.message || error));
}

function toMyCouponsMessage_(message) {
  if (!message || typeof message.id !== 'string' || !message.payload) {
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
    plainText: extractPlainText_(message.payload),
    subject: headers.subject || '',
  };
}

function extractPlainText_(payload) {
  var plainText = [];
  collectPlainTextParts_(payload, plainText);
  return plainText.join('\n');
}

function collectPlainTextParts_(part, plainText) {
  if (isAttachedPart_(part)) {
    return;
  }
  if (String(part.mimeType || '').toLowerCase() === 'text/plain' && part.body && part.body.data) {
    var decoded = decodeBase64UrlUtf8_(part.body.data);
    if (decoded !== null) {
      plainText.push(decoded);
    }
  }
  (part.parts || []).forEach(function(child) {
    collectPlainTextParts_(child, plainText);
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

function extractCouponCodes_(subject, plainText) {
  var content = [subject || '', plainText || ''];
  if (content.some(function(text) {
    return /\b(?:otp|one[- ]time password|verification code|authentication code)\b|\bcodice\s+(?:di\s+)?verifica\b|\bcodice\s+otp\b/iu.test(text);
  })) {
    return [];
  }
  var found = [];
  content.forEach(function(text) {
    collectExplicitCouponTokens_(text, found);
  });
  return found;
}

function collectExplicitCouponTokens_(text, found) {
  var introducer = '(?:\\b(?:coupon|promo(?:tional)?|discount)\\s+code\\b|\\bcodice\\s+sconto\\b)';
  var quoted = new RegExp(introducer + '\\s*(?::|=|-|–)?\\s*["“]([^\\s<>{}\\[\\]"“”]{1,64})["”](?=$|\\s|[.!?,;:])', 'giu');
  var delimited = new RegExp(introducer + '\\s*(?::|=|-|–)\\s*([^\\s<>{}\\[\\]"“”]{1,64})(?=$|\\s)', 'giu');
  [quoted, delimited].forEach(function(expression) {
    var match;
    while ((match = expression.exec(text)) !== null) {
      var code = acceptCouponToken_(match[1], expression === quoted);
      if (code && found.indexOf(code) === -1) {
        found.push(code);
      }
    }
  });
}

function acceptCouponToken_(token, quoted) {
  if (!token || /^(?:https?:\/\/|www\.)/iu.test(token) || !/[\p{L}\p{N}]/u.test(token)) {
    return null;
  }
  if (/^'/u.test(token) || isCouponAbsenceMarker_(token)) {
    return null;
  }
  if (!/^[\p{L}\p{N}\p{P}\p{S}]+$/u.test(token) || Array.from(token).length < 3 || Array.from(token).length > 64) {
    return null;
  }
  if (!quoted && /[.!?,;:]$/u.test(token)) {
    return null;
  }
  return token;
}

function isCouponAbsenceMarker_(token) {
  return /^(?:not|none|n\/?a|no|null|empty|required)$/iu.test(token);
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
