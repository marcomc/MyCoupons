const MC_GMAIL_PAGE_SIZE = 50;
const MC_GMAIL_MAX_PAGES = 20;
const MC_GMAIL_MAX_MESSAGES_PER_RUN = 50;
const MC_MAILBOX_SCAN_STATE_KEY = 'MYCOUPONS_MAILBOX_SCAN_STATE';
const MC_MAILBOX_SCAN_STATE_VERSION = 1;
const MC_FINAL_MESSAGE_STATES = Object.freeze(['confirmed', 'ignored', 'nonoffer']);

function mailboxScanState_(recoveryStart, nowMs, installationId) {
  if (!Number.isSafeInteger(recoveryStart) || recoveryStart < 0 ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) fail_('STATE');
  return {version: MC_MAILBOX_SCAN_STATE_VERSION, startMs: recoveryStart, endMs: Math.max(recoveryStart, nowMs),
    installationId: installationId || '', pageToken: '', pendingNextPageToken: '', pendingIds: [], retryCursor: '', complete: nowMs < recoveryStart};
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
    if (!initial.complete) saveMailboxScanState_(initial);
    return initial;
  }
  let state;
  try { state = JSON.parse(raw); } catch (e) { fail_('STATE'); }
  if (!validMailboxScanState_(state)) fail_('STATE');
  if (state.installationId !== (installationId || '')) {
    state = mailboxScanState_(recoveryStart, Date.now(), installationId);
    if (!state.complete) saveMailboxScanState_(state);
    return state;
  }
  if (state.complete) {
    const previousRetryCursor = state.retryCursor;
    state = mailboxScanState_(state.endMs, Date.now(), installationId);
    state.retryCursor = previousRetryCursor;
    if (!state.complete) saveMailboxScanState_(state);
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
  // A future recovery date is not a completed discovery checkpoint. Keep this
  // empty interval ephemeral so a corrected sheet date can take effect next run.
  if (scan.complete) { result.waitingUntilMs = scan.startMs; return result; }
  let remaining = MC_GMAIL_MAX_MESSAGES_PER_RUN;
  let pages = 0;
  const seenPageTokens = Object.create(null);

  // Failed/abandoned records stay reachable even after their original window has
  // completed. They are retried before new listing, but bounded so they cannot starve it.
  const journalSnapshot = readMessageJournal_(state.journalSheet);
  const retryCandidates = Object.keys(journalSnapshot).filter(function (id) {
    const journal = journalSnapshot[id];
    return journal && (journal.version === 3 && !completeCandidateBatch_(journal) ||
      journal.status === 'pending' && /^read\|\d+\|\d+$/.test(journal.failureStage || '') || journal.status === 'processing' ||
      awaitingMessageExtraction_(journal) ||
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
  if (journal && completeCandidateBatch_(journal) && (MC_FINAL_MESSAGE_STATES.indexOf(journal.status) >= 0 || journal.status === 'review')) return true;
  if (journal && journal.status === 'awaiting_extraction' && !awaitingMessageExtraction_(journal)) return true;
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

// Owner-only, read-only execution diagnostic for an operator investigating a
// provider/runtime mismatch. It intentionally returns no message identity,
// headers, body, URLs, image bytes, or exception text.
function diagnoseGmailRead(messageId) {
  return withLock_(function () {
    const config = config_();
    assertOwner_(config);
    if (!validGmailApiId_(messageId)) fail_('MAIL');
    const report = {rawShape: 'not-run', mimeTrace: {parts: [], omitted: 0}, read: 'not-run', mime: 'not-run', html: 'not-run',
      imageParts: 'not-run', acquisition: 'not-run', canonical: 'not-run'};
    let raw;
    try {
      raw = Gmail.Users.Messages.get('me', messageId, {format: 'full'});
      report.rawShape = gmailReadRawShape_(raw);
      if (!raw || typeof raw !== 'object' || raw.id !== messageId) fail_('MAIL');
      report.read = 'ok';
    } catch (e) {
      report.read = diagnosticStageError_(e);
      return report;
    }
    let payload;
    try {
      payload = parseMimePayload_(raw.payload, report.mimeTrace);
      report.mime = 'ok';
    } catch (e) {
      report.mime = diagnosticStageError_(e);
      return report;
    }
    try {
      const projected = htmlContent_(payload.html);
      report.html = projected && typeof projected === 'object' ? 'ok' : 'invalid';
    } catch (e) {
      report.html = diagnosticStageError_(e);
    }
    try {
      const resources = [];
      collectImageParts_(raw.payload, '', resources);
      report.imageParts = 'ok';
    } catch (e) {
      report.imageParts = diagnosticStageError_(e);
    }
    try {
      const acquired = acquireMessageImages_(raw, payload.html);
      report.acquisition = acquired && Array.isArray(acquired.images) && typeof acquired.incomplete === 'boolean' ? 'ok' : 'invalid';
    } catch (e) {
      report.acquisition = diagnosticStageError_(e);
    }
    try {
      const message = canonicalGmailMessage_(raw);
      report.canonical = message && Array.isArray(message.images) && typeof message.incomplete === 'boolean' ? 'ok' : 'invalid';
    } catch (e) {
      report.canonical = diagnosticStageError_(e);
    }
    return report;
  });
}

function gmailReadRawShape_(raw) {
  const payload = raw && typeof raw === 'object' ? raw.payload : null;
  function partFieldType_(name) {
    if (!payload || typeof payload !== 'object') return 'not-applicable';
    return Array.isArray(payload[name]) ? 'array' : typeof payload[name];
  }
  return {idType: raw && typeof raw === 'object' ? typeof raw.id : typeof raw,
    threadIdType: raw && typeof raw === 'object' ? typeof raw.threadId : 'not-applicable',
    internalDateType: raw && typeof raw === 'object' ? typeof raw.internalDate : 'not-applicable',
    payloadType: raw && typeof raw === 'object' ? typeof raw.payload : 'not-applicable',
    payloadHeadersType: partFieldType_('headers'), payloadPartsType: partFieldType_('parts')};
}

function diagnosticStageError_(error) {
  const code = errorCode_(error);
  return code === 'INTERNAL' ? 'error' : 'error-' + code;
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

// Trace records contain only closed classifications, types, counts and outcomes.
// Keep the most recent records so a deep/late failure remains visible. This is
// observation of the production path, never an alternate permissive parser.
function mimeDiagnosticType_(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function mimeDiagnosticPart_(trace, parent) {
  if (!trace) return null;
  const record = {index: trace.omitted + trace.parts.length, parent: parent ? parent.index : null,
    stage: 'part-validation', status: 'running'};
  if (trace.parts.length === 64) { trace.parts.shift(); trace.omitted++; }
  trace.parts.push(record);
  return record;
}

function parseMimePayload_(part, trace, parent) {
  const record = mimeDiagnosticPart_(trace, parent);
  try {
    const output = parseMimePart_(part, trace, record);
    if (record) { record.stage = 'complete'; record.status = 'ok'; }
    return output;
  } catch (e) {
    if (record) record.status = 'error';
    throw e;
  }
}

function parseMimePart_(part, trace, record) {
  if (record) {
    record.partType = mimeDiagnosticType_(part);
    record.mimeTypeType = part ? mimeDiagnosticType_(part.mimeType) : 'not-applicable';
  }
  if (!part || typeof part !== 'object' || typeof part.mimeType !== 'string' || !part.mimeType.trim()) fail_('MAIL');
  const mimeType = part.mimeType.split(';', 1)[0].trim().toLowerCase();
  if (record) {
    record.mimeClass = mimeType.indexOf('multipart/') === 0 ? 'multipart' :
      mimeType === 'text/plain' ? 'plain' : mimeType === 'text/html' ? 'html' : 'other';
    record.stage = 'headers-validation';
    record.headersType = mimeDiagnosticType_(part.headers);
  }
  const headers = mimeHeaders_(part.headers, record);
  const output = {headers: headers, text: '', html: '', incomplete: false};
  if (mimeType.indexOf('multipart/') === 0) {
    if (record) {
      record.stage = 'multipart-validation';
      record.partsType = mimeDiagnosticType_(part.parts);
      record.bodyType = mimeDiagnosticType_(part.body);
    }
    if (part.body != null) {
      if (typeof part.body !== 'object' || Array.isArray(part.body) ||
        decodeBytePayload_(part.body.data, part.body.size).length) fail_('MAIL');
    }
    if (!Array.isArray(part.parts)) {
      output.incomplete = true;
      return output;
    }
    if (record) record.stage = 'multipart-children';
    part.parts.forEach(function (child) {
      const parsed = parseMimePayload_(child, trace, record);
      if (record) record.stage = 'multipart-composition';
      if (parsed.text) output.text = appendMimeText_(output.text, parsed.text);
      if (parsed.html) output.html = appendMimeText_(output.html, parsed.html);
      output.incomplete = output.incomplete || parsed.incomplete;
      if (!output.headers.length && parsed.headers.length) output.headers = parsed.headers;
      if (record) record.stage = 'multipart-children';
    });
    return output;
  }
  if (mimeType === 'text/plain' || mimeType === 'text/html') {
    const value = decodeMimeBody_(part.body, headers, record);
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

function mimeHeaders_(headers, record) {
  if (headers == null) return [];
  if (!Array.isArray(headers)) fail_('MAIL');
  return headers.map(function (header, index) {
    if (record) {
      record.headerIndex = index;
      record.headerType = mimeDiagnosticType_(header);
      record.headerNameType = header ? mimeDiagnosticType_(header.name) : 'not-applicable';
      record.headerValueType = header ? mimeDiagnosticType_(header.value) : 'not-applicable';
    }
    if (!header || typeof header.name !== 'string' || !header.name || typeof header.value !== 'string') fail_('MAIL');
    return {name: header.name.toLowerCase(), value: header.value};
  });
}

function mimeHeader_(headers, name) {
  const match = headers.filter(function (header) { return header.name === name; });
  return match.length ? match[0].value : '';
}

function decodeMimeBody_(body, headers, record) {
  if (record) { record.stage = 'body-validation'; record.bodyType = mimeDiagnosticType_(body); }
  if (!body || typeof body !== 'object') fail_('MAIL');
  const bytes = decodeBytePayload_(body.data, body.size, record);
  if (!bytes.length) return '';
  if (record) record.stage = 'charset-validation';
  const charset = mimeCharset_(headers);
  if (record) {
    const normalized = charset.toLowerCase();
    record.charsetClass = normalized === 'utf-8' || normalized === 'utf8' ? 'utf8' :
      normalized === 'us-ascii' || normalized === 'ascii' ? 'ascii' :
      normalized === 'iso-8859-1' ? 'latin1' : normalized === 'windows-1252' ? 'windows1252' : 'other';
    record.stage = 'blob-create';
  }
  try {
    const blob = Utilities.newBlob(bytes);
    if (record) record.stage = 'string-decode';
    const value = blob.getDataAsString(charset);
    if (record) record.decodedType = mimeDiagnosticType_(value);
    return value;
  } catch (e) { fail_('MAIL'); }
}

function mimeCharset_(headers) {
  const contentType = mimeHeader_(headers, 'content-type');
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
  const charset = match ? (match[1] || match[2]) : 'UTF-8';
  if (!/^[A-Za-z0-9._-]+$/.test(charset)) fail_('MAIL');
  return charset;
}
