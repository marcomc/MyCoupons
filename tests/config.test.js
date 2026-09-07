const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness');

test('reserved journal title cannot alias the coupon tab at input or persisted reload', () => {
  const {ctx, config, properties} = harness();
  for (const sheetName of ['_MyCoupons Messages', '_mycoupons messages', '_MYCOUPONS MESSAGES', '_MycOuPoNs MeSsAgEs']) {
    const input = {...config, sheetName};
    assert.throws(() => ctx.validateConfig_(input), /CONFIG/, sheetName);
    properties.MYCOUPONS_CONFIG = JSON.stringify(input);
    assert.throws(() => ctx.config_(), /CONFIG/, sheetName);
  }
  for (const sheetName of ['Coupon Manager', 'COUPON MANAGER', '_MyCoupons Messages Archive']) {
    const input = {...config, sheetName, spreadsheetName: '_mycoupons messages'};
    assert.equal(ctx.validateConfig_(input).sheetName, sheetName);
    properties.MYCOUPONS_CONFIG = JSON.stringify(input);
    assert.equal(ctx.config_().sheetName, sheetName);
    assert.equal(ctx.config_().spreadsheetName, input.spreadsheetName);
  }
});
