const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

function encoded(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function message(payload) {
  return {id: 'abc123', internalDate: '0', payload};
}

const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 20, 0, 0, 0, 20];

test('maps a unique inline CID in DOM order and preserves independent HTML', () => {
  const {ctx} = harness();
  const bytes = png;
  const raw = message({mimeType: 'multipart/related', parts: [
    {mimeType: 'text/html', body: {data: encoded(Buffer.from('<img src="cid:hero">')), size: 25}},
    {mimeType: 'image/png', filename: 'hero.png', headers: [{name: 'Content-ID', value: '<hero>'}], body: {data: encoded(bytes), size: bytes.length}}
  ]});
  const result = ctx.acquireMessageImages_(raw, '<img src="cid:hero">');
  assert.equal(result.incomplete, false);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].sourceId, 'abc123:image:0');
  assert.equal(result.images[0].dimensions.width, 20);
});

test('duplicate inline identities remain uninspected and incomplete', () => {
  const {ctx} = harness();
  const raw = message({mimeType: 'multipart/related', parts: [
    {mimeType: 'image/gif', headers: [{name: 'Content-ID', value: '<same>'}], body: {data: encoded([71, 73, 70, 56, 57, 97, 20, 0, 20, 0])}},
    {mimeType: 'image/gif', headers: [{name: 'Content-ID', value: '<same>'}], body: {data: encoded([71, 73, 70, 56, 57, 97, 20, 0, 20, 0])}}
  ]});
  const result = ctx.acquireMessageImages_(raw, '<img src="cid:same">');
  assert.equal(result.incomplete, true);
  assert.equal(result.images.length, 2);
});

test('retrieves a bounded Gmail attachment by attachmentId without mutation', () => {
  const {ctx} = harness();
  const calls = [];
  ctx.Gmail.Users.Messages = {Attachments: {get: (user, id, attachmentId) => {
    calls.push([user, id, attachmentId]);
    return {data: encoded([71, 73, 70, 56, 57, 97, 20, 0, 20, 0])};
  }}};
  const result = ctx.acquireMessageImages_(message({mimeType: 'image/gif', filename: 'offer.gif', body: {attachmentId: 'att-1', size: 10}}), '');
  assert.equal(result.incomplete, false);
  assert.deepEqual(calls, [['me', 'abc123', 'att-1']]);
  assert.equal(result.images[0].mimeType, 'image/gif');
});

test('accepts only successful non-tracker remote image responses', () => {
  const {ctx} = harness();
  const calls = [];
  ctx.UrlFetchApp = {fetch: (url, options) => {
    calls.push({url, options});
    return {getResponseCode: () => 200, getHeaders: () => ({'Content-Type': 'image/png'}), getContent: () => png};
  }};
  let result = ctx.acquireMessageImages_(message({mimeType: 'multipart/mixed', parts: []}), '<img src="https://shop.com/offer.png">');
  assert.equal(result.incomplete, false);
  assert.equal(result.images.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.followRedirects, false);
  result = ctx.acquireMessageImages_(message({mimeType: 'multipart/mixed', parts: []}), '<img src="https://shop.com/pixel.gif"><img src="http://shop.com/no.png"><img width="1" src="https://shop.com/tiny.png">');
  assert.equal(result.incomplete, true);
  assert.equal(calls.length, 1);
});

test('does not fetch beyond the image-count bound', () => {
  const {ctx} = harness();
  let calls = 0;
  ctx.UrlFetchApp = {fetch: () => { calls++; return {getResponseCode: () => 200, getHeaders: () => ({'Content-Type': 'image/png'}), getContent: () => png}; }};
  const html = Array.from({length: 13}, (_, i) => '<img src="https://shop.com/' + i + '.png">').join('');
  const result = ctx.acquireMessageImages_(message({mimeType: 'multipart/mixed', parts: []}), html);
  assert.equal(calls, 6);
  assert.equal(result.incomplete, true);
  assert.equal(result.images.length, 6);
});

test('acquisition omits excess attachment images before Gemini transport and preserves image indexes', () => {
  const {ctx, properties} = harness(); properties.GEMINI_API_KEY = 'synthetic-key';
  const gif = [71, 73, 70, 56, 57, 97, 3, 0, 3, 0, 0, 0, 0];
  const raw = message({mimeType: 'multipart/mixed', parts: Array.from({length: 7}, (_, index) => ({
    mimeType: 'image/gif', filename: 'image' + index + '.gif', headers: [], body: {data: gif, size: gif.length}
  }))});
  const acquired = ctx.acquireMessageImages_(raw, '');
  assert.equal(acquired.incomplete, true);
  assert.deepEqual(Array.from(acquired.images, image => [image.sourceId, image.slot, image.mimeType]), [
    ['abc123:image:0', 0, 'image/gif'], ['abc123:image:1', 1, 'image/gif'],
    ['abc123:image:2', 2, 'image/gif'], ['abc123:image:3', 3, 'image/gif'],
    ['abc123:image:4', 4, 'image/gif'], ['abc123:image:5', 5, 'image/gif']
  ]);
  let request;
  const outcome = ctx.extractCouponOutcome_({text: 'Coupon code SAVE20', incomplete: acquired.incomplete, images: acquired.images}, {
    fetch: (_, options) => {
      request = JSON.parse(options.payload);
      return {status: 200, body: JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify({authentication: null, candidates: []})}]}}]})};
    }
  });
  assert.equal(request.contents[0].parts.filter(part => part.inlineData).length, 6);
  assert.equal(outcome.status, 'incomplete');
  assert.equal(outcome.archiveAllowed, false);
});

test('CID matching is case-sensitive and same-filename attachments remain independent', () => {
  const {ctx} = harness();
  const raw = message({mimeType: 'multipart/mixed', parts: [
    {mimeType: 'image/gif', filename: 'same.gif', headers: [{name: 'Content-ID', value: '<Hero>'}], body: {data: encoded([71, 73, 70, 56, 57, 97, 20, 0, 20, 0])}},
    {mimeType: 'image/gif', filename: 'same.gif', body: {data: encoded([71, 73, 70, 56, 57, 97, 20, 0, 20, 0])}}
  ]});
  let result = ctx.acquireMessageImages_(raw, '<img src="cid:hero">');
  assert.equal(result.incomplete, true);
  assert.equal(result.images.length, 2);
  result = ctx.acquireMessageImages_(raw, '<img src="cid:Hero">');
  assert.equal(result.incomplete, false);
  assert.equal(result.images.length, 2);
});

test('malformed image bytes and non-image attachment MIME are never inspected', () => {
  const {ctx} = harness();
  let gets = 0;
  ctx.Gmail.Users.Messages = {Attachments: {get: () => { gets++; return {data: encoded([1, 2, 3])}; }}};
  const result = ctx.acquireMessageImages_(message({mimeType: 'multipart/mixed', parts: [
    {mimeType: 'application/pdf', body: {attachmentId: 'pdf'}},
    {mimeType: 'image/png', body: {attachmentId: 'bad', size: 3}}
  ]}), '');
  assert.equal(gets, 1);
  assert.equal(result.incomplete, true);
  assert.equal(result.images.length, 0);
});

test('attachment size and base64 validation fail closed before retrieval or inspection', () => {
  const {ctx} = harness();
  let gets = 0;
  ctx.Gmail.Users.Messages = {Attachments: {get: () => { gets++; return {data: encoded([71, 73, 70, 56, 57, 97, 20, 0, 20, 0])}; }}};
  for (const body of [{attachmentId: 'missing'}, {attachmentId: 'large', size: 2 * 1024 * 1024 + 1}]) {
    const result = ctx.acquireMessageImages_(message({mimeType: 'image/gif', body}), '');
    assert.equal(result.incomplete, true);
    assert.equal(result.images.length, 0);
  }
  assert.equal(gets, 0);
  const malformed = message({mimeType: 'image/gif', body: {data: 'a==='}});
  const result = ctx.acquireMessageImages_(malformed, '');
  assert.equal(result.incomplete, true);
  assert.equal(result.images.length, 0);
});
