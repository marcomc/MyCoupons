const AI_EXTRACTION = Object.freeze({maxPromptText: 60000, maxCandidates: 12, maxResponse: 1024 * 1024});

function aiCandidateKeys_() { return MC.fields.concat(['confidence', 'review']); }

function candidateResponseSchema_() {
  const properties = {};
  MC.fields.forEach(function (field) {
    properties[field] = {type: ['object', 'null'], additionalProperties: false,
      properties: {value: {type: 'string'}, quote: {type: 'string'}, image: {type: ['integer', 'null'], minimum: 0}},
      required: ['value', 'quote', 'image']};
  });
  properties.confidence = {type: 'string', enum: ['high', 'medium', 'low']};
  properties.review = {type: 'boolean'};
  // Do not constrain maxItems: excess offers must reach the rejecting consumer,
  // rather than asking the provider to silently select a subset of the message.
  return {type: 'object', additionalProperties: false, required: ['candidates', 'authentication'],
    properties: {authentication: {type: ['object', 'null'], additionalProperties: false,
      properties: {quote: {type: 'string'}, image: {type: ['integer', 'null'], minimum: 0}},
      required: ['quote', 'image']},
    candidates: {type: 'array', items: {type: 'object', additionalProperties: false,
      properties: properties, required: aiCandidateKeys_()}}}};
}

function exactAIKeys_(value, keys) {
  return plainObjectWithKeys_(value, keys) && Object.getOwnPropertyNames(value).length === keys.length;
}

function validateAIWireCandidate_(candidate, source) {
  if (!exactAIKeys_(candidate, aiCandidateKeys_()) ||
      ['high', 'medium', 'low'].indexOf(candidate.confidence) < 0 || typeof candidate.review !== 'boolean') fail_('AI');
  MC.fields.forEach(function (field) {
    const fact = candidate[field];
    if (fact === null) return;
    if (!exactAIKeys_(fact, ['value', 'quote', 'image']) ||
        typeof fact.value !== 'string' || !fact.value.trim() || !wellFormedUtf16_(fact.value) ||
        typeof fact.quote !== 'string' || !wellFormedUtf16_(fact.quote) ||
        fact.image !== null && (!Number.isInteger(fact.image) || fact.image < 0 ||
          fact.image >= source.images.length || !inspectedImageAt_(source.images, fact.image)) ||
        !fact.quote.trim() && fact.image === null) fail_('AI');
  });
}

function projectAIWireCandidate_(candidate) {
  const raw = Object.create(null);
  raw.confidence = candidate.confidence; raw.review = candidate.review; raw.evidence = Object.create(null);
  MC.fields.forEach(function (field) {
    const fact = candidate[field];
    raw[field] = fact === null ? '' : fact.value;
    if (fact !== null) {
      raw.evidence[field] = Object.create(null);
      if (fact.quote) raw.evidence[field].quote = fact.quote;
      if (fact.image !== null) raw.evidence[field].image = fact.image;
    }
  });
  return raw;
}

function validateAIAuthentication_(authentication, source) {
  if (authentication === null) return;
  if (!exactAIKeys_(authentication, ['quote', 'image']) ||
      typeof authentication.quote !== 'string' || authentication.quote.length > 2000 ||
      !wellFormedUtf16_(authentication.quote)) fail_('AI');
  if (authentication.image === null) {
    // A grounded promotion excerpt is not authentication proof. Text must also
    // satisfy the shared source-derived policy, never a model-only assertion.
    if (!authentication.quote.trim() || !source.spans.some(function (span) { return span.indexOf(authentication.quote) >= 0; }) ||
        !authenticationMessage_(source)) fail_('AI');
    return;
  }
  if (!Number.isInteger(authentication.image) || authentication.image < 0 ||
      authentication.image >= source.images.length || source.images.length > MC.maxImages) fail_('AI');
  let total = 0;
  for (let index = 0; index < source.images.length; index++) {
    const item = Object.getOwnPropertyDescriptor(source.images, index);
    if (!item || !Object.prototype.hasOwnProperty.call(item, 'value') || !inspectedImage_(item.value)) fail_('AI');
    const image = item.value;
    if (Object.getOwnPropertySymbols(image).length || Object.getOwnPropertyNames(image).some(function (key) {
      return !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(image, key), 'value');
    })) fail_('AI');
    const mimeType = ownEnumerableDataValue_(image, 'mimeType');
    const bytes = ownEnumerableDataValue_(image, 'bytes');
    if (MC_IMAGE_MIME_TYPES.indexOf(mimeType) < 0 || !Array.isArray(bytes) ||
        !bytes.length || bytes.length > MC.maxImageBytes || total + bytes.length > MC.maxTotalImageBytes) fail_('AI');
    for (let offset = 0; offset < bytes.length; offset++) {
      const byte = Object.getOwnPropertyDescriptor(bytes, offset);
      if (!byte || !Object.prototype.hasOwnProperty.call(byte, 'value') ||
          !Number.isInteger(byte.value) || byte.value < -128 || byte.value > 255) fail_('AI');
    }
    if (!imageSignature_(mimeType, bytes)) fail_('AI');
    const dimensions = imageDimensions_(mimeType, bytes);
    if (dimensions && (dimensions.width <= 2 || dimensions.height <= 2)) fail_('AI');
    total += bytes.length;
  }
}

function buildCandidatePrompt_(message) {
  return candidatePrompt_(message).text;
}

function candidatePrompt_(message) {
  const source = candidateSource_(message);
  const instruction = [
    'Extract coupon offers from the supplied message. Return JSON only, with no prose or Markdown.',
    'Extract all offers; never select only a subset. An empty candidates array means no offer was found in the supplied source.',
    'Every factual field, including notes, is null when absent or uncertain; otherwise it is {value, quote, image}.',
    'value and quote are single strings, never arrays. image is one integer index or null, never a string or array.',
    'Keep each value together with its evidence: quote is one exact source excerpt supporting that value within one independent span.',
    'Use image only for a supplied inspected image supporting the value; use null otherwise. Use an empty quote only for image-only evidence.',
    'Never emit an empty value object or a value without evidence. Never invent facts or evidence.',
    'Set review=true for uncertain facts or actual offer information that could not be represented. Optional fields absent from the source may be null without requiring review.',
    'Preserve exact code case, Unicode and punctuation. Use source wording for descriptive values including notes, not summaries.',
    'Use HTTPS websites and explicit YYYY-MM-DD expiry supported by the source. discountValue and minimumSpend are scalar numeric strings without units.',
    'Inspect readable text and every supplied image for actual issuance of an account, login, verification, or other authentication code.',
    'Return exactly {candidates, authentication}. authentication is null if no actual authentication issuance is found; otherwise it is {quote, image} identifying the supporting source excerpt or inspected image.',
    'Use an empty authentication quote only for image-only evidence. A text quote must be exact; image is one supplied integer index or null.',
    'If any source issues an authentication code, exclude the ENTIRE message, even if it also contains a promotion: report authentication evidence and return no coupon candidates.',
    'Generic account discussion, descriptive predicates, examples, and negated authentication labels are not issuance. Null authentication does not establish absence of offers or complete inspection.',
    'discountType is the exact unit beside the discount amount, such as %, EUR, or a currency symbol; never a phrase such as percent off or % off. The type and value quotes must support the same adjacent amount and unit.',
    'An image-only fact is always review=true. Incomplete source coverage requires review=true and cannot verify absence of an offer.',
    'Each candidate has exactly these keys: ' + aiCandidateKeys_().join(', ') + '.',
    'confidence is high, medium, or low; review is boolean. Follow the supplied response schema.',
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
  const source = candidateSource_(message);
  const excluded = authenticationExclusion_(source);
  if (excluded) return excluded;
  if (!response || typeof response.text !== 'string' || response.text.length > AI_EXTRACTION.maxResponse ||
      /^\s*```|```\s*$/.test(response.text) || duplicateJsonKeys_(response.text)) fail_('AI');
  let body;
  try { body = JSON.parse(response.text); } catch (e) { fail_('AI'); }
  if (!exactAIKeys_(body, ['candidates', 'authentication']) || !Array.isArray(body.candidates) ||
      body.candidates.length > AI_EXTRACTION.maxCandidates) fail_('AI');
  // Validate the entire wire response, including keys and types in later offers,
  // before projecting any facts into the internal evidence representation.
  body.candidates.forEach(function (candidate) { validateAIWireCandidate_(candidate, source); });
  validateAIAuthentication_(body.authentication, source);
  if (body.authentication !== null) return authenticationExcludedOutcome_(source);
  let invalidated = 0;
  const candidates = body.candidates.map(function (candidate) {
    const raw = projectAIWireCandidate_(candidate);
    const normalized = normalizeCandidate_(raw, message);
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
  const excluded = authenticationExclusion_(source);
  if (excluded) return excluded;
  const prompt = candidatePrompt_(message);
  const images = source.images.map(function (image) {
    if (!image || typeof image.mimeType !== 'string' || !Array.isArray(image.bytes)) fail_('AI');
    return {mimeType: image.mimeType, data: canonicalBase64Url_(Utilities.base64EncodeWebSafe(image.bytes))};
  });
  const aiOutcome = parseAICandidateOutcome_(callGeminiModel_({text: prompt.text, images: images}, hooks), message);
  if (aiOutcome.excludedReason === 'authentication_code_message') return aiOutcome;
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
