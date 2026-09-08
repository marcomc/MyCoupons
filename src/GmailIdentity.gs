function gmailLink_(id) { return 'https://mail.google.com/mail/u/0/#all/' + id; }
function sourceId_(value) {
  // Gmail's opaque UI tokens (including msg-f:) are not REST message IDs.
  // Accept only the canonical hexadecimal links used by this importer.
  const link = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i.exec(String(value));
  if (!link) return '';
  const authority = /^mail\.google\.com(?::(\d+))?$/i.exec(link[1]);
  if (!authority || authority[1] !== undefined && Number(authority[1]) !== 443 ||
    !/^\/mail\/(?:u\/\d+\/)?$/.test(link[2] || '')) return '';
  if (link[4]) {
    const fragment = /^(?:all|inbox|search\/[^/#]+)\/([a-f0-9]+)$/.exec(link[4]);
    return fragment ? fragment[1] : '';
  }
  const threads = (link[3] || '').split('&').filter(function (param) { return /^th=/.test(param); });
  if (threads.length !== 1) return '';
  const thread = /^th=([a-f0-9]+)$/.exec(threads[0]);
  return thread ? thread[1] : '';
}
