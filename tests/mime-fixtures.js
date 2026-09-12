// Entirely synthetic MIME structures; no mailbox fixtures or identifiers.
const text = 'Brand coupon code Save+20 ; Members only. Caffè 🎁\r\n';
const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 200, 0, 0, 1, 128];
const forms = ['rest', 'padded', 'signed', 'unsigned'];
function body(value, form = 'rest') {
  const bytes = Buffer.from(value);
  const data = form === 'signed' ? Array.from(bytes, byte => byte > 127 ? byte - 256 : byte) :
    form === 'unsigned' ? Array.from(bytes) : form === 'padded' ? bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_') : bytes.toString('base64url');
  return {data, size: bytes.length};
}
function payload(mode, form = 'rest', source = text) {
  if (mode === 'mismatch') {
    const html = '<p>' + source + '</p>\r\n';
    const plainBody = body(source, form); plainBody.size -= 2;
    const htmlBody = body(html, form); htmlBody.size -= 2;
    return {mimeType: 'multipart/alternative', parts: [
      {mimeType: 'text/plain', body: plainBody}, {mimeType: 'text/html', body: htmlBody}]};
  }
  return {mimeType: 'multipart/mixed', parts: [
    {mimeType: 'text/plain', body: body(source, form)},
    {mimeType: 'text/plain', filename: 'document.txt', body: {size: 7164, attachmentId: 'text-file'}},
    {mimeType: 'text/csv', filename: 'document.csv', body: {size: 19513, attachmentId: 'csv-file'}}]};
}
module.exports = {text, png, forms, body, payload};
