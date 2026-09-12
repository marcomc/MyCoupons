const MC_GMAIL_PAGE_SIZE = 50;
const MC_GMAIL_MAX_PAGES = 20;
const MC_GMAIL_MAX_MESSAGES_PER_RUN = 50;
const MC_MAILBOX_SCAN_STATE_KEY = 'MYCOUPONS_MAILBOX_SCAN_STATE';
const MC_MAILBOX_SCAN_STATE_VERSION = 1;
const MC_FINAL_MESSAGE_STATES = Object.freeze(['confirmed', 'ignored']);

function mailboxScanState_(recoveryStart, nowMs, installationId) {
  if (!Number.isSafeInteger(recoveryStart) || recoveryStart < 0 ||
    !Number.isSafeInteger(nowMs) || nowMs < recoveryStart) fail_('STATE');
  return {version: MC_MAILBOX_SCAN_STATE_VERSION, startMs: recoveryStart, endMs: nowMs,
    installationId: installationId || '', pageToken: '', pendingNextPageToken: '', pendingIds: [], retryCursor: '', complete: false};
}

function validMailboxScanState_(value) {
  return recordWithExactKeys_(value, ['version', 'startMs', 'endMs', 'installationId', 'pageToken',
    'pendingNextPageToken', 'pendingIds', 'retryCursor', 'complete']) &&
    value.version === MC_MAILBOX_SCAN_STATE_VERSION && Number.isSafeInteger(value.startMs) && value.startMs >= 0 &&
    Number.isSafeInteger(value.endMs) && value.endMs >= value.startMs &&
    typeof value.installationId === 'string' && value.installationId.length <= 200 && mailboxPageToken_(value.pageToken) && mailboxPageToken_(value.pendingNextPageToken) &&
    mailboxMessageIds_(value.pendingIds) && typeof value.retryCursor === 'string' &&
    (!value.retryCursor || validGmailApiId_(value.retryCursor)) &&
    typeof value.complete === 'boolean' && (!value.complete ||
      (!value.pageToken && !value.pendingNextPageToken && !value.pendingIds.length));
}

function mailboxPageToken_(value) { return typeof value === 'string' && value.length <= 1000; }
function mailboxMessageIds_(value) {
  return Array.isArray(value) && value.length <= MC_GMAIL_PAGE_SIZE && value.every(validGmailApiId_) &&
    new Set(value).size === value.length;
}
function loadMailboxScanState_(recoveryStart, installationId) {
  if (!Number.isSafeInteger(recoveryStart) || recoveryStart < 0) fail_('STATE');
  const raw = props_().getProperty(MC_MAILBOX_SCAN_STATE_KEY);
  if (!raw) {
    const initial = mailboxScanState_(recoveryStart, Date.now(), installationId);
    saveMailboxScanState_(initial);
    return initial;
  }
  let state;
  try { state = JSON.parse(raw); } catch (e) { fail_('STATE'); }
  if (!validMailboxScanState_(state)) fail_('STATE');
  if (state.installationId !== (installationId || '')) {
    state = mailboxScanState_(recoveryStart, Date.now(), installationId);
    saveMailboxScanState_(state);
    return state;
  }
  if (state.complete) {
    const previousRetryCursor = state.retryCursor;
    state = mailboxScanState_(state.endMs, Date.now(), installationId);
    state.retryCursor = previousRetryCursor;
    saveMailboxScanState_(state);
  }
  return state;
}

function saveMailboxScanState_(state) {
  if (!validMailboxScanState_(state)) fail_('STATE');
  props_().setProperty(MC_MAILBOX_SCAN_STATE_KEY, JSON.stringify(state));
}

function completeMailboxScanState_(scan) {
  scan.pageToken = ''; scan.pendingNextPageToken = ''; scan.pendingIds = []; scan.complete = true;
  saveMailboxScanState_(scan);
}

function mailboxQuery_(scan) {
  // Gmail date strings are PST-defined. Epoch seconds plus an exact internalDate
  // filter below keep the frozen Europe/Rome recovery boundary authoritative.
  return 'after:' + (Math.floor(scan.startMs / 1000) - 1) + ' before:' + (Math.floor(scan.endMs / 1000) + 1);
}

function mailboxDeadlineReached_(deadlineMs) { return !!deadlineMs && Date.now() >= deadlineMs; }

function readCouponMessages_(state, onMessage, accumulator) {
  if (!state || typeof state !== 'object' || !state.journalSheet ||
    !Number.isSafeInteger(state.recoveryStart) || state.recoveryStart < 0) fail_('STATE');
  return scanCouponMessages_(state, onMessage || function () {}, accumulator);
}

function scanCouponMessages_(state, onMessage, accumulator) {
  return withMessageJournal_(state.journalSheet, function () {
    return scanCouponMessagesInSession_(state, onMessage, accumulator);
  });
}

function scanCouponMessagesInSession_(state, onMessage, accumulator) {
  if (typeof onMessage !== 'function') fail_('STATE');
  const result = accumulator || {messages: [], errors: [], truncated: false};
  let scan = loadMailboxScanState_(state.recoveryStart, state.config && mailboxInstallationId_(state.config));
  let remaining = MC_GMAIL_MAX_MESSAGES_PER_RUN;
  let pages = 0;
  const seenPageTokens = Object.create(null);

  // Failed/abandoned records stay reachable even after their original window has
  // completed. They are retried before new listing, but bounded so they cannot starve it.
  const journalSnapshot = readMessageJournal_(state.journalSheet);
  const retryCandidates = Object.keys(journalSnapshot).filter(function (id) {
    const journal = journalSnapshot[id];
    return journal && (journal.status === 'pending' && /^read\|\d+\|\d+$/.test(journal.failureStage || '') || journal.status === 'processing' ||
      journal.status === 'failed' && /^read\|\d+\|\d+$/.test(journal.failureStage || '') ||
      journal.status === 'failed' && journal.failureStage !== 'read' && !!journal.failureStage) &&
      scan.pendingIds.indexOf(id) < 0 && validGmailApiId_(id);
  }).sort();
  const afterCursor = retryCandidates.findIndex(function (id) { return id > scan.retryCursor; });
  const retryStart = afterCursor < 0 ? 0 : afterCursor;
  const retries = retryCandidates.slice(0, Math.min(3, remaining)).map(function (_, index) {
    return retryCandidates[(retryStart + index) % retryCandidates.length];
  });
  for (let index = 0; index < retries.length; index++) {
    if (mailboxDeadlineReached_(state._deadlineMs)) { result.truncated = true; return result; }
    const retryJournal = journalSnapshot[retries[index]];
    const retryWindow = mailboxRetryWindow_(scan, retryJournal);
    mailboxProcessMessage_(state, retryWindow, retries[index], !!retryWindow._retryWindow, onMessage, result);
    scan.retryCursor = retries[index]; saveMailboxScanState_(scan);
    remaining--;
  }

  while (remaining > 0) {
    if (mailboxDeadlineReached_(state._deadlineMs)) { result.truncated = true; return result; }
    if (scan.pendingIds.length) {
      const id = scan.pendingIds[0];
      if (!mailboxProcessMessage_(state, scan, id, true, onMessage, result)) {
        result.truncated = true;
        return result;
      }
      remaining--;
      if (mailboxDeadlineReached_(state._deadlineMs)) { result.truncated = true; return result; }
      scan.pendingIds.shift();
      saveMailboxScanState_(scan);
      if (scan.pendingIds.length) continue;
      scan.pageToken = scan.pendingNextPageToken;
      scan.pendingNextPageToken = '';
      saveMailboxScanState_(scan);
      if (!scan.pageToken) { completeMailboxScanState_(scan); return result; }
      continue;
    }
    if (pages++ >= MC_GMAIL_MAX_PAGES) { result.truncated = true; return result; }
    const listed = mailboxListPage_(scan, state._deadlineMs);
    if (mailboxDeadlineReached_(state._deadlineMs)) { result.truncated = true; return result; }
    const page = listed.page;
    const ids = (page.messages || []).map(function (summary) { return summary.id; });
    const next = page.nextPageToken || '';
    if (listed.restarted) {
      scan.pageToken = ''; scan.pendingNextPageToken = '';
      Object.keys(seenPageTokens).forEach(function (token) { delete seenPageTokens[token]; });
    }
    if (!mailboxPageToken_(next) || next &&
      (next === scan.pageToken || seenPageTokens[next])) fail_('MAIL');
    scan.pendingIds = ids;
    scan.pendingNextPageToken = next;
    if (scan.pageToken) seenPageTokens[scan.pageToken] = true;
    saveMailboxScanState_(scan); // Persist discovered work before fetch/image processing.
    if (!ids.length) {
      scan.pageToken = next; scan.pendingNextPageToken = '';
      saveMailboxScanState_(scan);
      if (!scan.pageToken) { completeMailboxScanState_(scan); return result; }
    }
  }
  result.truncated = true;
  return result;
}

function mailboxInstallationId_(config) {
  return digest_(JSON.stringify([config.ownerEmail.toLowerCase(), config.spreadsheetId, config.sheetName, config.initialDate, config.timeZone]));
}

function mailboxListPage_(scan, deadlineMs) {
  const response = mailboxListRequest_(scan, scan.pageToken);
  if (response.code === 200) return {page: validatedMailboxPage_(response.body), restarted: false};
  // The Advanced service does not promise a structured HTTP status on its
  // exception. Use REST, and prove token-specific rejection by a successful
  // identical query without that token; no localized error-string matching.
  if (response.code !== 400 || !scan.pageToken || !response.body || !response.body.error ||
      response.body.error.code !== 400 || typeof response.body.error.message !== 'string' ||
      mailboxDeadlineReached_(deadlineMs)) fail_('MAIL');
  const probe = mailboxListRequest_(scan, '');
  if (probe.code !== 200) fail_('MAIL');
  const page = validatedMailboxPage_(probe.body);
  if (page.nextPageToken === scan.pageToken) fail_('MAIL');
  return {page: page, restarted: true};
}

function mailboxListRequest_(scan, token) {
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + MC_GMAIL_PAGE_SIZE +
    '&q=' + encodeURIComponent(mailboxQuery_(scan)) + (token ? '&pageToken=' + encodeURIComponent(token) : '');
  try {
    const response = UrlFetchApp.fetch(url, {method: 'get', followRedirects: false, muteHttpExceptions: true,
      headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()}});
    return {code: response.getResponseCode(), body: JSON.parse(response.getContentText())};
  } catch (e) { fail_('MAIL'); }
}

function validatedMailboxPage_(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page) || page.error !== undefined ||
      Object.keys(page).some(function (key) { return ['messages', 'nextPageToken', 'resultSizeEstimate'].indexOf(key) < 0; }) ||
      page.resultSizeEstimate !== undefined && (!Number.isSafeInteger(page.resultSizeEstimate) || page.resultSizeEstimate < 0) ||
      page.messages !== undefined && !Array.isArray(page.messages) ||
      page.nextPageToken !== undefined && (!mailboxPageToken_(page.nextPageToken) || !page.nextPageToken)) fail_('MAIL');
  const ids = (page.messages || []).map(function (summary) {
    if (!summary || typeof summary.id !== 'string' || !validGmailApiId_(summary.id)) fail_('MAIL');
    return summary.id;
  });
  if (!mailboxMessageIds_(ids)) fail_('MAIL');
  return page;
}

function mailboxRetryWindow_(scan, journal) {
  const match = journal && /^read\|(\d+)\|(\d+)$/.exec(journal.failureStage || '');
  if (!match) return scan;
  const startMs = Number(match[1]); const endMs = Number(match[2]);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) fail_('STATE');
  return {startMs: startMs, endMs: endMs, _retryWindow: true};
}

function mailboxProcessMessage_(state, scan, messageId, enforceWindow, onMessage, result) {
  const journal = getMessageState_(state.journalSheet, messageId);
  if (journal && (MC_FINAL_MESSAGE_STATES.indexOf(journal.status) >= 0 || journal.status === 'review' ||
      awaitingMessageExtraction_(journal))) return true;
  if (!journal) {
    const pending = newMessageState_(messageId);
    pending.failureStage = 'read|' + scan.startMs + '|' + scan.endMs;
    saveMessageState_(state.journalSheet, pending);
  }
  if (mailboxDeadlineReached_(state._deadlineMs)) return false;
  let raw;
  try { raw = Gmail.Users.Messages.get('me', messageId, {format: 'full'}); } catch (e) {
    mailboxReadFailure_(state.journalSheet, messageId, scan, enforceWindow); result.errors.push(gmailReadError_(messageId)); return true;
  }
  if (mailboxDeadlineReached_(state._deadlineMs)) return false;
  if (!raw || typeof raw !== 'object' || raw.id !== messageId) {
    mailboxReadFailure_(state.journalSheet, messageId, scan, enforceWindow); result.errors.push(gmailReadError_(messageId)); return true;
  }
  let message;
  try { message = canonicalGmailMessage_(raw, state._deadlineMs); } catch (e) {
    mailboxReadFailure_(state.journalSheet, messageId, scan, enforceWindow); result.errors.push(gmailReadError_(messageId)); return true;
  }
  if (mailboxDeadlineReached_(state._deadlineMs)) return false;
  if (enforceWindow && (message.receivedAtMs < scan.startMs || message.receivedAtMs > scan.endMs)) {
    const outside = getMessageState_(state.journalSheet, messageId) || newMessageState_(messageId);
    // A one-second query overlap can surface a just-arrived message beyond this
    // frozen window. Defer it for the next window rather than finalizing it.
    outside.status = message.receivedAtMs < scan.startMs ? 'ignored' : 'deferred';
    outside.outcome = message.receivedAtMs < scan.startMs ? 'outside-window' : 'after-window';
    outside.updatedAt = new Date().toISOString();
    saveMessageState_(state.journalSheet, outside);
    return true;
  }
  if (mailboxDeadlineReached_(state._deadlineMs)) return false;
  const outcome = onMessage(message);
  if (outcome) result.messages.push(outcome);
  return true;
}

function mailboxReadFailure_(journalSheet, messageId, scan, enforceWindow) {
  const journal = getMessageState_(journalSheet, messageId) || newMessageState_(messageId);
  if (!scan || !Number.isSafeInteger(scan.startMs) || !Number.isSafeInteger(scan.endMs)) fail_('STATE');
  journal.status = 'failed'; journal.retryCount++;
  journal.failureStage = enforceWindow ? 'read|' + scan.startMs + '|' + scan.endMs : 'read_validated';
  journal.lastError = 'MAIL'; journal.updatedAt = new Date().toISOString();
  saveMessageState_(journalSheet, journal);
}

function gmailReadError_(messageId) {
  return {messageId: messageId, code: 'MAIL', retryable: true};
}

function validGmailApiId_(id) {
  return /^[a-f0-9]+$/.test(id) && sourceId_(gmailLink_(id)) === id;
}

function canonicalGmailMessage_(raw, deadlineMs) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !validGmailApiId_(raw.id) ||
    raw.threadId != null && typeof raw.threadId !== 'string' ||
    typeof raw.internalDate !== 'string' || !/^\d+$/.test(raw.internalDate)) fail_('MAIL');
  const receivedAtMs = Number(raw.internalDate);
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) fail_('MAIL');
  const receivedAt = new Date(receivedAtMs);
  if (!isFinite(receivedAt.getTime())) fail_('MAIL');
  const payload = parseMimePayload_(raw.payload);
  const imageDeadline = Math.min(Date.now() + 30000, deadlineMs ? deadlineMs - 15000 : Infinity);
  const acquired = acquireMessageImages_(raw, payload.html, imageDeadline);
  return {
    id: raw.id,
    threadId: raw.threadId || '',
    receivedAt: receivedAt.toISOString(),
    receivedAtMs: receivedAtMs,
    sender: mimeHeader_(payload.headers, 'from'),
    subject: mimeHeader_(payload.headers, 'subject'),
    text: payload.text,
    html: payload.html,
    link: gmailLink_(raw.id),
    incomplete: payload.incomplete || acquired.incomplete,
    images: acquired.images
  };
}

function parseMimePayload_(part) {
  if (!part || typeof part !== 'object' || typeof part.mimeType !== 'string' || !part.mimeType.trim()) fail_('MAIL');
  const mimeType = part.mimeType.split(';', 1)[0].trim().toLowerCase();
  const headers = mimeHeaders_(part.headers);
  const output = {headers: headers, text: '', html: '', incomplete: false};
  if (mimeType.indexOf('multipart/') === 0) {
    if (!Array.isArray(part.parts)) {
      if (part.body && typeof part.body === 'object' && part.body.data) fail_('MAIL');
      output.incomplete = true;
      return output;
    }
    if (part.body && typeof part.body === 'object' && part.body.data) fail_('MAIL');
    part.parts.forEach(function (child) {
      const parsed = parseMimePayload_(child);
      if (parsed.text) output.text = appendMimeText_(output.text, parsed.text);
      if (parsed.html) output.html = appendMimeText_(output.html, parsed.html);
      output.incomplete = output.incomplete || parsed.incomplete;
      if (!output.headers.length && parsed.headers.length) output.headers = parsed.headers;
    });
    return output;
  }
  if (mimeType === 'text/plain' || mimeType === 'text/html') {
    const value = decodeMimeBody_(part.body, headers);
    if (mimeType === 'text/plain') output.text = value;
    else output.html = value;
    return output;
  }
  output.incomplete = true;
  return output;
}

function appendMimeText_(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left + '\n' + right;
}

function mimeHeaders_(headers) {
  if (headers == null) return [];
  if (!Array.isArray(headers)) fail_('MAIL');
  return headers.map(function (header) {
    if (!header || typeof header.name !== 'string' || !header.name || typeof header.value !== 'string') fail_('MAIL');
    return {name: header.name.toLowerCase(), value: header.value};
  });
}

function mimeHeader_(headers, name) {
  const match = headers.filter(function (header) { return header.name === name; });
  return match.length ? match[0].value : '';
}

function decodeMimeBody_(body, headers) {
  if (!body || typeof body !== 'object') fail_('MAIL');
  const data = body.data == null ? '' : body.data;
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length % 4 === 1) fail_('MAIL');
  if (body.size != null && (!Number.isSafeInteger(body.size) || body.size < 0)) fail_('MAIL');
  if (!data) {
    if (body.size && body.size !== 0) fail_('MAIL');
    return '';
  }
  let bytes;
  try { bytes = Utilities.base64DecodeWebSafe(data); } catch (e) { fail_('MAIL'); }
  if (!Array.isArray(bytes)) fail_('MAIL');
  if (body.size != null && body.size !== bytes.length) fail_('MAIL');
  const charset = mimeCharset_(headers);
  try { return Utilities.newBlob(bytes).getDataAsString(charset); } catch (e) { fail_('MAIL'); }
}

function mimeCharset_(headers) {
  const contentType = mimeHeader_(headers, 'content-type');
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
  const charset = match ? (match[1] || match[2]) : 'UTF-8';
  if (!/^[A-Za-z0-9._-]+$/.test(charset)) fail_('MAIL');
  return charset;
}
