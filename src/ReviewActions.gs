const MC_REVIEW_ACTIONS = Object.freeze([EN.actions.confirm, EN.actions.ignore, EN.actions.retry_ai]);

function onReviewEdit(e) {
  if (!e || !e.range || !e.range.getSheet || !e.value) return;
  const sheet = e.range.getSheet();
  const rowNumber = e.range.getRow();
  const action = String(e.value);
  if (e.range.getColumn() !== MC.headers.indexOf('Action needed') + 1 || rowNumber < 2 ||
      MC_REVIEW_ACTIONS.indexOf(action) < 0) return;
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
  const key = String(row[16] || '');
  const state = key && findMessageStateByDedupeKey_(journalSheet, key);
  if (!state) return reviewFailure_(sheet, rowNumber, 'STATE');
  if (!candidateStates_(state.candidateStates)) {
    state.candidateStates = state.candidateKeys.map(function (candidateKey, index) {
      return {key: candidateKey, rowNumber: state.rowNumbers[index], status: 'review'};
    });
    state.version = 2;
  }
  const candidate = state.candidateStates.filter(function (item) { return item.key === key; });
  const currentRow = findCouponRowByDedupeKey_(sheet, key);
  if (candidate.length !== 1 || currentRow !== rowNumber) return reviewFailure_(sheet, rowNumber, 'STATE');
  candidate[0].rowNumber = rowNumber;
  const stateIndex = state.candidateKeys.indexOf(key);
  if (stateIndex < 0) return reviewFailure_(sheet, rowNumber, 'STATE');
  state.rowNumbers[stateIndex] = rowNumber;
  if (action === EN.actions.ignore) {
    setReviewStatus_(sheet, rowNumber, EN.statuses.ignored, '');
    candidate[0].status = 'ignored';
    return completeReviewMessage_(state, sheet, journalSheet, c);
  }
  const message = getReviewMessage_(state.messageId);
  if (action === EN.actions.retry_ai) return retryReviewCandidate_(sheet, rowNumber, state, candidate[0], message, journalSheet, c);
  if (!validateReviewRow_(row, message, displayRow, candidate[0].imageEvidence)) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  setReviewStatus_(sheet, rowNumber, EN.statuses.confirmed, '');
  candidate[0].status = 'confirmed';
  completeReviewMessage_(state, sheet, journalSheet, c);
}

function getReviewMessage_(messageId) {
  let raw;
  try { raw = Gmail.Users.Messages.get('me', messageId, {format: 'full'}); } catch (e) { fail_('MAIL'); }
  return canonicalGmailMessage_(raw);
}

function validateReviewRow_(row, message, displayRow, imageEvidence) {
  if (!Array.isArray(row) || !message) return false;
  const merchant = String(row[1] || '').trim();
  const code = String(row[3] || '').trim();
  const website = String(row[2] || '').trim();
  const discountType = String(row[4] || '').trim();
  const discountValue = String(row[5] || '').trim();
  if (!merchant || !(code || website || discountType && discountValue)) return false;
  const expiry = String((displayRow || row)[9] || '').trim();
  if (expiry && !validDate_(expiry)) return false;
  if (!reviewSourceColumnsMatch_(row, message)) return false;
  const candidate = {merchant: row[1], website: row[2], code: row[3], discountType: row[4], discountValue: row[5],
    minimumSpend: row[6], validOn: row[7], exclusions: row[8], expiry: expiry, usageLimits: row[10], currency: row[20]};
  const source = candidateSource_(message);
  const spans = source.spans.concat([message.subject, message.sender].filter(function (value) { return typeof value === 'string' && value; }));
  if (discountType || discountValue) {
    const pairedImage = imageEvidence && imageEvidence.discountType === imageEvidence.discountValue &&
      inspectedImageBySourceId_(source.images, imageEvidence.discountType);
    if (!discountType || !discountValue || !pairedImage && !spans.some(function (span) { return discountPairInSpan_(discountType, discountValue, span); })) return false;
  }
  return MC.fields.filter(function (field) { return field !== 'discountType' && field !== 'discountValue'; }).every(function (field) {
    const value = String(candidate[field] || '').trim();
    return !value || imageEvidence && inspectedImageBySourceId_(source.images, imageEvidence[field]) ||
      spans.some(function (span) { return fieldInQuote_(field, value, span); });
  });
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
  sheet.getRange(rowNumber, 18).setValues([[status]]);
  sheet.getRange(rowNumber, 25).setValues([[action]]);
  const stored = sheet.getRange(rowNumber, 18, 1, 8).getValues()[0];
  if (String(stored[0]) !== status || String(stored[7]) !== action) fail_('WRITE');
}

function reviewFailure_(sheet, rowNumber, code) {
  sheet.getRange(rowNumber, 18).setValues([[EN.statuses.review]]);
  sheet.getRange(rowNumber, 25).setValues([[EN.actions.confirm]]);
  return {status: 'failed', code: code};
}

function retryReviewCandidate_(sheet, rowNumber, state, candidate, message, journalSheet, c) {
  let candidates;
  try { candidates = extractCouponCandidates_(message); } catch (e) { return reviewFailure_(sheet, rowNumber, errorCode_(e)); }
  const row = sheet.getRange(rowNumber, 1, 1, MC.headers.length).getDisplayValues()[0];
  const enriched = candidates.filter(function (item) { return retryCandidateMatchesRow_(item, row); });
  if (enriched.length !== 1) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  const updated = couponRow_(message, enriched[0], candidate.key);
  const existing = sheet.getRange(rowNumber, 1, 1, updated.length).getValues()[0];
  const merged = existing.slice();
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 24].forEach(function (column) {
    merged[column] = updated[column];
  });
  sheet.getRange(rowNumber, 1, 1, merged.length).setValues([merged]);
  candidate.imageEvidence = enriched[0].imageEvidence || {};
  candidate.status = enriched[0].review ? 'review' : 'confirmed';
  completeReviewMessage_(state, sheet, journalSheet, c);
}

function retryCandidateMatchesRow_(candidate, row) {
  const code = String(row[3] || '');
  const website = String(row[2] || '');
  return !!candidate.merchant && (code ? candidate.code === code : !!website && candidate.website === website);
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
  if (!state.candidateStates.every(function (item) { return String(sheet.getRange(item.rowNumber, 18).getDisplayValues()[0][0]) === EN.statuses.confirmed; })) return;
  try {
    if (!state.labelApplied) { modifyReviewMessage_(state.messageId, {addLabelIds: [c.labelId]}); state.labelApplied = true; }
    if (!state.archived) { modifyReviewMessage_(state.messageId, {removeLabelIds: ['INBOX']}); state.archived = true; }
    state.status = 'confirmed'; state.outcome = 'archive'; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
  } catch (e) {
    if (state.labelApplied || state.archived) {
      state.status = 'confirmed'; state.outcome = 'archive'; state.updatedAt = new Date().toISOString();
      try { saveMessageState_(journalSheet, state); } catch (ignored) {}
      throw e;
    }
    state.candidateStates.forEach(function (item) {
      item.status = 'review';
      setReviewStatus_(sheet, item.rowNumber, EN.statuses.review, EN.actions.confirm);
    });
    state.status = 'review'; state.outcome = 'review'; state.lastError = errorCode_(e);
    state.failureStage = 'mail'; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
  }
}

function inspectedImageBySourceId_(images, sourceId) {
  return typeof sourceId === 'string' && images.some(function (image) {
    return inspectedImage_(image) && image.sourceId === sourceId;
  });
}

function restoreReviewRows_(state, sheet) {
  state.candidateStates.forEach(function (item) {
    if (item.status === 'confirmed') { item.status = 'review'; setReviewStatus_(sheet, item.rowNumber, EN.statuses.review, EN.actions.confirm); }
  });
}

function modifyReviewMessage_(messageId, body) {
  let result;
  try { result = Gmail.Users.Messages.modify(body, 'me', messageId); } catch (e) { fail_('MAIL'); }
  if (!result || result.id !== messageId || !Array.isArray(result.labelIds)) fail_('MAIL');
  return result;
}
