const MC_INSTALLER_VERSION = 1;
const MC_INSTALLER_LIMITS = Object.freeze({maxConfigUnits: 8000});
const MC_REVIEW_HANDLER = 'onReviewEdit';

function validateInstallerInput_(input, allowPersistedIdentity) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail_('CONFIG');
  const keys = Object.keys(input);
  if (keys.some(function (key) { return ['ownerEmail', 'spreadsheetId', 'spreadsheetName', 'sheetName', 'labelName',
    'locale', 'timeZone', 'initialDate', 'developerProject', 'vertexProject', 'vertexLocation', 'model',
    'autoVertexFallback', 'fetchRemoteImages'].concat(allowPersistedIdentity ? ['labelId'] : []).indexOf(key) < 0; })) fail_('CONFIG');
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
    if (previous) {
      let previousConfig;
      try { previousConfig = validateConfig_(JSON.parse(previous)); } catch (e) { fail_('CONFIG'); }
      if (config.spreadsheetId && config.spreadsheetId !== previousConfig.spreadsheetId) {
        assertPrivateSpreadsheet_(openSpreadsheetById_(config.spreadsheetId), config);
      }
    } else if (!config.spreadsheetId) {
      const matches = findSpreadsheetsByName_(config.spreadsheetName);
      if (matches.length > 1) fail_('RESOURCE');
      if (matches.length === 1) assertPrivateSpreadsheet_(openSpreadsheetById_(matches[0]), config);
    }
    const state = ensureSheetState_(config);
    assertPrivateSpreadsheet_(state.spreadsheet, config);
    const reviewTrigger = installReviewEditTrigger_(state.spreadsheet);
    const trigger = installDailyImportTrigger();
    return {version: MC_INSTALLER_VERSION, installed: true, resumed: !!config.spreadsheetId,
      spreadsheetId: String(state.spreadsheet.getId()), labelId: String(state.label.id),
      triggerCreated: !!trigger.created, reviewTriggerCreated: !!reviewTrigger.created,
      locale: config.locale, timeZone: config.timeZone};
  });
}

function beginMyCouponsInstallation(input) {
  return withLock_(function () {
    const config = validateInstallerInput_(input, false);
    assertOwner_(config);
    props_().setProperty(MC.configKey, JSON.stringify(config));
    return installMyCoupons();
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
      const response = Drive.Permissions.list(String(spreadsheet.getId()), {pageToken: token || undefined});
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
    const c = config_();
    assertOwner_(c);
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
      assertSpreadsheetIdentity_(openSpreadsheetById_(config.spreadsheetId), config);
      resourcesReady = listGmailLabels_().some(function (label) { return label.id === config.labelId && label.name === config.labelName; });
    } catch (e) { resourcesReady = false; }
  }
  return {configured: true, spreadsheetId: config.spreadsheetId || '', labelId: config.labelId || '',
    triggerCount: triggers.length, reviewTriggerCount: reviewTriggers.length,
    ready: resourcesReady && triggers.length === 1 && reviewTriggers.length === 1};
}
