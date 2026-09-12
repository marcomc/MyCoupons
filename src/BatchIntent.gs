/* One immutable extraction payload precedes all coupon-row writes. */
function validBatchIntent_(state) {
  const intent = state.batchIntent;
  if (!recordWithExactKeys_(intent, ['candidates', 'archiveAllowed']) ||
      typeof intent.archiveAllowed !== 'boolean' || !Array.isArray(intent.candidates) ||
      !intent.candidates.length || intent.candidates.length > MC.maxCandidates) return false;
  if (!intent.candidates.every(function (candidate) {
    return recordWithExactKeys_(candidate, MC.fields.concat(['confidence', 'review', 'imageEvidence'])) &&
      MC.fields.every(function (field) {
        const value = candidate[field];
        return typeof value === 'string' && wellFormedUtf16_(value) && value.length <= (field === 'notes' ? 3500 : 1000);
      }) && ['high', 'medium', 'low'].indexOf(candidate.confidence) >= 0 &&
      typeof candidate.review === 'boolean' && imageEvidence_(candidate.imageEvidence) &&
      JSON.stringify(candidate.imageEvidence).length <= 20000;
  })) return false;
  const expected = intent.candidates.map(function (candidate) { return candidateDedupeKey_({id: state.messageId}, candidate); });
  const completedMetadata = Object.assign({}, state, {dedupeKeys: expected, candidateKeys: expected,
    rowNumbers: expected.map(function () { return Number.MAX_SAFE_INTEGER; }),
    candidateStates: intent.candidates.map(function (candidate, index) {
      return {key: expected[index], rowNumber: Number.MAX_SAFE_INTEGER, status: 'confirmed', imageEvidence: candidate.imageEvidence};
    })});
  delete completedMetadata.batchIntent;
  // Reserve room for every future binding in the single mutable metadata cell,
  // including image attestations, before authorizing even the first row write.
  if (JSON.stringify(completedMetadata).length > MC_JOURNAL_CHUNK) return false;
  return new Set(expected).size === expected.length && new Set(state.candidateKeys).size === state.candidateKeys.length &&
    state.dedupeKeys.length === state.candidateKeys.length &&
    state.candidateKeys.every(function (key, index) { return expected.indexOf(key) >= 0 && state.dedupeKeys[index] === key; });
}

function completeCandidateBatch_(state) {
  if (!state || ![1, 2, 3].includes(state.version)) return false;
  if (state.version !== 3) return state.failureStage !== 'legacy_batch' &&
    (!state.candidateKeys.length || ['review', 'confirmed', 'ignored', 'nonoffer'].indexOf(state.status) >= 0 ||
      state.outcome === 'archive' && state.failureStage === 'mail');
  return validBatchIntent_(state) && candidateStates_(state.candidateStates, state.candidateKeys, state.rowNumbers) &&
    state.candidateKeys.length === state.batchIntent.candidates.length;
}

function createBatchIntent_(journal, extraction) {
  // Only new, unbound extraction batches use v3. Deployed bound legacy rows
  // retain their established identities and review semantics.
  if (journal.candidateKeys.length) return;
  journal.batchIntent = {archiveAllowed: extraction.archiveAllowed === true,
    candidates: extraction.candidates.map(function (candidate) {
      const stored = {};
      MC.fields.forEach(function (field) { stored[field] = candidate[field] || ''; });
      stored.confidence = candidate.confidence; stored.review = candidate.review;
      stored.imageEvidence = candidate.imageEvidence || {};
      return stored;
    })};
  journal.version = 3;
  if (!validBatchIntent_(journal)) fail_('STATE');
}

function keepIncompleteBatch_(state, journalSheet) {
  state.status = 'processing'; state.outcome = 'review';
  state.failureStage = state.version === 3 ? 'write' : 'legacy_batch';
  state.updatedAt = new Date().toISOString();
  saveMessageState_(journalSheet, state);
}
