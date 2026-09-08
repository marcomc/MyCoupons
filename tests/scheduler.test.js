const test = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

test('notification delta sends once and ignores unchanged outcome', () => {
  const {ctx, properties} = harness();
  const sent = [];
  ctx.MailApp = {sendEmail: (...args) => sent.push(args)};
  const summary = {imported: 1, review: 0, errors: [], links: []};
  const first = ctx.notifyScheduledImport_(summary);
  assert.equal(first.sent, true);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.fingerprint, JSON.parse(properties.MYCOUPONS_NOTIFICATION_STATE).fingerprint);
  assert.equal(ctx.notifyScheduledImport_(summary).sent, false);
  assert.equal(sent.length, 1);
});

test('notification send failure leaves prior state unchanged for retry', () => {
  const {ctx, properties} = harness();
  ctx.MailApp = {sendEmail: () => { throw new Error('send failed'); }};
  assert.throws(() => ctx.notifyScheduledImport_({imported: 1, review: 0, errors: [], links: []}));
  assert.equal(properties.MYCOUPONS_NOTIFICATION_STATE, undefined);
});

test('notification links require the supported HTTPS authorities', () => {
  const {ctx} = harness();
  assert.equal(ctx.validNotificationLink_('https://docs.google.com/spreadsheets/d/sheet/edit#gid=1'), true);
  assert.equal(ctx.validNotificationLink_('https://mail.google.com/mail/u/0/#all/abcdef'), true);
  assert.equal(ctx.validNotificationLink_('http://docs.google.com/spreadsheets/d/sheet'), false);
  assert.equal(ctx.validNotificationLink_('https://evil.example/sheet'), false);
});
