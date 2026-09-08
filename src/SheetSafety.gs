function validDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function textCell_(s) {
  const value = boundedText_(String(s == null ? '' : s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''), 4000);
  return /^[\s]*[=+@-]/.test(value) ? "'" + boundedText_(value, 3999) : value;
}
function realCouponRow_(row) {
  function present(value) { return String(value == null ? '' : value).trim() !== ''; }
  if ([row[4], row[17]].some(function (v) { return /^(?:scan|scanned|technical|no coupons?|no offers?)$/i.test(String(v).trim()); })) return false;
  return present(row[1]) && (present(row[3]) || present(row[2]) || present(row[4]) && present(row[5])) &&
    (present(row[11]) || present(row[13]));
}
function emailDate_(value, zone) {
  if (value instanceof Date && isFinite(value.getTime())) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value)) {
    if (value.length === 10 && validDate_(value)) return Utilities.parseDate(value, zone, 'yyyy-MM-dd');
    // Only explicitly zoned timestamps are portable. Locale-specific strings
    // require correction in Sheets instead of guessing day/month order.
    if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(value) && validDate_(value.slice(0, 10))) {
      const d = new Date(value); if (isFinite(d.getTime())) return d;
    }
  }
  fail_('DATE');
}
function recoveryStart_(rows, c) {
  let max = null;
  rows.filter(realCouponRow_).forEach(function (row) {
    const date = emailDate_(row[0], c.timeZone);
    if (!max || date > max) max = date;
  });
  const day = max ? Utilities.formatDate(max, c.timeZone, 'yyyy-MM-dd') : c.initialDate;
  if (!day) fail_('INITIAL_DATE');
  return Utilities.parseDate(day, c.timeZone, 'yyyy-MM-dd').getTime();
}
function validOutcome_(item) {
  return plainObjectWithKeys_(item, ['status']) &&
    ['confirmed', 'review', 'ignored'].indexOf(ownValue_(item, 'status')) >= 0;
}
function messageOutcome_(items) {
  if (!Array.isArray(items) || Array.from(items).some(function (item) { return !validOutcome_(item); })) fail_('STATE');
  if (items.some(function (item) { return ownValue_(item, 'status') === 'review'; })) return 'review';
  if (items.some(function (item) { return ownValue_(item, 'status') === 'ignored'; })) return 'unchanged';
  return items.length ? 'archive' : 'empty';
}
