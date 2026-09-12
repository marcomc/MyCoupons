const GEMINI_ROUTING = Object.freeze({
  primaryBackend: 'gemini_api',
  vertexBackend: 'vertex_ai',
  cooldownMs: 60 * 60 * 1000,
  maxAttempts: 3,
  maxResponseBytes: 1024 * 1024,
  retryableStatuses: [408, 429, 500, 502, 503, 504]
});

function getGeminiScriptProperty_(key) {
  return String(props_().getProperty(key) || '').trim();
}

function getGeminiBackendConfiguration_() {
  const c = config_();
  const developerKey = getGeminiScriptProperty_('GEMINI_API_KEY');
  const backend = getEffectiveGeminiBackend_();
  if (!developerKey && backend === 'gemini_api') fail_('GEMINI_API_KEY');
  if (backend === 'vertex_ai' && !c.vertexProject) fail_('VERTEX_PROJECT');
  if (c.autoVertexFallback && !c.vertexProject) fail_('VERTEX_PROJECT');
  return {backend, model: c.model, developerKey, developerProject: c.developerProject,
    vertexProject: c.vertexProject, vertexLocation: c.vertexLocation};
}

function getGeminiFallbackUntil_() {
  const raw = getGeminiScriptProperty_('MYCOUPONS_GEMINI_VERTEX_UNTIL');
  const until = Number(raw);
  return isFinite(until) && until > Date.now() ? until : 0;
}

function getEffectiveGeminiBackend_() {
  clearExpiredGeminiFallback_();
  const c = config_();
  return c.autoVertexFallback && getGeminiFallbackUntil_() ? 'vertex_ai' : 'gemini_api';
}

function activateTemporaryVertexFallback_(reason) {
  if (!config_().autoVertexFallback || !isGeminiFallbackReason_(reason)) return 0;
  const key = 'MYCOUPONS_GEMINI_VERTEX_UNTIL';
  const current = Number(getGeminiScriptProperty_(key)) || 0;
  const until = Math.max(current, Date.now() + GEMINI_ROUTING.cooldownMs);
  props_().setProperty(key, String(until));
  return until;
}

function clearExpiredGeminiFallback_() {
  const key = 'MYCOUPONS_GEMINI_VERTEX_UNTIL';
  const raw = getGeminiScriptProperty_(key);
  if (raw && !getGeminiFallbackUntil_()) props_().deleteProperty(key);
}

function getGeminiVertexFallbackReason_(response) {
  if (!response || Number(response.status) !== 429) return '';
  let body;
  try { body = JSON.parse(String(response.body || '')); } catch (e) { return ''; }
  const error = body && body.error;
  if (!error || typeof error !== 'object' || Array.isArray(error) ||
    typeof error.message !== 'string') return '';
  if (error.code === 'quota_exceeded') return 'daily-quota-exhausted';
  const daily = error.code === 429 && error.status === 'RESOURCE_EXHAUSTED' &&
    Array.isArray(error.details) && error.details.some(function (detail) {
      return detail && detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' &&
        Array.isArray(detail.violations) && detail.violations.some(function (v) {
          return v && typeof v.quotaMetric === 'string' &&
            /^generativelanguage\.googleapis\.com\/[a-z][a-z0-9_]*$/.test(v.quotaMetric) &&
            typeof v.quotaId === 'string' &&
            /^GenerateRequestsPerDayPerProjectPerModel(?:-(?:FreeTier|PaidTier))?$/.test(v.quotaId);
        });
    });
  if (daily) return 'daily-quota-exhausted';
  return /^Your prepayment credits are depleted\.(?:\s|$)/.test(error.message) ?
    'prepayment-credits-depleted' : '';
}

function isGeminiFallbackReason_(reason) {
  return reason === 'daily-quota-exhausted' || reason === 'prepayment-credits-depleted';
}

function buildGeminiEndpoint_(backend, c) {
  if (backend === 'gemini_api') {
    return 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(c.model) + ':generateContent';
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c.vertexProject) ||
    !/^[a-z][a-z0-9-]*$/.test(c.vertexLocation)) fail_('CONFIG');
  const host = c.vertexLocation === 'global' ? 'aiplatform.googleapis.com' : c.vertexLocation + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' +
    encodeURIComponent(c.vertexProject) + '/locations/' + encodeURIComponent(c.vertexLocation) +
    '/publishers/google/models/' + encodeURIComponent(c.model) + ':generateContent';
}

function validateGeminiRequest_(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
    typeof request.text !== 'string' || !request.text.trim() || request.text.length > 60000 ||
    (request.images != null && (!Array.isArray(request.images) || request.images.length > MC.maxImages))) {
    fail_('GEMINI_REQUEST');
  }
  let totalImageBytes = 0;
  (request.images || []).forEach(function (image) {
    if (!image || typeof image !== 'object' || typeof image.mimeType !== 'string' ||
      !/^image\/(?:jpeg|png|gif|webp)$/i.test(image.mimeType) ||
      typeof image.data !== 'string' || image.data.length > MC.maxImageBytes * 2 ||
      !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(image.data)) {
      fail_('GEMINI_REQUEST');
    }
    const padding = image.data.length % 4;
    const decodedBytes = Math.floor(image.data.length * 3 / 4) - (padding === 2 ? 1 : padding === 3 ? 2 : 0);
    if (decodedBytes > MC.maxImageBytes || totalImageBytes + decodedBytes > MC.maxTotalImageBytes) {
      fail_('GEMINI_REQUEST');
    }
    totalImageBytes += decodedBytes;
  });
}

function callGeminiModel_(request, hooks) {
  validateGeminiRequest_(request);
  clearExpiredGeminiFallback_();
  const c = getGeminiBackendConfiguration_();
  return callGeminiBackend_(c.backend, c, request, hooks, '');
}

function geminiRetrySleep_(hooks, delayMs) {
  const deadlineMs = hooks && hooks.deadlineMs;
  if (deadlineMs && (!Number.isFinite(deadlineMs) || Date.now() + delayMs >= deadlineMs)) fail_('LIMIT');
  if (hooks && typeof hooks.sleep === 'function') { hooks.sleep(delayMs); return; }
  // Apps Script has no implicit retry wait. Production must actually yield
  // between bounded attempts; the missing method in the Node harness is a
  // deliberate no-op only for transport unit tests.
  if (Utilities && typeof Utilities.sleep === 'function') Utilities.sleep(delayMs);
}

function callGeminiBackend_(backend, c, request, hooks, fallbackReason) {
  const fetcher = hooks && hooks.fetch ? hooks.fetch : function (url, options) {
    const response = UrlFetchApp.fetch(url, options);
    return {status: response.getResponseCode(), body: response.getContentText()};
  };
  const payload = {contents: [{role: 'user', parts: [{text: request.text}]}]};
  (request.images || []).forEach(function (image) {
    payload.contents[0].parts.push({inlineData: {mimeType: image.mimeType, data: image.data}});
  });
  for (let attempt = 1; attempt <= GEMINI_ROUTING.maxAttempts; attempt += 1) {
    let response;
    try {
      const headers = backend === 'gemini_api' ?
        {'x-goog-api-key': c.developerKey} : {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()};
      response = fetcher(buildGeminiEndpoint_(backend, c), {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
        headers, muteHttpExceptions: true
      });
    } catch (error) {
      if (attempt === GEMINI_ROUTING.maxAttempts) throw new Error('Gemini network request failed.');
      geminiRetrySleep_(hooks, 250 * Math.pow(2, attempt - 1));
      continue;
    }
    response = {status: Number(response.status), body: String(response.body || '')};
    if (response.body.length > GEMINI_ROUTING.maxResponseBytes) fail_('GEMINI_RESPONSE');
    if (response.status >= 200 && response.status < 300) return parseGeminiResponse_(response);
    const reason = backend === 'gemini_api' ? getGeminiVertexFallbackReason_(response) : '';
    if (reason && config_().autoVertexFallback) {
      activateTemporaryVertexFallback_(reason);
      const vertex = getGeminiBackendConfiguration_();
      return callGeminiBackend_('vertex_ai', vertex, request, hooks, reason);
    }
    if (GEMINI_ROUTING.retryableStatuses.indexOf(response.status) >= 0 &&
      attempt < GEMINI_ROUTING.maxAttempts) {
      geminiRetrySleep_(hooks, 250 * Math.pow(2, attempt - 1));
      continue;
    }
    throw new Error('Gemini request failed with HTTP ' + response.status + '.');
  }
  throw new Error('Gemini request failed.');
}

function parseGeminiResponse_(response) {
  if (response.body.length > GEMINI_ROUTING.maxResponseBytes) fail_('GEMINI_RESPONSE');
  let body;
  try { body = JSON.parse(response.body); } catch (e) { fail_('GEMINI_RESPONSE'); }
  const parts = body && body.candidates && body.candidates[0] && body.candidates[0].content &&
    body.candidates[0].content.parts;
  if (!Array.isArray(parts)) fail_('GEMINI_RESPONSE');
  const text = parts.filter(function (part) { return part && typeof part.text === 'string'; })
    .map(function (part) { return part.text; }).join('');
  if (!text) fail_('GEMINI_RESPONSE');
  return {text, backend: getEffectiveGeminiBackend_()};
}
