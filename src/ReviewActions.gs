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
  const row = sheet.getRange(rowNumber, 1, 1, MC.headers.length).getValues()[0];
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
  if (candidate.length !== 1 || candidate[0].rowNumber !== rowNumber) return reviewFailure_(sheet, rowNumber, 'STATE');
  if (action === EN.actions.ignore) {
    setReviewStatus_(sheet, rowNumber, EN.statuses.ignored, '');
    candidate[0].status = 'ignored';
    return completeReviewMessage_(state, sheet, journalSheet, c);
  }
  const message = getReviewMessage_(state.messageId);
  if (action === EN.actions.retry_ai) return retryReviewCandidate_(sheet, rowNumber, state, candidate[0], message, journalSheet, c);
  if (!validateReviewRow_(row, message)) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  setReviewStatus_(sheet, rowNumber, EN.statuses.confirmed, '');
  candidate[0].status = 'confirmed';
  completeReviewMessage_(state, sheet, journalSheet, c);
}

function getReviewMessage_(messageId) {
  let raw;
  try { raw = Gmail.Users.Messages.get('me', messageId, {format: 'full'}); } catch (e) { fail_('MAIL'); }
  return canonicalGmailMessage_(raw);
}

function validateReviewRow_(row, message) {
  if (!Array.isArray(row) || !message) return false;
  const merchant = String(row[1] || '').trim();
  const code = String(row[3] || '').trim();
  const website = String(row[2] || '').trim();
  const discountType = String(row[4] || '').trim();
  const discountValue = String(row[5] || '').trim();
  if (!merchant || !(code || website || discountType && discountValue)) return false;
  const candidate = {merchant: row[1], website: row[2], code: row[3], discountType: row[4], discountValue: row[5],
    minimumSpend: row[6], validOn: row[7], exclusions: row[8], expiry: row[9], usageLimits: row[10], currency: row[20]};
  const source = candidateSource_(message);
  return MC.fields.every(function (field) {
    const value = String(candidate[field] || '').trim();
    return !value || source.spans.some(function (span) { return fieldInQuote_(field, value, span); });
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
  const same = candidates.filter(function (item) { return candidateDedupeKey_(message, item, state.candidateKeys.indexOf(candidate.key)) === candidate.key; });
  if (same.length !== 1 || candidates.length !== state.candidateStates.length) return reviewFailure_(sheet, rowNumber, 'REVIEW');
  const updated = couponRow_(message, same[0], candidate.key);
  sheet.getRange(rowNumber, 1, 1, updated.length).setValues([updated]);
  candidate.status = same[0].review ? 'review' : 'confirmed';
  completeReviewMessage_(state, sheet, journalSheet, c);
}

function completeReviewMessage_(state, sheet, journalSheet, c) {
  state.outcome = messageOutcome_(state.candidateStates.map(function (item) { return {status: item.status}; }));
  state.updatedAt = new Date().toISOString();
  if (state.outcome === 'review') { state.status = 'review'; saveMessageState_(journalSheet, state); return; }
  if (state.outcome === 'unchanged') { state.status = 'ignored'; saveMessageState_(journalSheet, state); return; }
  if (!state.candidateStates.every(function (item) { return String(sheet.getRange(item.rowNumber, 18).getDisplayValues()[0][0]) === EN.statuses.confirmed; })) return;
  try {
    if (!state.labelApplied) { modifyReviewMessage_(state.messageId, {addLabelIds: [c.labelId]}); state.labelApplied = true; }
    if (!state.archived) { modifyReviewMessage_(state.messageId, {removeLabelIds: ['INBOX']}); state.archived = true; }
    state.status = 'confirmed'; state.outcome = 'archive'; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
  } catch (e) {
    state.candidateStates.forEach(function (item) {
      item.status = 'review';
      setReviewStatus_(sheet, item.rowNumber, EN.statuses.review, EN.actions.confirm);
    });
    state.status = 'review'; state.outcome = 'review'; state.lastError = errorCode_(e);
    state.failureStage = 'mail'; state.updatedAt = new Date().toISOString(); saveMessageState_(journalSheet, state);
  }
}

function modifyReviewMessage_(messageId, body) {
  let result;
  try { result = Gmail.Users.Messages.modify(body, 'me', messageId); } catch (e) { fail_('MAIL'); }
  if (!result || result.id !== messageId || !Array.isArray(result.labelIds)) fail_('MAIL');
  return result;
}
