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
  if (legacyMailReviewBatch_(existing)) {
    reconcileCandidateRows_(state.couponSheet, existing);
    existing.status = 'review'; existing.failureStage = ''; existing.lastError = ''; existing.nextRetryAt = '';
    existing.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, existing);
    return {messageId: message.id, status: 'review', rows: existing.rowNumbers.slice()};
  }
  if (existing && existing.version !== 3 && !completeCandidateBatch_(existing)) {
    keepIncompleteBatch_(existing, state.journalSheet);
    return {messageId: message.id, status: 'failed', rows: existing.rowNumbers.slice(), error: 'STATE'};
  }
  if (existing && completeCandidateBatch_(existing) && MC_FINAL_MESSAGE_STATES.indexOf(existing.status) >= 0) {
    return {messageId: message.id, status: existing.status, rows: existing.rowNumbers.slice()};
  }
  if (existing && completeCandidateBatch_(existing) && existing.status === 'review') {
    return {messageId: message.id, status: 'review', rows: existing.rowNumbers.slice()};
  }
  if (existing && completeCandidateBatch_(existing) && existing.outcome === 'archive' && existing.candidateStates &&
      existing.candidateStates.length && existing.candidateStates.every(function (item) { return item.status === 'confirmed'; })) {
    reconcileCandidateRows_(state.couponSheet, existing);
    if (!refreshAndValidateReviewRows_(existing, state.couponSheet, state.config)) {
      restoreReviewRows_(existing, state.couponSheet);
      existing.status = 'review'; existing.outcome = 'review'; existing.updatedAt = new Date().toISOString();
      saveMessageState_(state.journalSheet, existing);
      return {messageId: message.id, status: 'review', rows: existing.rowNumbers.slice()};
    }
    // Persist refreshed row locations before granting Gmail mutation authority.
    saveMessageState_(state.journalSheet, existing);
    return finalizeImportedMessage_(state, existing);
  }
  let journal = existing || newMessageState_(message.id);
  journal.attempts++;
  journal.status = 'processing'; journal.failureStage = 'extract'; journal.lastError = '';
  saveMessageState_(state.journalSheet, journal);
  try {
    if (!Array.isArray(journal.candidateStates)) {
      if (journal.candidateKeys.length || journal.rowNumbers.length) {
        if (journal.candidateKeys.length !== journal.rowNumbers.length) fail_('STATE');
        journal.candidateStates = journal.candidateKeys.map(function (key, index) {
          return {key: key, rowNumber: journal.rowNumbers[index], status: 'review'};
        });
      } else journal.candidateStates = [];
    }
    const resumingBatch = journal.version === 3;
    if (!resumingBatch) journal.version = 2;
    const extraction = resumingBatch ? {candidates: journal.batchIntent.candidates,
      archiveAllowed: false, verifiedNonOffer: false} : extractCouponOutcomeForState_(state, message);
    const candidates = extraction.candidates;
    if (extraction.excludedReason === 'authentication_code_message') {
      // Policy exclusion can include an offer: it is not verified offer absence.
      // No batch/row reconciliation or Gmail finalization is authorized here.
      journal.outcome = extraction.excludedReason; journal.status = 'ignored';
      journal.failureStage = ''; journal.nextRetryAt = '';
      journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
      return {messageId: message.id, status: 'ignored', rows: [], excludedReason: extraction.excludedReason};
    }
    if (extraction.verifiedNonOffer) {
      if (journal.candidateStates.length) {
        if (!candidateStates_(journal.candidateStates, journal.candidateKeys, journal.rowNumbers)) fail_('STATE');
        reconcileCandidateRows_(state.couponSheet, journal);
        const retainedStatuses = journal.candidateStates.map(function (item) {
          const status = Object.create(null); status.status = item.status; return status;
        });
        journal.outcome = messageOutcome_(retainedStatuses);
        journal.status = journal.outcome === 'archive' ? 'processing' : journal.outcome === 'unchanged' ? 'ignored' : 'review';
        journal.failureStage = journal.outcome === 'archive' ? 'mail' : '';
        journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
        if (journal.outcome === 'archive') return finalizeImportedMessage_(state, journal);
        return {messageId: message.id, status: journal.status, rows: journal.rowNumbers.slice()};
      }
      journal.outcome = 'empty'; journal.status = 'nonoffer'; journal.failureStage = '';
      journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
      return {messageId: message.id, status: 'nonoffer', rows: []};
    }
    // Empty but unverified, invalidated or incomplete output is never a
    // non-offer checkpoint. Preserve durable reachability without hot retries.
    if (!candidates.length) {
      journal.outcome = 'empty'; journal.status = 'awaiting_extraction'; journal.failureStage = '';
      journal.nextRetryAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      journal.updatedAt = new Date().toISOString(); saveMessageState_(state.journalSheet, journal);
      return {messageId: message.id, status: 'awaiting_extraction', rows: []};
    }
    if (!resumingBatch) {
      createBatchIntent_(journal, extraction);
      // This verified write contains EVERY payload before any coupon row is
      // touched. Interruption can replay it without asking the model again.
      journal.failureStage = 'write';
      saveMessageState_(state.journalSheet, journal);
    }
    const rows = [];
    candidates.forEach(function (candidate) {
      if (state._deadlineMs && Date.now() >= state._deadlineMs) fail_('WRITE');
      // A surviving candidate cannot erase a discarded model proposal or an
      // incomplete source. The complete outcome is the archive authority.
      const persistedCandidate = Object.assign({}, candidate, {review: candidate.review || !extraction.archiveAllowed});
      const key = candidateDedupeKey_(message, candidate);
      const known = journal.candidateKeys.indexOf(key);
      let rowNumber;
      if (known >= 0) {
        rowNumber = resolveCandidateRow_(state.couponSheet, message.id, key, journal.rowNumbers[known]);
        journal.rowNumbers[known] = rowNumber;
        if (resumingBatch) {
          const retained = journal.candidateStates.filter(function (item) { return item.key === key; });
          if (retained.length !== 1) fail_('STATE');
          retained[0].rowNumber = rowNumber;
          rows.push(rowNumber);
          return;
        }
      } else {
        const row = couponRow_(message, persistedCandidate);
        // Journal acknowledgement may have failed after the row write. Only a
        // fresh source-backed message and exact projected identity can recover it.
        const keyedRow = findCouponRowByDedupeKey_(state.couponSheet, key);
        const prior = keyedRow || findCouponRowByCandidateIdentity_(state.couponSheet, message, candidate, state.config);
        if (prior) {
          if (sourceId_(state.couponSheet.getRange(prior, 14).getValues()[0][0]) !== message.id) fail_('STATE');
          const priorKey = candidateKeyFromNote_(state.couponSheet.getRange(prior, 14).getNote());
          if (priorKey && priorKey !== key) fail_('STATE');
          persistCandidateKey_(state.couponSheet, prior, key);
          rowNumber = prior;
        } else rowNumber = appendCouponRow_(state.couponSheet, row, key);
        journal.dedupeKeys.push(key);
        journal.candidateKeys.push(key);
        journal.rowNumbers.push(rowNumber);
      }
      const storedStatus = String(state.couponSheet.getRange(rowNumber, 18, 1, 1).getValues()[0][0]);
      if (storedStatus !== EN.statuses.confirmed) persistedCandidate.review = true;
      rows.push(rowNumber);
      const persistedState = journal.candidateStates.filter(function (item) { return item.key === key; });
      if (!persistedState.length) {
        journal.candidateStates.push({key: key, rowNumber: rowNumber, status: persistedCandidate.review ? 'review' : 'confirmed', imageEvidence: candidate.imageEvidence || {}});
      } else if (persistedState.length === 1) {
        persistedState[0].rowNumber = rowNumber;
        persistedState[0].status = persistedCandidate.review ? 'review' : 'confirmed';
        persistedState[0].imageEvidence = candidate.imageEvidence || {};
      } else {
        fail_('STATE');
      }
      if (persistedCandidate.review && storedStatus !== EN.statuses.review) setReviewStatus_(state.couponSheet, rowNumber, EN.statuses.review, EN.actions.confirm);
      saveMessageState_(state.journalSheet, journal);
    });
    if (!completeCandidateBatch_(journal)) fail_('STATE');
    const persistedStatuses = journal.candidateStates.map(function (item) {
      const status = Object.create(null); status.status = item.status; return status;
    });
    journal.outcome = messageOutcome_(persistedStatuses);
    if (resumingBatch && journal.outcome === 'archive' &&
        !refreshAndValidateReviewRows_(journal, state.couponSheet, state.config)) {
      restoreReviewRows_(journal, state.couponSheet);
      journal.outcome = 'review';
    }
    journal.status = journal.outcome === 'archive' ? 'processing' : journal.outcome === 'unchanged' ? 'ignored' : 'review';
    journal.failureStage = journal.outcome === 'archive' ? 'mail' : '';
    journal.updatedAt = new Date().toISOString();
    saveMessageState_(state.journalSheet, journal);
    if (journal.outcome === 'archive') return finalizeImportedMessage_(state, journal);
    return {messageId: message.id, status: journal.status, rows: rows};
  } catch (e) {
    // The durable batch remains authoritative, including payloads whose rows
    // were never written. Do not overwrite reviewed rows during recovery.
    journal.status = 'failed'; journal.retryCount++; journal.failureStage = journal.failureStage || 'write';
    journal.lastError = errorCode_(e); journal.updatedAt = new Date().toISOString();
    saveMessageState_(state.journalSheet, journal);
    return {messageId: message.id, status: 'failed', rows: journal.rowNumbers.slice(), error: journal.lastError};
  }
}

function awaitingMessageExtraction_(journal) {
  const retryAt = Date.parse(journal.nextRetryAt || '');
  return (journal.status === 'awaiting_extraction' &&
    (!journal.nextRetryAt || Number.isFinite(retryAt) && retryAt <= Date.now())) ||
    journal.status === 'failed' && journal.outcome === 'empty' && !journal.failureStage && !journal.lastError;
}

function candidateDedupeKey_(message, candidate) {
  // Candidate order is model-controlled. Exact candidate identity is not.
  return digest_(message.id + '|' + exactCandidateIdentityKey_(candidate));
}

function findCouponRowByDedupeKey_(sheet, key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail_('STATE');
  const rowCount = sheet.getLastRow() - 1;
  const noteValues = rowCount > 0 && sheet.getRange(2, 14, rowCount, 1);
  const notes = noteValues && typeof noteValues.getNotes === 'function' ? noteValues.getNotes() : null;
  const noteMatches = [];
  for (let index = 0; index < rowCount; index++) {
    const note = notes ? notes[index][0] : sheet.getRange(index + 2, 14).getNote();
    if (candidateKeyFromNote_(note) === key) noteMatches.push(index + 2);
  }
  if (noteMatches.length > 1) fail_('STATE');
  if (noteMatches.length === 1) return noteMatches[0];
  // Legacy deployed rows placed the key in visible Notes. New identities use
  // private Range Notes.
  const rows = sheet.getDataRange().getDisplayValues();
  const legacyMatches = [];
  for (let index = 1; index < rows.length; index++) if (rows[index][16] === key) legacyMatches.push(index + 1);
  if (legacyMatches.length > 1) fail_('STATE');
  return legacyMatches.length ? legacyMatches[0] : 0;
}

function candidateKeyNote_(key) { return 'mycoupons-candidate:' + key; }

function candidateKeyFromNote_(note) {
  const match = /^mycoupons-candidate:([a-f0-9]{64})$/.exec(String(note || ''));
  return match ? match[1] : '';
}

function persistCandidateKey_(sheet, rowNumber, key) {
  const range = sheet.getRange(rowNumber, 14);
  if (!range || typeof range.setNote !== 'function' || typeof range.getNote !== 'function') fail_('WRITE');
  range.setNote(candidateKeyNote_(key));
  if (range.getNote() !== candidateKeyNote_(key)) fail_('WRITE');
}

function resolveCandidateRow_(sheet, messageId, key, persistedRowNumber) {
  const located = findCouponRowByDedupeKey_(sheet, key);
  if (!located || !Number.isInteger(persistedRowNumber) || persistedRowNumber < 2) fail_('STATE');
  const row = sheet.getRange(located, 1, 1, MC.headers.length).getValues()[0];
  if (sourceId_(row[13]) !== messageId) fail_('STATE');
  return located;
}

function findCouponRowByCandidateIdentity_(sheet, message, candidate, c) {
  const rows = sheet.getDataRange().getValues();
  const identity = candidateRowIdentity_(message, candidate);
  const matches = [];
  for (let index = 1; index < rows.length; index++) {
    if (rows[index][9] instanceof Date) {
      if (!c || !c.timeZone) fail_('CONFIG');
      rows[index][9] = Utilities.formatDate(rows[index][9], c.timeZone, 'yyyy-MM-dd');
    }
    if (candidateRowIdentityFromRow_(rows[index]) === identity) matches.push(index + 1);
  }
  if (matches.length > 1) fail_('STATE');
  return matches.length ? matches[0] : 0;
}

function candidateRowIdentity_(message, candidate) {
  return JSON.stringify([message.link, exactCandidateIdentityKey_(candidate)]);
}

function candidateRowIdentityFromRow_(row) {
  return JSON.stringify([String(row[13] || ''), exactCandidateIdentityKey_(candidateFactualValuesFromRow_(row))]);
}

function candidateFactualValuesFromRow_(row) {
  const columns = {merchant: 1, website: 2, code: 3, discountType: 4, discountValue: 5, minimumSpend: 6,
    validOn: 7, exclusions: 8, expiry: 9, usageLimits: 10, currency: 20, notes: 16};
  const candidate = {};
  MC.fields.forEach(function (field) { candidate[field] = reviewSourceValue_(row[columns[field]]); });
  return candidate;
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

function appendCouponRow_(sheet, row, key) {
  if (!Array.isArray(row) || row.length !== MC.headers.length) fail_('WRITE');
  const rowNumber = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  const stored = sheet.getRange(rowNumber, 1, 1, row.length).getValues()[0];
  if (stored.length !== row.length || String(stored[13]) !== String(row[13]) ||
      String(stored[16]) !== String(row[16]) || String(stored[20]) !== String(row[20])) fail_('WRITE');
  persistCandidateKey_(sheet, rowNumber, key);
  return rowNumber;
}

function extractCouponOutcomeForState_(state, message) {
  if (state && typeof state.extractCouponOutcome === 'function') return state.extractCouponOutcome(message);
  const hooks = Object.assign({}, state && state.extractionHooks || {});
  if (state && state._deadlineMs) hooks.deadlineMs = state._deadlineMs;
  return extractCouponOutcome_(message, hooks);
}

function reconcileCandidateRows_(sheet, journal) {
  if (!candidateStates_(journal.candidateStates, journal.candidateKeys, journal.rowNumbers)) fail_('STATE');
  journal.candidateStates.forEach(function (candidate) {
    const index = journal.candidateKeys.indexOf(candidate.key);
    if (index < 0) fail_('STATE');
    const rowNumber = resolveCandidateRow_(sheet, journal.messageId, candidate.key, journal.rowNumbers[index]);
    candidate.rowNumber = rowNumber;
    journal.rowNumbers[index] = rowNumber;
  });
}

function finalizeImportedMessage_(state, journal) {
  if (!completeCandidateBatch_(journal)) fail_('STATE');
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
