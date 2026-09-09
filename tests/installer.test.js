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
  assert.throws(() => ctx.validateInstallerInput_({...config, spreadsheetName: 'x'.repeat(201)}), /CONFIG/);
});
