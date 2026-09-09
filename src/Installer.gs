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
    const state = ensureSheetState_(config);
    assertPrivateSpreadsheet_(state.spreadsheet, config);
    const trigger = installDailyImportTrigger();
    const reviewTrigger = installReviewEditTrigger_(state.spreadsheet);
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

function assertPrivateSpreadsheet_(spreadsheet, config) {
  let file;
  try { file = DriveApp.getFileById(spreadsheet.getId()); } catch (e) { fail_('RESOURCE'); }
  if (file.getSharingAccess && file.getSharingAccess() !== DriveApp.Access.PRIVATE) fail_('RESOURCE');
  if (file.getSharingPermission && file.getSharingPermission() !== DriveApp.Permission.NONE) fail_('RESOURCE');
  const sharedUsers = (file.getEditors ? file.getEditors() : []).concat(file.getViewers ? file.getViewers() : []);
  if (sharedUsers.some(function (user) {
    return String(user.getEmail()).toLowerCase() !== String(config.ownerEmail).toLowerCase();
  })) fail_('RESOURCE');
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

function getInstallationStatus() {
  if (!props_().getProperty(MC.configKey)) {
    const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === MC_SCHEDULED_HANDLER && trigger.getEventType() === ScriptApp.EventType.CLOCK;
    });
    return {configured: false, spreadsheetId: '', labelId: '', triggerCount: triggers.length, ready: false};
  }
  const config = config_();
  const triggers = ownedImportTriggers_();
  const reviewTriggers = config.spreadsheetId ? ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === MC_REVIEW_HANDLER && trigger.getEventType() === ScriptApp.EventType.ON_EDIT &&
      trigger.getTriggerSourceId && String(trigger.getTriggerSourceId()) === String(config.spreadsheetId);
  }) : [];
  return {configured: true, spreadsheetId: config.spreadsheetId || '', labelId: config.labelId || '',
    triggerCount: triggers.length, reviewTriggerCount: reviewTriggers.length,
    ready: !!config.spreadsheetId && !!config.labelId && triggers.length === 1 && reviewTriggers.length === 1};
}
