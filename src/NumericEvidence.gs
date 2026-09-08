function scalarNumericValue_(value) {
  return /^\p{Nd}+(?:[.,٫．]\p{Nd}+)?$/u.test(value);
}
const DATE_MONTH_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|gen(?:naio)?|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)';
const DATE_MONTH_DOTTED_ABBREVIATION = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|gen|mag|giu|lug|ago|set|ott|dic)\\.';
const DATE_MONTH_TOKEN_PATTERN = '(?:' + DATE_MONTH_PATTERN + '|' + DATE_MONTH_DOTTED_ABBREVIATION + ')';
const DATE_MONTH_END = '(?=$|[^\\p{L}\\p{N}\\p{M}_])';
const NUMERIC_RANGE_SEPARATOR = '(?:[-‐‑‒−–—－/⁄:]|…|‥|\\.{2,})';
const NUMERIC_SIGN_TOKEN = '(?:[+＋﹢⁺₊]|[-‐‑‒−–—―－﹣⁻₋])';
const NUMERIC_RANGE_CURRENCY_CODE_TOKEN = '(?:[Ee][Uu][Rr]|[Uu][Ss][Dd]|[Gg][Bb][Pp])';
const NUMERIC_RANGE_CURRENCY_CODE_PREFIX_FRAGMENT_TOKEN = '(?:[Ee](?:[Uu])?|[Uu](?:[Ss])?|[Gg](?:[Bb])?)';
const NUMERIC_RANGE_CURRENCY_CODE_SUFFIX_FRAGMENT_TOKEN = '(?:[Rr]|[Uu][Rr]|[Dd]|[Ss][Dd]|[Pp]|[Bb][Pp])';
const NUMERIC_RANGE_CURRENCY_PREFIX_TOKEN = '(?:[€$£]\\s*|' + NUMERIC_RANGE_CURRENCY_CODE_TOKEN + '\\s+)';
const NUMERIC_RANGE_UNIT_TOKEN = '(?:\\s*[%€$£]|\\s+(?:[eE][uU][rR][oO][sS]?|[dD][oO][lL][lL][aA][rR][sS]?|[pP][oO][uU][nN][dD][sS]?|[pP][eE][rR][cC][eE][nN][tT][sS]?|' + NUMERIC_RANGE_CURRENCY_CODE_TOKEN + '))';
const NUMERIC_RANGE_CONNECTOR_FRAGMENT = '(?:[tT][oO]|[oO][rR]|[oO]|[rR]|[aA][nN][dD]|[nN][dD]|[dD]|[tT][hH][rR][oO][uU][gG][hH]|[hH][rR][oO][uU][gG][hH]|[rR][oO][uU][gG][hH]|[oO][uU][gG][hH]|[uU][gG][hH]|[gG][hH]|[hH]|[uU][pP]\\s+[tT][oO]|[pP]\\s+[tT][oO])';
const NUMERIC_RANGE_QUALIFIER_FRAGMENT = '(?:[oO][fF][fF]|[fF][fF]|[fF])';
function truncatedRangeFragment_(text) {
  const currencyPrefix = '(?:' + NUMERIC_RANGE_CURRENCY_PREFIX_TOKEN + ')?';
  const currencySuffix = '(?:' + NUMERIC_RANGE_CURRENCY_CODE_TOKEN + '|' +
    NUMERIC_RANGE_CURRENCY_CODE_SUFFIX_FRAGMENT_TOKEN + ')?';
  return new RegExp('^\\s*' + currencySuffix + '\\s*(?:' + NUMERIC_RANGE_QUALIFIER_FRAGMENT + '\\s+)?' +
    NUMERIC_RANGE_CONNECTOR_FRAGMENT + '\\s*' + currencyPrefix + '$', 'u').test(text);
}
function signedNumericPrefix_(before) {
  return new RegExp(NUMERIC_SIGN_TOKEN + '\\s*(?:' + NUMERIC_RANGE_CURRENCY_PREFIX_TOKEN + ')?$', 'u').test(before);
}
function numericRangeEndpoint_(before, after) {
  const space = '\\s*';
  const gap = '\\s+';
  const unit = '(?:' + NUMERIC_RANGE_UNIT_TOKEN + ')?';
  const qualifier = '(?:\\s+[oO][fF][fF])?';
  const to = '[tT][oO]';
  const or = '[oO][rR]';
  const and = '[aA][nN][dD]';
  const between = '[bB][eE][tT][wW][eE][eE][nN]';
  const through = '[tT][hH][rR][oO][uU][gG][hH]';
  const up = '[uU][pP]';
  const digit = '\\p{Nd}';
  const decimal = '[.,٫．]';
  const month = DATE_MONTH_PATTERN;
  const currency = '(?:' + NUMERIC_RANGE_CURRENCY_PREFIX_TOKEN + ')?';
  const amount = currency + digit + '+(?:' + decimal + digit + '+)?' + unit;
  const separator = NUMERIC_RANGE_SEPARATOR;
  const nextAmount = currency + digit;
  const datedRange = new RegExp('^' + unit + qualifier + gap + '(?:' + or + '|' + through + '|' + up + gap + to + ')' + gap +
    currency + digit + '+(?:' + decimal + digit + '+)?' + gap + month + DATE_MONTH_END, 'iu');
  return new RegExp('^' + unit + space + separator + space + nextAmount, 'u').test(after) ||
    new RegExp(amount + space + separator + space + currency + '$', 'u').test(before) ||
    new RegExp('^' + unit + qualifier + gap + to + gap + nextAmount, 'u').test(after) ||
    new RegExp(amount + qualifier + gap + to + gap + currency + '$', 'u').test(before) ||
    new RegExp('^' + unit + qualifier + gap + or + gap + nextAmount, 'u').test(after) &&
      !datedRange.test(after) ||
    new RegExp(amount + qualifier + gap + or + gap + currency + '$', 'u').test(before) &&
      !dateMonthFollows_(after) ||
    new RegExp('^' + unit + qualifier + gap + and + gap + nextAmount, 'u').test(after) &&
      new RegExp('\\b' + between + space + currency + '$', 'u').test(before) ||
    new RegExp('\\b' + between + gap + amount + qualifier + gap + and + gap + currency + '$', 'u').test(before) ||
    new RegExp('^' + unit + qualifier + gap + through + gap + nextAmount, 'u').test(after) &&
      !datedRange.test(after) ||
    new RegExp(amount + qualifier + gap + through + gap + currency + '$', 'u').test(before) &&
      !dateMonthFollows_(after) ||
    new RegExp('^' + unit + qualifier + gap + up + gap + to + gap + nextAmount, 'u').test(after) &&
      !datedRange.test(after) ||
    new RegExp(amount + qualifier + gap + up + gap + to + gap + currency + '$', 'u').test(before) &&
      !dateMonthFollows_(after) ||
    new RegExp('(?:^|[^\\p{L}\\p{N}\\p{M}_])' + up + gap + to + gap + currency + '$', 'u').test(before);
}
function dateMonthFollows_(source) {
  return new RegExp('^\\s+' + DATE_MONTH_PATTERN + DATE_MONTH_END, 'iu').test(source);
}
function dateMonthPrecedes_(source) {
  return new RegExp('(?:^|[^\\p{L}\\p{N}\\p{M}_])' + DATE_MONTH_TOKEN_PATTERN + '\\s+$', 'iu').test(source);
}
function dateMonthDayPrecedes_(source) {
  return new RegExp('(?:^|[^\\p{L}\\p{N}\\p{M}_])' + DATE_MONTH_TOKEN_PATTERN + '\\s+\\p{Nd}{1,2}(?:st|nd|rd|th)?\\s*,?\\s*$', 'iu').test(source);
}
