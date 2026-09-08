const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function harness({vendorLast = false} = {}) {
  const properties = {};
  const owner = 'owner@example.com';
  const ctx = {Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Set, Error,
    PropertiesService: {getScriptProperties: () => ({getProperty: k => properties[k] ?? null,
      setProperty: (k, v) => { properties[k] = v; }, deleteProperty: k => { delete properties[k]; }})},
    Utilities: {
      DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()],
      formatDate: (d, zone) => new Intl.DateTimeFormat('en-CA', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(d),
      parseDate: (s, zone) => {
        // Derive the offset at midnight itself, including a DST transition day.
        const midnight = Date.parse(s + 'T00:00:00Z');
        const hourAtUtcMidnight = Number(new Intl.DateTimeFormat('en', {
          timeZone: zone, hour: 'numeric', hourCycle: 'h23'
        }).format(new Date(midnight)));
        return new Date(midnight - hourAtUtcMidnight * 3600000);
      }
    },
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
    Session: {getEffectiveUser: () => ({getEmail: () => owner})},
    Gmail: {Users: {getProfile: () => ({emailAddress: owner})}}
  };
  vm.createContext(ctx);
  const names = ['locales/en', 'Config', 'Core', 'NumericEvidence', 'HtmlEvidence',
    'CandidateEvidence', 'GmailIdentity', 'SheetSafety', 'SheetState'];
  if (vendorLast) names.push('vendor/Html');
  else names.unshift('vendor/Html');
  for (const name of names) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name + '.gs'), 'utf8'), ctx, {filename: name});
  }
  const config = ctx.validateConfig_({ownerEmail: owner, spreadsheetId: 'sheet-id', initialDate: '2026-05-22'});
  properties.MYCOUPONS_CONFIG = JSON.stringify(config);
  return {ctx, properties, config};
}
module.exports = {harness};
