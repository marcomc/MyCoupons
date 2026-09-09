const MC_INSTALLER_VERSION = 1;
const MC_INSTALLER_LIMITS = Object.freeze({maxConfigBytes: 12000});

function validateInstallerInput_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail_('CONFIG');
  const keys = Object.keys(input);
  if (keys.some(function (key) { return ['ownerEmail', 'spreadsheetId', 'spreadsheetName', 'sheetName', 'labelName',
    'locale', 'timeZone', 'initialDate', 'developerProject', 'vertexProject', 'vertexLocation', 'model',
    'autoVertexFallback', 'fetchRemoteImages'].indexOf(key) < 0; })) fail_('CONFIG');
  const config = validateConfig_(input);
  if (JSON.stringify(config).length > MC_INSTALLER_LIMITS.maxConfigBytes) fail_('CONFIG');
  return config;
}

function installMyCoupons(input) {
  return withLock_(function () {
    const config = validateInstallerInput_(input || config_());
    assertOwner_(config);
    const state = ensureSheetState_(config);
    const trigger = installDailyImportTrigger();
    return {version: MC_INSTALLER_VERSION, installed: true, resumed: !!config.spreadsheetId,
      spreadsheetId: String(state.spreadsheet.getId()), labelId: String(state.label.id),
      triggerCreated: !!trigger.created, locale: config.locale, timeZone: config.timeZone};
  });
}

function getInstallationStatus() {
  const config = config_();
  const triggers = ownedImportTriggers_();
  return {configured: true, spreadsheetId: config.spreadsheetId || '', labelId: config.labelId || '',
    triggerCount: triggers.length, ready: !!config.spreadsheetId && !!config.labelId && triggers.length === 1};
}
