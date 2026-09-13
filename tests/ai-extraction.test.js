const test = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');
const {wireCandidate} = require('./ai-wire-fixtures');

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
  const result = ctx.parseAICandidates_({text: JSON.stringify({candidates: [wireCandidate(candidate)]})}, message);
  assert.equal(result[0].code, 'SAVE20');
  assert.equal(result[0].review, false);
});

test('truncated prompt coverage and candidate identity remain fail-closed', () => {
  const {ctx, properties} = harness();
  const prompt = ctx.candidatePrompt_({text: 'X'.repeat(70000), incomplete: false});
  assert.equal(prompt.truncated, true);
  properties.GEMINI_API_KEY = 'test-key';
  const outcome = ctx.extractCouponOutcome_({text: 'X'.repeat(70000), incomplete: false}, {fetch: () => ({status: 200,
    body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})})});
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

for (const [name, message, code, quote] of [
  ['subject-purpose', {subject: 'Sign in to Acme', text: 'Your code is 123456'}, '123456'],
  ['alphabetic', {text: 'Acme: Your verification code is ABCDEF'}, 'ABCDEF'],
  ['heading-expiry', {subject: 'Acme', html: '<h1>Your verification code</h1><p>123456 expires in 10 minutes</p>'},
    '123456', '123456 expires in 10 minutes'],
  ['trailing-label', {text: 'Acme: 123456 is your verification code.'}, '123456']
]) {
  test('R5 authentication exclusion at actual extraction consumer: ' + name, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: 'Acme', code, evidence: {merchant: {quote: 'Acme'}, code: {quote: quote || message.text}}});
    };
    const outcome = ctx.extractCouponOutcome_({incomplete: false, ...message});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0);
    assert.equal(outcome.archiveAllowed, false);
    assert.deepEqual(Array.from(outcome.candidates), []);
  });
}

for (const [name, message, excluded] of [
  ['qualified-pin', {text: 'Acme: Your login PIN is 123456'}, true],
  ['representation-heading', {text: 'Your verification code', html: '<p>SAVE20.</p><p>Brand coupon code SAVE20</p>'}, false],
  ['advisory', {text: 'Acme: Your verification code is 123456 and should not be shared.'}, true],
  ['copula-heading', {subject: 'Acme', text: 'Your verification code is\n123456'}, true],
  ['representation-example', {subject: 'Acme', text: 'Example:', html: '<p>Your verification code is 123456</p>'}, true]
]) {
  test('R8 authentication admission at actual extraction consumer: ' + name, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: excluded ? 'Acme' : 'Brand', code: excluded ? '123456' : 'SAVE20',
        evidence: {merchant: {quote: excluded ? 'Acme' : 'Brand'}, code: {quote: excluded ? '123456' : 'Brand coupon code SAVE20'}}});
    };
    const outcome = ctx.extractCouponOutcome_({incomplete: false, ...message});
    assert.equal(outcome.excludedReason, excluded ? 'authentication_code_message' : undefined);
    assert.equal(calls, excluded ? 0 : 1);
    assert.equal(outcome.archiveAllowed, !excluded);
    assert.equal(outcome.candidates.length, excluded ? 0 : 1);
  });
}

for (const [name, text, code] of [
  ['grouped-value', 'Acme: Your verification code is 123 456.', '123'],
  ['instruction-frame', 'Acme: Use the verification code to sign in:\n123456', '123456'],
  ['wrapped-tail', 'Acme: Your verification code is 123456 (valid for 10 minutes).', '123456']
]) {
  test('R9 authentication admission at actual extraction consumer: ' + name, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: 'Acme', code, evidence: {merchant: {quote: 'Acme'}, code: {quote: code}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0);
    assert.equal(outcome.archiveAllowed, false);
    assert.equal(outcome.candidates.length, 0);
  });
}

test('grouped authentication recognition is bounded and cannot normalize coupon identities', () => {
  const {ctx} = harness();
  for (const separator of [' ', '\u00a0', '\u202f']) {
    const text = 'Brand coupon code 123' + separator + '456';
    ctx.callGeminiModel_ = () => aiResponse({code: '123456',
      evidence: {merchant: {quote: 'Brand'}, code: {quote: text}}});
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, undefined);
    assert.equal(outcome.archiveAllowed, false);
    assert.equal(outcome.candidates.some(candidate => candidate.code === '123456'), false);
    assert.equal(ctx.codeOccurrences_('123456', text).length, 0);
    assert.equal(ctx.codeOccurrences_('123' + separator + '456', text).length, 0);
  }
  for (const text of ['123 456.ABC', '123 456!tail', '"123 456"tail', '"123 456".tail', '"123 456"!tail', '123 456-789']) {
    assert.equal(ctx.authenticationGroupedLiteral_(text, 0), null, text);
  }
  for (const text of ['123 456.', '123 456!', '"123 456"', '"123 456".', '"123 456"!', '12 3456', '123\u202f456']) {
    assert.ok(ctx.authenticationGroupedLiteral_(text, 0), text);
  }
  const text = '123 '.repeat(8000);
  const measured = {length: text.length, charAt: index => text.charAt(index),
    slice: (start, end) => { assert.ok(end - start <= 80); return text.slice(start, end); }};
  for (let index = 0; index < text.length; index += 4) ctx.authenticationGroupedLiteral_(measured, index);
});

test('authentication issuance excludes the entire message before model and both candidate producers', () => {
  const {ctx} = harness();
  const {authenticationMessages, ordinaryMessages} = require('./authentication-fixtures');
  ctx.callGeminiModel_ = () => assert.fail('excluded messages must not reach Gemini');
  for (const message of authenticationMessages) {
    const input = {incomplete: false, ...message};
    const outcome = ctx.extractCouponOutcome_(input);
    assert.equal(outcome.excludedReason, 'authentication_code_message', JSON.stringify(message));
    assert.deepEqual(Array.from(outcome.candidates), []);
    assert.equal(outcome.archiveAllowed, false);
    assert.equal(outcome.verifiedNonOffer, false);
    assert.equal(outcome.modelEmpty, false);
    assert.deepEqual(Array.from(ctx.deterministicCandidates_(input)), []);
    // The parser entry point cannot bypass admission with a promotional response.
    assert.deepEqual(Array.from(ctx.parseAICandidates_(aiResponse(), input)), []);
  }
  for (const message of ordinaryMessages) {
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_({incomplete: false, ...message})), false, JSON.stringify(message));
  }
});

test('R4 login-adjacent coupon remains automatically eligible and generic wording stays AI-only', () => {
  const {ctx} = harness();
  const text = 'Brand: Log in to your account and use code SAVE20 to get 20% off';
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: text}}});
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.candidates[0].code, 'SAVE20');
  assert.equal(outcome.invalidated, false);
  assert.equal(outcome.archiveAllowed, true);
  assert.deepEqual(Array.from(ctx.deterministicCandidates_({text, incomplete: false})), []);
  assert.deepEqual(Array.from(ctx.deterministicCandidates_({text: 'Coupon code SAVE20 Promo code PLUS20 Discount code LESS20 Codice sconto ÈTÉ+20', incomplete: false}), c => c.code),
    ['SAVE20', 'PLUS20', 'LESS20', 'ÈTÉ+20']);
  const generic = 'Brand promo: usa il codice ÈTÉ+20';
  ctx.callGeminiModel_ = () => aiResponse({code: 'ÈTÉ+20', evidence: {merchant: {quote: generic}, code: {quote: generic}}});
  assert.deepEqual(Array.from(ctx.deterministicCandidates_({text: generic, incomplete: false})), []);
  assert.equal(ctx.extractCouponOutcome_({text: generic, incomplete: false}).candidates[0].code, 'ÈTÉ+20');
});

test('authentication admission preserves full token punctuation and ignores model quote selection', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => assert.fail('auth must be excluded before model quote selection');
  for (const code of ['LOGIN77', 'ABC.77', 'ABC.77!', 'LOGIN77.', 'ÈTÉ+20!', '１２３４５６', 'Code+12!']) {
    for (const wrapped of [code, '"' + code + '"', "'" + code + "'", '<' + code + '>']) {
      const auth = 'Acme: use code ' + wrapped + ' To verify your account.';
      const offer = 'Brand coupon code ' + code + ' gives 20% off.';
      for (const text of [auth, auth + '\n' + offer, offer + '\n' + auth, auth + ' ' + offer]) {
        assert.equal(ctx.extractCouponOutcome_({text, incomplete: false}).excludedReason, 'authentication_code_message', text);
      }
    }
  }
});

test('code purpose takes precedence over incidental offer words and preserves associated promotions', () => {
  const {ctx} = harness();
  const cases = [
    ['Brand: use code SAVE20 to verify your discount purchase.', false],
    ['Brand: use code SAVE20 to reset your password for 20% off.', false],
    ['Brand: use code SAVE20 to sign-in at checkout.', false],
    ['Brand: one-time code SAVE20 for your order.', false],
    ['Brand: codice di verifica SAVE20 per il tuo acquisto.', false],
    ['Brand: usa il codice SAVE20 per verificare il tuo account.', false],
    ['Brand: log in and use code SAVE20 for a discount.', true],
    ['Brand: coupon code SAVE20 after login.', true],
    ['Brand: coupon code is SAVE20 after login.', true],
    ['Brand: log in and use code SAVE20 for 20% off.', true],
    ['Brand: 20% off with code SAVE20 after login.', true],
    ['Brand: after login get 20% off with code SAVE20', true],
    ['Brand: after login get a discount using code SAVE20', true],
    ['Brand: codice sconto SAVE20 dopo accesso.', true],
    ['Brand: codice sconto SAVE20 after login.', true],
    ['Brand: codice sconto: SAVE20 after login.', true],
    ['Brand: codice sconto= SAVE20 after login.', true],
    ['Brand: codice sconto : SAVE20 after login.', true],
    ['Brand: codice sconto is SAVE20 after login.', true],
    ['Brand: accedi e usa il codice SAVE20 nel carrello.', true],
    ['Brand promo: usa il codice SAVE20 dopo accesso.', true]
  ];
  for (const [text, retained] of cases) {
    ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: text}}});
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.candidates.some(candidate => candidate.merchant === 'Brand' && candidate.code === 'SAVE20'), retained, text);
    assert.equal(outcome.invalidated, false, text);
    assert.equal(outcome.excludedReason, retained ? undefined : 'authentication_code_message', text);
    assert.equal(outcome.archiveAllowed, retained, text);
    assert.equal(outcome.verifiedNonOffer, false, text);
  }
});

test('message exclusion supersedes historical mixed-code quote selection in either order', () => {
  const {ctx} = harness();
  for (const code of ['LOGIN77', 'LOGIN77.', 'ÈTÉ+20!']) {
    const auth = 'Acme: verify your account using code ' + code;
    const offer = 'Brand coupon code ' + code + ' gives 20% off.';
    for (const text of [auth + '\n' + offer, offer + '\n' + auth, auth + ' ' + offer]) {
      ctx.callGeminiModel_ = () => aiResponse({code, evidence: {merchant: {quote: 'Brand'}, code: {quote: offer}}});
      const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
      assert.equal(outcome.invalidated, false, text);
      assert.equal(outcome.excludedReason, 'authentication_code_message', text);
      assert.deepEqual(Array.from(outcome.candidates), [], text);
    }
  }
});

test('message classification uses bounded context work for repeated literals and introductions', () => {
  const {ctx} = harness();
  const original = ctx.authenticationInstruction_;
  for (const text of ['LOGIN77 '.repeat(8000), 'use code LOGIN77 '.repeat(8000),
    'Brand: use code LOGIN77 for a discount.\n'.repeat(8000), 'x'.repeat(100000) + '\n' + 'LOGIN77 '.repeat(8000)]) {
    let units = 0;
    let calls = 0;
    ctx.authenticationInstruction_ = function (before, after, code, frame) {
      units += before.length + after.length;
      calls++;
      return original(before, after, code, frame);
    };
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_({text, incomplete: false})), false);
    assert.equal(calls, ctx.codeLexemes_(text).filter(code => ctx.authenticationLiteral_(code)).length);
    assert.ok(units <= 480 * calls, 'fixed per-literal context, no growing prefix/suffix');
    assert.ok(units <= 160 * text.length, 'linear total context bound for minimum three-unit literals');
  }
  ctx.authenticationInstruction_ = original;
});

test('message scanner keeps line, literal and discussion inspection work linear', () => {
  const {ctx} = harness();
  let units = 0;
  for (const name of ['authenticationHeading_', 'authenticationLiteral_', 'authenticationDiscussion_']) {
    const original = ctx[name];
    ctx[name] = text => { units += text.length; return original(text); };
  }
  const text = 'x'.repeat(100000) + '\n' + 'LOGIN77 '.repeat(8000);
  assert.equal(ctx.authenticationMessage_(ctx.candidateSource_({text, incomplete: false})), false);
  assert.ok(units <= 50 * text.length, 'whole-line discussion must not be rescanned per literal');
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
  return {text: JSON.stringify({candidates: [wireCandidate(candidate)]})};
}

test('shared field identities preserve typed zero, exact codes and URL suffixes across all key consumers', () => {
  const {ctx} = harness();
  const base = {merchant: 'Brand', code: 'Save+20', minimumSpend: '0', website: 'https://shop.example/Offer?A=1#X'};
  const same = {...base, merchant: '  BRAND  ', minimumSpend: 0, website: 'HTTPS://SHOP.EXAMPLE/Offer?A=1#X'};
  for (const key of ['exactCandidateIdentityKey_', 'candidateMergeKey_']) {
    assert.equal(ctx[key](base), ctx[key](same), key);
    for (const different of [{minimumSpend: ''}, {minimumSpend: '25'}, {code: 'save+20'}, {code: 'Save20'},
      {website: 'https://shop.example/offer?A=1#X'}, {website: 'https://shop.example/Offer?a=1#X'},
      {website: 'https://shop.example/Offer?A=1#x'}]) {
      assert.notEqual(ctx[key](base), ctx[key]({...base, ...different}), JSON.stringify(different));
    }
  }
});

test('deterministic copied Notes loss survives high-confidence enrichment even with replacement Notes', () => {
  for (const length of [3500, 3501]) for (const replacementNotes of ['', 'Brand']) {
    const {ctx} = harness();
    const prefix = 'Brand coupon code AI20 ';
    const message = {text: prefix + 'x'.repeat(length - prefix.length), incomplete: false};
    ctx.callGeminiModel_ = () => aiResponse({notes: replacementNotes,
      evidence: {merchant: {quote: 'Brand'}, code: {quote: 'AI20'},
        ...(replacementNotes ? {notes: {quote: 'Brand'}} : {})}});
    assert.equal(ctx.candidatePrompt_(message).truncated, false);
    const outcome = ctx.extractCouponOutcome_(message);
    assert.equal(outcome.status, length === 3500 ? 'complete' : 'incomplete');
    assert.equal(outcome.archiveAllowed, length === 3500);
    assert.equal(outcome.candidates[0].notes.length, replacementNotes ? 5 : 3500);
  }
});

test('deterministic unique-code clipping distinguishes twelve, thirteen and repeated codes', () => {
  for (const count of [12, 13]) for (const duplicate of [false, true]) {
    const {ctx} = harness();
    const codes = Array.from({length: count}, (_, i) => 'SAVE' + i);
    const text = 'Brand ' + codes.map(code => 'coupon code ' + code).join(' ') + (duplicate ? ' coupon code SAVE0' : '');
    ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: codes.slice(0, 12).map(code =>
      JSON.parse(aiResponse({code, evidence: {merchant: {quote: 'Brand'}, code: {quote: code}}}).text).candidates[0])})});
    const message = {text, incomplete: false};
    assert.equal(ctx.deterministicCandidates_(message).length, 12);
    assert.equal(ctx.deterministicCandidateOutcome_(message).complete, count === 12);
    const outcome = ctx.extractCouponOutcome_(message);
    assert.equal(outcome.candidates.length, 12);
    assert.equal(outcome.status, count === 12 ? 'complete' : 'incomplete');
    assert.equal(outcome.archiveAllowed, count === 12);
  }
});

test('end-to-end extraction accepts bounded prompt and preserves deterministic code', () => {
  const {ctx, properties} = harness();
  properties.GEMINI_API_KEY = 'test-key';
  let request;
  const result = ctx.extractCouponCandidates_({text: 'Coupon code SAVE20 ' + 'x'.repeat(59900), incomplete: false}, {
    fetch: (_, options) => { request = JSON.parse(options.payload); return {status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})};}
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: [wireCandidate(candidate)]})}]}}]})})
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})})
  });
  assert.deepEqual(Array.from(outcome.candidates), []);
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.empty, true);
  assert.equal(outcome.archiveAllowed, false);
  assert.deepEqual(Array.from(outcome.candidates), []);
  assert.equal(ctx.sameCouponOffer_(ctx.normalizeCandidate_(make('First'), {text: 'First SAVE20', incomplete: false}),
    ctx.normalizeCandidate_(make('Second'), {text: 'Second SAVE20', incomplete: false})), false);
  assert.equal(ctx.extractCouponOutcome_({text: '', incomplete: true}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})})
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: [wireCandidate(candidate('Monday')), wireCandidate(candidate('Tuesday'))]})}]}}]})})
  });
  assert.deepEqual(Array.from(result, item => item.validOn), ['Monday', 'Tuesday']);
});

test('URL identity preserves path, query, fragment and percent-escape spelling through extraction and row recovery', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const urls = ['https://shop.example.com/Promo', 'https://shop.example.com/promo',
    'https://shop.example.com/?Offer=A', 'https://shop.example.com/?offer=a',
    'https://shop.example.com/#Offer', 'https://shop.example.com/#offer',
    'https://shop.example.com/%2F', 'https://shop.example.com/%2f'];
  const candidates = urls.map(website => JSON.parse(aiResponse({code: '', website,
    evidence: {merchant: {quote: 'Brand'}, website: {quote: website}}}).text).candidates[0]);
  const message = {id: 'abc123', link: ctx.gmailLink_('abc123'), text: 'Brand ' + urls.join(' '), incomplete: false};
  const outcome = ctx.extractCouponOutcome_(message, {fetch: () => ({status: 200,
    body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates})}]}}]})})});
  assert.deepEqual(Array.from(outcome.candidates, c => c.website), urls);
  assert.equal(new Set(outcome.candidates.map(c => ctx.candidateDedupeKey_(message, c))).size, urls.length);
  const state = ctx.newMessageState_('abc123'); state.candidateStates = [];
  ctx.createBatchIntent_(state, outcome); assert.equal(ctx.validMessageState_(state), true);
  const identities = outcome.candidates.map(c => ctx.candidateRowIdentityFromRow_(ctx.couponRow_(message, c)));
  assert.equal(new Set(identities).size, urls.length);
  const upperHost = {...outcome.candidates[0], website: 'HTTPS://SHOP.EXAMPLE.COM/Promo'};
  assert.equal(ctx.exactCandidateIdentityKey_(upperHost), ctx.exactCandidateIdentityKey_(outcome.candidates[0]));
  assert.notEqual(ctx.candidateMergeKey_(outcome.candidates[0]), ctx.candidateMergeKey_(outcome.candidates[1]));
});

test('exact coded AI duplicates collapse before sparse source-note enrichment without dropping review requirements', () => {
  for (const explicitCode of [true, false]) for (const needsReview of [true, false]) {
    const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
    const proposal = JSON.parse(aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}).text).candidates[0];
    const message = {id: 'abc123', text: explicitCode ? 'Brand coupon code SAVE20' : 'Brand SAVE20', incomplete: false};
    const outcome = ctx.extractCouponOutcome_(message, {fetch: () => ({status: 200,
      body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: [{...proposal, review: needsReview}, proposal]})}]}}]})})});
    assert.equal(outcome.candidates.length, 1);
    assert.equal(outcome.candidates[0].code, 'SAVE20');
    assert.equal(outcome.archiveAllowed, !needsReview);
    const state = ctx.newMessageState_('abc123'); state.candidateStates = [];
    ctx.createBatchIntent_(state, outcome); assert.equal(ctx.validMessageState_(state), true);
  }
});

test('same-code described offers stay distinct in every other factual field', () => {
  const {ctx} = harness();
  const base = ctx.projectAIWireCandidate_(JSON.parse(aiResponse({code: 'SAVE20'}).text).candidates[0]); delete base.evidence;
  for (const field of ['merchant', 'website', 'discountType', 'discountValue', 'minimumSpend', 'validOn',
    'exclusions', 'expiry', 'usageLimits', 'currency', 'notes']) {
    assert.equal(ctx.sameCouponOffer_(base, {...base, [field]: 'Different factual value'}), false, field);
  }
});

test('sparse deterministic codes enrich distinct same-code AI offers without collapsing their conditions', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const make = validOn => JSON.parse(aiResponse({code: 'SAVE20', validOn,
    evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}, validOn: {quote: validOn}}}).text).candidates[0];
  const outcome = ctx.extractCouponOutcome_({id: 'abc123', text: 'Brand coupon code SAVE20 Monday Tuesday', incomplete: false}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: [make('Monday'), make('Tuesday'), make('Monday')]})}]}}]})})
  });
  assert.deepEqual(Array.from(outcome.candidates, c => c.validOn), ['Monday', 'Tuesday']);
  const state = ctx.newMessageState_('abc123'); state.candidateStates = [];
  ctx.createBatchIntent_(state, outcome); assert.equal(ctx.validMessageState_(state), true);
});

test('end-to-end extraction propagates transport failure and drops blank proposals', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  assert.throws(() => ctx.extractCouponCandidates_({text: 'offer', incomplete: false}, {fetch: () => ({status: 503, body: ''})}), /Gemini request failed/);
  const {ctx: ctx2, properties: props2} = harness(); props2.GEMINI_API_KEY = 'test-key';
  const fields = ['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'];
  const result = ctx2.extractCouponCandidates_({text: 'offer', incomplete: false}, {fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: [wireCandidate(Object.assign(Object.fromEntries(fields.map(k => [k, ''])), {confidence: 'low', review: true, evidence: {}}))]})}]}}]})})});
  assert.equal(result.length, 0);
});

test('extraction rejects duplicate keys and incomplete candidate schemas', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const bad = '{"candidates":[{"merchant":"A","merchant":"B"}]}';
  assert.throws(() => ctx.extractCouponCandidates_({text: 'x', incomplete: false}, {fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: bad}]}}]})})}), /AI/);
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: [wireCandidate(candidate)]})}]}}]})})
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].review, true);
});
