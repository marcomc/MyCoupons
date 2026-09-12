const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

const signed = bytes => Array.from(bytes, byte => byte > 127 ? byte - 256 : byte);
const forms = bytes => [Array.from(bytes), signed(bytes), Buffer.from(bytes).toString('base64url'), Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')];
const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 200, 0, 0, 1, 128];
const invalidArrays = () => [[undefined], [null], ['1'], [1.5], [NaN], [Infinity], [-129], [256], [true], new Array(1), Object.assign(new Array(1), {extra: 1})];

function strictUtilities(ctx) {
  const original = ctx.Utilities.newBlob;
  ctx.Utilities.newBlob = (bytes, ...args) => {
    assert.ok(bytes.every(byte => Number.isInteger(byte) && byte >= -128 && byte <= 127));
    return original(bytes, ...args);
  };
  ctx.Utilities.base64DecodeWebSafe = value => signed(Buffer.from(value, 'base64url'));
}

test('both Gmail byte representations preserve every octet and exact Unicode text', () => {
  const {ctx} = harness(); strictUtilities(ctx);
  const octets = Array.from({length: 256}, (_, i) => i);
  for (const data of forms(octets)) {
    assert.deepEqual(Array.from(ctx.decodeBytePayload_(data, 256)), signed(octets));
  }
  for (const value of ['Caffè: coupon code ÉTÉ+20 🎁\r\n東京 e\u0301', 'a', 'ab', 'abc']) {
    const bytes = Buffer.from(value);
    for (const data of forms(bytes)) {
      const original = Array.isArray(data) ? data.slice() : data;
      assert.equal(ctx.decodeMimeBody_({data, size: bytes.length}, []), value);
      assert.deepEqual(data, original);
      assert.throws(() => ctx.decodeMimeBody_({data, size: bytes.length + 1}, []), /MAIL/);
    }
  }
  for (const data of forms([67, 97, 102, 233])) {
    assert.equal(ctx.decodeMimeBody_({data, size: 4}, [{name: 'content-type', value: 'text/plain; charset=iso-8859-1'}]), 'Café');
  }
});

test('shared boundary rejects invalid elements before Utilities or image inspection', () => {
  const {ctx} = harness();
  ctx.Utilities.newBlob = () => assert.fail('invalid bytes cannot reach a blob');
  for (const data of [...invalidArrays(), new Int8Array([1]), {0: 1, length: 1}, 1, false]) {
    assert.throws(() => ctx.decodeMimeBody_({data}, []), /MAIL/);
    assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data}, 0), null);
  }
  for (const tail of invalidArrays()) {
    const data = png.concat(tail);
    assert.equal(ctx.imageSignature_('image/png', data), false);
    assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data}, 0), null);
  }
  ctx.Utilities.base64DecodeWebSafe = () => [256];
  assert.throws(() => ctx.decodeMimeBody_({data: 'AA'}, []), /MAIL/);
});

test('empty and missing data are accepted only without a positive declared size', () => {
  const {ctx} = harness();
  ctx.Utilities.base64DecodeWebSafe = () => assert.fail('no empty decode');
  for (const data of ['', [], undefined, null]) {
    for (const size of [0, undefined]) assert.equal(ctx.decodeMimeBody_({data, size}, []), '');
    assert.throws(() => ctx.decodeMimeBody_({data, size: 1}, []), /MAIL/);
    assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data}, 0), null);
  }
  for (const size of ['0', -1, NaN, Infinity, 0.5]) {
    assert.throws(() => ctx.decodeMimeBody_({data: [], size}, []), /MAIL/);
  }
});

test('base64url syntax rejects padding errors and discarded nonzero tail bits', () => {
  const {ctx} = harness();
  for (const data of ['A', '=', '====', 'AA=', 'AAA==', 'AAAA=', 'AA===', 'A=AA', 'A A', 'AA\n', '+w', '/w', 'AB', 'AAB']) {
    assert.throws(() => ctx.decodeMimeBody_({data}, []), /MAIL/, data);
    assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data}, 0), null);
  }
});

test('multipart containers accept empty byte arrays but reject hidden body content or inconsistent size', () => {
  const {ctx} = harness();
  for (const data of ['', [], undefined]) {
    const part = {mimeType: 'multipart/alternative', body: {data, size: 0}, parts: [{mimeType: 'text/plain', body: {data: [65], size: 1}}]};
    assert.equal(ctx.parseMimePayload_(part).text, 'A');
    assert.equal(ctx.parseMimePayload_({...part, parts: undefined}).incomplete, true);
  }
  for (const body of [{data: [65], size: 1}, {data: 'QQ', size: 1}, {data: [], size: 1}, {data: false}, {data: [256]}, []]) {
    for (const parts of [[], undefined]) assert.throws(() => ctx.parseMimePayload_({mimeType: 'multipart/mixed', body, parts}), /MAIL/);
  }
});

test('signed inline, attachment and remote images preserve signature, dimensions and transport bytes', () => {
  for (const data of forms(png)) {
    const {ctx} = harness(); strictUtilities(ctx);
    const blob = ctx.Utilities.newBlob;
    ctx.Utilities.newBlob = bytes => { assert.deepEqual(Array.from(bytes), signed(png)); return blob(bytes); };
    for (const external of [false, true]) {
      let reads = 0;
      ctx.Gmail.Users.Messages = {Attachments: {get: () => { reads++; return {data, size: png.length}; }}};
      const resource = {mimeType: 'image/png', declaredSize: png.length, data: external ? [] : data, attachmentId: external ? 'att' : ''};
      const record = ctx.materializeImage_('abc123', 0, resource, 0);
      assert.equal(reads, external ? 1 : 0);
      assert.equal(record.dimensions.width, 200); assert.equal(record.dimensions.height, 384);
      assert.deepEqual(Array.from(record.bytes), signed(png));
      assert.equal(ctx.Utilities.base64EncodeWebSafe(record.bytes), Buffer.from(png).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  const {ctx} = harness(); strictUtilities(ctx);
  ctx.UrlFetchApp = {fetch: () => ({getResponseCode: () => 200, getHeaders: () => ({'Content-Type': 'image/png'}), getContent: () => signed(png)})};
  const remote = ctx.acquireMessageImages_({id: 'abc123'}, '<img src="https://example.com/offer.png">');
  assert.equal(remote.images[0].dimensions.height, 384);
  assert.equal(remote.incomplete, false);
  assert.equal(ctx.imageSignature_('image/jpeg', [-1, -40, -1]), true);
  assert.equal(ctx.imageSignature_('image/jpeg', [255, 216, 255]), true);
  const gif = [71, 73, 70, 56, 57, 97, 200, 0, 128, 1];
  assert.equal(ctx.imageDimensions_('image/gif', signed(gif)).width, 200);
  assert.equal(ctx.imageDimensions_('image/gif', signed(gif)).height, 384);
});

test('attachment and inline sizes, invalid bytes and aggregate limits retain incomplete coverage', () => {
  const {ctx} = harness();
  const raw = {id: 'abc123', payload: {mimeType: 'image/png', body: {attachmentId: 'att', size: png.length}}};
  for (const attachment of [{data: signed(png), size: 1}, {data: signed(png), size: '24'}, {data: signed(png.slice(1))}, {data: []}, {}, ...invalidArrays().map(data => ({data}))]) {
    ctx.Gmail.Users.Messages = {Attachments: {get: () => attachment}};
    const result = ctx.acquireMessageImages_(raw, '');
    assert.equal(result.incomplete, true); assert.equal(result.images.length, 0);
  }
  for (const declaredSize of [1, '24', -1, NaN]) {
    assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data: png, declaredSize}, 0), null);
  }
  assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data: png}, 6 * 1024 * 1024), null);
  assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data: png.concat(new Array(2 * 1024 * 1024).fill(0))}, 0), null);
  const tiny = png.slice(); tiny[19] = 1;
  assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data: signed(tiny)}, 0), null);
});

test('synthetic Advanced Gmail full message reaches canonicalization, evidenced extraction and image transport', () => {
  const {ctx, properties} = harness(); strictUtilities(ctx); properties.GEMINI_API_KEY = 'synthetic-key';
  const text = 'Caffè coupon code ÉTÉ+20 🎁';
  const html = '<p>' + text + '</p><img src="cid:hero">';
  const body = value => ({data: signed(Buffer.from(value)), size: Buffer.byteLength(value)});
  const raw = {id: 'abc123', threadId: 'def456', internalDate: '0', payload: {mimeType: 'multipart/related', body: {data: [], size: 0},
    headers: [{name: 'Subject', value: 'Caffè offer'}, {name: 'From', value: 'offers@example.com'}], parts: [
      {mimeType: 'multipart/alternative', body: {data: [], size: 0}, parts: [
        {mimeType: 'text/plain', body: body(text)}, {mimeType: 'text/html', body: body(html)}]},
      {mimeType: 'image/png', headers: [{name: 'Content-ID', value: '<hero>'}], body: {attachmentId: 'att', size: png.length}}]}};
  ctx.Gmail.Users.Messages = {get: () => raw, Attachments: {get: () => ({data: signed(png), size: png.length})}};
  const report = ctx.diagnoseGmailRead('abc123');
  assert.equal(report.mime, 'ok'); assert.equal(report.canonical, 'ok');
  const message = ctx.canonicalGmailMessage_(raw);
  assert.equal(message.text, text); assert.equal(message.html, html);
  assert.equal(message.images[0].dimensions.width, 200);
  let calls = 0;
  const outcome = ctx.extractCouponOutcome_(message, {fetch: (_, request) => {
    calls++;
    assert.match(JSON.stringify(request), new RegExp(Buffer.from(png).toString('base64url')));
    return {status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})};
  }});
  assert.equal(calls, 1);
  assert.equal(outcome.candidates[0].code, 'ÉTÉ+20');
  assert.equal(outcome.archiveAllowed, false); // Unsupported MIME coverage still requires review.
});

test('padded Apps Script image encoding canonicalizes every remainder before Gemini transport', () => {
  for (const bytes of [[255], [255, 1], [255, 1, 2]]) {
    for (const imageBytes of [bytes, signed(bytes)]) {
      const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'synthetic-key';
      const utilityOutput = ctx.Utilities.base64EncodeWebSafe(imageBytes);
      const expected = Buffer.from(bytes).toString('base64url');
      assert.equal(utilityOutput, Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
      let request;
      const outcome = ctx.extractCouponOutcome_({text: 'Brand coupon code SAVE20', incomplete: false,
        images: [{mimeType: 'image/png', bytes: imageBytes, sourceId: 'image'}]}, {fetch: (_, options) => {
          request = JSON.parse(options.payload);
          return {status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({candidates: []})}]}}]})};
        }});
      const data = request.contents[0].parts[1].inlineData.data;
      assert.equal(data, expected);
      assert.deepEqual(Array.from(Buffer.from(data, 'base64url')), bytes);
      assert.equal(outcome.status, 'complete');
    }
  }
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'synthetic-key';
  ctx.Utilities.base64EncodeWebSafe = () => 'AA=';
  assert.throws(() => ctx.extractCouponOutcome_({text: 'offer', incomplete: false,
    images: [{mimeType: 'image/png', bytes: [0], sourceId: 'image'}]}), e => ctx.errorCode_(e) === 'AI');
});

test('image byte budgets reject oversized arrays and base64 before decode or byte copying', () => {
  const {ctx} = harness();
  let decodes = 0; let copies = 0;
  ctx.Utilities.base64DecodeWebSafe = () => { decodes++; throw Error('must not decode an oversized image'); };
  const max = 2 * 1024 * 1024;
  const oversized = new Array(max + 1).fill(0);
  Object.defineProperty(oversized, 0, {get: () => { copies++; return 0; }});
  const encoded = Buffer.alloc(max + 1).toString('base64url');
  for (const data of [oversized, encoded]) {
    for (const declaredSize of [undefined, png.length]) {
      assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data, declaredSize}, 0), null);
    }
    ctx.Gmail.Users.Messages = {Attachments: {get: () => ({data, size: png.length})}};
    assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', attachmentId: 'att', declaredSize: png.length}, 0), null);
  }
  assert.equal(ctx.materializeImage_('abc123', 0, {mimeType: 'image/png', data: Buffer.from(png).toString('base64url')}, 6 * 1024 * 1024 - 1), null);
  assert.equal(decodes, 0); assert.equal(copies, 0);
  const fresh = harness().ctx;
  // The exact cap remains valid; padding must not inflate the byte estimate.
  for (const data of forms([1, 2])) assert.equal(fresh.decodeBytePayload_(data, 2, null, 2).length, 2);
});


test('remote image acquisition stops at the exact aggregate budget before another fetch', () => {
  const {ctx} = harness();
  const large = png.concat(new Array(2 * 1024 * 1024 - png.length).fill(0));
  let reads = 0;
  ctx.UrlFetchApp = {fetch: () => {
    reads++;
    if (reads > 3) assert.fail('must not fetch after reaching the aggregate image budget');
    return {getResponseCode: () => 200, getHeaders: () => ({'Content-Type': 'image/png'}),
      getContent: () => large};
  }};
  const html = Array.from({length: 5}, (_, i) => '<img src="https://example.com/' + i + '.png">').join('');
  const result = ctx.acquireMessageImages_({id: 'abc123'}, html);
  assert.equal(reads, 3);
  assert.equal(result.images.length, 3);
  assert.equal(result.incomplete, true);
});
