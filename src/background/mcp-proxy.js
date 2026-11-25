const MAX_PROXY_TIMEOUT_MS = 60000;
const DEFAULT_PROXY_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB safety cap per MCP HTTP response.

const activeRequests = new Map();

function validateProxyUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('无效的 MCP 服务地址。');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('MCP 代理仅允许访问 HTTPS 服务。');
  }
  return parsed.toString();
}

function sanitizeHeaders(rawHeaders) {
  const clean = {};
  if (!rawHeaders || typeof rawHeaders !== 'object') return clean;
  for (const [key, value] of Object.entries(rawHeaders)) {
    const name = String(key || '').trim();
    if (!name || typeof value !== 'string') continue;
    // Block forbidden browser-managed headers.
    if (/^(host|origin|referer|cookie|connection|content-length)$/i.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

function extractQuotaHeaders(headers) {
  if (!headers?.get) return null;
  const readNum = (...names) => {
    for (const name of names) {
      const raw = headers.get(name);
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
      }
    }
    return null;
  };
  const limit = readNum('x-ratelimit-limit', 'ratelimit-limit', 'x-quota-limit', 'x-daily-limit');
  const remaining = readNum('x-ratelimit-remaining', 'ratelimit-remaining', 'x-quota-remaining', 'x-daily-remaining');
  const used = readNum('x-ratelimit-used', 'x-quota-used', 'x-daily-used');
  if (limit === null && remaining === null && used === null) return null;
  const computedUsed = used !== null ? used : (limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null);
  return { limit, remaining, used: computedUsed };
}

async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const allowed = Math.max(0, value.byteLength - (totalBytes - maxBytes));
        if (allowed > 0) result += decoder.decode(value.subarray(0, allowed), { stream: true });
        await reader.cancel().catch(() => {});
        break;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function abortMcpProxyRequest(requestId) {
  const id = String(requestId || '').trim();
  if (!id) return false;
  const entry = activeRequests.get(id);
  if (!entry) return false;
  entry.abortedByCaller = true;
  entry.controller.abort(new DOMException('已取消 MCP 请求。', 'AbortError'));
  activeRequests.delete(id);
  return true;
}

export async function executeMcpProxyRequest(message, { fetchImpl = globalThis.fetch } = {}) {
  const requestId = String(message?.requestId || '').trim() || `mcp-${Date.now()}`;
  const url = validateProxyUrl(message?.url);
  const method = String(message?.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const headers = sanitizeHeaders(message?.headers);
  const body = typeof message?.body === 'string' ? message.body : '';
  const requestedTimeout = Number(message?.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, MAX_PROXY_TIMEOUT_MS)
    : DEFAULT_PROXY_TIMEOUT_MS;

  const controller = new AbortController();
  const entry = { controller, abortedByCaller: false, timedOut: false };
  activeRequests.set(requestId, entry);

  const timer = setTimeout(() => {
    entry.timedOut = true;
    controller.abort(new DOMException('MCP 请求超时。', 'TimeoutError'));
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      credentials: 'omit',
      signal: controller.signal,
    });
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    const quota = extractQuotaHeaders(response.headers);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || '',
      contentType: response.headers?.get?.('content-type') || '',
      sessionId: response.headers?.get?.('mcp-session-id') || '',
      ...(quota ? { quota } : {}),
      body: text,
    };
  } catch (error) {
    if (entry.timedOut || error?.name === 'TimeoutError') {
      return { ok: false, code: 'MCP_TIMEOUT', error: 'MCP 服务请求超时，请稍后重试。' };
    }
    if (entry.abortedByCaller || error?.name === 'AbortError') {
      return { ok: false, code: 'MCP_ABORTED', error: '已取消 MCP 请求。' };
    }
    return { ok: false, code: 'MCP_NETWORK_ERROR', error: '无法连接 MCP 服务，请检查网络或服务地址。' };
  } finally {
    clearTimeout(timer);
    if (activeRequests.get(requestId) === entry) {
      activeRequests.delete(requestId);
    }
  }
}

export function handleMcpProxyMessage(message, sender, sendResponse, { runtimeId = globalThis.chrome?.runtime?.id, fetchImpl = globalThis.fetch } = {}) {
  if (message?.type !== 'MCP_HTTP_REQUEST' && message?.type !== 'MCP_HTTP_ABORT') return false;
  if (runtimeId && sender?.id !== runtimeId) {
    sendResponse({ ok: false, code: 'MCP_FORBIDDEN', error: '仅允许扩展内部调用 MCP 代理。' });
    return false;
  }
  if (message.type === 'MCP_HTTP_ABORT') {
    sendResponse({ ok: abortMcpProxyRequest(message.requestId) });
    return false;
  }
  executeMcpProxyRequest(message, { fetchImpl })
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, code: 'MCP_NETWORK_ERROR', error: error?.message || 'MCP 代理请求失败。' }));
  return true;
}
