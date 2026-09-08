const MC_SCHEDULED_HANDLER = 'runScheduledImport';
const MC_NOTIFICATION_STATE_KEY = 'MYCOUPONS_NOTIFICATION_STATE';
const MC_NOTIFICATION_STATE_VERSION = 1;

function installDailyImportTrigger() {
  const c = config_();
  assertOwner_(c);
  const triggers = ownedImportTriggers_();
  if (triggers.length > 1) fail_('RESOURCE');
  if (triggers.length === 1) return {created: false, trigger: triggers[0]};
  const trigger = ScriptApp.newTrigger(MC_SCHEDULED_HANDLER).timeBased().atHour(8)
    .everyDays(1).inTimezone(c.timeZone).create();
  if (!trigger || trigger.getHandlerFunction() !== MC_SCHEDULED_HANDLER) fail_('RESOURCE');
  return {created: true, trigger: trigger};
}

function removeDailyImportTrigger() {
  const triggers = ownedImportTriggers_();
  if (triggers.length > 1) fail_('RESOURCE');
  if (!triggers.length) return {removed: false};
  ScriptApp.deleteTrigger(triggers[0]);
  return {removed: true};
}

function ownedImportTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger && trigger.getHandlerFunction() === MC_SCHEDULED_HANDLER &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK;
  });
}

function runScheduledImport() {
  let summary;
  try {
    const state = ensureSheetState_();
    summary = withLock_(function () {
      const before = readMessageJournal_(state.journalSheet);
      const result = runImportWorkflow_(state);
      return scheduledSummary_(state, before, result);
    });
  } catch (e) {
    summary = {imported: 0, review: 0, errors: [{code: errorCode_(e)}], links: []};
  }
  try { notifyScheduledImport_(summary); } catch (e) { /* notification is best effort */ }
  return summary;
}

function scheduledSummary_(state, before, result) {
  const after = readMessageJournal_(state.journalSheet);
  const links = [];
  let review = 0;
  (result.messages || []).forEach(function (message) {
    if (message.status !== 'review' || before[message.messageId]) return;
    review += message.rows.length;
    message.rows.forEach(function (row) { links.push(reviewLink_(state, row)); });
    const source = gmailLink_(message.messageId);
    if (sourceId_(source) !== message.messageId) fail_('STATE');
    links.push(source);
  });
  const errors = (result.errors || []).map(function (error) { return {code: String(error.code || 'INTERNAL')}; });
  Object.keys(after).forEach(function (messageId) {
    if (!before[messageId] && after[messageId].status === 'failed') errors.push({code: after[messageId].lastError || 'INTERNAL'});
  });
  (result.messages || []).forEach(function (message) {
    if (message.status === 'failed' && message.error) errors.push({code: String(message.error)});
  });
  const uniqueErrors = [];
  errors.forEach(function (error) {
    if (!uniqueErrors.some(function (item) { return item.code === error.code; })) uniqueErrors.push(error);
  });
  return {imported: Number(result.imported) || 0, review: review, errors: uniqueErrors, links: links};
}

function reviewLink_(state, row) {
  if (!state || !state.spreadsheet || typeof state.spreadsheet.getId !== 'function' ||
      !state.couponSheet || typeof state.couponSheet.getSheetId !== 'function' ||
      !Number.isInteger(row) || row < 2) fail_('STATE');
  const id = String(state.spreadsheet.getId());
  const gid = state.couponSheet.getSheetId();
  if (!/^[\w-]+$/.test(id) || !Number.isInteger(gid) || gid < 0) fail_('STATE');
  return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit#gid=' + gid + '&range=A' + row;
}

function validNotificationState_(state) {
  return state && typeof state === 'object' && !Array.isArray(state) &&
    state.version === MC_NOTIFICATION_STATE_VERSION && typeof state.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(state.fingerprint) && typeof state.notifiedAt === 'string' &&
    !isNaN(Date.parse(state.notifiedAt));
}

function notificationState_() {
  const raw = props_().getProperty(MC_NOTIFICATION_STATE_KEY);
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch (e) { fail_('STATE'); }
  if (!validNotificationState_(state)) fail_('STATE');
  return state;
}

function notifyScheduledImport_(summary) {
  const c = config_();
  if (!summary || !Number.isSafeInteger(summary.imported) || summary.imported < 0 ||
      !Number.isSafeInteger(summary.review) || summary.review < 0 || !Array.isArray(summary.errors) ||
      !Array.isArray(summary.links)) fail_('STATE');
  const meaningful = summary.imported > 0 || summary.review > 0 || summary.errors.length > 0;
  if (!meaningful) return {sent: false};
  const links = summary.links.filter(validNotificationLink_);
  if (links.length !== summary.links.length) fail_('STATE');
  const payload = {imported: summary.imported, review: summary.review,
    errors: summary.errors.map(function (error) { return String(error.code); }).sort(), links: links.sort()};
  const fingerprint = digest_(JSON.stringify(payload));
  const previous = notificationState_();
  if (previous && previous.fingerprint === fingerprint) return {sent: false};
  const body = boundedText_(t_('summaryBody', {imported: summary.imported, review: summary.review,
    errors: summary.errors.length, links: links.length ? '\n' + links.join('\n') : ''}), 4000);
  MailApp.sendEmail(c.ownerEmail, EN.summarySubject, body);
  const notifiedAt = new Date().toISOString();
  props_().setProperty(MC_NOTIFICATION_STATE_KEY, JSON.stringify({version: MC_NOTIFICATION_STATE_VERSION,
    fingerprint: fingerprint, notifiedAt: notifiedAt}));
  return {sent: true, fingerprint: fingerprint, notifiedAt: notifiedAt};
}

function validNotificationLink_(link) {
  return typeof link === 'string' && /^https:\/\/(?:docs\.google\.com\/spreadsheets\/d\/|mail\.google\.com\/mail\/u\/0\/)/.test(link);
}
