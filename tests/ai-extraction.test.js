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
  const result = ctx.parseAICandidates_({text: JSON.stringify({authentication: null, candidates: [wireCandidate(candidate)]})}, message);
  assert.equal(result[0].code, 'SAVE20');
  assert.equal(result[0].review, false);
});

test('truncated prompt coverage and candidate identity remain fail-closed', () => {
  const {ctx, properties} = harness();
  const prompt = ctx.candidatePrompt_({text: 'X'.repeat(70000), incomplete: false});
  assert.equal(prompt.truncated, true);
  properties.GEMINI_API_KEY = 'test-key';
  const outcome = ctx.extractCouponOutcome_({text: 'X'.repeat(70000), incomplete: false}, {fetch: () => ({status: 200,
    body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: []})}]}}]})})});
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
  ['alphabetic-delimiter', {text: 'Acme: Your verification code is: "ABCDEF"'}, 'ABCDEF'],
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

for (const text of ['Your code to sign in is 123456. Brand coupon code SAVE20',
  'Sign in with 123456. Brand coupon code SAVE20',
  'Your security PIN is: 42\nBrand coupon code SAVE20']) {
  test('R28 actual consumer issuance: ' + text, () => {
    const {ctx} = harness(); let calls = 0;
    ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0); assert.equal(outcome.archiveAllowed, false);
  });
}

for (const [message, excluded] of [
  [{text: 'Sign in with SAVE20! for a discount. Brand coupon code SAVE20'}, false],
  [{text: 'Your security PIN:\nUse code 42.\nBrand coupon code SAVE20'}, true]
]) test('R28 cumulative boundary: ' + message.text, () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({...message, incomplete: false});
  assert.equal(outcome.excludedReason === 'authentication_code_message', excluded);
  assert.equal(calls, excluded ? 0 : 1);
});

test('R28 qualified generic alphabetic values retain grounded semantic admission', () => {
  const {ctx} = harness();
  const quote = 'Your code to sign in is “ABCDEF”';
  const message = {text: quote + '. Brand coupon code SAVE20', incomplete: false};
  assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(message)), false);
  const response = {text: JSON.stringify({candidates: [], authentication: {quote, image: null}})};
  assert.equal(ctx.parseAICandidateOutcome_(response, message).excludedReason, 'authentication_code_message');
  for (const role of ['Suppose ', 'You said that ', 'Check whether ']) {
    assert.throws(() => ctx.parseAICandidateOutcome_(response, {...message, text: role + message.text}));
  }
});

for (const [text, excluded] of [
  ['If my verification code is 123456, enter it to sign in. Brand coupon code SAVE20', false],
  ['Unless our verification code is 123456, enter it to sign in. Brand coupon code SAVE20', false],
  ['The help page mentions verification code 123456. Brand coupon code SAVE20', false],
  ['The article discusses verification code 123456. Brand coupon code SAVE20', false],
  ['The help page mentions shipping; Your verification code is 123456. Brand coupon code SAVE20', true],
  ['Mention Bank: Your verification code is 123456. Brand coupon code SAVE20', true],
  ['The help page mentions that 123456 is your verification code. Brand coupon code SAVE20', false],
  ['“If my verification code is 123456, enter it to sign in”. Brand coupon code SAVE20', false],
  ['The help page mentions shipping; 123456 is your verification code. Brand coupon code SAVE20', true],
  ['The help page mentions shipping. 123456 is your verification code. Brand coupon code SAVE20', true],
  ['The help page mentions this: Your verification code is 123456. Brand coupon code SAVE20', false],
  ['The article describes the following: Your verification code is 123456. Brand coupon code SAVE20', false],
  ['Welcome. Refers Bank: Your verification code is 123456. Brand coupon code SAVE20', true],
  ['Welcome; Refers Bank: Your verification code is 123456. Brand coupon code SAVE20', true],
  ['The help page mentions “a code; Your verification code is 123456”. Brand coupon code SAVE20', false],
  ["The help page mentions 'a code; Your verification code is 123456'. Brand coupon code SAVE20", false],
  ["The help page mentions 'it's a code; Your verification code is 123456'. Brand coupon code SAVE20", false],
  ["The help page mentions 'a code'. Your verification code is 123456. Brand coupon code SAVE20", true],
  ["The store's help page mentions verification code 123456. Brand coupon code SAVE20", false],
  ['The help page mentions “a code”. Your verification code is 123456. Brand coupon code SAVE20', true],
  ['The help page mentions a code; Your verification code is 123456. Brand coupon code SAVE20', true],
  ['Your verification code is 123456. Brand coupon code SAVE20', true]
]) test('R29 actual consumer discussion/conditional role: ' + text, () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.excludedReason === 'authentication_code_message', excluded);
  assert.equal(calls, excluded ? 0 : 1);
});

for (const [text, excluded] of [
  ['Why should I share my verification code 123456? Brand coupon code SAVE20', false],
  ['Your verification code is 123456, enter it to sign in. Brand coupon code SAVE20', true],
  ['Suppose your verification code is 123456. Brand coupon code SAVE20', false]
]) test('R27 actual consumer admission: ' + text, () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.excludedReason === 'authentication_code_message', excluded);
  assert.equal(calls, excluded ? 0 : 1);
  if (!excluded) assert.equal(outcome.candidates[0].code, 'SAVE20');
});

test('R27 question and supposition context cannot be cropped from semantic proof', () => {
  const {ctx} = harness();
  const quote = 'your verification code is “ABCDEF”';
  for (const prefix of ['Why should I confirm ', 'Suppose ', 'Assuming that ']) {
    const message = {text: prefix + quote + '. Brand coupon code SAVE20', incomplete: false};
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(message), true), false);
    assert.throws(() => ctx.parseAICandidateOutcome_({text: JSON.stringify({candidates: [], authentication: {quote, image: null}})}, message));
  }
});

for (const [phrase, excluded] of [
  ['Your verification code is 123456, use it to confirm your account discount', false],
  ['Your verification code is ABCDEF, enter it to sign in', true],
  ['Who should use my verification code 123456?', false],
  ['Your verification code is “support.acme.com”, enter it to sign in', false]
]) test('R27 cumulative boundary: ' + phrase, () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: phrase + '. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason === 'authentication_code_message', excluded);
  assert.equal(calls, excluded ? 0 : 1);
  if (!excluded) assert.equal(outcome.candidates[0].code, 'SAVE20');
});

test('R27 anaphoric presentation supports alphabetic values without crossing blocks', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => { throw new Error('clear issuance must precede model'); };
  for (const value of ['ABCDEF', 'aBcDeF', '“ABCDEF”', '‘aBcDeF’', '“123 456”']) {
    const message = {text: 'Your verification code is ' + value + ', enter it to sign in. Brand coupon code SAVE20', incomplete: false};
    assert.equal(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message', value);
  }
  for (const message of [
    {text: 'Your code is ABCDEF, enter it\nto sign in. Brand coupon code SAVE20'},
    {html: '<p>Your code is ABCDEF, enter it</p><p>to sign in. Brand coupon code SAVE20</p>'}
  ]) assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(message)), false);
});

test('R26 direct first-person authentication questions preserve a genuine promotion', () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Can I share my verification code 123456? Brand coupon code SAVE20', incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1); assert.equal(outcome.candidates[0].code, 'SAVE20');
});

for (const question of ['May I share my verification code 123456?',
  '“Can I share my verification code: 123456; your verification code is 654321”']) {
  test('R26 complete auxiliary and quoted-colon boundaries: ' + question, () => {
    const {ctx} = harness(); let calls = 0;
    ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
    const outcome = ctx.extractCouponOutcome_({text: question + '. Brand coupon code SAVE20', incomplete: false});
    assert.notEqual(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 1); assert.equal(outcome.candidates[0].code, 'SAVE20');
  });
}

test('R26 direct question context survives a cropped semantic quote', () => {
  const {ctx} = harness();
  const quote = 'code is “ABCDEF”';
  for (const text of ['Can I confirm my code is “ABCDEF”', 'Can I check whether my code is “ABCDEF”']) {
    const message = {subject: 'Sign in to Acme', text: text + '? Brand coupon code SAVE20', incomplete: false};
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(message), true), false);
    assert.throws(() => ctx.parseAICandidateOutcome_({text: JSON.stringify({candidates: [], authentication: {quote, image: null}})}, message));
  }
});

for (const [name, text, excluded] of [
  ['expiration-qualified-label', 'Your verification code expires in 10 minutes: 123456. Brand coupon code SAVE20', true],
  ['indirect-question', 'Check whether your verification code is 123456. Brand coupon code SAVE20', false]
]) test('R25 actual consumer admission: ' + name, () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.excludedReason === 'authentication_code_message', excluded);
  assert.equal(calls, excluded ? 0 : 1);
  if (!excluded) assert.equal(outcome.candidates[0].code, 'SAVE20');
});

test('R25 indirect questions cannot ground semantic authentication by cropping their role', () => {
  const {ctx} = harness();
  for (const conjunction of ['if', 'whether']) {
    const quote = 'your code is “ABCDEF”';
    const message = {subject: 'Sign in to Acme', text: 'Check ' + conjunction + ' ' + quote + '. Brand coupon code SAVE20', incomplete: false};
    const source = ctx.candidateSource_(message);
    assert.equal(ctx.authenticationMessage_(source, true), false);
    assert.throws(() => ctx.parseAICandidateOutcome_({text: JSON.stringify({candidates: [], authentication: {quote, image: null}})}, message));
  }
});

test('R24 wrapper-only copular alphabetic values defer to grounded model semantics', () => {
  for (const value of ['incorrect', 'ABCDEF', 'aBcDeF']) {
    const {ctx} = harness(); let calls = 0;
    const quote = 'Your verification code is “' + value + '”';
    const message = {text: quote + '. Brand coupon code SAVE20', incomplete: false};
    ctx.callGeminiModel_ = () => {
      calls++;
      return value === 'incorrect' ? aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}) :
        {text: JSON.stringify({candidates: [], authentication: {quote, image: null}})};
    };
    const outcome = ctx.extractCouponOutcome_(message);
    assert.equal(calls, 1, value);
    assert.equal(outcome.excludedReason === 'authentication_code_message', value !== 'incorrect');
    if (value === 'incorrect') assert.equal(outcome.candidates[0].code, 'SAVE20');
  }
});

test('R24 former wrapper-only copular fixtures retain semantic rather than deterministic authority', () => {
  const {ctx} = harness();
  const {ambiguousMessages} = require('./authentication-fixtures');
  assert.ok(ambiguousMessages.length > 50);
  for (const message of ambiguousMessages) {
    const input = {incomplete: false, ...message};
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(input)), false, JSON.stringify(message));
    let calls = 0;
    ctx.callGeminiModel_ = () => { calls++; return {text: JSON.stringify({candidates: [], authentication: null})}; };
    assert.notEqual(ctx.extractCouponOutcome_(input).excludedReason, 'authentication_code_message');
    assert.equal(calls, 1);
    // Stub semantic verdict, not a lexical guess about the selected word.
    ctx.callGeminiModel_ = () => ({text: JSON.stringify({candidates: [], authentication: {quote: message.text, image: null}})});
    assert.equal(ctx.extractCouponOutcome_(input).excludedReason, 'authentication_code_message', JSON.stringify(message));
  }
});

test('R24 semantic authentication proof is exact, occurrence-local and context-bound', () => {
  const {ctx} = harness();
  const statement = 'Your verification code is “ABCDEF”';
  const response = quote => ({text: JSON.stringify({candidates: [], authentication: {quote, image: null}})});
  for (const message of [
    {text: statement + '. Brand coupon code SAVE20'},
    {subject: 'Sign in to Acme', text: 'Your code is “ABCDEF”'},
    {subject: 'Sign in to Acme', html: '<p>Your code is “ABCDEF”</p>'},
    {html: '<h1>Your verification code</h1><p>Your code is “ABCDEF”</p>'},
    {text: 'Example: ' + statement + '.\n' + statement},
    {text: statement + '. Example: ' + statement}
  ]) {
    const quote = (message.text || '').includes(statement) ? statement : 'Your code is “ABCDEF”';
    assert.equal(ctx.parseAICandidateOutcome_(response(quote), {...message, incomplete: false}).excludedReason, 'authentication_code_message');
  }
  for (const [message, quote] of [
    [{text: statement + '. Brand coupon code SAVE20'}, 'Brand coupon code SAVE20'],
    [{text: statement}, '“ABCDEF”'],
    [{text: statement}, 'Your verification code is “ABC'],
    [{text: statement}, statement.replace('ABCDEF', 'abcdef')],
    [{text: 'Example: ' + statement + '. Brand coupon code SAVE20'}, statement],
    [{text: 'You said that ' + statement + '. Brand coupon code SAVE20'}, statement],
    [{text: 'Your verification code is not “ABCDEF”. Brand coupon code SAVE20'}, 'Your verification code is not “ABCDEF”'],
    [{subject: 'Sign in to Acme', text: 'Your coupon code is “ABCDEF”'}, 'Your coupon code is “ABCDEF”'],
    [{subject: 'Sign in to Acme', text: 'Your code is “ABCDEF”'}, 'Sign in to Acme\nYour code is “ABCDEF”'],
    [{text: 'Example: ' + statement, html: '<p>Brand coupon code ABCDEF</p>'}, 'Brand coupon code ABCDEF']
  ]) assert.throws(() => ctx.parseAICandidateOutcome_(response(quote), {...message, incomplete: false}), undefined, JSON.stringify({message, quote}));
  assert.throws(() => ctx.validateAIAuthentication_({quote: 'Your verification code is “ABCDEF”', image: null},
    ctx.candidateSource_({html: '<p>Your verification code is</p><p>“ABCDEF”</p>', incomplete: false})));
  assert.throws(() => ctx.parseAICandidateOutcome_({text: JSON.stringify({authentication: {quote: statement, image: null}, candidates: [{}]})},
    {text: statement, incomplete: false}));
});

test('R24 affirmative declarative assignment excludes mixed mail before the model', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => assert.fail('clear assignment must exclude before model');
  assert.equal(ctx.extractCouponOutcome_({text: 'We assigned 123456 as your verification code. Brand coupon code SAVE20', incomplete: false}).excludedReason,
    'authentication_code_message');
});

test('R23 inherited purpose cannot override promotional tails on punctuated code values', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
  for (const value of ['SAVE20!', 'ABC.77!', '“SAVE20!”']) {
    const message = {subject: 'Sign in to Acme', text: 'Use code ' + value + ' at checkout for 20% off. Brand coupon code SAVE20', incomplete: false};
    assert.notEqual(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message');
  }
});

test('R23 later promotional lines cannot veto completed authentication instructions', () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const message = {subject: 'Sign in to Acme', text: 'Use code 123456.\nAt checkout get 20% off with coupon code SAVE20.', incomplete: false};
  assert.equal(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R23 authentication subjects cannot turn nounless commands into issued codes', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
  const message = {subject: 'Sign in to Acme', text: 'Use coupons. Brand coupon code SAVE20', incomplete: false};
  assert.notEqual(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message');
});

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

for (const [name, text, code, excluded] of [
  ['account-access', 'Brand: Use code 123456 to access your account', '123456', true],
  ['descriptive-predicate', 'Your verification code is confidential. Brand coupon code SAVE20', 'SAVE20', false],
  ['verification-object', 'Brand: Use code SAVE20 to verify the 20% discount is applied at checkout.', 'SAVE20', false],
  ['negated-label', 'This is not a verification code: SAVE20. Brand coupon code SAVE20', 'SAVE20', false]
]) {
  test('R10 authentication admission at actual extraction consumer: ' + name, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({code, evidence: {merchant: {quote: 'Brand'}, code: {quote: code}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, excluded ? 'authentication_code_message' : undefined);
    assert.equal(calls, excluded ? 0 : 1);
    assert.equal(outcome.archiveAllowed, !excluded);
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

for (const [name, message, excluded] of [
  ['interrogative', {text: 'Was your verification code 123456? Brand coupon code SAVE20'}, false],
  ['assigned-as', {text: 'Acme: Use 123456 as your verification code.'}, true],
  ['target-tail', {subject: 'Your verification code', text: 'Your code is SAVE20 for your account discount. Brand coupon code SAVE20'}, false]
]) {
  test('R12 authentication role at actual extraction consumer: ' + name, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: excluded ? 'Acme' : 'Brand', code: excluded ? '123456' : 'SAVE20',
        evidence: {merchant: {quote: excluded ? 'Acme' : 'Brand'}, code: {quote: excluded ? message.text : 'Brand coupon code SAVE20'}}});
    };
    const outcome = ctx.extractCouponOutcome_({incomplete: false, ...message});
    assert.equal(outcome.excludedReason, excluded ? 'authentication_code_message' : undefined);
    assert.equal(calls, excluded ? 0 : 1);
    assert.equal(outcome.archiveAllowed, !excluded);
    assert.equal(outcome.candidates.length, excluded ? 0 : 1);
  });
}

for (const [name, text, excluded] of [
  ['bare-domain', 'Troubleshoot your verification code: help.acme.example/article/12345. Brand coupon code SAVE20', false],
  ['same-line-instruction', 'Acme: Use the verification code to sign in: 123456', true],
  ['purpose-label', 'Acme: Your verification code for signing in is 123456', true],
  ['account-access-label', 'Acme: Your account access code is 123456. Brand coupon code SAVE20', true]
]) {
  test('R13 authentication association at actual extraction consumer: ' + name, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: excluded ? 'Acme' : 'Brand', code: excluded ? '123456' : 'SAVE20',
        evidence: {merchant: {quote: excluded ? 'Acme' : 'Brand'}, code: {quote: excluded ? '123456' : 'Brand coupon code SAVE20'}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, excluded ? 'authentication_code_message' : undefined);
    assert.equal(calls, excluded ? 0 : 1);
    assert.equal(outcome.archiveAllowed, !excluded);
    assert.equal(outcome.candidates.length, excluded ? 0 : 1);
  });
}

for (const text of ['Your verification code:123456', 'OTP=123456',
  '123456 is your code to verify your email', 'Use 123456 for two-factor authentication']) {
  test('R14 authentication relation at actual extraction consumer: ' + text, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: '', code: '123456', evidence: {code: {quote: text}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0);
    assert.equal(outcome.archiveAllowed, false);
    assert.deepEqual(Array.from(outcome.candidates), []);
  });
}

test('R14 admission delimiters never split factual coupon codes', () => {
  const {ctx} = harness();
  for (const code of ['SAVE:20', 'SAVE=20', 'ABC.77', 'ÈTÉ:20=VIP', '"aBcDeF".', "'aBcDeF'!", '<aBcDeF>?', 'SAVE.VIP', 'SAVE.VIP.', '“ABCDEF”.', '‘ÈTÉ+77’']) {
    const message = {text: 'Brand coupon code ' + code, incomplete: false};
    assert.equal(ctx.authenticationMessage_(ctx.candidateSource_(message)), false);
    assert.deepEqual(Array.from(ctx.deterministicCandidates_(message), candidate => candidate.code), [code]);
  }
});

for (const text of ['Acme: Your verification code will be 123456.', 'Use this code to sign in: 123456.']) {
  test('R15 authentication assignment at actual extraction consumer: ' + text, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: '', code: '123456.', evidence: {code: {quote: text}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0);
    assert.equal(outcome.archiveAllowed, false);
    assert.deepEqual(Array.from(outcome.candidates), []);
  });
}

for (const punctuation of ['.', '!']) {
  test('R30 inline authentication instruction ends at token punctuation before promotion: ' + punctuation, () => {
    const {ctx} = harness();
    let calls = 0;
    ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
    const text = 'Use this code to sign in: 123456' + punctuation + ' Brand coupon code SAVE20';
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0);
    assert.equal(outcome.archiveAllowed, false);
  });
}

for (const tail of ['for a discount', 'at checkout']) test('R30 inline instruction still defers an attached promotional tail: ' + tail, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Use this code to sign in: 123456! ' + tail + '. Brand coupon code SAVE20', incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

for (const phrase of ['you requested', 'you asked for']) test('R31 requested-code qualifier establishes affirmative issuance: ' + phrase, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const text = 'Here is the verification code ' + phrase + ': 123456. Brand coupon code SAVE20';
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R31 requested-code qualifier also covers the value-before-label form', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: '123456 is the verification code you requested. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R31 reporting a requested-code qualifier remains ordinary discussion', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'The article discusses the verification code you requested: 123456. Brand coupon code SAVE20', incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

for (const text of [
  'The audit log records verification code 123456. Brand coupon code SAVE20',
  'The audit log records verification code: 123456. Brand coupon code SAVE20',
  'The audit log records verification code = 123456. Brand coupon code SAVE20',
  'The audit log records that 123456 is your verification code. Brand coupon code SAVE20',
  'The audit log records verification code was sent to your phone: 123456. Brand coupon code SAVE20'
]) test('R32 reporting context remains ordinary across label presentation: ' + text, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

test('R32 issuer names containing reporting-shaped words remain authoritative', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Records Bank: 123456 is your verification code. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R32 affirmative issuance survives a prior independent sentence', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Welcome. Your verification code 123456. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R32 imperative note-your-code issuance remains authentication', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Please note your verification code is 123456. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

for (const text of [
  'Please note the verification code is 123456. Brand coupon code SAVE20',
  'Please note that your verification code is 123456. Brand coupon code SAVE20',
  'Welcome. Please note the verification code is 123456. Brand coupon code SAVE20'
]) test('R32 imperative note-code variants remain authentication: ' + text, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R32 records-your reporting remains ordinary', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Acme records your verification code: 123456. Brand coupon code SAVE20', incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

for (const prefix of ['Maybe', 'I think']) test('R32 speculative code prefix remains ordinary: ' + prefix, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: prefix + ' your verification code is 123456. Brand coupon code SAVE20', incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

for (const message of [
  {text: 'Welcome. Maybe your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Maybe 123456 is your verification code. Brand coupon code SAVE20'},
  {subject: 'Sign in to Acme', text: 'Maybe your code is 123456. Brand coupon code SAVE20'}
]) test('R32 speculative occurrence remains ordinary across admission path: ' + message.text, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({incomplete: false, ...message});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

for (const text of [
  'Maybe 123456. is your verification code. Brand coupon code SAVE20',
  'Maybe 123456 is your MFA code. Brand coupon code SAVE20',
  'Maybe 123456 is your account recovery code. Brand coupon code SAVE20',
  'Maybe ABC.77 is your verification code. Brand coupon code SAVE20',
  'Maybe ABC!77 is your MFA code. Brand coupon code SAVE20',
  'Maybe 123456 is your verification code. Additional information. More text. Brand coupon code SAVE20'
]) test('R32 speculative reversed qualified label remains ordinary: ' + text, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 1);
});

test('R32 later speculation does not suppress an earlier issued code', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Your verification code is 123456. Maybe your verification code is 654321. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

for (const destination of ['your phone', 'your email']) test('R32 passive delivery carries a bounded destination: ' + destination, () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const outcome = ctx.extractCouponOutcome_({text: 'Your verification code was sent to ' + destination + ': 123456. Brand coupon code SAVE20', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

for (const label of ['email confirmation code', 'MFA code']) {
  test('R11 explicit authentication label at actual extraction consumer: ' + label, () => {
    const {ctx} = harness();
    const text = 'Acme: Your ' + label + ' is 123456';
    let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({merchant: 'Acme', code: '123456',
        evidence: {merchant: {quote: 'Acme'}, code: {quote: text}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0);
    assert.equal(outcome.archiveAllowed, false);
    assert.deepEqual(Array.from(outcome.candidates), []);
  });
}

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
    ['Brand: use code SAVE20 to verify your discount purchase.', true],
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
    'Brand: use code LOGIN77 for a discount.\n'.repeat(8000), 'x'.repeat(100000) + '\n' + 'LOGIN77 '.repeat(8000),
    '1 a 42 to is '.repeat(8000)]) {
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
    assert.ok(units <= 480 * text.length, 'linear total context bound including one-unit literals');
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
  assert.throws(() => ctx.parseAICandidates_({text: JSON.stringify({authentication: null, candidates: [{unknown: 1}]})}, {text: 'x'}), /AI/);
});

test('R17 actual consumer preserves descriptive participles and excludes qualified factor issuance', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
  const ordinary = ctx.extractCouponOutcome_({text: 'A verification code is used to verify your account. Brand coupon code SAVE20', incomplete: false});
  assert.notEqual(ordinary.excludedReason, 'authentication_code_message');
  assert.equal(ordinary.candidates[0].code, 'SAVE20');
});

test('R17 actual consumer recognizes 2FA and two-factor labels before model extraction', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => assert.fail('factor authentication must not reach model');
  for (const label of ['2FA code', 'two-factor code']) {
    assert.equal(ctx.extractCouponOutcome_({text: 'Your ' + label + ' is 123456', incomplete: false}).excludedReason,
      'authentication_code_message');
  }
});

test('R18 account-recovery issuance excludes before a grounded mistaken coupon proposal', () => {
  const {ctx} = harness(); let calls = 0;
  const text = 'Your account recovery code is 123456. Brand coupon code SAVE20';
  ctx.callGeminiModel_ = () => {
    calls++;
    return aiResponse({code: '123456.', evidence: {merchant: {quote: 'Brand'}, code: {quote: text}}});
  };
  const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(calls, 0); assert.equal(outcome.archiveAllowed, false);
  assert.deepEqual(Array.from(outcome.candidates), []);
});

test('R19 issuer names do not turn clear authentication issuance into an example', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => assert.fail('clear issuer-labelled authentication must not reach model');
  const outcome = ctx.extractCouponOutcome_({text: 'Sample Bank: Your verification code is 123456', incomplete: false});
  assert.equal(outcome.excludedReason, 'authentication_code_message');
  assert.equal(outcome.archiveAllowed, false);
});

test('R22 host-only help domains do not suppress a grounded promotion', () => {
  const {ctx} = harness();
  const message = {text: 'For help with your verification code: support.acme.com. Brand coupon code SAVE20', incomplete: false};
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
  const outcome = ctx.extractCouponOutcome_(message);
  assert.notEqual(outcome.excludedReason, 'authentication_code_message');
  assert.equal(outcome.candidates[0].code, 'SAVE20');
});

test('R22 connected polite and dotted-issuer reports cannot suppress promotions', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
  for (const prefix of ['You said: please ', 'You said: Acme Inc.: ', 'You said: Acme Inc.: please ']) {
    const message = {text: prefix + 'use code 123456 for authentication. Brand coupon code SAVE20', incomplete: false};
    const outcome = ctx.extractCouponOutcome_(message);
    assert.notEqual(outcome.excludedReason, 'authentication_code_message');
    assert.equal(outcome.candidates[0].code, 'SAVE20');
  }
});

test('R22 unquoted reports end before independent semicolon authentication issuance', () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const message = {text: 'You said: please use code 123456 for authentication; Use code 654321 for authentication. Brand coupon code SAVE20', incomplete: false};
  assert.equal(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

test('R22 standalone authentication purpose excludes mixed mail before the model', () => {
  const {ctx} = harness(); let calls = 0;
  ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
  const message = {text: 'Use code 123456 for authentication. Brand coupon code SAVE20', incomplete: false};
  assert.equal(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message');
  assert.equal(calls, 0);
});

for (const [name, message, excluded] of [
  ['modal-report', {text: 'You said that I should use code 123456 to sign in. Brand coupon code SAVE20'}, false],
  ['recipientless-passive', {text: 'Your verification code has been sent: 123456. Brand coupon code SAVE20'}, true],
  ['subject-imperative', {subject: 'Sign in to Acme', text: 'Use code 123456. Brand coupon code SAVE20'}, true],
  ['curly-delimited-value', {text: 'Your verification code is: “ABCDEF”. Brand coupon code SAVE20'}, true]
]) {
  test('R23 actual consumer admission: ' + name, () => {
    const {ctx} = harness(); let calls = 0;
    ctx.callGeminiModel_ = () => { calls++; return aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}}); };
    const outcome = ctx.extractCouponOutcome_({incomplete: false, ...message});
    assert.equal(outcome.excludedReason === 'authentication_code_message', excluded);
    assert.equal(calls, excluded ? 0 : 1);
    if (!excluded) assert.equal(outcome.candidates[0].code, 'SAVE20');
  });
}

test('R21 account and identity confirmation labels exclude mixed mail before the model', () => {
  const {ctx} = harness();
  ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
  for (const target of ['account', 'identity']) {
    const message = {text: 'Your ' + target + ' confirmation code is 123456. Brand coupon code SAVE20', incomplete: false};
    assert.equal(ctx.extractCouponOutcome_(message).excludedReason, 'authentication_code_message');
  }
});

for (const text of ['To sign in, use code 123456. Brand coupon code SAVE20',
  'Your verification code is: "aBcDeF". Brand coupon code SAVE20',
  'To sign in, use this code 123456. Brand coupon code SAVE20',
  'Acme Inc.: To sign in, use code 123456. Brand coupon code SAVE20',
  'A verification code has been sent to you: 123456. Brand coupon code SAVE20']) {
  test('R20 actual consumer recognizes governing issuance: ' + text, () => {
    const {ctx} = harness(); let calls = 0;
    ctx.callGeminiModel_ = () => {
      calls++;
      return aiResponse({code: '123456.', evidence: {merchant: {quote: 'Brand'}, code: {quote: text}}});
    };
    const outcome = ctx.extractCouponOutcome_({text, incomplete: false});
    assert.equal(outcome.excludedReason, 'authentication_code_message');
    assert.equal(calls, 0); assert.equal(outcome.archiveAllowed, false);
  });
}

test('R20 bare alphabetic status and code words cannot establish source or model authentication', () => {
  const {ctx} = harness();
  for (const word of ['incorrect', 'wrong', 'missing', 'aBcDeF', 'HERE', 'ÈTÉ']) {
    const message = {text: 'Your verification code is ' + word + '. Brand coupon code SAVE20', incomplete: false};
    ctx.callGeminiModel_ = () => aiResponse({code: 'SAVE20', evidence: {merchant: {quote: 'Brand'}, code: {quote: 'SAVE20'}}});
    const outcome = ctx.extractCouponOutcome_(message);
    assert.notEqual(outcome.excludedReason, 'authentication_code_message');
    assert.equal(outcome.candidates[0].code, 'SAVE20');
    assert.throws(() => ctx.parseAICandidateOutcome_({text: JSON.stringify({candidates: [],
      authentication: {quote: message.text, image: null}})}, message), error => error.code === 'AI');
    const presented = {text: 'Your verification code: ' + word, incomplete: false};
    assert.equal(ctx.parseAICandidateOutcome_({text: JSON.stringify({candidates: [],
      authentication: {quote: presented.text, image: null}})}, presented).excludedReason, 'authentication_code_message');
  }
});

function aiResponse(overrides = {}) {
  const candidate = Object.assign(Object.fromEntries(['merchant','website','code','discountType','discountValue','minimumSpend','validOn','exclusions','expiry','usageLimits','currency','notes'].map(k => [k, ''])), {
    merchant: 'Brand', code: 'AI20', confidence: 'high', review: false, evidence: {merchant: {quote: 'Brand'}, code: {quote: 'AI20'}}
  }, overrides);
  return {text: JSON.stringify({authentication: null, candidates: [wireCandidate(candidate)]})};
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
    ctx.callGeminiModel_ = () => ({text: JSON.stringify({authentication: null, candidates: codes.slice(0, 12).map(code =>
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
    fetch: (_, options) => { request = JSON.parse(options.payload); return {status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: []})}]}}]})};}
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: [wireCandidate(candidate)]})}]}}]})})
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: []})}]}}]})})
  });
  assert.deepEqual(Array.from(outcome.candidates), []);
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.empty, true);
  assert.equal(outcome.archiveAllowed, false);
  assert.deepEqual(Array.from(outcome.candidates), []);
  assert.equal(ctx.sameCouponOffer_(ctx.normalizeCandidate_(make('First'), {text: 'First SAVE20', incomplete: false}),
    ctx.normalizeCandidate_(make('Second'), {text: 'Second SAVE20', incomplete: false})), false);
  assert.equal(ctx.extractCouponOutcome_({text: '', incomplete: true}, {
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: []})}]}}]})})
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: [wireCandidate(candidate('Monday')), wireCandidate(candidate('Tuesday'))]})}]}}]})})
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
    body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates})}]}}]})})});
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
      body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: [{...proposal, review: needsReview}, proposal]})}]}}]})})});
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: [make('Monday'), make('Tuesday'), make('Monday')]})}]}}]})})
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
  const result = ctx2.extractCouponCandidates_({text: 'offer', incomplete: false}, {fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: [wireCandidate(Object.assign(Object.fromEntries(fields.map(k => [k, ''])), {confidence: 'low', review: true, evidence: {}}))]})}]}}]})})});
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
    fetch: () => ({status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: [wireCandidate(candidate)]})}]}}]})})
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].review, true);
});
