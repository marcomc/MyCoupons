function reviewActions_() {
  return [EN.actions.confirm, EN.actions.ignore, EN.actions.retry_ai];
}

function onReviewEdit(e) {
  if (!e || !e.range || !e.range.getSheet || !e.value) return;
  const sheet = e.range.getSheet();
  const rowNumber = e.range.getRow();
  const action = String(e.value);
  if (e.range.getColumn() !== MC.headers.indexOf('Action needed') + 1 || rowNumber < 2 ||
      reviewActions_().indexOf(action) < 0) return;
  withLock_(function () {
    const c = config_();
    if (sheet.getName() !== c.sheetName) return;
    const spreadsheet = sheet.getParent();
    if (!spreadsheet || typeof spreadsheet.getId !== 'function' || String(spreadsheet.getId()) !== String(c.spreadsheetId)) return;
    assertPrivateSpreadsheet_(spreadsheet, c);
    const current = sheet.getRange(rowNumber, 18, 1, 8).getValues()[0];
    if (String(current[0]) !== EN.statuses.review || String(current[7]) !== action) return;
    processReviewAction_(sheet, rowNumber, action, c);
  });
}

function processReviewAction_(sheet, rowNumber, action, c) {
  const journalSheet = SpreadsheetApp.openById(c.spreadsheetId).getSheetByName(MC.journalName);
  const range = sheet.getRange(rowNumber, 1, 1, MC.headers.length);
  const row = range.getValues()[0];
  const displayRow = range.getDisplayValues()[0];
  const formulas = range.getFormulas()[0];
  const noteKey = candidateKeyFromNote_(sheet.getRange(rowNumber, 14).getNote());
  const visibleNotes = String(row[16] || '');
  let state = noteKey ? findMessageStateByDedupeKey_(journalSheet, noteKey) : null;
  // Deployed legacy rows used visible Notes for the technical key. Keep them
  // reviewable without extending that legacy storage mistake.
  if (!state && !noteKey && visibleNotes) state = findMessageStateByDedupeKey_(journalSheet, visibleNotes);
  if (!state) state = findMessageStateByRowNumber_(journalSheet, rowNumber);
  if (!state) return reviewFailure_(sheet, rowNumber, 'STATE');
  if (!candidateStates_(state.candidateStates, state.candidateKeys, state.rowNumbers)) {
    state.candidateStates = state.candidateKeys.map(function (candidateKey, index) {
      return {key: candidateKey, rowNumber: state.rowNumbers[index], status: 'review'};
    });
    state.version = 2;
  }
  const key = reviewCandidateKey_(state, rowNumber, noteKey, visibleNotes);
  const stateIndex = state.candidateKeys.indexOf(key);
  const candidate = state.candidateStates.filter(function (item) { return item.key === key; });
  const legacyTechnicalNotes = !noteKey && String(row[16] || '') === key;
  if (candidate.length !== 1 || stateIndex < 0 || resolveCandidateRow_(sheet, state.messageId, key, state.rowNumbers[stateIndex]) !== rowNumber ||
      sourceId_(row[13]) !== state.messageId) return reviewFailure_(sheet, rowNumber, 'STATE');
  candidate[0].rowNumber = rowNumber;
  state.rowNumbers[stateIndex] = rowNumber;
  if (action === EN.actions.ignore) {
    setReviewStatus_(sheet, rowNumber, EN.statuses.ignored, '');
    candidate[0].status = 'ignored';
    return completeReviewMessage_(state, sheet, journalSheet, c);
  }
  const message = getReviewMessage_(state.messageId);
  if (action === EN.actions.retry_ai) return retryReviewCandidate_(sheet, rowNumber, state, candidate[0], message, journalSheet, c);
  if (!validateReviewRow_(row, message, displayRow, candidate[0].imageEvidence, formulas, c, key, legacyTechnicalNotes)) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  setReviewStatus_(sheet, rowNumber, EN.statuses.confirmed, '');
  candidate[0].status = 'confirmed';
  completeReviewMessage_(state, sheet, journalSheet, c);
}

function getReviewMessage_(messageId) {
  let raw;
  try { raw = Gmail.Users.Messages.get('me', messageId, {format: 'full'}); } catch (e) { fail_('MAIL'); }
  return canonicalGmailMessage_(raw);
}

function reviewCandidateKey_(state, rowNumber, noteKey, visibleNotes) {
  if (noteKey) return noteKey;
  const visible = String(visibleNotes || '');
  if (state && Array.isArray(state.candidateKeys) && state.candidateKeys.indexOf(visible) >= 0) return visible;
  const index = state && Array.isArray(state.rowNumbers) ? state.rowNumbers.indexOf(rowNumber) : -1;
  return index < 0 ? '' : state.candidateKeys[index];
}

function validateReviewRow_(row, message, displayRow, imageEvidence, formulas, c, technicalKey, legacyTechnicalNotes) {
  if (!Array.isArray(row) || !message) return false;
  formulas = Array.isArray(formulas) ? formulas : Array(MC.headers.length).fill('');
  if (formulas.slice(0, 14).concat([formulas[16]], formulas.slice(20, 21)).some(function (formula) { return !!formula; })) return false;
  const merchant = reviewSourceValue_(row[1]).trim();
  const code = reviewSourceValue_(row[3]).trim();
  const website = reviewSourceValue_(row[2]).trim();
  const discountType = reviewSourceValue_(row[4]).trim();
  const discountValue = reviewSourceValue_(row[5]).trim();
  if (!reviewCandidateFieldsValid_(row)) return false;
  if (!merchant || !(code || website || discountType && discountValue)) return false;
  const expiry = row[9] instanceof Date ? Utilities.formatDate(row[9], c.timeZone, 'yyyy-MM-dd') : String((displayRow || row)[9] || '').trim();
  if (expiry && !validDate_(expiry)) return false;
  if (!reviewSourceColumnsMatch_(row, message)) return false;
  const candidate = {merchant: merchant, website: website, code: code, discountType: discountType, discountValue: discountValue,
    minimumSpend: reviewSourceValue_(row[6]), validOn: reviewSourceValue_(row[7]), exclusions: reviewSourceValue_(row[8]), expiry: expiry, usageLimits: reviewSourceValue_(row[10]), currency: reviewSourceValue_(row[20]),
    notes: candidateNotesForReview_(row, technicalKey, legacyTechnicalNotes)};
  const source = candidateSource_(message);
  const spans = source.spans;
  if (discountType || discountValue) {
    const pairedImage = reviewFieldImageEvidence_(imageEvidence, 'discountType', discountType, source.images) &&
      reviewFieldImageEvidence_(imageEvidence, 'discountValue', discountValue, source.images) &&
      imageEvidence.discountType.sourceId === imageEvidence.discountValue.sourceId;
    if (!discountType || !discountValue || !pairedImage && !spans.some(function (span) { return discountPairInSpan_(discountType, discountValue, span); })) return false;
  }
  return MC.fields.filter(function (field) { return field !== 'discountType' && field !== 'discountValue'; }).every(function (field) {
    const value = String(candidate[field] || '').trim();
    return !value || reviewFieldImageEvidence_(imageEvidence, field, value, source.images) ||
      spans.some(function (span) { return fieldInQuote_(field, value, span); });
  });
}

function candidateNotesForReview_(row, key, legacyTechnicalNotes) {
  const value = reviewSourceValue_(row[16]);
  return legacyTechnicalNotes && value === key ? '' : value;
}

function reviewCandidateFieldsValid_(row) {
  const columns = {merchant: 1, website: 2, code: 3, discountType: 4, discountValue: 5, minimumSpend: 6,
    validOn: 7, exclusions: 8, expiry: 9, usageLimits: 10, currency: 20, notes: 16};
  return MC.fields.every(function (field) {
    const index = columns[field];
    const raw = reviewSourceValue_(row[index]);
    const limit = field === 'notes' ? 3500 : 1000;
    if (!wellFormedUtf16_(raw) || raw.length > limit) return false;
    if (field === 'code' && raw !== raw.trim()) return false;
    if (field === 'website' && raw && safeUrl_(raw) !== raw) return false;
    return true;
  });
}

function reviewSourceValue_(value) {
  const raw = String(value == null ? '' : value);
  return /^'[=+@-]/.test(raw) ? raw.slice(1) : raw;
}

function reviewSourceColumnsMatch_(row, message) {
  const date = row[0];
  return date instanceof Date && date.getTime() === message.receivedAtMs &&
    String(row[11] || '') === textCell_(message.subject) && String(row[12] || '') === textCell_(message.sender) &&
    String(row[13] || '') === message.link;
}

function discountPairInSpan_(type, value, span) {
  const values = fieldOccurrences_('discountValue', String(value), span);
  const types = fieldOccurrences_('discountType', String(type), span);
  return values.some(function (numeric) {
    return types.some(function (unit) {
      const between = numeric.end <= unit.start ? span.slice(numeric.end, unit.start) :
        unit.end <= numeric.start ? span.slice(unit.end, numeric.start) : null;
      return between !== null && /^\s*$/u.test(between);
    });
  });
}

function setReviewStatus_(sheet, rowNumber, status, action) {
  const statusRange = sheet.getRange(rowNumber, 18);
  const actionRange = sheet.getRange(rowNumber, 25);
  try {
    actionRange.setValues([[action]]);
    statusRange.setValues([[status]]);
    const stored = sheet.getRange(rowNumber, 18, 1, 8).getValues()[0];
    if (String(stored[0]) !== status || String(stored[7]) !== action) fail_('WRITE');
  } catch (e) {
    try { statusRange.setValues([[EN.statuses.review]]); actionRange.setValues([[EN.actions.confirm]]); } catch (ignored) {}
    throw e;
  }
}

function reviewFailure_(sheet, rowNumber, code) {
  sheet.getRange(rowNumber, 18).setValues([[EN.statuses.review]]);
  sheet.getRange(rowNumber, 25).setValues([[EN.actions.confirm]]);
  return {status: 'failed', code: code};
}

function retryReviewCandidate_(sheet, rowNumber, state, candidate, message, journalSheet, c) {
  let extraction;
  try { extraction = extractCouponOutcome_(message); } catch (e) { return reviewFailure_(sheet, rowNumber, errorCode_(e)); }
  const candidates = extraction.candidates;
  const row = sheet.getRange(rowNumber, 1, 1, MC.headers.length).getDisplayValues()[0];
  const enriched = candidates.filter(function (item) { return retryCandidateMatchesRow_(item, row); });
  if (enriched.length !== 1) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  const knownRows = state.candidateStates.map(function (known) {
    const index = state.candidateKeys.indexOf(known.key);
    if (index < 0) return null;
    const resolved = resolveCandidateRow_(sheet, state.messageId, known.key, state.rowNumbers[index]);
    known.rowNumber = resolved; state.rowNumbers[index] = resolved;
    return sheet.getRange(resolved, 1, 1, MC.headers.length).getDisplayValues()[0];
  });
  if (knownRows.some(function (knownRow) { return !knownRow; })) return reviewFailure_(sheet, rowNumber, 'STATE');
  if (candidates.length !== knownRows.length || knownRows.some(function (knownRow) {
    return candidates.filter(function (item) { return retryCandidateMatchesRow_(item, knownRow); }).length !== 1;
  }) || candidates.some(function (item) {
    return knownRows.filter(function (knownRow) { return retryCandidateMatchesRow_(item, knownRow); }).length !== 1;
  })) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  const updatedCandidate = Object.assign({}, enriched[0], {review: enriched[0].review || !extraction.archiveAllowed});
  const updated = couponRow_(message, updatedCandidate);
  persistCandidateKey_(sheet, rowNumber, candidate.key);
  const existing = sheet.getRange(rowNumber, 1, 1, updated.length).getValues()[0];
  const existingFormulas = sheet.getRange(rowNumber, 1, 1, updated.length).getFormulas()[0];
  const merged = existing.slice();
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 24].forEach(function (column) {
    merged[column] = updated[column];
  });
  sheet.getRange(rowNumber, 1, 1, merged.length).setValues([merged]);
  existingFormulas.forEach(function (formula, index) {
    if (formula && [18, 19, 21, 22, 23, 25].indexOf(index) >= 0) sheet.getRange(rowNumber, index + 1).setFormula(formula);
  });
  candidate.imageEvidence = enriched[0].imageEvidence || {};
  candidate.status = updatedCandidate.review ? 'review' : 'confirmed';
  completeReviewMessage_(state, sheet, journalSheet, c);
}

function retryCandidateMatchesRow_(candidate, row) {
  const columns = {merchant: 1, website: 2, code: 3, discountType: 4, discountValue: 5, minimumSpend: 6,
    validOn: 7, exclusions: 8, expiry: 9, usageLimits: 10, currency: 20, notes: 16};
  return !!candidate.merchant && MC.fields.every(function (field) {
    const value = reviewSourceValue_(row[columns[field]] || '');
    return !value || String(candidate[field] || '') === value;
  });
}

function completeReviewMessage_(state, sheet, journalSheet, c) {
  state.outcome = messageOutcome_(state.candidateStates.map(function (item) { return {status: item.status}; }));
  state.updatedAt = new Date().toISOString();
  if (state.outcome === 'review') {
    state.status = 'review';
    try { saveMessageState_(journalSheet, state); } catch (e) { restoreReviewRows_(state, sheet); throw e; }
    return;
  }
  if (state.outcome === 'unchanged') {
    state.status = 'ignored';
    try { saveMessageState_(journalSheet, state); } catch (e) { restoreReviewRows_(state, sheet); throw e; }
    return;
  }
  state.status = 'processing'; state.failureStage = 'mail';
  try { saveMessageState_(journalSheet, state); } catch (e) { restoreReviewRows_(state, sheet); throw e; }
  try {
    if (!refreshAndValidateReviewRows_(state, sheet, c)) { restoreReviewRows_(state, sheet); state.status = 'review'; state.outcome = 'review'; saveMessageState_(journalSheet, state); return; }
  } catch (e) {
    restoreReviewRows_(state, sheet); state.status = 'review'; state.outcome = 'review'; state.lastError = errorCode_(e); saveMessageState_(journalSheet, state); return;
  }
  try {
    if (!state.labelApplied) {
      const labelled = modifyReviewMessage_(state.messageId, {addLabelIds: [c.labelId]});
      if (labelled.labelIds.indexOf(c.labelId) < 0) fail_('MAIL');
      state.labelApplied = true; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
    }
    if (!state.archived) {
      const archived = modifyReviewMessage_(state.messageId, {removeLabelIds: ['INBOX']});
      if (archived.labelIds.indexOf('INBOX') >= 0) fail_('MAIL');
      state.archived = true; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
    }
    state.status = 'confirmed'; state.outcome = 'archive'; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
  } catch (e) {
    // Gmail may have accepted an operation even when its acknowledgement is
    // uncertain. Preserve the already validated confirmed rows and durable
    // archive intent; the initial workflow retries idempotent per-message
    // mutations instead of asking the user to confirm a second time.
    state.status = 'failed'; state.outcome = 'archive'; state.failureStage = 'mail';
    state.lastError = errorCode_(e); state.updatedAt = new Date().toISOString();
    try { saveMessageState_(journalSheet, state); } catch (ignored) {}
    throw e;
  }
}

function reviewFieldImageEvidence_(evidence, field, value, images) {
  const item = evidence && evidence[field];
  return item && item.valueDigest === digest_(value) && typeof item.sourceId === 'string' && typeof item.digest === 'string' && images.some(function (image) {
    return inspectedImage_(image) && image.sourceId === item.sourceId && imageEvidenceDigest_(image) === item.digest;
  });
}

function imageEvidenceDigest_(image) {
  return image && Array.isArray(image.bytes) ? digest_(Utilities.base64EncodeWebSafe(image.bytes)) : '';
}

function restoreReviewRows_(state, sheet) {
  state.candidateStates.forEach(function (item) {
    if (item.status !== 'review') { item.status = 'review'; setReviewStatus_(sheet, item.rowNumber, EN.statuses.review, EN.actions.confirm); }
  });
}

function refreshAndValidateReviewRows_(state, sheet, c) {
  const message = getReviewMessage_(state.messageId);
  const complete = state.candidateStates.every(function (item) {
    const index = state.candidateKeys.indexOf(item.key);
    if (index < 0) return false;
    const rowNumber = resolveCandidateRow_(sheet, state.messageId, item.key, state.rowNumbers[index]);
    item.rowNumber = rowNumber;
    state.rowNumbers[index] = rowNumber;
    return true;
  });
  if (!complete) return false;
  return state.candidateStates.every(function (item) {
    const range = sheet.getRange(item.rowNumber, 1, 1, MC.headers.length);
    const row = range.getValues()[0];
    const noteKey = candidateKeyFromNote_(sheet.getRange(item.rowNumber, 14).getNote());
    const legacyTechnicalNotes = !noteKey && String(row[16] || '') === item.key;
    return String(row[17]) === EN.statuses.confirmed && validateReviewRow_(row, message, range.getDisplayValues()[0], item.imageEvidence, range.getFormulas()[0], c, item.key, legacyTechnicalNotes);
  });
}

function modifyReviewMessage_(messageId, body) {
  let result;
  try { result = Gmail.Users.Messages.modify(body, 'me', messageId); } catch (e) { fail_('MAIL'); }
  if (!result || result.id !== messageId || !Array.isArray(result.labelIds)) fail_('MAIL');
  return result;
}
