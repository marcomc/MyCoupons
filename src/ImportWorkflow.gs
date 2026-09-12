/* Durable extraction/import orchestration. Gmail mutation follows verified journal persistence. */
function runImportWorkflow_(input) {
  return withLock_(function () {
    const state = input || ensureSheetState_();
    if (!state.couponSheet || !state.journalSheet) fail_('STATE');
    return withMessageJournal_(state.journalSheet, function () { return runImportWorkflowInSession_(state); });
  }, input && input._deadlineMs);
}

function runImportWorkflowInSession_(state) {
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
  if (existing && existing.outcome === 'archive' && existing.candidateStates &&
      existing.candidateStates.length && existing.candidateStates.every(function (item) { return item.status === 'confirmed'; })) {
    return finalizeImportedMessage_(state, existing);
  }
  let journal = existing || newMessageState_(message.id);
  journal.attempts++;
  journal.status = 'processing'; journal.failureStage = 'extract'; journal.lastError = '';
  saveMessageState_(state.journalSheet, journal);
  try {
    if (!Array.isArray(journal.candidateStates)) journal.candidateStates = [];
    journal.version = 2;
    const extraction = extractCouponOutcomeForState_(state, message);
    const candidates = extraction.candidates;
    if (extraction.verifiedNonOffer) {
      journal.outcome = 'empty'; journal.status = 'nonoffer'; journal.failureStage = '';
      journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
      return {messageId: message.id, status: 'nonoffer', rows: []};
    }
    // Empty but unverified, invalidated or incomplete output is never a
    // non-offer checkpoint. Preserve durable reachability without hot retries.
    if (!candidates.length) {
      journal.outcome = 'empty'; journal.status = 'awaiting_extraction'; journal.failureStage = '';
      journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
      return {messageId: message.id, status: 'awaiting_extraction', rows: []};
    }
    const rows = [];
    const statuses = [];
    candidates.forEach(function (candidate, index) {
      // A surviving candidate cannot erase a discarded model proposal or an
      // incomplete source. The complete outcome is the archive authority.
      const persistedCandidate = Object.assign({}, candidate, {review: candidate.review || !extraction.archiveAllowed});
      const key = candidateDedupeKey_(message, candidate, index);
      const known = journal.candidateKeys.indexOf(key);
      let rowNumber;
      if (known >= 0) {
        rowNumber = journal.rowNumbers[known];
        if (!rowNumber) fail_('STATE');
      } else {
        const row = couponRow_(message, persistedCandidate);
        // Journal acknowledgement may have failed after the row write. Only a
        // fresh source-backed message and exact projected identity can recover it.
        const prior = findCouponRowByCandidateIdentity_(state.couponSheet, message, candidate);
        rowNumber = prior || appendCouponRow_(state.couponSheet, row);
        journal.dedupeKeys.push(key);
        journal.candidateKeys.push(key);
        journal.rowNumbers.push(rowNumber);
      }
      const status = Object.create(null); status.status = persistedCandidate.review ? 'review' : 'confirmed';
      statuses.push(status);
      rows.push(rowNumber);
      if (!journal.candidateStates.some(function (item) { return item.key === key; })) {
        journal.candidateStates.push({key: key, rowNumber: rowNumber, status: persistedCandidate.review ? 'review' : 'confirmed', imageEvidence: candidate.imageEvidence || {}});
      }
    });
    journal.outcome = messageOutcome_(statuses);
    journal.status = journal.outcome === 'archive' ? 'processing' : 'review';
    journal.failureStage = journal.outcome === 'archive' ? 'mail' : '';
    journal.updatedAt = new Date().toISOString();
    saveMessageState_(state.journalSheet, journal);
    if (journal.outcome === 'archive') return finalizeImportedMessage_(state, journal);
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
  // Candidate order is model-controlled. Exact candidate identity is not.
  return digest_(message.id + '|' + exactCandidateIdentityKey_(candidate));
}

function findCouponRowByDedupeKey_(sheet, key) {
  // Technical keys live in the private journal, never in user-visible Notes.
  // Retained only for compatibility; callers must resolve through journal state.
  return 0;
}

function findCouponRowByCandidateIdentity_(sheet, message, candidate) {
  const rows = sheet.getDataRange().getDisplayValues();
  const identity = candidateRowIdentity_(message, candidate);
  const matches = [];
  for (let index = 1; index < rows.length; index++) {
    if (candidateRowIdentityFromRow_(rows[index]) === identity) matches.push(index + 1);
  }
  if (matches.length > 1) fail_('STATE');
  return matches.length ? matches[0] : 0;
}

function candidateRowIdentity_(message, candidate) {
  return JSON.stringify([message.link].concat(MC.fields.map(function (field) { return String(candidate[field] || ''); })));
}

function candidateRowIdentityFromRow_(row) {
  const columns = {merchant: 1, website: 2, code: 3, discountType: 4, discountValue: 5, minimumSpend: 6,
    validOn: 7, exclusions: 8, expiry: 9, usageLimits: 10, currency: 20, notes: 16};
  return JSON.stringify([String(row[13] || '')].concat(MC.fields.map(function (field) {
    return reviewSourceValue_(row[columns[field]] || '');
  })));
}

function couponRow_(message, candidate) {
  const row = Array(26).fill('');
  row[0] = new Date(message.receivedAtMs); row[1] = textCell_(candidate.merchant);
  row[2] = textCell_(candidate.website); row[3] = textCell_(candidate.code);
  row[4] = textCell_(candidate.discountType); row[5] = textCell_(candidate.discountValue);
  row[6] = textCell_(candidate.minimumSpend); row[7] = textCell_(candidate.validOn);
  row[8] = textCell_(candidate.exclusions); row[9] = candidate.expiry || '';
  row[10] = textCell_(candidate.usageLimits); row[11] = textCell_(message.subject);
  row[12] = textCell_(message.sender); row[13] = message.link;
  row[14] = candidate.confidence; row[15] = candidate.review ? EN.yes : '';
  row[16] = textCell_(candidate.notes); row[17] = candidate.review ? EN.statuses.review : EN.statuses.confirmed;
  row[20] = textCell_(candidate.currency);
  row[24] = '';
  return row;
}

function appendCouponRow_(sheet, row) {
  if (!Array.isArray(row) || row.length !== MC.headers.length) fail_('WRITE');
  const rowNumber = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  const stored = sheet.getRange(rowNumber, 1, 1, row.length).getValues()[0];
  if (stored.length !== row.length || String(stored[13]) !== String(row[13]) ||
      String(stored[16]) !== String(row[16]) || String(stored[20]) !== String(row[20])) fail_('WRITE');
  return rowNumber;
}

function extractCouponOutcomeForState_(state, message) {
  if (state && typeof state.extractCouponOutcome === 'function') return state.extractCouponOutcome(message);
  const hooks = Object.assign({}, state && state.extractionHooks || {});
  if (state && state._deadlineMs) hooks.deadlineMs = state._deadlineMs;
  return extractCouponOutcome_(message, hooks);
}

function finalizeImportedMessage_(state, journal) {
  const c = state && state.config;
  if (!c || !c.labelId) fail_('CONFIG');
  try {
    if (!journal.labelApplied) {
      const labelled = modifyReviewMessage_(journal.messageId, {addLabelIds: [c.labelId]});
      if (labelled.labelIds.indexOf(c.labelId) < 0) fail_('MAIL');
      journal.labelApplied = true; journal.updatedAt = new Date().toISOString();
      saveMessageState_(state.journalSheet, journal);
    }
    if (!journal.archived) {
      const archived = modifyReviewMessage_(journal.messageId, {removeLabelIds: ['INBOX']});
      if (archived.labelIds.indexOf('INBOX') >= 0) fail_('MAIL');
      journal.archived = true; journal.updatedAt = new Date().toISOString();
      saveMessageState_(state.journalSheet, journal);
    }
    journal.status = 'confirmed'; journal.failureStage = ''; journal.lastError = '';
    journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
    return {messageId: journal.messageId, status: 'confirmed', rows: journal.rowNumbers.slice()};
  } catch (e) {
    journal.status = 'failed'; journal.retryCount++; journal.failureStage = 'mail';
    journal.lastError = errorCode_(e); journal.updatedAt = new Date().toISOString();
    try { saveMessageState_(state.journalSheet, journal); } catch (ignored) {}
    return {messageId: journal.messageId, status: 'failed', rows: journal.rowNumbers.slice(), error: journal.lastError};
  }
}
