const MC_SCHEDULED_HANDLER = 'runScheduledImport';
const MC_NOTIFICATION_STATE_KEY = 'MYCOUPONS_NOTIFICATION_STATE';
const MC_PENDING_NOTIFICATION_KEY = 'MYCOUPONS_PENDING_NOTIFICATION';
const MC_TRIGGER_ID_KEY = 'MYCOUPONS_TRIGGER_ID';
const MC_NOTIFICATION_STATE_VERSION = 1;

function installDailyImportTrigger() {
  return withLock_(function () {
    const c = config_();
    assertOwner_(c);
    const triggers = ownedImportTriggers_();
    if (triggers.length > 1) fail_('RESOURCE');
    if (triggers.length === 1) return {created: false, trigger: triggers[0]};
    const trigger = ScriptApp.newTrigger(MC_SCHEDULED_HANDLER).timeBased().atHour(8)
      .everyDays(1).inTimezone(c.timeZone).create();
    if (!trigger || trigger.getHandlerFunction() !== MC_SCHEDULED_HANDLER || typeof trigger.getUniqueId !== 'function') fail_('RESOURCE');
    props_().setProperty(MC_TRIGGER_ID_KEY, String(trigger.getUniqueId()));
    return {created: true, trigger: trigger};
  });
}

function removeDailyImportTrigger() {
  return withLock_(function () {
    const triggers = ownedImportTriggers_();
    if (triggers.length > 1) fail_('RESOURCE');
    if (!triggers.length) { props_().deleteProperty(MC_TRIGGER_ID_KEY); return {removed: false}; }
    ScriptApp.deleteTrigger(triggers[0]);
    props_().deleteProperty(MC_TRIGGER_ID_KEY);
    return {removed: true};
  });
}

function ownedImportTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger && trigger.getHandlerFunction() === MC_SCHEDULED_HANDLER &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK;
  });
  const id = props_().getProperty(MC_TRIGGER_ID_KEY);
  if (id && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail_('STATE');
  if (!id) return triggers.length ? fail_('RESOURCE') : [];
  return triggers.filter(function (trigger) {
    return typeof trigger.getUniqueId === 'function' && String(trigger.getUniqueId()) === id;
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
    if (message.status !== 'review') return;
    const priorRows = before[message.messageId] && before[message.messageId].rowNumbers || [];
    const newRows = message.rows.filter(function (row) { return priorRows.indexOf(row) < 0; });
    if (!newRows.length) return;
    review += newRows.length;
    newRows.forEach(function (row) { links.push(reviewLink_(state, row)); });
    const source = gmailLink_(message.messageId);
    if (sourceId_(source) !== message.messageId) fail_('STATE');
    links.push(source);
  });
  const errors = (result.errors || []).map(function (error) { return {messageId: String(error.messageId || ''), code: String(error.code || 'INTERNAL')}; });
  Object.keys(after).forEach(function (messageId) {
    if (after[messageId].status === 'failed' && (!before[messageId] || before[messageId].lastError !== after[messageId].lastError)) errors.push({messageId: messageId, code: after[messageId].lastError || 'INTERNAL'});
  });
  (result.messages || []).forEach(function (message) {
    if (message.status === 'failed' && message.error) errors.push({messageId: message.messageId, code: String(message.error)});
  });
  const uniqueErrors = [];
  errors.forEach(function (error) {
    if (!uniqueErrors.some(function (item) { return item.messageId === error.messageId && item.code === error.code; })) uniqueErrors.push(error);
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
  if (!validNotificationState_(state)) { props_().deleteProperty(MC_NOTIFICATION_STATE_KEY); return null; }
  return state;
}

function pendingNotification_() {
  const raw = props_().getProperty(MC_PENDING_NOTIFICATION_KEY);
  if (!raw) return null;
  let summary;
  try { summary = JSON.parse(raw); } catch (e) { props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY); return null; }
  if (!summary || !Number.isSafeInteger(summary.imported) || summary.imported < 0 || !Number.isSafeInteger(summary.review) || summary.review < 0 || !Array.isArray(summary.errors) || !Array.isArray(summary.links)) { props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY); return null; }
  return summary;
}

function mergeNotificationSummaries_(left, right) {
  return {imported: left.imported + right.imported, review: left.review + right.review,
    errors: (left.errors || []).concat(right.errors || []), links: (left.links || []).concat(right.links || [])};
}

function notifyScheduledImport_(summary) {
  const c = config_();
  if (!summary || !Number.isSafeInteger(summary.imported) || summary.imported < 0 ||
      !Number.isSafeInteger(summary.review) || summary.review < 0 || !Array.isArray(summary.errors) ||
      !Array.isArray(summary.links)) fail_('STATE');
  const pending = pendingNotification_();
  if (pending) summary = mergeNotificationSummaries_(pending, summary);
  const meaningful = summary.imported > 0 || summary.review > 0 || summary.errors.length > 0;
  if (!meaningful) return {sent: false};
  const links = summary.links.filter(validNotificationLink_);
  if (links.length !== summary.links.length) fail_('STATE');
  const payload = {imported: summary.imported, review: summary.review,
    errors: summary.errors.map(function (error) { return {messageId: String(error.messageId || ''), code: String(error.code)}; }).sort(function (a, b) { return (a.messageId + a.code).localeCompare(b.messageId + b.code); }), links: links.sort()};
  const fingerprint = digest_(JSON.stringify(payload));
  const previous = notificationState_();
  if (previous && previous.fingerprint === fingerprint) return {sent: false};
  props_().setProperty(MC_PENDING_NOTIFICATION_KEY, JSON.stringify(summary));
  const body = boundedText_(t_('summaryBody', {imported: summary.imported, review: summary.review,
    errors: summary.errors.length, links: links.length ? '\n' + links.join('\n') : ''}), 4000);
  MailApp.sendEmail(c.ownerEmail, EN.summarySubject, body);
  const notifiedAt = new Date().toISOString();
  props_().setProperty(MC_NOTIFICATION_STATE_KEY, JSON.stringify({version: MC_NOTIFICATION_STATE_VERSION,
    fingerprint: fingerprint, notifiedAt: notifiedAt}));
  props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY);
  return {sent: true, fingerprint: fingerprint, notifiedAt: notifiedAt};
}

function validNotificationLink_(link) {
  return typeof link === 'string' && /^https:\/\/(?:docs\.google\.com\/spreadsheets\/d\/|mail\.google\.com\/mail\/u\/0\/)/.test(link);
}
