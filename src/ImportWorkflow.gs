/* Deterministic, read-only import orchestration. Gmail mutations are deliberately absent. */
function runImportWorkflow_(input) {
  const state = input || ensureSheetState_();
  if (!state.couponSheet || !state.journalSheet) fail_('STATE');
  if (!Array.isArray(state.messages)) {
    // The scanner invokes this callback for one durable pending ID at a time.
    // Consequently image acquisition cannot defer every sheet write until the
    // complete mailbox page has been fetched.
    const streamed = {imported: 0, review: 0, errors: [], messages: [], truncated: false};
    try {
      readCouponMessages_(state, function (message) {
        return processCouponMessage_(state, message);
      }, streamed);
    } catch (e) {
      streamed.errors.push({messageId: '', code: errorCode_(e)});
    }
    streamed.messages.forEach(function (outcome) {
      if (outcome.status === 'confirmed') streamed.imported += outcome.rows.length;
      if (outcome.status === 'review') streamed.review += outcome.rows.length;
    });
    return streamed;
  }
  const result = {imported: 0, review: 0, errors: state.errors || [], messages: [], truncated: !!state.truncated};
  state.messages.forEach(function (message) {
    if (state._deadlineMs && Date.now() >= state._deadlineMs) { result.truncated = true; return; }
    const outcome = processCouponMessage_(state, message);
    result.messages.push(outcome);
    if (outcome.status === 'confirmed') result.imported += outcome.rows.length;
    if (outcome.status === 'review') result.review += outcome.rows.length;
  });
  return result;
}

function processCouponMessage_(state, message) {
  if (!message || typeof message.id !== 'string' || !validGmailApiId_(message.id)) fail_('MAIL');
  const existing = getMessageState_(state.journalSheet, message.id);
  if (existing && MC_FINAL_MESSAGE_STATES.indexOf(existing.status) >= 0) {
    return {messageId: message.id, status: existing.status, rows: existing.rowNumbers.slice()};
  }
  if (existing && existing.status === 'review') {
    return {messageId: message.id, status: 'review', rows: existing.rowNumbers.slice()};
  }
  let journal = existing || newMessageState_(message.id);
  journal.attempts++;
  journal.status = 'processing'; journal.failureStage = 'extract'; journal.lastError = '';
  saveMessageState_(state.journalSheet, journal);
  try {
    if (!Array.isArray(journal.candidateStates)) journal.candidateStates = [];
    journal.version = 2;
    const candidates = deterministicCandidates_(message).map(function (candidate) {
      const normalized = {}; MC.fields.forEach(function (field) { normalized[field] = ''; });
      normalized.code = candidate.code; normalized.notes = candidate.notes;
      normalized.confidence = candidate.confidence; normalized.review = true;
      return normalized;
    });
    const rows = [];
    const statuses = [];
    candidates.forEach(function (candidate, index) {
      const key = candidateDedupeKey_(message, candidate, index);
      const known = journal.candidateKeys.indexOf(key);
      let rowNumber;
      if (known >= 0) {
        rowNumber = journal.rowNumbers[known];
        if (!rowNumber) fail_('STATE');
      } else {
        const row = couponRow_(message, candidate, key);
        const prior = findCouponRowByDedupeKey_(state.couponSheet, key);
        rowNumber = prior || appendCouponRow_(state.couponSheet, row);
        journal.dedupeKeys.push(key);
        journal.candidateKeys.push(key);
        journal.rowNumbers.push(rowNumber);
      }
      const status = Object.create(null); status.status = candidate.review ? 'review' : 'confirmed';
      statuses.push(status);
      rows.push(rowNumber);
      if (!journal.candidateStates.some(function (item) { return item.key === key; })) {
        journal.candidateStates.push({key: key, rowNumber: rowNumber, status: candidate.review ? 'review' : 'confirmed', imageEvidence: candidate.imageEvidence || {}});
      }
    });
    journal.outcome = messageOutcome_(statuses);
    journal.status = journal.outcome === 'archive' ? 'confirmed' : 'review';
    // No deterministic code is not proof of a non-offer. Retain the source ID
    // for the later AI pass without retrying it or granting archive authority.
    if (journal.outcome === 'empty') journal.status = 'awaiting_extraction';
    journal.failureStage = ''; journal.updatedAt = new Date().toISOString();
    saveMessageState_(state.journalSheet, journal);
    return {messageId: message.id, status: journal.status, rows: rows};
  } catch (e) {
    journal.status = 'failed'; journal.retryCount++; journal.failureStage = journal.failureStage || 'write';
    journal.lastError = errorCode_(e); journal.updatedAt = new Date().toISOString();
    saveMessageState_(state.journalSheet, journal);
    return {messageId: message.id, status: 'failed', rows: journal.rowNumbers.slice(), error: journal.lastError};
  }
}

function awaitingMessageExtraction_(journal) {
  return journal.status === 'awaiting_extraction' ||
    journal.status === 'failed' && journal.outcome === 'empty' && !journal.failureStage && !journal.lastError;
}

function candidateDedupeKey_(message, candidate, index) {
  return digest_(message.id + '|' + index + '|' + normalized_(candidate.merchant) + '|' +
    candidate.code + '|' + candidate.website + '|' + candidate.discountType + '|' + candidate.discountValue);
}

function findCouponRowByDedupeKey_(sheet, key) {
  const rows = sheet.getDataRange().getDisplayValues();
  for (let index = 1; index < rows.length; index++) if (rows[index][16] === key) return index + 1;
  return 0;
}

function couponRow_(message, candidate, key) {
  const row = Array(26).fill('');
  row[0] = new Date(message.receivedAtMs); row[1] = textCell_(candidate.merchant);
  row[2] = textCell_(candidate.website); row[3] = textCell_(candidate.code);
  row[4] = textCell_(candidate.discountType); row[5] = textCell_(candidate.discountValue);
  row[6] = textCell_(candidate.minimumSpend); row[7] = textCell_(candidate.validOn);
  row[8] = textCell_(candidate.exclusions); row[9] = candidate.expiry || '';
  row[10] = textCell_(candidate.usageLimits); row[11] = textCell_(message.subject);
  row[12] = textCell_(message.sender); row[13] = message.link;
  row[14] = candidate.confidence; row[15] = candidate.review ? EN.yes : '';
  row[16] = key; row[17] = candidate.review ? EN.statuses.review : EN.statuses.confirmed;
  row[24] = '';
  return row;
}

function appendCouponRow_(sheet, row) {
  if (!Array.isArray(row) || row.length !== MC.headers.length) fail_('WRITE');
  const rowNumber = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  const stored = sheet.getRange(rowNumber, 1, 1, row.length).getValues()[0];
  if (stored.length !== row.length || String(stored[16]) !== String(row[16])) fail_('WRITE');
  return rowNumber;
}
