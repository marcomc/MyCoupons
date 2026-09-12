const MC_IMAGE_MAX_COUNT = 12;
const MC_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const MC_IMAGE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MC_IMAGE_MIME_TYPES = Object.freeze(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

function acquireMessageImages_(raw, html, deadlineMs) {
  const slots = htmlContent_(html).images;
  const resources = [];
  collectImageParts_(raw && raw.payload, '', resources);
  const byCid = Object.create(null);
  resources.forEach(function (resource) {
    if (resource.cid) {
      if (byCid[resource.cid] !== undefined) byCid[resource.cid] = null;
      else byCid[resource.cid] = resource;
    }
  });
  const records = [];
  const used = [];
  let total = 0;
  let inspected = 0;
  let incomplete = false;
  if (slots.length > MC_IMAGE_MAX_COUNT) incomplete = true;
  slots.forEach(function (attrs, index) {
    if (deadlineMs && Date.now() >= deadlineMs) { incomplete = true; return; }
    if (inspected >= MC_IMAGE_MAX_COUNT) return;
    inspected++;
    const src = typeof attrs.src === 'string' ? attrs.src.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '') : '';
    let resource = null;
    if (/^cid:/i.test(src)) resource = byCid[imageIdentity_(src.slice(4))] || null;
    else if (safeUrl_(src) && !trackerImageUrl_(src) && !smallImageDimension_(attrs.width) && !smallImageDimension_(attrs.height)) resource = fetchRemoteImage_(src);
    if (!resource) { incomplete = true; return; }
    used.push(resource);
    const record = materializeImage_(raw.id, index, resource, total);
    if (!record) { incomplete = true; return; }
    total += record.bytes.length;
    if (total > MC_IMAGE_MAX_TOTAL_BYTES) { incomplete = true; return; }
    records.push(record);
  });
  resources.forEach(function (resource, index) {
    if (used.indexOf(resource) >= 0) return;
    if (deadlineMs && Date.now() >= deadlineMs) { incomplete = true; return; }
    if (inspected >= MC_IMAGE_MAX_COUNT) { incomplete = true; return; }
    inspected++;
    const record = materializeImage_(raw.id, slots.length + index, resource, total);
    if (!record) { incomplete = true; return; }
    total += record.bytes.length;
    if (total > MC_IMAGE_MAX_TOTAL_BYTES) { incomplete = true; return; }
    records.push(record);
  });
  return {images: records, incomplete: incomplete};
}

function fetchRemoteImage_(url) {
  try {
    const response = UrlFetchApp.fetch(url, {method: 'get', followRedirects: false, muteHttpExceptions: true});
    if (!response || response.getResponseCode() !== 200) return null;
    const headers = response.getHeaders() || {};
    const contentType = String(headers['Content-Type'] || headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (MC_IMAGE_MIME_TYPES.indexOf(contentType) < 0) return null;
    const bytes = response.getContent();
    if (!Array.isArray(bytes) || !bytes.length || bytes.length > MC_IMAGE_MAX_BYTES) return null;
    return {mimeType: contentType, data: Utilities.base64EncodeWebSafe(bytes)};
  } catch (e) { return null; }
}

function collectImageParts_(part, parentCid, resources) {
  if (!part || typeof part !== 'object') return;
  const headers = mimeHeaders_(part.headers);
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType.split(';', 1)[0].trim().toLowerCase() : '';
  const disposition = mimeHeader_(headers, 'content-disposition');
  const cidHeader = imageIdentity_(mimeHeader_(headers, 'content-id').trim());
  const filename = String(part.filename || '').trim();
  if (MC_IMAGE_MIME_TYPES.indexOf(mimeType) >= 0 && ((part.body || {}).data || (part.body || {}).attachmentId)) {
    resources.push({mimeType: mimeType, cid: cidHeader, filename: filename,
      data: (part.body || {}).data || '', attachmentId: (part.body || {}).attachmentId || '',
      declaredSize: (part.body || {}).size,
      disposition: disposition});
  }
  (part.parts || []).forEach(function (child) { collectImageParts_(child, cidHeader || parentCid, resources); });
}

function materializeImage_(messageId, slot, resource, total) {
  if (resource.attachmentId && (!Number.isSafeInteger(resource.declaredSize) || resource.declaredSize <= 0 ||
    resource.declaredSize > MC_IMAGE_MAX_BYTES || total + resource.declaredSize > MC_IMAGE_MAX_TOTAL_BYTES)) return null;
  if (Number.isSafeInteger(resource.declaredSize) &&
    (resource.declaredSize <= 0 || resource.declaredSize > MC_IMAGE_MAX_BYTES || total + resource.declaredSize > MC_IMAGE_MAX_TOTAL_BYTES)) return null;
  let bytes = [];
  try {
    if (resource.data) {
      if (!validBase64Url_(resource.data)) return null;
      bytes = Utilities.base64DecodeWebSafe(resource.data);
    }
    else if (resource.attachmentId) {
      const attachment = Gmail.Users.Messages.Attachments.get('me', messageId, resource.attachmentId);
      if (!attachment || typeof attachment.data !== 'string') return null;
      if (!validBase64Url_(attachment.data)) return null;
      bytes = Utilities.base64DecodeWebSafe(attachment.data);
    }
  } catch (e) { return null; }
  if (!Array.isArray(bytes) || !bytes.length || bytes.length > MC_IMAGE_MAX_BYTES || total + bytes.length > MC_IMAGE_MAX_TOTAL_BYTES) return null;
  if (!imageSignature_(resource.mimeType, bytes)) return null;
  const dimensions = imageDimensions_(resource.mimeType, bytes);
  if (dimensions && (dimensions.width <= 2 || dimensions.height <= 2)) return null;
  return {sourceId: messageId + ':image:' + slot, slot: slot, mimeType: resource.mimeType,
    bytes: bytes, blob: Utilities.newBlob(bytes, resource.mimeType, 'image'), dimensions: dimensions || null};
}

function validBase64Url_(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(value) && value.length % 4 !== 1 &&
    (value.indexOf('=') < 0 || value.indexOf('=') >= value.length - 2);
}

function imageIdentity_(value) {
  if (/^<[^<>]+>$/.test(value)) return value.slice(1, -1);
  return /[<>]/.test(value) ? '' : value;
}

function imageSignature_(mimeType, bytes) {
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
  if (mimeType === 'image/gif') return bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97;
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
}

function imageDimensions_(mimeType, bytes) {
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
    return {width: u32_(bytes, 16), height: u32_(bytes, 20)};
  if (mimeType === 'image/gif' && bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70)
    return {width: bytes[6] | bytes[7] << 8, height: bytes[8] | bytes[9] << 8};
  return null;
}

function u32_(bytes, offset) { return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3]; }
