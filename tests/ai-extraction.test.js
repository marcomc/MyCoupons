const test = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

test('AI prompt is bounded and strict response parsing normalizes evidence', () => {
  const {ctx} = harness();
  const message = {text: 'Brand offers 20% off with SAVE20', incomplete: false};
  const prompt = ctx.buildCandidatePrompt_(message);
  assert.ok(prompt.includes('JSON only'));
  assert.ok(prompt.length <= 60000);
  const candidate = {merchant: 'Brand', website: '', code: 'SAVE20', discountType: '%', discountValue: '20',
    minimumSpend: '', validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: '',
    confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Brand offers 20% off with SAVE20'}, code: {quote: 'Brand offers 20% off with SAVE20'},
      discountType: {quote: 'Brand offers 20% off with SAVE20'}, discountValue: {quote: 'Brand offers 20% off with SAVE20'}}};
  const result = ctx.parseAICandidates_({text: JSON.stringify({candidates: [candidate]})}, message);
  assert.equal(result[0].code, 'SAVE20');
  assert.equal(result[0].review, false);
});

test('truncated prompt coverage and candidate identity remain fail-closed', () => {
  const {ctx, properties} = harness();
  const prompt = ctx.candidatePrompt_({text: 'X'.repeat(70000), incomplete: false});
  assert.equal(prompt.truncated, true);
  properties.GEMINI_API_KEY = 'test-key';
  const outcome = ctx.extractCouponOutcome_({text: 'X'.repeat(70000), incomplete: false}, {fetch: () => ({status: 200,
    body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})})});
  assert.equal(outcome.status, 'incomplete'); assert.equal(outcome.archiveAllowed, false); assert.equal(outcome.verifiedNonOffer, false);
  const left = {merchant: 'Brand', website: '', code: 'X|Y', discountType: '', discountValue: '', minimumSpend: '', validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: ''};
  const right = {merchant: 'Brand', website: '', code: 'X', discountType: '|Y', discountValue: '', minimumSpend: '', validOn: '', exclusions: '', expiry: '', usageLimits: '', currency: '', notes: ''};
  assert.notEqual(ctx.exactCandidateIdentityKey_(left), ctx.exactCandidateIdentityKey_(right));
});

test('subject is independent factual evidence while sender remains metadata only', () => {
  const {ctx} = harness();
  const message = {subject: 'Brand coupon code SAVE20', sender: 'Brand <offers@example.com>', text: 'Body', incomplete: false};
  const source = ctx.candidateSource_(message);
  assert.deepEqual(Array.from(source.sourceSpans, span => ({kind: span.kind, text: span.text})), [
    {kind: 'subject', text: 'Brand coupon code SAVE20'}, {kind: 'text', text: 'Body'}
  ]);
  assert.equal(ctx.deterministicCandidates_(message)[0].code, 'SAVE20');
  assert.equal(ctx.deterministicCandidates_({subject: 'Coupon code SAVE+20', incomplete: false})[0].code, 'SAVE+20');
  const prompt = ctx.buildCandidatePrompt_(message);
  assert.match(prompt, /SUBJECT \(independent evidence span\):\nBrand coupon code SAVE20/);
  assert.doesNotMatch(prompt, /offers@example\.com/);
  const senderOnly = {merchant: 'Brand', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}};
  assert.equal(ctx.normalizeCandidate_(senderOnly, {subject: 'Coupon code SAVE20', sender: 'Brand', incomplete: false}).merchant, '');
});

test('AI extraction rejects fenced or unknown responses before transport', () => {
  const {ctx} = harness();
  assert.throws(() => ctx.parseAICandidates_({text: "```json{}"}, {text: 'x'}), /AI/);
  assert.throws(() => ctx.parseAICandidates_({text: JSON.stringify({candidates: [{unknown: 1}]})}, {text: 'x'}), /AI/);
});

function aiResponse(overrides = {}) {
  const candidate = Object.assign(Object.fromEntries(['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'].map(k => [k, ''])), {
    merchant: 'Brand', code: 'AI20', confidence: 'high', review: false, evidence: {merchant: {quote: 'Brand'}, code: {quote: 'AI20'}}
  }, overrides);
  return {text: JSON.stringify({candidates: [candidate]})};
}

test('end-to-end extraction accepts bounded prompt and preserves deterministic code', () => {
  const {ctx, properties} = harness();
  properties.GEMINI_API_KEY = 'test-key';
  let request;
  const result = ctx.extractCouponCandidates_({text: 'Coupon code SAVE20 ' + 'x'.repeat(59900), incomplete: false}, {
    fetch: (_, options) => { request = JSON.parse(options.payload); return {status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})};}
  });
  assert.ok(request.contents[0].parts[0].text.length <= 60000);
  assert.equal(result[0].code, 'SAVE20');
});

test('extraction consolidates a sparse deterministic code with its evidenced AI offer exactly', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const candidate = Object.assign(Object.fromEntries(['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'].map(k => [k, ''])), {
    merchant: 'Brand', code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Brand coupon code SAVE20'}, code: {quote: 'Brand coupon code SAVE20'}}
  });
  const result = ctx.extractCouponCandidates_({text: 'Brand coupon code SAVE20', incomplete: false}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: [candidate]})}]}}]})})
  });
  assert.deepEqual(Array.from(result, item => [item.merchant, item.code, item.review]), [['Brand', 'SAVE20', false]]);
  assert.notEqual(ctx.candidateMergeKey_({code: 'AbC123'}), ctx.candidateMergeKey_({code: 'abc123'}));
});

test('distinct described offers sharing a code stay separate and empty extraction has no archive authority', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const make = (merchant) => Object.assign(Object.fromEntries(['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'].map(k => [k, ''])), {
    merchant, code: 'SAVE20', confidence: 'high', review: false,
    evidence: {merchant: {quote: merchant + ' SAVE20'}, code: {quote: merchant + ' SAVE20'}}
  });
  const outcome = ctx.extractCouponOutcome_({text: 'First SAVE20 Second SAVE20', incomplete: false}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})})
  });
  assert.deepEqual(Array.from(outcome.candidates), []);
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.empty, true);
  assert.equal(outcome.archiveAllowed, false);
  assert.deepEqual(Array.from(outcome.candidates), []);
  assert.equal(ctx.sameCouponOffer_(ctx.normalizeCandidate_(make('First'), {text: 'First SAVE20', incomplete: false}),
    ctx.normalizeCandidate_(make('Second'), {text: 'Second SAVE20', incomplete: false})), false);
  assert.equal(ctx.extractCouponOutcome_({text: '', incomplete: true}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})})
  }).status, 'incomplete');
});

test('code-less offers with different grounded conditions stay separate', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const candidate = (validOn) => Object.assign(Object.fromEntries(['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'].map(k => [k, ''])), {
    merchant: 'Brand', discountType: '%', discountValue: '20', validOn, confidence: 'high', review: false,
    evidence: {merchant: {quote: 'Brand 20% ' + validOn}, discountType: {quote: 'Brand 20% ' + validOn},
      discountValue: {quote: 'Brand 20% ' + validOn}, validOn: {quote: 'Brand 20% ' + validOn}}
  });
  const result = ctx.extractCouponCandidates_({text: 'Brand 20% Monday Brand 20% Tuesday', incomplete: false}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: [candidate('Monday'), candidate('Tuesday')]})}]}}]})})
  });
  assert.deepEqual(Array.from(result, item => item.validOn), ['Monday', 'Tuesday']);
});

test('end-to-end extraction propagates transport failure and drops blank proposals', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  assert.throws(() => ctx.extractCouponCandidates_({text: 'offer', incomplete: false}, {fetch: () => ({status: 503, body: ''})}), /Gemini request failed/);
  const {ctx: ctx2, properties: props2} = harness(); props2.GEMINI_API_KEY = 'test-key';
  const fields = ['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'];
  const result = ctx2.extractCouponCandidates_({text: 'offer', incomplete: false}, {fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: [Object.assign(Object.fromEntries(fields.map(k => [k, ''])), {confidence: 'low', review: true, evidence: {}})]})}]}}]})})});
  assert.equal(result.length, 0);
});

test('extraction rejects duplicate keys and incomplete candidate schemas', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const bad = '{"candidates":[{"merchant":"A","merchant":"B"}]}';
  assert.throws(() => ctx.extractCouponCandidates_({text: 'x', incomplete: false}, {fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: bad}]}}]})})}), /AI/);
  assert.throws(() => ctx.parseAICandidates_(aiResponse({evidence: {}}), {text: 'Brand AI20', incomplete: false}), /AI/);
  assert.throws(() => ctx.parseAICandidates_({text: '{"candidates":[{"\\u":"x"}]}'}, {text: 'x', incomplete: false}), /AI/);
});

test('image-only incomplete extraction remains review-required', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const image = {mimeType: 'image/png', bytes: [137, 80, 78, 71], sourceId: 'image'};
  const candidate = Object.assign(Object.fromEntries(['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'].map(k => [k, ''])), {
    merchant: 'Brand', code: 'IMG20', confidence: 'high', review: false,
    evidence: {merchant: {image: 0}, code: {image: 0}}
  });
  const result = ctx.extractCouponCandidates_({text: '', images: [image], incomplete: true}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{content: {parts: [{text: JSON.stringify({candidates: [candidate]})}]}}]})})
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].review, true);
});
