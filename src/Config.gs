const MC = Object.freeze({
  version: '0.1.0', configKey: 'MYCOUPONS_CONFIG', maxRuntimeMs: 240000,
  maxText: 60000, maxImages: 6, maxImageBytes: 2 * 1024 * 1024,
  maxTotalImageBytes: 6 * 1024 * 1024, maxCandidates: 12,
  headers: ['Email date', 'Brand / merchant', 'Website', 'Coupon code', 'Discount type',
    'Discount value', 'Minimum spend', 'Valid on', 'Excluded products / limits', 'Expiry date',
    'Usage limits', 'Source email subject', 'Sender', 'Email link', 'Extraction confidence',
    'Needs visual check / OCR', 'Notes / dedupe key', 'Status', 'Priority', 'Category',
    'Currency', 'Estimated value', 'Used date', 'Last checked', 'Action needed', 'Days to expiry'],
  fields: ['merchant', 'website', 'code', 'discountType', 'discountValue', 'minimumSpend',
    'validOn', 'exclusions', 'expiry', 'usageLimits', 'currency', 'notes'],
  journalName: '_MyCoupons Messages', journalHeaders: ['Message ID', 'State JSON'],
  defaults: {spreadsheetId: '', spreadsheetName: 'My Coupons', sheetName: 'Coupon Manager',
    labelName: 'Coupon Code Discount', locale: 'en', timeZone: 'Europe/Rome', initialDate: '',
    developerProject: '', vertexProject: '', vertexLocation: 'global', model: 'gemini-flash-latest',
    autoVertexFallback: false, fetchRemoteImages: true}
});

function props_() { return PropertiesService.getScriptProperties(); }
function config_() {
  const raw = props_().getProperty(MC.configKey);
  if (!raw) fail_('CONFIG');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { fail_('CONFIG'); }
  return validateConfig_(parsed);
}
function validateConfig_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail_('CONFIG');
  const allowed = Object.keys(MC.defaults).concat(['ownerEmail', 'labelId']);
  if (Object.keys(input).some(function (k) { return allowed.indexOf(k) < 0; })) fail_('CONFIG');
  const c = Object.assign({}, MC.defaults, input);
  Object.keys(MC.defaults).forEach(function (k) {
    if (typeof c[k] !== typeof MC.defaults[k]) fail_('CONFIG');
  });
  if (typeof c.ownerEmail !== 'string' || c.labelId != null && typeof c.labelId !== 'string') fail_('CONFIG');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.ownerEmail || '') || c.locale !== 'en' ||
    c.timeZone !== 'Europe/Rome' || typeof c.autoVertexFallback !== 'boolean' ||
    typeof c.fetchRemoteImages !== 'boolean' || !/^gemini-[a-z0-9._-]+$/.test(c.model) ||
    !/^[a-z][a-z0-9-]*$/.test(c.vertexLocation)) fail_('CONFIG');
  ['spreadsheetName', 'sheetName', 'labelName'].forEach(function (k) {
    const limit = k === 'sheetName' ? 100 : 200;
    if (typeof c[k] !== 'string' || !c[k].trim() || c[k].length > limit || /[\x00-\x1f]/.test(c[k])) fail_('CONFIG');
  });
  if (/[\[\]*?:/\\]/.test(c.sheetName) || c.sheetName.toLowerCase() === MC.journalName.toLowerCase() ||
    c.labelName.split('/').some(function (p) { return !p.trim(); })) fail_('CONFIG');
  ['developerProject', 'vertexProject'].forEach(function (k) {
    if (c[k] && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c[k])) fail_('CONFIG');
  });
  if (c.autoVertexFallback && !c.vertexProject) fail_('CONFIG');
  if (c.initialDate && !validDate_(c.initialDate)) fail_('CONFIG');
  if (c.spreadsheetId && !/^[\w-]+$/.test(c.spreadsheetId)) fail_('CONFIG');
  return c;
}
function fail_(code) { const e = new Error(code); e.code = code; throw e; }
function errorCode_(e) { return e && Object.prototype.hasOwnProperty.call(EN.errorCodes, e.code) ? e.code : 'INTERNAL'; }
function t_(key, values) {
  let text = EN[key];
  if (typeof text !== 'string') fail_('CONFIG');
  Object.keys(values || {}).forEach(function (k) { text = text.replace('{' + k + '}', values[k]); });
  return text;
}
var MC_LOCK_DEPTH = 0;
function withLock_(fn) {
  if (MC_LOCK_DEPTH > 0) {
    MC_LOCK_DEPTH++;
    try { return fn(); } finally { MC_LOCK_DEPTH--; }
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(240000)) fail_('BUSY');
  MC_LOCK_DEPTH = 1;
  try { return fn(); } finally { MC_LOCK_DEPTH = 0; lock.releaseLock(); }
}
function assertOwner_(c) {
  const profile = Gmail.Users.getProfile('me');
  const owner = String(c.ownerEmail).toLowerCase();
  if (String(profile.emailAddress).toLowerCase() !== owner ||
    String(Session.getEffectiveUser().getEmail()).toLowerCase() !== owner) fail_('OWNER');
}
