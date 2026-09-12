const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

const request = {text: 'Extract candidates.', images: []};
const ok = JSON.stringify({candidates: [{content: {parts: [{text: 'result'}]}}]});
function response(status, body) { return {status, body: JSON.stringify(body)}; }
function setup() {
  const h = harness();
  h.properties.GEMINI_API_KEY = 'test-key';
  h.properties.MYCOUPONS_CONFIG = JSON.stringify({...h.config, autoVertexFallback: true, vertexProject: 'vertex-project'});
  return h;
}

test('primary Developer request succeeds without exposing the key in the payload', () => {
  const {ctx} = setup(); let seen;
  const result = ctx.callGeminiModel_(request, {fetch: (url, options) => {
    seen = {url, options}; return {status: 200, body: ok};
  }});
  assert.equal(result.text, 'result');
  assert.match(seen.url, /generativelanguage.*gemini-flash-latest/);
  assert.equal(seen.options.headers['x-goog-api-key'], 'test-key');
  assert.doesNotMatch(seen.options.payload, /test-key/);
});

test('Vertex uses the global host only for global and preserves regional hosts', () => {
  const {ctx} = setup();
  assert.match(ctx.buildGeminiEndpoint_('vertex_ai', {vertexProject: 'vertex-project', vertexLocation: 'global', model: 'gemini-flash-latest'}),
    /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/vertex-project\/locations\/global\//);
  assert.match(ctx.buildGeminiEndpoint_('vertex_ai', {vertexProject: 'vertex-project', vertexLocation: 'europe-west1', model: 'gemini-flash-latest'}),
    /^https:\/\/europe-west1-aiplatform\.googleapis\.com\/v1\/projects\/vertex-project\/locations\/europe-west1\//);
});

test('exact daily quota activates Vertex once and persists a one-hour route', () => {
  const {ctx, properties} = setup(); let calls = 0;
  const daily = {error: {code: 'quota_exceeded', message: 'daily quota'}};
  const result = ctx.callGeminiModel_(request, {fetch: (url) => {
    calls += 1; return calls === 1 ? response(429, daily) : {status: 200, body: ok};
  }});
  assert.equal(result.text, 'result'); assert.equal(calls, 2);
  assert.match(properties.MYCOUPONS_GEMINI_VERTEX_UNTIL, /^\d+$/);
  assert.equal(ctx.getEffectiveGeminiBackend_(), 'vertex_ai');
});

test('expired fallback returns to Developer and malformed state is cleared', () => {
  const {ctx, properties} = setup();
  properties.MYCOUPONS_GEMINI_VERTEX_UNTIL = 'not-a-time';
  assert.equal(ctx.getEffectiveGeminiBackend_(), 'gemini_api');
  assert.equal(properties.MYCOUPONS_GEMINI_VERTEX_UNTIL, undefined);
});

test('generic 429, transient text, and network failures never activate Vertex', () => {
  for (const failure of [
    response(429, {error: {code: 429, status: 'RESOURCE_EXHAUSTED', message: 'try again'}}),
    response(429, {error: {code: 'rate_limit', message: 'quota exceeded briefly'}})
  ]) {
    const {ctx, properties} = setup(); let attempts = 0;
    assert.throws(() => ctx.callGeminiModel_(request, {fetch: () => { attempts += 1; return failure; }}), /HTTP 429/);
    assert.equal(attempts, 3); assert.equal(properties.MYCOUPONS_GEMINI_VERTEX_UNTIL, undefined);
  }
  const {ctx, properties} = setup(); let attempts = 0;
  assert.throws(() => ctx.callGeminiModel_(request, {fetch: () => { attempts += 1; throw new Error('offline'); }}), /network/);
  assert.equal(attempts, 3); assert.equal(properties.MYCOUPONS_GEMINI_VERTEX_UNTIL, undefined);
});

test('production retries sleep within the runtime deadline', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'test-key';
  const sleeps = []; ctx.Utilities.sleep = milliseconds => sleeps.push(milliseconds);
  const response = JSON.stringify({candidates: [{content: {parts: [{text: 'ok'}]}}]});
  const result = ctx.callGeminiModel_({text: 'offer', images: []}, {fetch: (() => {
    let calls = 0; return () => ++calls < 3 ? {status: 503, body: ''} : {status: 200, body: response};
  })(), deadlineMs: Date.now() + 5000});
  assert.equal(result.text, 'ok'); assert.deepEqual(sleeps, [250, 500]);
  assert.throws(() => ctx.callGeminiModel_({text: 'offer', images: []}, {fetch: () => ({status: 503, body: ''}),
    deadlineMs: Date.now() + 100}), /LIMIT/);
});

test('oversized quota-like errors fail closed before fallback classification', () => {
  const {ctx, properties} = setup();
  const body = JSON.stringify({error: {code: 'quota_exceeded', message: 'daily quota'}}) + 'x'.repeat(1024 * 1024);
  assert.throws(() => ctx.callGeminiModel_(request, {fetch: () => ({status: 429, body})}), /GEMINI_RESPONSE/);
  assert.equal(properties.MYCOUPONS_GEMINI_VERTEX_UNTIL, undefined);
});

test('invalid image MIME, base64, and aggregate size are rejected before fetch', () => {
  for (const images of [
    [{mimeType: 'text/plain', data: 'AAAA'}],
    [{mimeType: 'image/png', data: 'not base64'}],
    [{mimeType: 'image/png', data: 'AA=='}],
    [{mimeType: 'image/png', data: 'A=AA'}],
    [{mimeType: 'image/png', data: 'AB'}],
    [{mimeType: 'image/png', data: 'A'.repeat(4 * 1024 * 1024)}]
  ]) {
    const {ctx} = setup(); let fetches = 0;
    assert.throws(() => ctx.callGeminiModel_({text: 'x', images}, {
      fetch: () => { fetches += 1; return {status: 200, body: ok}; }
    }), /GEMINI_REQUEST/);
    assert.equal(fetches, 0);
  }
  const {ctx} = setup(); let fetches = 0;
  const images = Array.from({length: 5}, () => ({mimeType: 'image/png', data: 'A'.repeat(2 * 1024 * 1024)}));
  assert.throws(() => ctx.callGeminiModel_({text: 'x', images}, {
    fetch: () => { fetches += 1; return {status: 200, body: ok}; }
  }), /GEMINI_REQUEST/);
  assert.equal(fetches, 0);
});

test('Gemini image byte budgets use exact unpadded base64url lengths', () => {
  const {ctx} = setup();
  const encode = length => Buffer.alloc(length).toString('base64url');
  const max = 2 * 1024 * 1024;
  const fetch = () => ({status: 200, body: ok});
  for (const [length, expected] of [[1, 1], [2, 2], [3, 3]]) {
    const data = encode(length);
    assert.equal(ctx.base64UrlByteLength_(data), expected);
    assert.equal(ctx.callGeminiModel_({text: 'x', images: [{mimeType: 'image/png', data}]}, {fetch}).text, 'result');
  }
  const exact = encode(max);
  assert.equal(ctx.callGeminiModel_({text: 'x', images: Array.from({length: 3}, () => ({mimeType: 'image/png', data: exact}))}, {fetch}).text, 'result');
  for (const images of [
    [{mimeType: 'image/png', data: encode(max + 1)}],
    Array.from({length: 3}, () => ({mimeType: 'image/png', data: exact})).concat({mimeType: 'image/png', data: encode(1)})
  ]) {
    let calls = 0;
    assert.throws(() => ctx.callGeminiModel_({text: 'x', images}, {fetch: () => { calls++; return {status: 200, body: ok}; }}), /GEMINI_REQUEST/);
    assert.equal(calls, 0);
  }
});

test('malformed response, missing key, and invalid request fail closed', () => {
  const {ctx} = setup();
  assert.throws(() => ctx.callGeminiModel_(request, {fetch: () => ({status: 200, body: '{}'})}), /GEMINI_RESPONSE/);
  const missing = harness();
  assert.throws(() => missing.ctx.callGeminiModel_(request, {fetch: () => ({status: 200, body: ok})}), /GEMINI_API_KEY/);
  assert.throws(() => ctx.callGeminiModel_({text: ''}, {fetch: () => ({status: 200, body: ok})}), /GEMINI_REQUEST/);
});
