const MC_SCHEDULED_HANDLER = 'runScheduledImport';
const MC_NOTIFICATION_STATE_KEY = 'MYCOUPONS_NOTIFICATION_STATE';
const MC_PENDING_NOTIFICATION_KEY = 'MYCOUPONS_PENDING_NOTIFICATION';
const MC_TRIGGER_ID_KEY = 'MYCOUPONS_TRIGGER_ID';
const MC_NOTIFICATION_STATE_VERSION = 1;
const MC_CONTINUATION_HANDLER = 'runMailboxContinuation';
const MC_CONTINUATION_KEY = 'MYCOUPONS_MAILBOX_CONTINUATION';
// Reserve at most fifteen four-minute execution slots per rolling 24 hours.
// Keep headroom for notifications and the user's other Apps Script work.
const MC_CONTINUATION_MAX_RUNS = 15;

function mailboxContinuation_(config) {
  const raw = props_().getProperty(MC_CONTINUATION_KEY);
  let record = null;
  if (raw) {
    try { record = JSON.parse(raw); } catch (e) { fail_('STATE'); }
    if (!recordWithExactKeys_(record, ['version', 'ownerEmail', 'installationId', 'triggerId', 'budgetStartMs', 'runs']) ||
        record.version !== 1 || typeof record.installationId !== 'string' || !/^[a-f0-9]{64}$/.test(record.installationId) ||
        typeof record.ownerEmail !== 'string' || record.ownerEmail !== String(Session.getEffectiveUser().getEmail()).toLowerCase() ||
        typeof record.triggerId !== 'string' || !/^[A-Za-z0-9_-]{0,200}$/.test(record.triggerId) ||
        !Number.isSafeInteger(record.budgetStartMs) || record.budgetStartMs < 0 ||
        !Number.isSafeInteger(record.runs) || record.runs < 0 || record.runs > MC_CONTINUATION_MAX_RUNS) fail_('STATE');
    if (config && record.installationId !== mailboxInstallationId_(config)) fail_('RESOURCE');
  }
  const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger && trigger.getHandlerFunction() === MC_CONTINUATION_HANDLER &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK;
  });
  if (triggers.length > 1) fail_('RESOURCE');
  if (triggers.length && (!record || !record.triggerId)) {
    fail_('RESOURCE');
  } else if (triggers.length && (typeof triggers[0].getUniqueId !== 'function' ||
      String(triggers[0].getUniqueId()) !== record.triggerId)) fail_('RESOURCE');
  return {record: record, trigger: triggers[0] || null};
}

function stopMailboxContinuation_(owned) {
  if (owned.trigger) ScriptApp.deleteTrigger(owned.trigger);
  if (owned.record) {
    owned.record.triggerId = '';
    props_().setProperty(MC_CONTINUATION_KEY, JSON.stringify(owned.record));
  }
}

function beginMailboxContinuation_(config, event) {
  const owned = mailboxContinuation_(config);
  if (event && (!owned.trigger || !owned.record || typeof event.triggerUid !== 'string' ||
      event.triggerUid !== owned.record.triggerId)) fail_('RESOURCE');
  let record = owned.record || {version: 1, ownerEmail: config.ownerEmail, installationId: mailboxInstallationId_(config), triggerId: '',
    budgetStartMs: Date.now(), runs: 0};
  if (Date.now() >= record.budgetStartMs + 86400000) {
    record.budgetStartMs = Date.now(); record.runs = 0;
  }
  if (record.runs >= MC_CONTINUATION_MAX_RUNS) { stopMailboxContinuation_(owned); return false; }
  record.runs++;
  // Reserve the execution even if it terminates abruptly, and persist creation
  // intent before the provider mutation. Unknown orphan triggers are never adopted.
  if (!owned.trigger) record.triggerId = '';
  props_().setProperty(MC_CONTINUATION_KEY, JSON.stringify(record));
  if (owned.trigger) return true;
  let trigger;
  try {
    trigger = ScriptApp.newTrigger(MC_CONTINUATION_HANDLER).timeBased().everyMinutes(5).create();
    if (!trigger || trigger.getHandlerFunction() !== MC_CONTINUATION_HANDLER ||
        trigger.getEventType() !== ScriptApp.EventType.CLOCK || typeof trigger.getUniqueId !== 'function' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(String(trigger.getUniqueId()))) fail_('RESOURCE');
    record.triggerId = String(trigger.getUniqueId());
    props_().setProperty(MC_CONTINUATION_KEY, JSON.stringify(record));
    return true;
  } catch (e) {
    if (trigger) { try { ScriptApp.deleteTrigger(trigger); } catch (ignored) {} }
    throw e;
  }
}

function runMailboxContinuation(event) {
  // A direct call or an event for a removed/replaced trigger has no authority.
  if (!event || typeof event.triggerUid !== 'string') fail_('RESOURCE');
  return runMailboxScheduledImport_(event);
}

function installDailyImportTrigger() {
  return withLock_(function () {
    const c = config_();
    assertOwner_(c);
    const triggers = ownedImportTriggers_();
    if (triggers.length > 1) fail_('RESOURCE');
    if (triggers.length === 1) return {created: false, trigger: triggers[0]};
    let trigger;
    try {
      trigger = ScriptApp.newTrigger(MC_SCHEDULED_HANDLER).timeBased().atHour(8)
        .everyDays(1).inTimezone(c.timeZone).create();
      if (!trigger || trigger.getHandlerFunction() !== MC_SCHEDULED_HANDLER || typeof trigger.getUniqueId !== 'function') fail_('RESOURCE');
      props_().setProperty(MC_TRIGGER_ID_KEY, String(trigger.getUniqueId()));
      return {created: true, trigger: trigger};
    } catch (e) {
      if (trigger) {
        try { ScriptApp.deleteTrigger(trigger); } catch (ignored) {}
      }
      throw e;
    }
  });
}

function removeDailyImportTrigger() {
  return withLock_(function () {
    const raw = props_().getProperty(MC.configKey);
    if (raw) assertOwner_(config_());
    else if (String(Gmail.Users.getProfile('me').emailAddress).toLowerCase() !==
      String(Session.getEffectiveUser().getEmail()).toLowerCase()) fail_('OWNER');
    const triggers = raw ? ownedImportTriggers_(true) : ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger && trigger.getHandlerFunction() === MC_SCHEDULED_HANDLER &&
        trigger.getEventType() === ScriptApp.EventType.CLOCK;
    });
    if (triggers.length > 1) fail_('RESOURCE');
    const continuation = mailboxContinuation_(raw ? config_() : null);
    stopMailboxContinuation_(continuation);
    if (!triggers.length) { props_().deleteProperty(MC_TRIGGER_ID_KEY); return {removed: false}; }
    ScriptApp.deleteTrigger(triggers[0]);
    props_().deleteProperty(MC_TRIGGER_ID_KEY);
    return {removed: true};
  });
}

function ownedImportTriggers_(allowMissingIdRecovery) {
  const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger && trigger.getHandlerFunction() === MC_SCHEDULED_HANDLER &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK;
  });
  const id = props_().getProperty(MC_TRIGGER_ID_KEY);
  if (id && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail_('STATE');
  if (!id) {
    if (!triggers.length) return [];
    if (allowMissingIdRecovery && triggers.length === 1) return triggers;
    fail_('RESOURCE');
  }
  if (!triggers.length) {
    return [];
  }
  if (triggers.length !== 1 || typeof triggers[0].getUniqueId !== 'function' ||
      String(triggers[0].getUniqueId()) !== id) fail_('RESOURCE');
  return triggers;
}

function runScheduledImport() {
  return runMailboxScheduledImport_(null);
}

function runMailboxScheduledImport_(event) {
  let summary;
  let authorized = false;
  const deadlineMs = Date.now() + MC.maxRuntimeMs - 15000;
  try {
    summary = withLock_(function () {
      const config = config_();
      assertOwner_(config);
      if (mailboxDeadlineReached_(deadlineMs)) fail_('BUSY');
      assertPrivateSpreadsheet_(openSpreadsheetById_(config.spreadsheetId), config);
      if (!beginMailboxContinuation_(config, event)) {
        return {imported: 0, importedIds: [], review: 0, errors: [], links: [], omittedLinks: false};
      }
      authorized = true;
      const state = ensureSheetState_(config, deadlineMs);
      state._deadlineMs = deadlineMs;
      const before = readMessageJournal_(state.journalSheet);
      const result = runImportWorkflow_(state);
      const outcome = scheduledSummary_(state, before, result);
      // Cleanup failures must not erase rows/links already collected this run.
      try {
        const scan = JSON.parse(props_().getProperty(MC_MAILBOX_SCAN_STATE_KEY));
        if (!validMailboxScanState_(scan) || scan.installationId !== mailboxInstallationId_(config)) fail_('STATE');
        const continuation = mailboxContinuation_(config);
        if (scan.complete || continuation.record.runs >= MC_CONTINUATION_MAX_RUNS) stopMailboxContinuation_(continuation);
      } catch (e) { outcome.errors.push({messageId: '', code: errorCode_(e)}); }
      return outcome;
    }, deadlineMs);
  } catch (e) {
    summary = {imported: 0, importedIds: [], review: 0, errors: [{messageId: '', code: errorCode_(e)}], links: [], omittedLinks: false};
  }
  if (!authorized) return summary;
  try { withLock_(function () { notifyScheduledImport_(summary); }, deadlineMs); } catch (e) {
    if (e && e.code === 'BUSY') persistPendingNotification_(summary);
  }
  return summary;
}

function scheduledSummary_(state, before, result) {
  const after = readMessageJournal_(state.journalSheet);
  const links = [];
  let review = 0;
  (result.messages || []).forEach(function (message) {
    if (message.status !== 'review') return;
    const prior = before[message.messageId];
    const priorRows = prior && prior.rowNumbers || [];
    const recovered = prior && prior.status === 'failed';
    const newRows = message.rows.filter(function (row) { return recovered || priorRows.indexOf(row) < 0; });
    if (!newRows.length) return;
    review += newRows.length;
    newRows.forEach(function (row) { links.push(reviewLink_(state, row)); });
    const source = gmailLink_(message.messageId);
    if (sourceId_(source) !== message.messageId) fail_('STATE');
    links.push(source);
  });
  const errors = (result.errors || []).map(function (error) { return {messageId: String(error.messageId || ''), code: String(error.code || 'INTERNAL')}; });
  Object.keys(after).forEach(function (messageId) {
    if (after[messageId].status === 'failed' && after[messageId].lastError &&
      (!before[messageId] || before[messageId].lastError !== after[messageId].lastError)) errors.push({messageId: messageId, code: after[messageId].lastError});
  });
  (result.messages || []).forEach(function (message) {
    if (message.status === 'failed' && message.error &&
        (!before[message.messageId] || before[message.messageId].lastError !== message.error)) {
      errors.push({messageId: message.messageId, code: String(message.error)});
    }
  });
  const uniqueErrors = [];
  errors.forEach(function (error) {
    if (!uniqueErrors.some(function (item) { return item.messageId === error.messageId && item.code === error.code; })) uniqueErrors.push(error);
  });
  const importedIds = (result.messages || []).filter(function (message) { return message.status === 'confirmed'; })
    .map(function (message) { return String(message.messageId); }).sort();
  return {imported: Number(result.imported) || 0, importedIds: importedIds, review: review, errors: uniqueErrors, links: links, omittedLinks: false};
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
  try { state = JSON.parse(raw); } catch (e) { props_().deleteProperty(MC_NOTIFICATION_STATE_KEY); return null; }
  if (!validNotificationState_(state)) { props_().deleteProperty(MC_NOTIFICATION_STATE_KEY); return null; }
  return state;
}

function pendingNotification_() {
  const raw = props_().getProperty(MC_PENDING_NOTIFICATION_KEY);
  if (!raw) return null;
  let summary;
  try { summary = JSON.parse(raw); } catch (e) { props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY); return null; }
  if (!summary || !Number.isSafeInteger(summary.imported) || summary.imported < 0 || typeof summary.omittedLinks !== 'boolean' || !Array.isArray(summary.importedIds) ||
      !summary.importedIds.every(validGmailApiId_) || !Number.isSafeInteger(summary.review) || summary.review < 0 ||
      !Array.isArray(summary.errors) || !summary.errors.every(validNotificationError_) || !Array.isArray(summary.links) ||
      !summary.links.every(validNotificationLink_)) { props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY); return null; }
  return summary;
}

function mergeNotificationSummaries_(left, right) {
  const importedIds = (left.importedIds || []).concat(right.importedIds || []).filter(function (id, index, all) { return all.indexOf(id) === index; });
  const errors = (left.errors || []).concat(right.errors || []).filter(function (error, index, all) {
    return all.findIndex(function (item) { return item.messageId === error.messageId && item.code === error.code; }) === index;
  });
  const links = (left.links || []).concat(right.links || []).filter(function (link, index, all) { return all.indexOf(link) === index; });
  return {imported: left.imported + right.imported, importedIds: importedIds, review: left.review + right.review, errors: errors, links: links, omittedLinks: !!left.omittedLinks || !!right.omittedLinks};
}

function validNotificationError_(error) {
  return error && typeof error === 'object' && typeof error.messageId === 'string' &&
    (!error.messageId || validGmailApiId_(error.messageId)) && typeof error.code === 'string' && !!error.code;
}

function notifyScheduledImport_(summary) {
  const c = config_();
  if (!summary || !Number.isSafeInteger(summary.imported) || summary.imported < 0 || typeof summary.omittedLinks !== 'boolean' || !Array.isArray(summary.importedIds) ||
      !summary.importedIds.every(validGmailApiId_) || !Number.isSafeInteger(summary.review) || summary.review < 0 ||
      !Array.isArray(summary.errors) || !summary.errors.every(validNotificationError_) || !Array.isArray(summary.links)) fail_('STATE');
  let pending = pendingNotification_();
  const storedFingerprint = pending && pending.fingerprint;
  if (pending && storedFingerprint && notificationState_() && storedFingerprint === notificationState_().fingerprint) {
    props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY);
    pending = null;
  }
  if (pending) summary = mergeNotificationSummaries_(pending, summary);
  const meaningful = summary.imported > 0 || summary.review > 0 || summary.errors.length > 0;
  if (!meaningful) { props_().deleteProperty(MC_NOTIFICATION_STATE_KEY); props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY); return {sent: false}; }
  const links = summary.links.filter(validNotificationLink_);
  if (links.length !== summary.links.length) fail_('STATE');
  const boundedLinks = [];
  for (let index = 0; index < links.length; index++) {
    const candidate = boundedLinks.concat([links[index]]);
    if (JSON.stringify({imported: summary.imported, importedIds: summary.importedIds, review: summary.review, errors: summary.errors, links: candidate}).length > 8000) break;
    boundedLinks.push(links[index]);
  }
  const omittedLinks = summary.omittedLinks || boundedLinks.length !== links.length;
  const payload = {imported: summary.imported, importedIds: summary.importedIds.sort(), review: summary.review,
    errors: summary.errors.map(function (error) { return {messageId: String(error.messageId || ''), code: String(error.code)}; }).sort(function (a, b) { return (a.messageId + a.code).localeCompare(b.messageId + b.code); }), links: boundedLinks.sort()};
  const fingerprint = digest_(JSON.stringify(payload));
  const previous = notificationState_();
  if (previous && previous.fingerprint === fingerprint) { props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY); return {sent: false}; }
  const pendingSummary = {imported: summary.imported, importedIds: summary.importedIds, review: summary.review, errors: summary.errors, links: boundedLinks, omittedLinks: omittedLinks, fingerprint: fingerprint};
  const pendingJson = JSON.stringify(pendingSummary);
  if (pendingJson.length > 8000) fail_('LIMIT');
  props_().setProperty(MC_PENDING_NOTIFICATION_KEY, pendingJson);
  const body = boundedText_(t_('summaryBody', {imported: summary.imported, review: summary.review,
    errors: summary.errors.length, links: boundedLinks.length ? '\n' + boundedLinks.join('\n') + (omittedLinks ? '\nAdditional links omitted; open the review sheet for the complete list.' : '') : ''}), 4000);
  MailApp.sendEmail(c.ownerEmail, EN.summarySubject, body);
  const notifiedAt = new Date().toISOString();
  props_().setProperty(MC_NOTIFICATION_STATE_KEY, JSON.stringify({version: MC_NOTIFICATION_STATE_VERSION,
    fingerprint: fingerprint, notifiedAt: notifiedAt}));
  props_().deleteProperty(MC_PENDING_NOTIFICATION_KEY);
  return {sent: true, fingerprint: fingerprint, notifiedAt: notifiedAt};
}

function persistPendingNotification_(summary) {
  if (!summary || !Array.isArray(summary.errors)) return;
  const existing = pendingNotification_();
  if (existing) summary = mergeNotificationSummaries_(existing, summary);
  const pending = {imported: Number(summary.imported) || 0, importedIds: summary.importedIds || [], review: Number(summary.review) || 0,
    errors: summary.errors, links: summary.links || [], omittedLinks: !!summary.omittedLinks};
  const value = JSON.stringify(pending);
  if (value.length <= 8000) props_().setProperty(MC_PENDING_NOTIFICATION_KEY, value);
}

function validNotificationLink_(link) {
  if (typeof link !== 'string') return false;
  if (/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/edit#gid=\d+&range=A\d+$/.test(link)) return true;
  return /^https:\/\/mail\.google\.com\/mail\/u\/0\//.test(link) && !!sourceId_(link);
}
