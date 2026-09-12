const AI_EXTRACTION = Object.freeze({maxPromptText: 60000, maxCandidates: 12, maxResponse: 1024 * 1024});

function aiCandidateKeys_() { return MC.fields.concat(['confidence', 'review', 'evidence']); }

function buildCandidatePrompt_(message) {
  return candidatePrompt_(message).text;
}

function candidatePrompt_(message) {
  const source = candidateSource_(message);
  const instruction = [
    'Extract coupon offers from the supplied message. Return JSON only, with no prose or Markdown.',
    'Leave uncertain facts empty. Never invent a merchant, condition, expiry, link, or code.',
    'Every non-empty factual field must have evidence.quote and/or evidence.image.',
    'An image-only fact is always review=true. Use only inspected image indexes.',
    'Response schema: {"candidates":[candidate, ...]}. Each candidate has exactly these keys: ' +
      aiCandidateKeys_().join(', ') + '.',
    'Candidate fields: ' + MC.fields.join(', ') + '. confidence is high, medium, or low; review is boolean.',
    'Evidence keys are candidate field names; each evidence value has only quote and/or image.',
    'INSPECTED IMAGES: ' + source.images.length + ' images, indexed from 0.'
  ].join('\n\n');
  const subjectLabel = '\n\nSUBJECT (independent evidence span):\n';
  const textLabel = '\n\nTEXT (independent plain text):\n';
  const htmlLabel = '\n\nHTML-DERIVED SOURCE CONTEXT (separate spans):\n';
  const budget = AI_EXTRACTION.maxPromptText - instruction.length - subjectLabel.length - textLabel.length - htmlLabel.length;
  if (budget < 0) fail_('GEMINI_REQUEST');
  const subject = source.sourceSpans.filter(function (span) { return span.kind === 'subject'; })
    .map(function (span) { return span.text; }).join('\n');
  const text = source.sourceSpans.filter(function (span) { return span.kind === 'text'; })
    .map(function (span) { return span.text; }).join('\n');
  const htmlContext = source.sourceSpans.filter(function (span) { return span.kind === 'html'; })
    .map(function (span) { return span.text; }).join('\n');
  const subjectBudget = Math.floor(budget / 4);
  const textBudget = Math.floor((budget - subjectBudget) / 2);
  const boundedSubject = boundedText_(subject, subjectBudget);
  const boundedText = boundedText_(text, textBudget);
  const boundedHtml = boundedText_(htmlContext, budget - boundedSubject.length - boundedText.length);
  return {text: instruction + subjectLabel + boundedSubject + textLabel + boundedText + htmlLabel + boundedHtml,
    truncated: boundedSubject !== subject || boundedText !== text || boundedHtml !== htmlContext};
}

function duplicateJsonKeys_(json) {
  const stack = [], string = function (index) { while (index < json.length) { if (json[index] === '\\') index += 2; else if (json[index++] === '"') return index; } return index; };
  for (let i = 0; i < json.length; i++) {
    if (json[i] === '"') { const start = i; i = string(i + 1) - 1; if (json.slice(i + 1).match(/^\s*:/)) {
      let key;
      try { key = JSON.parse(json.slice(start, i + 1)); } catch (e) { fail_('AI'); }
      const object = stack[stack.length - 1];
      if (object && object.has(key)) return true; if (object) object.add(key);
    }} else if (json[i] === '{') stack.push(new Set()); else if (json[i] === '}') stack.pop();
  }
  return false;
}

function parseAICandidateOutcome_(response, message) {
  if (!response || typeof response.text !== 'string' || response.text.length > AI_EXTRACTION.maxResponse ||
      /^\s*```|```\s*$/.test(response.text) || duplicateJsonKeys_(response.text)) fail_('AI');
  let body;
  try { body = JSON.parse(response.text); } catch (e) { fail_('AI'); }
  if (!plainObjectWithKeys_(body, ['candidates']) || !Array.isArray(body.candidates) ||
      body.candidates.length > AI_EXTRACTION.maxCandidates) fail_('AI');
  let invalidated = 0;
  const candidates = body.candidates.map(function (candidate) {
    if (!plainObjectWithKeys_(candidate, aiCandidateKeys_()) ||
        Object.getOwnPropertyNames(candidate).length !== aiCandidateKeys_().length) fail_('AI');
    const evidence = candidate.evidence;
    if (!plainObjectWithKeys_(evidence || {}, MC.fields) ||
        Object.keys(evidence || {}).some(function (key) {
          return !candidate[key] || !plainObjectWithKeys_(evidence[key], ['quote', 'image']) ||
            Object.keys(evidence[key]).length < 1;
        }) || MC.fields.some(function (key) { return candidate[key] && !Object.prototype.hasOwnProperty.call(evidence, key); })) fail_('AI');
    const normalized = normalizeCandidate_(candidate, message);
    if (!(normalized.merchant || normalized.code || normalized.website || normalized.discountType && normalized.discountValue)) {
      invalidated++;
      return null;
    }
    return normalized;
  }).filter(function (candidate) {
    return candidate !== null;
  });
  // An empty syntactically valid response is distinct from a candidate that was
  // discarded because its claimed facts could not be grounded in the source.
  return {candidates: candidates, modelEmpty: body.candidates.length === 0, invalidated: invalidated > 0};
}

function parseAICandidates_(response, message) {
  return parseAICandidateOutcome_(response, message).candidates;
}

function candidateMergeKey_(candidate) {
  return JSON.stringify(['merchant', 'website', 'code', 'discountType', 'discountValue', 'minimumSpend', 'expiry']
    .map(function (field) { return candidateFieldIdentity_(field, candidate[field]); }));
}

function exactCandidateIdentityKey_(candidate) {
  return JSON.stringify(MC.fields.map(function (field) {
    return candidateFieldIdentity_(field, candidate[field]);
  }));
}

function candidateFieldIdentity_(field, value) {
  const raw = String(value == null ? '' : value);
  if (field === 'website') return candidateWebsiteIdentity_(raw);
  return field === 'code' ? raw : normalized_(raw);
}

function candidateWebsiteIdentity_(value) {
  // Only the HTTPS scheme and authority are case-insensitive. Path, query and
  // fragment spelling (including percent escapes) remain part of the identity.
  return String(value || '').replace(/^https:\/\/[^/?#]+/i, function (authority) { return authority.toLowerCase(); });
}

function mergeCouponCandidates_(left, right) {
  const merged = {};
  MC.fields.forEach(function (field) { merged[field] = right[field] || left[field] || ''; });
  merged.confidence = right.confidence || left.confidence;
  merged.review = Boolean(right.review);
  merged.imageEvidence = right.imageEvidence || left.imageEvidence || {};
  return merged;
}

function sameCouponOffer_(left, right) {
  // A non-empty code is an exact Unicode/case/punctuation identity. A blank
  // deterministic proposal may enrich from AI, but two separate described
  // offers that happen to reuse a code remain separate for review.
  const sparse = function (candidate) {
    return !!candidate.code && !candidate.merchant && !candidate.website && !candidate.discountType &&
      !candidate.discountValue && !candidate.minimumSpend && !candidate.validOn && !candidate.exclusions &&
      !candidate.expiry && !candidate.usageLimits && !candidate.currency;
  };
  if (exactCandidateIdentityKey_(left) === exactCandidateIdentityKey_(right)) return true;
  return !!left.code && left.code === right.code && (sparse(left) || sparse(right));
}

function uniqueAICandidates_(candidates) {
  const result = [];
  candidates.forEach(function (candidate) {
    const key = exactCandidateIdentityKey_(candidate);
    const index = result.findIndex(function (prior) { return exactCandidateIdentityKey_(prior) === key; });
    if (index < 0) result.push(candidate);
    else {
      const merged = mergeCouponCandidates_(result[index], candidate);
      merged.review = result[index].review || candidate.review;
      result[index] = merged;
    }
  });
  return result;
}

function extractCouponOutcome_(message, hooks) {
  // Validate all source ownership, HTML coverage, and image records before any fetch.
  const source = candidateSource_(message);
  const prompt = candidatePrompt_(message);
  const images = source.images.map(function (image) {
    if (!image || typeof image.mimeType !== 'string' || !Array.isArray(image.bytes)) fail_('AI');
    return {mimeType: image.mimeType, data: Utilities.base64EncodeWebSafe(image.bytes)};
  });
  const aiOutcome = parseAICandidateOutcome_(callGeminiModel_({text: prompt.text, images: images}, hooks), message);
  // Consolidate exact model duplicates before sparse deterministic enrichment
  // adds copied source notes that could make an identical proposal look new.
  const ai = uniqueAICandidates_(aiOutcome.candidates);
  const deterministicOutcome = deterministicCandidateOutcome_(message);
  const deterministic = deterministicOutcome.candidates.map(function (candidate) {
    return {merchant: '', website: '', code: candidate.code, discountType: '', discountValue: '', minimumSpend: '',
      validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: candidate.notes,
      confidence: candidate.confidence, review: true};
  });
  const result = deterministic.slice();
  ai.forEach(function (candidate) {
    const existing = result.findIndex(function (prior) { return sameCouponOffer_(prior, candidate); });
    if (existing < 0) result.push(candidate);
    else result[existing] = mergeCouponCandidates_(result[existing], candidate);
  });
  if (result.length > MC.maxCandidates) fail_('AI');
  // This is deliberately descriptive, not authorization to mutate Gmail. In
  // particular, an empty complete outcome only means no candidate was found.
  const complete = !source.incomplete && !prompt.truncated && deterministicOutcome.complete;
  const autoConfirmed = result.length > 0 && complete && !aiOutcome.invalidated && result.every(function (candidate) {
    return candidateAutomaticallyConfirmed_(candidate);
  });
  return {status: complete ? 'complete' : 'incomplete', candidates: result,
    empty: result.length === 0, modelEmpty: aiOutcome.modelEmpty, invalidated: aiOutcome.invalidated,
    verifiedNonOffer: complete && result.length === 0 && aiOutcome.modelEmpty,
    archiveAllowed: autoConfirmed};
}

function candidateAutomaticallyConfirmed_(candidate) {
  return !!candidate && !candidate.review && !!candidate.merchant &&
    !!(candidate.code || candidate.website || candidate.discountType && candidate.discountValue);
}

function extractCouponCandidates_(message, hooks) {
  return extractCouponOutcome_(message, hooks).candidates;
}
