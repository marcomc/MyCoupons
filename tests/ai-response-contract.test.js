const test = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

const fields = ['merchant', 'website', 'code', 'discountType', 'discountValue', 'minimumSpend',
  'validOn', 'exclusions', 'expiry', 'usageLimits', 'currency', 'notes'];
const fact = (value, quote = value, image = null) => ({value, quote, image});
const candidate = () => ({...Object.fromEntries(fields.map(k => [k, null])),
  merchant: fact('Brand'), code: fact('Save+Ü20'), confidence: 'high', review: false});
const response = candidates => ({text: JSON.stringify({candidates})});
const provider = text => ({status: 200, body: JSON.stringify({candidates: [
  {finishReason: 'STOP', content: {parts: [{text}]}}
]})});
const message = {text: 'Brand Save+Ü20 Members only', incomplete: false};

test('both configured backends send identical typed JSON generation contracts', () => {
  for (const fallback of [false, true]) {
    const {ctx, properties, config} = harness(); properties.GEMINI_API_KEY = 'test';
    properties.MYCOUPONS_CONFIG = JSON.stringify({...config, autoVertexFallback: true, vertexProject: 'valid-project'});
    const requests = [];
    const result = ctx.extractCouponOutcome_(message, {fetch: (url, options) => {
      const payload = JSON.parse(options.payload); requests.push({url, payload});
      if (fallback && requests.length === 1) return {status: 429, body: JSON.stringify({error: {
        code: 'quota_exceeded', message: 'Daily quota exhausted.'
      }})};
      return provider(response([candidate()]).text);
    }});
    assert.equal(result.archiveAllowed, true);
    assert.equal(requests.length, fallback ? 2 : 1);
    const generation = requests.at(-1).payload.generationConfig;
    assert.equal(generation.responseMimeType, 'application/json');
    const schema = generation.responseJsonSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['candidates']);
    assert.equal(schema.properties.candidates.maxItems, undefined);
    const offer = schema.properties.candidates.items;
    assert.deepEqual(offer.required, [...fields, 'confidence', 'review']);
    assert.equal(offer.additionalProperties, false);
    for (const field of fields) {
      const f = offer.properties[field];
      assert.deepEqual(f.type, ['object', 'null']);
      assert.deepEqual(f.required, ['value', 'quote', 'image']);
      assert.equal(f.additionalProperties, false);
      assert.equal(f.properties.value.type, 'string');
      assert.equal(f.properties.quote.type, 'string');
      assert.deepEqual(f.properties.image.type, ['integer', 'null']);
    }
    if (fallback) {
      assert.match(requests[1].url, /aiplatform.googleapis.com/);
      assert.deepEqual(requests[0].payload, requests[1].payload);
    }
  }
});

test('observed fence, array, missing binding and empty-fact failures remain fail-closed', () => {
  const {ctx} = harness();
  assert.throws(() => ctx.parseAICandidateOutcome_({text: '```json\n' + response([candidate()]).text + '\n```'}, message), /AI/);
  const mutations = [
    c => { c.code.quote = ['Save+Ü20']; },
    c => { c.code.image = ['0']; },
    c => { c.code.image = '0'; },
    c => { c.code.value = 20; },
    c => { c.code.quote = ''; },
    c => { delete c.code.quote; },
    c => { c.notes = fact('', 'Members only'); },
    c => { c.notes = fact('Members only', ''); },
    c => { c.code.value = '\ud800'; },
    c => { c.code.quote = '\ud800'; },
    c => { c.code.image = 0; },
    c => { c.code.image = -1; },
    c => { c.code.image = 0.5; },
    c => { c.extra = 'unvalidated'; },
    c => { c.evidence = {}; },
    c => { c.code.extra = 'unvalidated'; },
    c => { delete c.notes; },
    c => { c.review = 'false'; },
    c => { c.confidence = 'certain'; }
  ];
  for (const mutate of mutations) {
    const c = candidate(); mutate(c);
    assert.throws(() => ctx.parseAICandidateOutcome_(response([c]), message), /AI/, String(mutate));
  }
  assert.throws(() => ctx.parseAICandidateOutcome_({text: '{"candidates":[],"extra":true}'}, message), /AI/);
  for (const duplicate of ['"candidates":[],"candidates":[]',
    '"candidates":[{"code":{"value":"X","value":"Y"}}]']) {
    assert.throws(() => ctx.parseAICandidateOutcome_({text: '{' + duplicate + '}'}, message), /AI/);
  }
});

test('the complete wire set is checked before projection and oversized offer sets cannot be selected down', () => {
  const {ctx} = harness();
  let projections = 0;
  ctx.projectAIWireCandidate_ = () => { projections++; throw new Error('projection reached'); };
  const bad = candidate(); bad.notes = {value: 'Unknown', quote: ['Unknown'], image: null};
  assert.throws(() => ctx.parseAICandidateOutcome_(response([candidate(), bad]), message), /^Error: AI$/);
  assert.throws(() => ctx.parseAICandidateOutcome_(response(Array.from({length: 13}, candidate)), message), /^Error: AI$/);
  assert.equal(projections, 0);
});

test('ungrounded claims cannot become a verified non-offer or automatic archive', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test';
  for (const claims of [[candidate()], [{...candidate(), notes: fact('Invented')}], [
    {...candidate(), merchant: fact('Invented'), code: fact('Invented')}
  ]]) {
    const outcome = ctx.extractCouponOutcome_(message, {fetch: () => provider(response(claims).text)});
    assert.equal(outcome.verifiedNonOffer, false);
    assert.equal(outcome.archiveAllowed, claims[0].notes === null && claims[0].merchant.value === 'Brand');
  }
  for (const incomplete of [false, true]) {
    const empty = ctx.extractCouponOutcome_({...message, incomplete}, {fetch: () => provider(response([]).text)});
    assert.equal(empty.verifiedNonOffer, !incomplete); assert.equal(empty.archiveAllowed, false);
    const offer = ctx.extractCouponOutcome_({...message, incomplete}, {fetch: () => provider(response([candidate()]).text)});
    assert.equal(offer.archiveAllowed, !incomplete);
  }
});

test('image evidence remains tied to an inspected index and requires review', () => {
  const {ctx} = harness();
  const source = {text: '', incomplete: false, images: [{mimeType: 'image/png', bytes: [137,80,78,71], sourceId: 'image-one'}]};
  const c = {...candidate(), merchant: fact('Brand', '', 0), code: fact('Save+Ü20', '', 0)};
  const result = ctx.parseAICandidateOutcome_(response([c]), source);
  assert.equal(result.candidates[0].review, true);
  assert.equal(result.candidates[0].imageEvidence.code.sourceId, 'image-one');
  c.notes = fact('Members only', '', 1);
  assert.throws(() => ctx.parseAICandidateOutcome_(response([c]), source), /AI/);
});

test('HTTP 200 format failures and incomplete provider responses do not retry or activate paid fallback', () => {
  for (const mode of ['format', 'missing-stop', 'MAX_TOKENS', 'SAFETY', 'extra-candidate']) {
    const {ctx, properties, config} = harness(); properties.GEMINI_API_KEY = 'test';
    properties.MYCOUPONS_CONFIG = JSON.stringify({...config, autoVertexFallback: true, vertexProject: 'valid-project'});
    let calls = 0, sleeps = 0;
    const p = provider(mode === 'format' ? '```json{}' : response([]).text);
    const body = JSON.parse(p.body);
    if (mode === 'missing-stop') delete body.candidates[0].finishReason;
    if (['MAX_TOKENS', 'SAFETY'].includes(mode)) body.candidates[0].finishReason = mode;
    if (mode === 'extra-candidate') body.candidates.push(body.candidates[0]);
    assert.throws(() => ctx.extractCouponOutcome_(message, {fetch: () => {
      calls++; return {status: 200, body: JSON.stringify(body)};
    }, sleep: () => sleeps++, deadlineMs: Date.now() + 10000}), /AI|GEMINI_RESPONSE/);
    assert.equal(calls, 1); assert.equal(sleeps, 0);
    assert.equal(properties.MYCOUPONS_GEMINI_VERTEX_UNTIL, undefined);
  }
});
