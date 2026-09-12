const MC_INSTALLER_VERSION = 1;
const MC_INSTALLER_LIMITS = Object.freeze({maxConfigUnits: 8000});
const MC_REVIEW_HANDLER = 'onReviewEdit';
const MC_INSTALLER_INPUT_KEYS = Object.freeze(['ownerEmail', 'spreadsheetId', 'spreadsheetName', 'sheetName',
  'labelName', 'locale', 'timeZone', 'initialDate', 'developerProject', 'vertexProject', 'vertexLocation',
  'model', 'autoVertexFallback', 'fetchRemoteImages']);
const MC_BOOTSTRAP = Object.freeze({
  secretName: 'mycoupons-bootstrap', version: 1, maxPayloadUnits: 12000,
  maxSecretDataChars: 16384, maxApiKeyUnits: 512
});

function validateInstallerInput_(input, allowPersistedIdentity) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail_('CONFIG');
  const keys = Object.keys(input);
  if (keys.some(function (key) {
    return MC_INSTALLER_INPUT_KEYS.concat(allowPersistedIdentity ? ['labelId'] : []).indexOf(key) < 0;
  })) fail_('CONFIG');
  const config = validateConfig_(input);
  if (JSON.stringify(config).length > MC_INSTALLER_LIMITS.maxConfigUnits) fail_('CONFIG');
  return config;
}

function installMyCoupons(input) {
  const hasInput = arguments.length > 0;
  return withLock_(function () {
    const config = hasInput ? validateInstallerInput_(input, false) :
      validateInstallerInput_(config_(), true);
    assertOwner_(config);
    const previous = props_().getProperty(MC.configKey);
    let previousConfig = null;
    if (previous) {
      try { previousConfig = validateConfig_(JSON.parse(previous)); } catch (e) { fail_('CONFIG'); }
    }
    // Reconfiguration cannot carry an old mailbox continuation into a new
    // resource. Preflight before changing configuration; a failed installation
    // can safely resume through its existing daily trigger.
    const continuation = mailboxContinuation_(previousConfig);
    if (continuation.record && mailboxInstallationId_(config) !== continuation.record.installationId) {
      stopMailboxContinuation_(continuation);
      props_().deleteProperty(MC_CONTINUATION_KEY);
    }
    if (config.spreadsheetId) {
      assertPrivateSpreadsheet_(openSpreadsheetById_(config.spreadsheetId), config);
    } else if (!config.spreadsheetId) {
      const matches = findSpreadsheetsByName_(config.spreadsheetName);
      if (matches.length > 1) fail_('RESOURCE');
      if (matches.length === 1) assertPrivateSpreadsheet_(openSpreadsheetById_(matches[0]), config);
    }
    let reviewTrigger;
    let replacingReviewTrigger = false;
    try {
      const state = ensureSheetState_(config);
      assertPrivateSpreadsheet_(state.spreadsheet, config);
      replacingReviewTrigger = !!previousConfig && String(previousConfig.spreadsheetId) !== String(state.spreadsheet.getId());
      reviewTrigger = installReviewEditTrigger_(state.spreadsheet);
      const trigger = installDailyImportTrigger();
      return {version: MC_INSTALLER_VERSION, installed: true, resumed: !!config.spreadsheetId,
        spreadsheetId: String(state.spreadsheet.getId()), labelId: String(state.label.id),
        triggerCreated: !!trigger.created, reviewTriggerCreated: !!reviewTrigger.created,
        locale: config.locale, timeZone: config.timeZone};
    } catch (e) {
      if (previous === null) props_().deleteProperty(MC.configKey);
      else props_().setProperty(MC.configKey, previous);
      if (reviewTrigger && reviewTrigger.created && reviewTrigger.trigger) {
        try { ScriptApp.deleteTrigger(reviewTrigger.trigger); } catch (ignored) {}
      }
      if (previousConfig && replacingReviewTrigger) {
        try { installReviewEditTrigger_(openSpreadsheetById_(previousConfig.spreadsheetId)); } catch (ignored) {}
      }
      throw e;
    }
  });
}

function beginMyCouponsInstallation(input) {
  return withLock_(function () {
    const config = validateInstallerInput_(input, false);
    assertOwner_(config);
    return installMyCoupons(config);
  });
}

function beginMyCouponsInstallationFromBootstrapProperty() {
  const raw = props_().getProperty('MYCOUPONS_BOOTSTRAP_CONFIG');
  if (!raw) fail_('CONFIG');
  let input;
  try { input = JSON.parse(raw); } catch (e) { fail_('CONFIG'); }
  const result = beginMyCouponsInstallation(input);
  props_().deleteProperty('MYCOUPONS_BOOTSTRAP_CONFIG');
  return result;
}

// Performs no configuration or secret access. A successful Execution API call
// proves that the caller's OAuth client is authorized for this deployment.
function verifyBootstrapExecutionAccess() {
  return {version: MC_INSTALLER_VERSION, ready: true};
}

// This function is intended only for an Execution API deployment with access MYSELF.
// It deliberately accepts one exact Secret Manager version, never a secret name or alias.
function bootstrapFromSecret(secretVersion) {
  return withLock_(function () {
    const persisted = bootstrapPersistedConfig_();
    if (persisted) assertOwner_(persisted);
    const resource = validateBootstrapSecretVersion_(secretVersion, persisted && persisted.vertexProject);
    const secret = readBootstrapSecret_(resource);
    const bootstrap = validateBootstrapPayload_(secret.payload);
    if (persisted && bootstrap.config.vertexProject !== persisted.vertexProject) fail_('RESOURCE');
    if (persisted && MC_INSTALLER_INPUT_KEYS.some(function (key) {
      return persisted[key] !== bootstrap.config[key] && !(key === 'spreadsheetId' && bootstrap.config.spreadsheetId === '');
    })) fail_('RESOURCE');
    assertBootstrapSecretProject_(resource, secret.name, bootstrap.config.vertexProject);
    assertOwner_(bootstrap.config);
    const properties = props_();
    const previousKey = properties.getProperty('GEMINI_API_KEY');
    try {
      properties.setProperty('GEMINI_API_KEY', bootstrap.geminiApiKey);
      // Persisted configuration includes the opaque label identity, which is
      // accepted only by the no-argument resume path.
      const result = persisted ? installMyCoupons() : beginMyCouponsInstallation(bootstrap.config);
      return bootstrapInstallationResult_(result);
    } catch (e) {
      if (previousKey === null) properties.deleteProperty('GEMINI_API_KEY');
      else properties.setProperty('GEMINI_API_KEY', previousKey);
      throw e;
    }
  });
}

function bootstrapPersistedConfig_() {
  const raw = props_().getProperty(MC.configKey);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { fail_('CONFIG'); }
  return validateInstallerInput_(parsed, true);
}

function validateBootstrapSecretVersion_(value, expectedProject) {
  if (typeof value !== 'string') fail_('RESOURCE');
  const pattern = new RegExp('^projects/((?:[a-z][a-z0-9-]{4,28}[a-z0-9])|(?:[1-9][0-9]*))/secrets/' +
    MC_BOOTSTRAP.secretName + '/versions/([1-9][0-9]*)$');
  const match = pattern.exec(value);
  if (!match) fail_('RESOURCE');
  if (expectedProject) {
    const expectedNumber = resolveBootstrapProjectNumber_(expectedProject);
    if (match[1] !== expectedProject && match[1] !== expectedNumber) fail_('RESOURCE');
  }
  return {name: value, project: match[1], version: match[2]};
}

function readBootstrapSecret_(resource) {
  let response;
  try {
    response = UrlFetchApp.fetch('https://secretmanager.googleapis.com/v1/' + resource.name + ':access', {
      method: 'get', headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}, muteHttpExceptions: true
    });
  } catch (e) { fail_('RESOURCE'); }
  if (!response || response.getResponseCode() < 200 || response.getResponseCode() >= 300) fail_('RESOURCE');
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (e) { fail_('RESOURCE'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' ||
    !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) fail_('RESOURCE');
  const canonical = new RegExp('^projects/([1-9][0-9]*)/secrets/' + MC_BOOTSTRAP.secretName +
    '/versions/' + resource.version + '$').exec(body.name);
  if (!canonical) fail_('RESOURCE');
  const data = body.payload.data;
  const checksum = body.payload.dataCrc32c;
  if (typeof data !== 'string' || data.length > MC_BOOTSTRAP.maxSecretDataChars ||
    typeof checksum !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/.test(checksum) || Number(checksum) > 4294967295 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail_('RESOURCE');
  let bytes;
  try { bytes = Utilities.base64Decode(data); } catch (e) { fail_('RESOURCE'); }
  if (crc32c_(bytes) !== Number(checksum)) fail_('RESOURCE');
  try { return {name: body.name, payload: Utilities.newBlob(bytes).getDataAsString()}; } catch (e) { fail_('RESOURCE'); }
}

function assertBootstrapSecretProject_(resource, canonicalName, projectId) {
  const projectNumber = resolveBootstrapProjectNumber_(projectId);
  const expected = 'projects/' + projectNumber + '/secrets/' + MC_BOOTSTRAP.secretName + '/versions/' + resource.version;
  if (canonicalName !== expected) fail_('RESOURCE');
}

function resolveBootstrapProjectNumber_(projectId) {
  let response;
  try {
    response = UrlFetchApp.fetch('https://cloudresourcemanager.googleapis.com/v1/projects/' + encodeURIComponent(projectId), {
      method: 'get', headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}, muteHttpExceptions: true
    });
  } catch (e) { fail_('RESOURCE'); }
  if (!response || response.getResponseCode() < 200 || response.getResponseCode() >= 300) fail_('RESOURCE');
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (e) { fail_('RESOURCE'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.projectId !== projectId ||
    typeof body.projectNumber !== 'string' || !/^[1-9][0-9]*$/.test(body.projectNumber)) fail_('RESOURCE');
  return body.projectNumber;
}

function validateBootstrapPayload_(raw) {
  if (typeof raw !== 'string' || raw.length > MC_BOOTSTRAP.maxPayloadUnits ||
    bootstrapHasDuplicateJsonKeys_(raw)) fail_('CONFIG');
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { fail_('CONFIG'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).length !== 3 || Object.keys(payload).some(function (key) {
      return ['version', 'config', 'geminiApiKey'].indexOf(key) < 0;
    }) || payload.version !== MC_BOOTSTRAP.version || typeof payload.geminiApiKey !== 'string' ||
    payload.geminiApiKey.length > MC_BOOTSTRAP.maxApiKeyUnits ||
    !/^AIza[A-Za-z0-9_-]{20,}$/.test(payload.geminiApiKey)) fail_('CONFIG');
  if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config) ||
    Object.keys(payload.config).length !== MC_INSTALLER_INPUT_KEYS.length || MC_INSTALLER_INPUT_KEYS.some(function (key) {
      return !Object.prototype.hasOwnProperty.call(payload.config, key);
    })) fail_('CONFIG');
  const config = validateInstallerInput_(payload.config, false);
  if (!config.vertexProject) fail_('CONFIG');
  return {config: config, geminiApiKey: payload.geminiApiKey};
}

function crc32c_(bytes) {
  let checksum = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    checksum ^= Number(bytes[index]) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      checksum = checksum & 1 ? (checksum >>> 1) ^ 0x82f63b78 : checksum >>> 1;
    }
  }
  return (checksum ^ -1) >>> 0;
}

function bootstrapHasDuplicateJsonKeys_(json) {
  const objects = [];
  function endString(index) {
    while (index < json.length) {
      if (json[index] === '\\') index += 2;
      else if (json[index++] === '"') return index;
    }
    return index;
  }
  for (let index = 0; index < json.length; index++) {
    if (json[index] === '"') {
      const start = index;
      index = endString(index + 1) - 1;
      if (/^\s*:/.test(json.slice(index + 1))) {
        let key;
        try { key = JSON.parse(json.slice(start, index + 1)); } catch (e) { return true; }
        const object = objects[objects.length - 1];
        if (object && object.has(key)) return true;
        if (object) object.add(key);
      }
    } else if (json[index] === '{') {
      objects.push(new Set());
    } else if (json[index] === '}') {
      objects.pop();
    }
  }
  return false;
}

function bootstrapInstallationResult_(result) {
  if (!result || typeof result !== 'object') fail_('INTERNAL');
  return {version: result.version, installed: result.installed, resumed: result.resumed,
    spreadsheetId: result.spreadsheetId, labelId: result.labelId, triggerCreated: result.triggerCreated,
    reviewTriggerCreated: result.reviewTriggerCreated, locale: result.locale, timeZone: result.timeZone};
}

function assertPrivateSpreadsheet_(spreadsheet, config) {
  let file;
  try { file = DriveApp.getFileById(spreadsheet.getId()); } catch (e) { fail_('RESOURCE'); }
  if (file.getSharingAccess && file.getSharingAccess() !== DriveApp.Access.PRIVATE) fail_('RESOURCE');
  if (file.getSharingPermission && file.getSharingPermission() !== DriveApp.Permission.NONE) fail_('RESOURCE');
  const sharedUsers = (file.getEditors ? file.getEditors() : []).concat(file.getViewers ? file.getViewers() : []);
  if (sharedUsers.some(function (user) {
    return String(user.getEmail()).toLowerCase() !== String(config.ownerEmail).toLowerCase();
  })) fail_('RESOURCE');
  if (typeof Drive !== 'undefined' && Drive.Permissions && Drive.Permissions.list) {
    let token = '';
    do {
      const response = Drive.Permissions.list(String(spreadsheet.getId()), {
        pageToken: token || undefined,
        fields: 'nextPageToken,permissions(type,role,emailAddress)'
      });
      (response.permissions || []).forEach(function (permission) {
        if (permission.type !== 'user' || String(permission.role).toLowerCase() !== 'owner' ||
            String(permission.emailAddress || '').toLowerCase() !== String(config.ownerEmail).toLowerCase()) fail_('RESOURCE');
      });
      token = response.nextPageToken || '';
    } while (token);
  }
}

function installReviewEditTrigger_(spreadsheet) {
  const all = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === MC_REVIEW_HANDLER && trigger.getEventType() === ScriptApp.EventType.ON_EDIT;
  });
  all.filter(function (trigger) {
    return trigger.getTriggerSourceId && String(trigger.getTriggerSourceId()) !== String(spreadsheet.getId());
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  const triggers = all.filter(function (trigger) {
    return !trigger.getTriggerSourceId || String(trigger.getTriggerSourceId()) === String(spreadsheet.getId());
  });
  if (triggers.length > 1) fail_('RESOURCE');
  if (triggers.length === 1) return {created: false, trigger: triggers[0]};
  const trigger = ScriptApp.newTrigger(MC_REVIEW_HANDLER).forSpreadsheet(spreadsheet).onEdit().create();
  if (!trigger || trigger.getHandlerFunction() !== MC_REVIEW_HANDLER) fail_('RESOURCE');
  return {created: true, trigger: trigger};
}

function removeReviewEditTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === MC_REVIEW_HANDLER && trigger.getEventType() === ScriptApp.EventType.ON_EDIT;
  });
  triggers.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  return {removed: triggers.length};
}

function removeMyCouponsAutomation() {
  return withLock_(function () {
    const raw = props_().getProperty(MC.configKey);
    if (raw) assertOwner_(config_());
    else if (String(Gmail.Users.getProfile('me').emailAddress).toLowerCase() !==
      String(Session.getEffectiveUser().getEmail()).toLowerCase()) fail_('OWNER');
    const scheduled = removeDailyImportTrigger();
    const review = removeReviewEditTriggers_();
    return {scheduledRemoved: !!scheduled.removed, reviewRemoved: review.removed};
  });
}

function getInstallationStatus() {
  if (!props_().getProperty(MC.configKey)) {
    const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === MC_SCHEDULED_HANDLER && trigger.getEventType() === ScriptApp.EventType.CLOCK;
    });
    const reviewTriggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === MC_REVIEW_HANDLER && trigger.getEventType() === ScriptApp.EventType.ON_EDIT;
    });
    return {configured: false, spreadsheetId: '', labelId: '', triggerCount: triggers.length,
      reviewTriggerCount: reviewTriggers.length, ready: false};
  }
  const config = config_();
  const triggers = ownedImportTriggers_();
  const reviewTriggers = config.spreadsheetId ? ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === MC_REVIEW_HANDLER && trigger.getEventType() === ScriptApp.EventType.ON_EDIT &&
      trigger.getTriggerSourceId && String(trigger.getTriggerSourceId()) === String(config.spreadsheetId);
  }) : [];
  let resourcesReady = !!config.spreadsheetId && !!config.labelId;
  if (resourcesReady) {
    try {
      const spreadsheet = openSpreadsheetById_(config.spreadsheetId);
      assertSpreadsheetIdentity_(spreadsheet, config);
      assertPrivateSpreadsheet_(spreadsheet, config);
      resourcesReady = listGmailLabels_().some(function (label) { return label.id === config.labelId && label.name === config.labelName; });
    } catch (e) { resourcesReady = false; }
  }
  return {configured: true, spreadsheetId: config.spreadsheetId || '', labelId: config.labelId || '',
    triggerCount: triggers.length, reviewTriggerCount: reviewTriggers.length,
    ready: resourcesReady && triggers.length === 1 && reviewTriggers.length === 1};
}
