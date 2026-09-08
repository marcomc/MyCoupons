const MC_GMAIL_PAGE_SIZE = 50;
const MC_GMAIL_MAX_PAGES = 20;
const MC_FINAL_MESSAGE_STATES = Object.freeze(['confirmed', 'ignored']);

function readCouponMessages_(state) {
  if (!state || typeof state !== 'object' || !state.label || !state.journalSheet ||
    typeof state.recoveryStart !== 'number' || !isFinite(state.recoveryStart)) fail_('STATE');
  return readGmailMessages_(state.label, state.recoveryStart, state.journalSheet);
}

function readGmailMessages_(label, recoveryStart, journalSheet) {
  if (!label || typeof label.id !== 'string' || !label.id ||
    typeof label.name !== 'string' || !label.name ||
    typeof recoveryStart !== 'number' || !isFinite(recoveryStart) || recoveryStart < 0 ||
    !journalSheet) fail_('MAIL');
  const states = readMessageJournal_(journalSheet);
  const result = {messages: [], errors: [], truncated: false};
  const seen = Object.create(null);
  const seenPageTokens = Object.create(null);
  // Gmail's date search boundary is provider-defined; include the prior local
  // day and apply the exact recovery timestamp below before returning a message.
  const query = 'after:' + Utilities.formatDate(new Date(recoveryStart - 86400000), MC.defaults.timeZone, 'yyyy/MM/dd');
  let pageToken = '';
  let pages = 0;
  do {
    if (pages >= MC_GMAIL_MAX_PAGES) {
      result.truncated = true;
      break;
    }
    pages++;
    let page;
    try {
      const options = {labelIds: [label.id], maxResults: MC_GMAIL_PAGE_SIZE, q: query};
      if (pageToken) options.pageToken = pageToken;
      page = Gmail.Users.Messages.list('me', options);
    } catch (e) {
      fail_('MAIL');
    }
    if (!page || typeof page !== 'object' || page.messages != null && !Array.isArray(page.messages)) fail_('MAIL');
    const summaries = page.messages || [];
    summaries.forEach(function (summary) {
      if (!summary || typeof summary.id !== 'string' || !validGmailApiId_(summary.id)) fail_('MAIL');
      if (seen[summary.id]) return;
      seen[summary.id] = true;
      const state = states[summary.id];
      if (state && MC_FINAL_MESSAGE_STATES.indexOf(state.status) >= 0) return;
      let raw;
      try {
        raw = Gmail.Users.Messages.get('me', summary.id, {format: 'full'});
      } catch (e) {
        result.errors.push(gmailReadError_(summary.id));
        return;
      }
      try {
        const message = canonicalGmailMessage_(raw);
        if (message.receivedAtMs >= recoveryStart) result.messages.push(message);
      } catch (e) {
        result.errors.push(gmailReadError_(summary.id));
      }
    });
    const nextToken = page.nextPageToken;
    if (nextToken != null && typeof nextToken !== 'string') fail_('MAIL');
    if (!nextToken) pageToken = '';
    else if (seenPageTokens[nextToken]) fail_('MAIL');
    else { seenPageTokens[nextToken] = true; pageToken = nextToken; }
  } while (pageToken);
  return result;
}

function gmailReadError_(messageId) {
  return {messageId: messageId, code: 'MAIL', retryable: true};
}

function validGmailApiId_(id) {
  return /^[a-f0-9]+$/.test(id) && sourceId_(gmailLink_(id)) === id;
}

function canonicalGmailMessage_(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !validGmailApiId_(raw.id) ||
    raw.threadId != null && typeof raw.threadId !== 'string' ||
    typeof raw.internalDate !== 'string' || !/^\d+$/.test(raw.internalDate)) fail_('MAIL');
  const receivedAtMs = Number(raw.internalDate);
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) fail_('MAIL');
  const receivedAt = new Date(receivedAtMs);
  if (!isFinite(receivedAt.getTime())) fail_('MAIL');
  const payload = parseMimePayload_(raw.payload);
  const acquired = acquireMessageImages_(raw, payload.html);
  return {
    id: raw.id,
    threadId: raw.threadId || '',
    receivedAt: receivedAt.toISOString(),
    receivedAtMs: receivedAtMs,
    sender: mimeHeader_(payload.headers, 'from'),
    subject: mimeHeader_(payload.headers, 'subject'),
    text: payload.text,
    html: payload.html,
    link: gmailLink_(raw.id),
    incomplete: payload.incomplete || acquired.incomplete,
    images: acquired.images
  };
}

function parseMimePayload_(part) {
  if (!part || typeof part !== 'object' || typeof part.mimeType !== 'string' || !part.mimeType.trim()) fail_('MAIL');
  const mimeType = part.mimeType.split(';', 1)[0].trim().toLowerCase();
  const headers = mimeHeaders_(part.headers);
  const output = {headers: headers, text: '', html: '', incomplete: false};
  if (mimeType.indexOf('multipart/') === 0) {
    if (!Array.isArray(part.parts)) {
      if (part.body && typeof part.body === 'object' && part.body.data) fail_('MAIL');
      output.incomplete = true;
      return output;
    }
    if (part.body && typeof part.body === 'object' && part.body.data) fail_('MAIL');
    part.parts.forEach(function (child) {
      const parsed = parseMimePayload_(child);
      if (parsed.text) output.text = appendMimeText_(output.text, parsed.text);
      if (parsed.html) output.html = appendMimeText_(output.html, parsed.html);
      output.incomplete = output.incomplete || parsed.incomplete;
      if (!output.headers.length && parsed.headers.length) output.headers = parsed.headers;
    });
    return output;
  }
  if (mimeType === 'text/plain' || mimeType === 'text/html') {
    const value = decodeMimeBody_(part.body, headers);
    if (mimeType === 'text/plain') output.text = value;
    else output.html = value;
    return output;
  }
  output.incomplete = true;
  return output;
}

function appendMimeText_(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left + '\n' + right;
}

function mimeHeaders_(headers) {
  if (headers == null) return [];
  if (!Array.isArray(headers)) fail_('MAIL');
  return headers.map(function (header) {
    if (!header || typeof header.name !== 'string' || !header.name || typeof header.value !== 'string') fail_('MAIL');
    return {name: header.name.toLowerCase(), value: header.value};
  });
}

function mimeHeader_(headers, name) {
  const match = headers.filter(function (header) { return header.name === name; });
  return match.length ? match[0].value : '';
}

function decodeMimeBody_(body, headers) {
  if (!body || typeof body !== 'object') fail_('MAIL');
  const data = body.data == null ? '' : body.data;
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length % 4 === 1) fail_('MAIL');
  if (body.size != null && (!Number.isSafeInteger(body.size) || body.size < 0)) fail_('MAIL');
  if (!data) {
    if (body.size && body.size !== 0) fail_('MAIL');
    return '';
  }
  let bytes;
  try { bytes = Utilities.base64DecodeWebSafe(data); } catch (e) { fail_('MAIL'); }
  if (!Array.isArray(bytes)) fail_('MAIL');
  if (body.size != null && body.size !== bytes.length) fail_('MAIL');
  const charset = mimeCharset_(headers);
  try { return Utilities.newBlob(bytes).getDataAsString(charset); } catch (e) { fail_('MAIL'); }
}

function mimeCharset_(headers) {
  const contentType = mimeHeader_(headers, 'content-type');
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
  const charset = match ? (match[1] || match[2]) : 'UTF-8';
  if (!/^[A-Za-z0-9._-]+$/.test(charset)) fail_('MAIL');
  return charset;
}
