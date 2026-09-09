function boundedText_(text, limit) {
  const prefix = text.slice(0, limit);
  return /[\ud800-\udbff]$/.test(prefix) && /[\udc00-\udfff]/.test(text.charAt(limit)) ? prefix.slice(0, -1) : prefix;
}
function normalized_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function wellFormedUtf16_(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= value.length || value.charCodeAt(i + 1) < 0xdc00 || value.charCodeAt(i + 1) > 0xdfff) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function utf16Boundary_(value, index) {
  return !(index > 0 && index < value.length && value.charCodeAt(index - 1) >= 0xd800 &&
    value.charCodeAt(index - 1) <= 0xdbff && value.charCodeAt(index) >= 0xdc00 && value.charCodeAt(index) <= 0xdfff);
}
