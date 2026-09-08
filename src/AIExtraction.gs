const AI_EXTRACTION = Object.freeze({maxPromptText: 60000, maxCandidates: 12, maxResponse: 1024 * 1024});

function aiCandidateKeys_() { return MC.fields.concat(['confidence', 'review', 'evidence']); }

function buildCandidatePrompt_(message) {
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
  const budget = AI_EXTRACTION.maxPromptText - instruction.length - 2;
  if (budget < 0) fail_('GEMINI_REQUEST');
  const textBudget = Math.floor(budget / 2);
  const text = boundedText_(source.evidenceSpans[0] || '', textBudget);
  const htmlContext = boundedText_(source.evidenceSpans.slice(1).join('\n'), budget - text.length);
  return instruction + '\n\nTEXT (independent plain text):\n' + text +
    '\n\nHTML-DERIVED SOURCE CONTEXT (separate spans):\n' + htmlContext;
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

function parseAICandidates_(response, message) {
  if (!response || typeof response.text !== 'string' || response.text.length > AI_EXTRACTION.maxResponse ||
      /^\s*```|```\s*$/.test(response.text) || duplicateJsonKeys_(response.text)) fail_('AI');
  let body;
  try { body = JSON.parse(response.text); } catch (e) { fail_('AI'); }
  if (!plainObjectWithKeys_(body, ['candidates']) || !Array.isArray(body.candidates) ||
      body.candidates.length > AI_EXTRACTION.maxCandidates) fail_('AI');
  return body.candidates.map(function (candidate) {
    if (!plainObjectWithKeys_(candidate, aiCandidateKeys_()) ||
        Object.getOwnPropertyNames(candidate).length !== aiCandidateKeys_().length) fail_('AI');
    const evidence = candidate.evidence;
    if (!plainObjectWithKeys_(evidence || {}, MC.fields) ||
        Object.keys(evidence || {}).some(function (key) {
          return !candidate[key] || !plainObjectWithKeys_(evidence[key], ['quote', 'image']) ||
            Object.keys(evidence[key]).length < 1;
        }) || MC.fields.some(function (key) { return candidate[key] && !Object.prototype.hasOwnProperty.call(evidence, key); })) fail_('AI');
    const normalized = normalizeCandidate_(candidate, message);
    return normalized;
  }).filter(function (candidate) {
    return candidate.merchant || candidate.code || candidate.website || candidate.discountType && candidate.discountValue;
  });
}

function candidateMergeKey_(candidate) {
  return [candidate.merchant, candidate.website, candidate.code, candidate.discountType,
    candidate.discountValue, candidate.minimumSpend, candidate.expiry].map(normalized_).join('|');
}

function extractCouponCandidates_(message, hooks) {
  // Validate all source ownership, HTML coverage, and image records before any fetch.
  candidateSource_(message);
  const prompt = buildCandidatePrompt_(message);
  const source = candidateSource_(message);
  const images = source.images.map(function (image) {
    if (!image || typeof image.mimeType !== 'string' || !Array.isArray(image.bytes)) fail_('AI');
    return {mimeType: image.mimeType, data: Utilities.base64EncodeWebSafe(image.bytes)};
  });
  const ai = parseAICandidates_(callGeminiModel_({text: prompt, images: images}, hooks), message);
  const deterministic = deterministicCandidates_(message).map(function (candidate) {
    return {merchant: '', website: '', code: candidate.code, discountType: '', discountValue: '', minimumSpend: '',
      validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: candidate.notes,
      confidence: candidate.confidence, review: true};
  });
  const result = deterministic.slice();
  const keys = result.map(candidateMergeKey_);
  ai.forEach(function (candidate) { if (keys.indexOf(candidateMergeKey_(candidate)) < 0) { keys.push(candidateMergeKey_(candidate)); result.push(candidate); } });
  if (result.length > MC.maxCandidates) fail_('AI');
  return result;
}
