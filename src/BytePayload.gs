// Gmail REST data is base64url; the Advanced service can return Byte[].
// Validate before conversion: signed [-128, 127] and unsigned [0, 255]
// spellings identify the same octet. Utilities receives signed Byte[] values.
function validatedBytes_(value, unsigned) {
  if (!Array.isArray(value)) fail_('MAIL');
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) fail_('MAIL');
    const byte = value[i];
    if (!Number.isInteger(byte) || byte < -128 || byte > 255) fail_('MAIL');
    bytes.push(unsigned ? (byte < 0 ? byte + 256 : byte) : (byte > 127 ? byte - 256 : byte));
  }
  return bytes;
}

function validBase64Url_(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return false;
  const unpadded = value.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  if (remainder === 1 || value.length !== unpadded.length && value.length % 4 !== 0) return false;
  // Reject nonzero unused bits, which permissive provider decoders may discard.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(unpadded.slice(-1));
  return remainder === 2 ? last % 16 === 0 : remainder === 3 ? last % 4 === 0 : true;
}

function base64UrlByteLength_(value) {
  const unpadded = value.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  return Math.floor(unpadded.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
}

function canonicalBase64Url_(value) {
  if (!validBase64Url_(value)) fail_('AI');
  return value.replace(/=+$/, '');
}

function decodeBytePayload_(value, size, record, maxBytes) {
  const bytes = validatedBytePayloadContents_(value, size, record, maxBytes);
  if (size != null && size !== bytes.length) fail_('MAIL');
  return bytes;
}

// Validate transport, elements and size type without asserting size equality.
// Only MIME text recovery consumes this directly and must retain incompleteness.
function validatedBytePayloadContents_(value, size, record, maxBytes) {
  const data = value == null ? '' : value;
  if (record) {
    record.stage = 'data-validation';
    record.dataType = mimeDiagnosticType_(value);
    record.dataLength = typeof data === 'string' || Array.isArray(data) ? data.length : null;
    record.dataLengthRemainder = typeof data === 'string' ? data.length % 4 : null;
    record.dataSyntaxValid = typeof data === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(data);
    record.paddingLength = typeof data === 'string' ? (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : null;
    record.sizeType = mimeDiagnosticType_(size);
  }
  // Bound image allocations before decoding strings or copying byte arrays.
  if (maxBytes != null) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail_('MAIL');
    const byteLength = typeof data === 'string' && validBase64Url_(data) ? base64UrlByteLength_(data) :
      Array.isArray(data) ? data.length : 0;
    if (byteLength > maxBytes) fail_('MAIL');
  }
  if (!Array.isArray(data) && !validBase64Url_(data)) fail_('MAIL');
  if (record) {
    record.stage = 'size-validation';
    record.sizeValid = size == null || Number.isSafeInteger(size) && size >= 0;
  }
  if (size != null && (!Number.isSafeInteger(size) || size < 0)) fail_('MAIL');
  if (!data.length) {
    if (record) record.stage = 'empty-body-validation';
    if (size && size !== 0) fail_('MAIL');
    return [];
  }
  let bytes;
  if (Array.isArray(data)) bytes = data;
  else {
    if (record) record.stage = 'base64-decode';
    try { bytes = Utilities.base64DecodeWebSafe(data); } catch (e) { fail_('MAIL'); }
  }
  if (record) {
    record.stage = 'bytes-validation';
    record.bytesType = mimeDiagnosticType_(bytes);
    record.bytesLengthType = bytes == null ? 'not-applicable' : typeof bytes.length;
    record.bytesLength = bytes != null && Number.isSafeInteger(bytes.length) && bytes.length >= 0 ? bytes.length : null;
    record.sizeMatches = size == null ? 'not-declared' : bytes != null && size === bytes.length;
  }
  if (maxBytes != null && Array.isArray(bytes) && bytes.length > maxBytes) fail_('MAIL');
  bytes = validatedBytes_(bytes);
  if (record) record.stage = 'size-match';
  return bytes;
}
