const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const DEFAULT_CLIENT_INFO = Object.freeze({ name: 'unk-ai', version: '0.20.0' });
const DEFAULT_TIMEOUT_MS = 18000;
const MAX_LIST_PAGES = 10;

export class McpClientError extends Error {
  constructor(message, { code = 'MCP_ERROR', status = 0, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'McpClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function sanitizeMcpEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) throw new McpClientError('请先配置 MCP 服务端点地址。', { code: 'MCP_INVALID_ENDPOINT' });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpClientError('MCP 服务端点不是有效的 URL。', { code: 'MCP_INVALID_ENDPOINT' });
  }
  if (parsed.protocol !== 'https:') {
    throw new McpClientError('MCP 服务端点仅支持 HTTPS 协议。', { code: 'MCP_INVALID_ENDPOINT' });
  }
  return parsed.toString();
}

/** Parse a Streamable HTTP response body (JSON or text/event-stream) for a JSON-RPC reply. */
export function parseStreamableHttpBody(body, contentType = '', expectedId = null) {
  const text = String(body || '').trim();
  if (!text) return null;
  const isSse = /text\/event-stream/i.test(contentType) || (!text.startsWith('{') && !text.startsWith('[') && /(?:^|\n)data:/i.test(text));
  if (!isSse) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        if (expectedId !== null) {
          const matched = parsed.find(item => item && item.id === expectedId);
          if (matched) return matched;
        }
        return parsed.find(item => item && ('result' in item || 'error' in item)) || parsed[0] || null;
      }
      return parsed;
    } catch (error) {
      throw new McpClientError('MCP 服务返回了无法解析的 JSON 数据。', { code: 'MCP_PROTOCOL_ERROR', cause: error });
    }
  }

  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else if (parsed && typeof parsed === 'object') messages.push(parsed);
    } catch {
      // Ignore non-JSON SSE keepalive/comment payloads.
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') {
      flush();
      continue;
    }
    if (rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();

  if (!messages.length) {
    throw new McpClientError('MCP SSE 响应中未包含有效的 JSON-RPC 消息。', { code: 'MCP_PROTOCOL_ERROR' });
  }
  if (expectedId !== null) {
    const matched = messages.find(item => item && item.id === expectedId);
    if (matched) return matched;
  }
  return messages.findLast(item => item && ('result' in item || 'error' in item)) || messages[messages.length - 1];
}

function classifyHttpError(status, bodyText = '') {
  const snippet = String(bodyText || '').trim().slice(0, 200);
  if (status === 401 || status === 403) {
    return new McpClientError('MCP 认证失败（401/403），请检查 API Key 是否有效。', { code: 'MCP_AUTH_ERROR', status });
  }
  if (status === 429) {
    return new McpClientError('MCP 调用频率或每日配额已达上限（429），请稍后再试或等待次日重置。', { code: 'MCP_RATE_LIMIT', status });
  }
  if (status >= 500) {
    return new McpClientError(`MCP 服务端暂时不可用（HTTP ${status}）。`, { code: 'MCP_UPSTREAM_ERROR', status, retryable: true });
  }
  return new McpClientError(`MCP 请求失败（HTTP ${status}）${snippet ? `：${snippet}` : ''}。`, { code: 'MCP_HTTP_ERROR', status });
}

function classifyRpcError(rpcError) {
  const message = String(rpcError?.message || 'MCP 工具执行失败。');
  const code = Number(rpcError?.code);
  if (/quota|limit|配额|上限|频率|429/i.test(message) || code === 429) {
    return new McpClientError(`MCP 配额受限：${message}`, { code: 'MCP_RATE_LIMIT' });
  }
  if (/auth|key|unauthorized|forbidden|鉴权|密钥/i.test(message) || code === 401 || code === 403) {
    return new McpClientError(`MCP 鉴权失败：${message}`, { code: 'MCP_AUTH_ERROR' });
  }
  return new McpClientError(message, { code: 'MCP_RPC_ERROR' });
}

export function extractQuotaFromHeaders(headers) {
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

/** Direct fetch transport for Node tests or environments with direct HTTPS access. */
export function createFetchMcpTransport(fetchImpl = globalThis.fetch) {
  return async function fetchTransport({ url, method = 'POST', headers = {}, body = '', timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new McpClientError('当前运行环境不支持网络请求。', { code: 'MCP_NETWORK_ERROR' });
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason || new DOMException('已取消 MCP 请求。', 'AbortError'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('MCP 请求超时。', 'TimeoutError'));
    }, timeoutMs) : null;

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
        credentials: 'omit',
        signal: controller.signal,
      });
      const text = await response.text();
      const quota = extractQuotaFromHeaders(response.headers);
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
      if (timedOut || error?.name === 'TimeoutError') {
        throw new McpClientError('MCP 服务请求超时，请稍后重试。', { code: 'MCP_TIMEOUT', retryable: true, cause: error });
      }
      if (signal?.aborted || error?.name === 'AbortError') {
        const abortError = new DOMException('已取消 MCP 请求。', 'AbortError');
        throw abortError;
      }
      throw new McpClientError('无法连接 MCP 服务，请检查网络状态。', { code: 'MCP_NETWORK_ERROR', retryable: true, cause: error });
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  };
}

/** Extension runtime transport that delegates HTTPS fetch to the MV3 background service worker. */
export function createExtensionMcpTransport(runtime = globalThis.chrome?.runtime) {
  let seq = 0;
  return async function extensionTransport({ url, method = 'POST', headers = {}, body = '', timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    if (!runtime?.sendMessage) {
      return createFetchMcpTransport()({ url, method, headers, body, timeoutMs, signal });
    }
    if (signal?.aborted) {
      throw new DOMException('已取消 MCP 请求。', 'AbortError');
    }
    const requestId = `mcp-${Date.now()}-${++seq}`;
    const abortRemote = () => {
      try {
        void runtime.sendMessage({ type: 'MCP_HTTP_ABORT', requestId }).catch(() => {});
      } catch { /* Ignore cleanup errors when service worker is inactive. */ }
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        abortRemote();
        finish(reject, new DOMException('已取消 MCP 请求。', 'AbortError'));
      };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        abortRemote();
        finish(reject, new McpClientError('MCP 服务请求超时，请稍后重试。', { code: 'MCP_TIMEOUT', retryable: true }));
      }, timeoutMs + 1500) : null;

      signal?.addEventListener?.('abort', onAbort, { once: true });

      Promise.resolve(runtime.sendMessage({
        type: 'MCP_HTTP_REQUEST',
        requestId,
        url,
        method,
        headers,
        body,
        timeoutMs,
      })).then(response => {
        if (!response || typeof response !== 'object') {
          finish(reject, new McpClientError('后台 MCP 代理未返回有效响应。', { code: 'MCP_NETWORK_ERROR' }));
          return;
        }
        if (response.error && !response.status) {
          if (response.code === 'MCP_ABORTED') {
            finish(reject, new DOMException('已取消 MCP 请求。', 'AbortError'));
            return;
          }
          finish(reject, new McpClientError(response.error, {
            code: response.code || 'MCP_NETWORK_ERROR',
            retryable: response.code === 'MCP_TIMEOUT' || response.code === 'MCP_NETWORK_ERROR',
          }));
          return;
        }
        finish(resolve, response);
      }).catch(error => {
        finish(reject, new McpClientError(error?.message || '无法连接后台 MCP 代理。', { code: 'MCP_NETWORK_ERROR', cause: error }));
      });
    });
  };
}

/** Extract readable text & structured payloads from an MCP tools/call result. */
export function extractMcpToolResult(result) {
  if (!result || typeof result !== 'object') {
    return { isError: false, text: '', structured: null, rawContent: [] };
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
    } else if (item.type === 'resource' && typeof item.resource?.text === 'string') {
      textParts.push(item.resource.text);
    }
  }
  const text = textParts.join('\n').trim();
  let structured = result.structuredContent ?? null;
  if (structured === null && text && (text.startsWith('{') || text.startsWith('['))) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = null;
    }
  }
  return {
    isError: result.isError === true,
    text,
    structured,
    rawContent: content,
  };
}

/**
 * Reusable MCP Streamable HTTP Client.
 * Supports initialize handshake, session tracking, tools/list, and tools/call.
 */
export function createMcpHttpClient({
  endpoint,
  headers = {},
  transport = createExtensionMcpTransport(),
  clientInfo = DEFAULT_CLIENT_INFO,
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const url = sanitizeMcpEndpoint(endpoint);
  let nextId = 1;
  let sessionId = '';
  let initialized = false;
  let serverInfo = null;
  let lastQuota = null;
  let initializingPromise = null;

  function buildHeaders() {
    const merged = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    };
    if (sessionId) merged['Mcp-Session-Id'] = sessionId;
    return merged;
  }

  async function rpc(method, params, { signal, timeoutMs = defaultTimeoutMs, notification = false } = {}) {
    const id = notification ? undefined : nextId++;
    const payload = notification
      ? { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
      : { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };

    const response = await transport({
      url,
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      timeoutMs,
      signal,
    });

    if (response.sessionId) sessionId = response.sessionId;
    if (response.quota && typeof response.quota === 'object') lastQuota = response.quota;
    if (notification) {
      // Notifications may return 202 Accepted / 204 No Content / 200 OK.
      return null;
    }
    if (!response.ok) {
      throw classifyHttpError(response.status, response.body);
    }
    const parsed = parseStreamableHttpBody(response.body, response.contentType, id);
    if (!parsed || typeof parsed !== 'object') {
      throw new McpClientError('MCP 服务返回了空响应。', { code: 'MCP_PROTOCOL_ERROR' });
    }
    if (parsed.error) {
      throw classifyRpcError(parsed.error);
    }
    return parsed.result;
  }

  async function initialize({ signal, timeoutMs = defaultTimeoutMs } = {}) {
    if (initialized) return { serverInfo, sessionId };
    if (initializingPromise) return initializingPromise;
    initializingPromise = (async () => {
      const result = await rpc('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo,
      }, { signal, timeoutMs });
      serverInfo = result?.serverInfo || null;
      initialized = true;
      try {
        await rpc('notifications/initialized', undefined, { signal, timeoutMs: Math.min(timeoutMs, 5000), notification: true });
      } catch {
        // Some Streamable HTTP gateways do not require or acknowledge notifications/initialized.
      }
      return { serverInfo, sessionId };
    })();
    try {
      return await initializingPromise;
    } finally {
      initializingPromise = null;
    }
  }

  async function listTools({ signal, timeoutMs = defaultTimeoutMs } = {}) {
    await initialize({ signal, timeoutMs });
    const tools = [];
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await rpc('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs });
      if (Array.isArray(result?.tools)) {
        tools.push(...result.tools);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : '';
      if (!cursor) break;
    }
    return tools;
  }

  async function callTool(name, args = {}, { signal, timeoutMs = defaultTimeoutMs } = {}) {
    const toolName = String(name || '').trim();
    if (!toolName) throw new McpClientError('缺少要调用的 MCP 工具名称。', { code: 'MCP_INVALID_ARGS' });
    await initialize({ signal, timeoutMs });
    const result = await rpc('tools/call', {
      name: toolName,
      arguments: args && typeof args === 'object' ? args : {},
    }, { signal, timeoutMs });
    return extractMcpToolResult(result);
  }

  function resetSession() {
    sessionId = '';
    initialized = false;
    serverInfo = null;
  }

  return Object.freeze({
    endpoint: url,
    initialize,
    listTools,
    callTool,
    resetSession,
    get sessionId() { return sessionId; },
    get serverInfo() { return serverInfo; },
    get lastQuota() { return lastQuota; },
  });
}
