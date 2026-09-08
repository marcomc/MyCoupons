function htmlContent_(html) {
  const root = MC_HTML.parse(String(html), {scriptingEnabled: false});
  const stack = [{node: root}];
  const pieces = [];
  const evidenceSpans = [];
  let evidence = '';
  const images = [];
  let incomplete = false;
  let activeImageCount = 0;
  let pendingImageBoundary = false;
  function flushEvidence() {
    if (evidence) evidenceSpans.push(evidence);
    evidence = '';
  }
  function newline(block) {
    if (pieces.length && !pieces[pieces.length - 1].endsWith('\n')) pieces.push('\n');
    pendingImageBoundary = false;
    if (block) {
      flushEvidence();
    } else if (evidence && !evidence.endsWith('\n')) evidence += '\n';
  }
  function replacementBoundary() {
    flushEvidence();
    pendingImageBoundary = pendingImageBoundary || pieces.length && !pieces[pieces.length - 1].endsWith('\n');
  }
  function appendProjectedText(value) {
    if (pendingImageBoundary) { pieces.push('\n'); pendingImageBoundary = false; }
    pieces.push(value); evidence += value;
  }
  while (stack.length) {
    const entry = stack.pop();
    if (entry.exit) {
      if (entry.exit === 'block') newline(true);
      else flushEvidence();
      continue;
    }
    const node = entry.node;
    if (node.nodeName === '#text') {
      if (!entry.suppressed && node.value) appendProjectedText(node.value);
      continue;
    }
    if (node.nodeName === '#comment') {
      if (!entry.suppressed) flushEvidence();
      continue;
    }
    const tag = node.tagName || '';
    const isHtml = node.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const foreign = Boolean(tag && !isHtml);
    if (foreign) incomplete = true;
    const nodeAttrs = node.attrs || [];
    const closedDialog = isHtml && tag === 'dialog' && !nodeAttrs.some(function (attr) { return attr.name === 'open'; });
    const closedDetails = isHtml && tag === 'details' && !nodeAttrs.some(function (attr) { return attr.name === 'open'; });
    const closedPopover = isHtml && nodeAttrs.some(function (attr) { return attr.name === 'popover'; });
    const contextSuppressed = entry.suppressed || foreign || isHtml &&
      (/^(?:script|style|template|title|head|iframe|noembed|noframes|datalist|rp)$/.test(tag) ||
        closedDialog || closedPopover || nodeAttrs.some(function (attr) { return attr.name === 'hidden'; }));
    const hiddenInput = isHtml && tag === 'input' && nodeAttrs.some(function (attr) {
      return attr.name === 'type' && String(attr.value).toLowerCase() === 'hidden';
    });
    const visibleInput = isHtml && tag === 'input' && !contextSuppressed && !hiddenInput;
    const activeIframe = isHtml && tag === 'iframe' && !entry.suppressed && !closedPopover &&
      !nodeAttrs.some(function (attr) { return attr.name === 'hidden'; }) && nodeAttrs.some(function (attr) {
        return (attr.name === 'src' || attr.name === 'srcdoc') && /[^\t\n\f\r ]/.test(String(attr.value));
      });
    if (!contextSuppressed && isHtml && (tag === 'picture' || (tag === 'img' || tag === 'source') &&
      nodeAttrs.some(function (attr) { return attr.name === 'srcset'; }))) incomplete = true;
    if (isHtml && tag === 'select' && !contextSuppressed) incomplete = true;
    if (visibleInput) incomplete = true;
    if (activeIframe) incomplete = true;
    const activeUnmodeled = isHtml && !contextSuppressed && /^(?:audio|canvas|embed|meter|object|progress|textarea|video)$/.test(tag);
    if (activeUnmodeled) incomplete = true;
    const suppressed = contextSuppressed || hiddenInput || activeUnmodeled || isHtml && /^(?:select|optgroup|option)$/.test(tag);
    const buttonBoundary = !suppressed && isHtml && tag === 'button';
    const block = !suppressed && isHtml && /^(?:address|article|aside|blockquote|caption|center|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|legend|li|listing|main|menu|nav|ol|p|plaintext|pre|search|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|xmp)$/.test(tag);
    if (block || !suppressed && isHtml && tag === 'br') newline(block);
    if (block) stack.push({exit: 'block'});
    if (buttonBoundary) { flushEvidence(); stack.push({exit: 'button'}); }
    if (activeUnmodeled || visibleInput) replacementBoundary();
    else if (suppressed && !entry.suppressed) flushEvidence();
    if (!suppressed && isHtml && tag === 'img') {
      replacementBoundary();
      const imageAttrs = Object.create(null);
      nodeAttrs.forEach(function (attr) { imageAttrs[attr.name] = attr.value; });
      images.push(imageAttrs);
      const hasSrc = nodeAttrs.some(function (attr) {
        return attr.name === 'src' && /[^\t\n\f\r ]/.test(String(attr.value));
      });
      if (hasSrc) activeImageCount++;
      const alt = nodeAttrs.find(function (attr) { return attr.name === 'alt'; });
      if (!hasSrc && alt && /\S/u.test(String(alt.value))) {
        appendProjectedText(alt.value);
        flushEvidence();
        pendingImageBoundary = pieces.length && !pieces[pieces.length - 1].endsWith('\n');
      }
    }
    // Suppressed and inert subtrees still contribute unsupported-namespace coverage.
    const children = node.content ? node.content.childNodes : node.childNodes || [];
    let visibleSummary = null;
    if (!suppressed && closedDetails) {
      for (let i = 0; i < children.length; i++) {
        if (children[i].namespaceURI === 'http://www.w3.org/1999/xhtml' && children[i].tagName === 'summary') {
          visibleSummary = children[i]; break;
        }
      }
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({node: children[i], suppressed: suppressed || closedDetails && children[i] !== visibleSummary});
    }
  }
  flushEvidence();
  return {text: pieces.join(''), evidenceSpans: evidenceSpans, images: images,
    activeImageCount: activeImageCount, incomplete: incomplete};
}
function htmlText_(html) {
  return htmlContent_(html).text;
}
function safeUrl_(s) {
  if (typeof s !== 'string' || s.length > 2048 || /[\s\\\x00-\x1f]/.test(s)) return '';
  const m = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i.exec(s);
  if (!m || m[1].indexOf('.') < 0 || /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(m[1]) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|arpa|onion)$/i.test(m[1]) ||
    !m[1].split('.').every(function (p) { return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(p); })) return '';
  return s;
}
function smallImageDimension_(value) {
  // HTML dimension rules: digit-led decimal; only an immediately following % is relative.
  const match = /^[\t\n\f\r ]*([0-9]+(?:\.[0-9]*)?)(%?)/.exec(value || '');
  return Boolean(match && !match[2] && Number(match[1]) <= 2);
}
function remoteImageUrls_(html) {
  const urls = [];
  htmlContent_(html).images.forEach(function (attrs) {
    const src = typeof attrs.src === 'string' ? attrs.src.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '') : '';
    const url = safeUrl_(src);
    if (!url || ['width', 'height'].some(function (key) { return smallImageDimension_(attrs[key]); }) || trackerImageUrl_(url)) return;
    if (urls.indexOf(url) < 0) urls.push(url);
  });
  return urls;
}
const IMAGE_TRACKER_PATTERN = /(?:pixel|tracking|tracker|beacon|\/open(?:[/.?#;]|$)|transparent|spacer)/i;
function trackerImageUrl_(url) {
  if (IMAGE_TRACKER_PATTERN.test(url)) return true;
  const match = /^https:\/\/[a-z0-9.-]+(?::443)?([^?#]*)/i.exec(url);
  if (!match) return true;
  try { return IMAGE_TRACKER_PATTERN.test(decodeURIComponent(match[1])); }
  catch (error) { return true; }
}
function couponSignal_(text) {
  return /\b(coupon|voucher|promo(?:tion|code)?|discount|sconto|codice|offert[ae]|redeem|cashback|sale|save|risparmi|buono|buoni|deal)\b|\d\s*%/i.test(text);
}
