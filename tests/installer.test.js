const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

test('installer input accepts only validated product configuration', () => {
  const {ctx, config} = harness();
  assert.equal(ctx.validateInstallerInput_(config).ownerEmail, 'owner@example.com');
  assert.throws(() => ctx.validateInstallerInput_({...config, secret: 'never'}), /CONFIG/);
  assert.throws(() => ctx.validateInstallerInput_({...config, ownerEmail: 'not-an-email'}), /CONFIG/);
});

test('installer input rejects oversized bounded settings', () => {
  const {ctx, config} = harness();
  assert.throws(() => ctx.validateInstallerInput_({...config, model: 'gemini-' + 'x'.repeat(8000)}), /CONFIG/);
});

test('persisted label identity is accepted only on the resume path', () => {
  const {ctx, config} = harness();
  const persisted = {...config, labelId: 'Label_123'};
  assert.equal(ctx.validateInstallerInput_(persisted, true).labelId, 'Label_123');
  assert.throws(() => ctx.validateInstallerInput_(persisted, false), /CONFIG/);
  assert.throws(() => ctx.installMyCoupons(false), /CONFIG/);
});
