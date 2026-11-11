import { awaitWithAbort } from './abortable.js';

const MAX_ERROR_LENGTH = 1000;
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|models|web_search|web_fetch)\/?$/i;
export const DEFAULT_WEB_SEARCH_ENDPOINT = 'web_search';
export const DEFAULT_WEB_FETCH_ENDPOINT = 'web_fetch';
export const RESEARCH_ENDPOINT_CANDIDATES = Object.freeze({
  search: Object.freeze(['tools/search', 'web_search', 'search', 'web/search', 'tools/web_search']),
  fetch: Object.freeze(['tools/fetch', 'web_fetch', 'fetch', 'web/fetch', 'tools/web_fetch']),
});

function notifyDiagnostic(observer, event) {
  if (typeof observer !== 'function') return;
  try { Promise.resolve(observer(Object.freeze(event))).catch(() => {}); }
  catch { /* Observers never own transport success, failure or cancellation. */ }
}

function createTransportDiagnostics(onDiagnostic, signal) {
  const active = typeof onDiagnostic === 'function';
  const startedAt = Date.now();
  const metrics = { attempt: 0, byteCount: 0, chunkCount: 0, eventCount: 0 };
  let failureReason;
  const elapsed = () => Math.max(0, Math.min(86400000, Date.now() - startedAt));
  const emit = (type, extra = {}) => {
    if (active) notifyDiagnostic(onDiagnostic, { type: `transport.${type}`, durationMs: elapsed(), ...metrics, ...extra });
  };
  const first = kind => {
    const field = kind === 'reasoning' ? 'firstReasoningMs' : 'firstContentMs';
    if (!active || metrics[field] !== undefined) return;
    metrics[field] = elapsed(); emit(`first-${kind}`);
  };
  return {
    active, emit, first,
    reason(value) { failureReason = value; },
    parsed() { if (active) metrics.eventCount = Math.min(2147483647, metrics.eventCount + 1); },
    chunk(value) {
      if (!active) return;
      metrics.chunkCount = Math.min(2147483647, metrics.chunkCount + 1);
      metrics.byteCount = Math.min(2147483647, metrics.byteCount + (Number(value?.byteLength) || 0));
      if (metrics.firstByteMs === undefined && value?.byteLength > 0) {
        metrics.firstByteMs = elapsed(); emit('first-byte');
      }
      // At most 31 progress samples, even for one-byte network chunks.
      if (metrics.chunkCount <= 1073741824 && (metrics.chunkCount & (metrics.chunkCount - 1)) === 0) emit('progress');
    },
    fetch(fetchImpl) {
      if (!active) return fetchImpl;
      return async (...args) => {
        metrics.attempt = Math.min(10, metrics.attempt + 1);
        failureReason = 'network';
        const response = await fetchImpl(...args);
        const status = Number(response?.status);
        if (Number.isInteger(status) && status >= 100 && status <= 599) metrics.status = status;
        const mediaType = String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        metrics.contentType = ['text/event-stream', 'application/json', 'text/json', 'text/plain', 'text/html'].includes(mediaType)
          ? mediaType : mediaType ? 'other' : 'missing';
        failureReason = response.ok ? 'stream-error' : status === 429 ? 'rate-limit' : 'http-error';
        emit('headers');
        return response;
      };
    },
    async json(response) {
      if (!active) return response.json();
      emit('body-started');
      try {
        const payload = await response.json();
        metrics.eventCount = Math.min(2147483647, metrics.eventCount + 1);
        emit('body-completed');
        return payload;
      } catch (error) {
        if (response.ok) failureReason = 'malformed';
        throw error;
      }
    },
    async run(operation) {
      emit('started');
      try {
        const result = await operation();
        emit('completed', { reason: failureReason === 'empty' || failureReason === 'reasoning-only' ? failureReason : 'complete' });
        return result;
      } catch (error) {
        const cancelled = error?.name === 'AbortError' || signal?.aborted && signal.reason?.name !== 'TimeoutError';
        const reason = cancelled ? 'aborted' : error?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError'
          ? 'timeout' : failureReason || 'network';
        emit(cancelled ? 'cancelled' : 'failed', { reason });
        throw error;
      }
    },
  };
}

function diagnosticRequest(options, operation) {
  const diagnostic = createTransportDiagnostics(options.onDiagnostic, options.signal);
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  return diagnostic.run(() => operation({ ...options, diagnostic, fetchImpl: diagnostic.fetch(fetchImpl) }));
}

function researchEndpointName(value, fallback) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return (normalized && !normalized.split('/').includes('..') ? normalized : fallback);
}

function researchRequestId(prefix, value) {
  return `${prefix}-${String(value || '').slice(0, 80)}`;
}

function researchNetworkError(error, timeoutMessage) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return error;
  return error instanceof TypeError
    ? Object.assign(new Error(timeoutMessage || '网络请求失败。'), { cause: error })
    : error;
}

function boundedResearchText(value, limit = 16000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function researchResults(payload) {
  const data = payload?.data && !Array.isArray(payload.data) ? payload.data : null;
  const value = Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.items) ? payload.items
        : Array.isArray(payload?.sources) ? payload.sources
          : Array.isArray(data?.results) ? data.results
            : Array.isArray(data?.items) ? data.items
              : [];
  return value.filter(item => item && typeof item.url === 'string' && /^https?:/i.test(item.url))
    .map(item => {
      const result = {
        title: String(item.title || item.name || item.site_name || item.site || item.url).slice(0, 300),
        url: String(item.url),
        snippet: String(item.summary || item.snippet || item.description || item.content || '').slice(0, 6000),
        site: String(item.site_name || item.site || '').slice(0, 200),
        favicon: String(item.site_icon || item.favicon || '').slice(0, 2000),
      };
      if (item.content) result.content = String(item.content).slice(0, 16000);
      if (item.date || item.published_at) result.publishedAt = String(item.date || item.published_at).slice(0, 100);
      if (Number.isFinite(Number(item.authority))) result.authority = Number(item.authority);
      return result;
    });
}

function processContentChunk(chunk, state) {
  let text = (state.contentBuffer || '') + chunk;
  state.contentBuffer = '';

  while (text.length > 0) {
    if (state.inThink) {
      const closeIdx = text.indexOf('</think>');
      if (closeIdx !== -1) {
        const thinkSegment = text.slice(0, closeIdx);
        if (thinkSegment.length > 0) {
          state.reasoning += thinkSegment;
          if (state.onReasoning !== undefined) state.onReasoning(thinkSegment, state.reasoning);
        }
        state.inThink = false;
        text = text.slice(closeIdx + 8);
      } else {
        let partialMatch = 0;
        for (let i = 1; i < 8 && i <= text.length; i++) {
          if ('</think>'.startsWith(text.slice(-i))) {
            partialMatch = i;
          }
        }
        if (partialMatch > 0) {
          const thinkSegment = text.slice(0, -partialMatch);
          if (thinkSegment.length > 0) {
            state.reasoning += thinkSegment;
            if (state.onReasoning !== undefined) state.onReasoning(thinkSegment, state.reasoning);
          }
          state.contentBuffer = text.slice(-partialMatch);
          return;
        }
        state.reasoning += text;
        if (state.onReasoning !== undefined) state.onReasoning(text, state.reasoning);
        return;
      }
    } else {
      const openIdx = text.indexOf('<think>');
      if (openIdx !== -1) {
        const normalSegment = text.slice(0, openIdx);
        if (normalSegment.length > 0) {
          state.text += normalSegment;
          if (state.onDelta !== undefined) state.onDelta(normalSegment, state.text, state.reasoning);
        }
        state.inThink = true;
        text = text.slice(openIdx + 7);
      } else {
        let partialMatch = 0;
        for (let i = 1; i < 7 && i <= text.length; i++) {
          if ('<think>'.startsWith(text.slice(-i))) {
            partialMatch = i;
          }
        }
        if (partialMatch > 0) {
          const normalSegment = text.slice(0, -partialMatch);
          if (normalSegment.length > 0) {
            state.text += normalSegment;
            if (state.onDelta !== undefined) state.onDelta(normalSegment, state.text, state.reasoning);
          }
          state.contentBuffer = text.slice(-partialMatch);
          return;
        }
        state.text += text;
        if (state.onDelta !== undefined) state.onDelta(text, state.text, state.reasoning);
        return;
      }
    }
  }
}

function flushContentBuffer(state) {
  if (!state.contentBuffer) return;
  const rem = state.contentBuffer;
  state.contentBuffer = '';
  if (state.inThink) {
    state.reasoning += rem;
    if (state.onReasoning !== undefined) state.onReasoning(rem, state.reasoning);
  } else {
    state.text += rem;
    if (state.onDelta !== undefined) state.onDelta(rem, state.text, state.reasoning);
  }
}

function toolProtocolError(state, message) {
  state.diagnostic?.reason('malformed');
  return new Error(`模型工具响应无效：${message}`);
}

function collectToolDeltas(deltas, state) {
  if (!Array.isArray(deltas)) throw toolProtocolError(state, 'tool_calls 不是数组。');
  for (const delta of deltas) {
    const index = delta?.index;
    if (!Number.isInteger(index) || index < 0 || index >= 12) throw toolProtocolError(state, '工具索引无效或超过上限。');
    let call = state.toolCalls.get(index);
    if (!call) {
      call = { id: '', type: 'function', function: { name: '', arguments: '' } };
      state.toolCalls.set(index, call);
    }
    if (delta.type !== undefined && delta.type !== 'function') throw toolProtocolError(state, '不支持此工具类型。');
    if (delta.id !== undefined) {
      if (typeof delta.id !== 'string' || !/^[^\s]{1,200}$/.test(delta.id)) throw toolProtocolError(state, '工具标识无效。');
      if (call.id && call.id !== delta.id) throw toolProtocolError(state, '同一工具索引出现冲突标识。');
      call.id = delta.id;
    }
    if (delta.function !== undefined && (!delta.function || typeof delta.function !== 'object' || Array.isArray(delta.function))) {
      throw toolProtocolError(state, '工具函数格式无效。');
    }
    for (const field of ['name', 'arguments']) {
      const fragment = delta.function?.[field];
      if (fragment === undefined) continue;
      if (typeof fragment !== 'string') throw toolProtocolError(state, '工具参数分片不是字符串。');
      call.function[field] += fragment;
      if (call.function[field].length > (field === 'name' ? 64 : 8192)) throw toolProtocolError(state, '工具名称或参数超过上限。');
    }
  }
}

function completeToolTurn(state) {
  const toolCalls = [...state.toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
  if (toolCalls.length) {
    if (state.finishReason !== 'tool_calls') throw toolProtocolError(state, '工具调用没有完整结束标记。');
    const ids = new Set();
    for (const call of toolCalls) {
      if (!call.id || ids.has(call.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.function.name)) throw toolProtocolError(state, '工具标识重复或名称无效。');
      ids.add(call.id);
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { throw toolProtocolError(state, '工具参数不是完整 JSON。'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw toolProtocolError(state, '工具参数必须是对象。');
    }
  } else if (state.finishReason === 'tool_calls') {
    throw toolProtocolError(state, '工具结束标记缺少工具调用。');
  } else if (!state.text.trim()) {
    state.diagnostic?.reason(state.reasoning.trim() ? 'reasoning-only' : 'empty');
    throw new Error(state.reasoning.trim() ? '模型只返回了思考内容，没有完整回答。' : '模型返回了空回答。');
  }
  const message = { role: 'assistant', content: state.rawContent || null,
    ...(state.nativeReasoning ? { reasoning_content: state.nativeReasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  return { content: state.text, reasoning: state.reasoning, toolCalls, message, finishReason: state.finishReason || 'stop' };
}

function parseEvent(event, state) {
  if (state.toolMode) state.signal?.throwIfAborted();
  const data = [];
  let eventId;

  for (const line of event.split(/\r\n|\r|\n/)) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalizedLine || normalizedLine.startsWith(':')) continue;

    const colon = normalizedLine.indexOf(':');
    const field = colon === -1 ? normalizedLine : normalizedLine.slice(0, colon);
    let value = colon === -1 ? '' : normalizedLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    if (field === 'id' && !value.includes('\0')) eventId = value;
  }

  if (data.length === 0) return;
  const payload = data.join('\n');
  // The SSE event ID identifies a delivery; JSON completion IDs commonly stay
  // identical across every chunk and must never be used to deduplicate deltas.
  if (state.toolMode && eventId) {
    const previous = state.eventIds.get(eventId);
    if (previous !== undefined) {
      if (previous !== payload) throw toolProtocolError(state, '重复 SSE 标识包含冲突内容。');
      return;
    }
    if (eventId.length > 200 || state.eventIds.size >= 65536) throw toolProtocolError(state, 'SSE 标识超过处理预算。');
    state.eventIds.set(eventId, payload);
  }
  if (payload.trim() === '[DONE]') {
    state.diagnostic?.parsed();
    state.done = true;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    state.diagnostic?.reason('malformed');
    throw new Error('Invalid JSON in streaming response.');
  }

  state.diagnostic?.parsed();

  if (parsed?.error) {
    state.diagnostic?.reason('error-event');
    const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || parsed.error.code;
    throw new Error(`模型流式响应失败：${redact(detail || '服务返回错误。', state.apiKey)}`);
  }
  const choice = parsed?.choices?.[0];
  const delta = choice?.delta;
  if (state.toolMode) {
    if (state.finishReason && (delta?.content || delta?.reasoning_content || delta?.reasoning || delta?.tool_calls?.length
      || choice?.finish_reason && choice.finish_reason !== state.finishReason)) throw toolProtocolError(state, '完成标记后仍收到新内容或冲突终态。');
    if (delta?.tool_calls !== undefined) collectToolDeltas(delta.tool_calls, state);
    if (delta?.function_call !== undefined) throw toolProtocolError(state, '需要使用带标识的 tool_calls 协议。');
  }
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    if (state.toolMode) state.nativeReasoning += reasoning;
    state.reasoning += reasoning;
    if (state.onReasoning !== undefined) state.onReasoning(reasoning, state.reasoning);
  }
  const content = delta?.content;
  if (typeof content === 'string' && content.length > 0) {
    if (state.toolMode) state.rawContent += content;
    processContentChunk(content, state);
  }
}

/** Extract all complete events, leaving an incomplete final event buffered. */
function drainEvents(buffer, state, flush = false) {
  while (!state.done) {
    // Two line endings delimit an event. The CRLF alternative comes first so
    // a delimiter split between arbitrary chunks is still parsed correctly.
    const boundary = /(?:\r\n|\r(?!\n)|\n){2}/.exec(buffer);
    if (!boundary) break;
    parseEvent(buffer.slice(0, boundary.index), state);
    buffer = buffer.slice(boundary.index + boundary[0].length);
  }

  if (state.done) return '';
  if (flush && buffer) parseEvent(buffer, state);
  return flush ? '' : buffer;
}

function redact(text, apiKey) {
  let detail = String(text || '').trim().replace(/\s+/g, ' ');
  if (apiKey !== undefined && apiKey !== null && String(apiKey) !== '') {
    detail = detail.split(String(apiKey)).join('[redacted]');
  }
  return detail.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, MAX_ERROR_LENGTH);
}

async function readErrorBody(response, apiKey) {
  try {
    return redact(await response.text(), apiKey);
  } catch {
    return '';
  }
}

function requestHeaders(apiKey, accept = 'application/json') {
  const headers = { Accept: accept };
  if (apiKey !== undefined && apiKey !== null && String(apiKey).trim() !== '') {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }
  return headers;
}

/**
 * Search through the configured model gateway. This is intentionally opt-in:
 * OpenAI-compatible providers that do not expose /web_search return 404 and
 * the caller can fall back without hiding an actual search failure.
 */
export async function requestGatewayWebSearch(options = {}) {
  return diagnosticRequest(options, gatewayWebSearch);
}

async function gatewayWebSearch({
  endpointUrl, apiKey, endpointName = DEFAULT_WEB_SEARCH_ENDPOINT,
  query, maxResults = 5, signal, fetchImpl = globalThis.fetch, diagnostic,
} = {}) {
  if (!endpointUrl || !String(endpointUrl).trim()) throw new Error('模型 Endpoint 未配置，搜索无从发起。');
  const text = String(query || '').trim();
  if (!text) throw new Error('搜索关键词为空。');
  if (text.length > 200) throw new Error('搜索关键词过长（上限 200 字）。');
  const url = researchApiUrl(endpointUrl, endpointName, DEFAULT_WEB_SEARCH_ENDPOINT);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...requestHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: text,
        max_results: Math.max(1, Math.min(10, Number(maxResults) || 5)),
        ...(String(endpointName || '').includes('tools/') ? {
          count: Math.max(1, Math.min(50, Number(maxResults) || 5)),
          need_content: false,
        } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw researchNetworkError(error, '搜索请求失败。');
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  if ([404, 405, 501].includes(response.status)) {
    throw Object.assign(new Error(`模型服务未提供搜索端点 ${url}（HTTP ${response.status}）。`), {
      status: response.status,
      endpoint: url,
    });
  }
  const payload = await researchJson(response, '搜索', apiKey, diagnostic);
  if (!response.ok) {
    const detail = payload?.errors?.[0] || payload?.message || payload?.error?.message || payload?.error;
    throw Object.assign(new Error(`模型服务搜索失败（HTTP ${response.status}）${detail ? `：${redact(detail, apiKey)}` : ''}`),
      { status: response.status });
  }
  const results = researchResults(payload);
  if (results.length) diagnostic.first('content');
  else diagnostic.reason('empty');
  return { ok: payload?.ok !== false, query: String(payload?.query || text),
    engine: String(payload?.engine || ''), results };
}

/**
 * Fetch a public page through the configured provider capability. The provider
 * returns readable Markdown/plain text, so callers do not need to parse HTML.
 */
export async function requestGatewayWebFetch(options = {}) {
  return diagnosticRequest(options, gatewayWebFetch);
}

async function gatewayWebFetch({
  endpointUrl, apiKey, endpointName = DEFAULT_WEB_FETCH_ENDPOINT,
  url: targetUrl, signal, fetchImpl = globalThis.fetch, diagnostic,
} = {}) {
  if (!endpointUrl || !String(endpointUrl).trim()) throw new Error('模型 Endpoint 未配置，网页抓取无从发起。');
  let target;
  try {
    target = new URL(String(targetUrl || '').trim());
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
  } catch {
    throw new TypeError('网页抓取需要有效的 HTTP 或 HTTPS 地址。');
  }
  const url = researchApiUrl(endpointUrl, endpointName, DEFAULT_WEB_FETCH_ENDPOINT);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...requestHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target.href }),
      signal: controller.signal,
    });
  } catch (error) {
    throw researchNetworkError(error, '网页抓取请求失败。');
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  const payload = await researchJson(response, '网页抓取', apiKey, diagnostic);
  if (!response.ok || payload?.ok === false) {
    throw Object.assign(new Error(actionFailureMessage('模型服务抓取失败', response, payload, apiKey)), {
      status: response.status,
    });
  }
  const content = String(payload?.content || payload?.markdown || payload?.text || '').trim();
  if (!content) { diagnostic.reason('empty'); throw new Error('网页抓取服务没有返回可读取的正文。'); }
  diagnostic.first('content');
  return {
    ok: true,
    title: String(payload?.title || '').slice(0, 300),
    url: String(payload?.url || target.href),
    content: content.slice(0, 16000),
    contentType: String(payload?.content_type || payload?.contentType || 'text/markdown').slice(0, 100),
    truncated: Boolean(payload?.truncated || content.length > 16000),
    engine: String(payload?.engine || '').slice(0, 100),
    pageStatus: Number(payload?.page_status || payload?.status || 0) || null,
  };
}

/** Build the provider capability URL from a base endpoint and editable route name. */
export function researchApiUrl(endpointUrl, endpointName = DEFAULT_WEB_SEARCH_ENDPOINT, fallback = DEFAULT_WEB_SEARCH_ENDPOINT) {
  const name = researchEndpointName(endpointName, fallback);
  return `${resolveApiUrl(endpointUrl, 'models').replace(/\/models\/?$/i, '')}/${name}`;
}

function actionFailureMessage(prefix, response, payload, apiKey) {
  const detail = payload?.errors?.[0] || payload?.message || payload?.error?.message || payload?.error;
  return `${prefix}（HTTP ${response.status}）${detail ? `：${redact(detail, apiKey)}` : ''}`;
}

async function researchJson(response, label, apiKey, diagnostic) {
  let payload;
  try { payload = await (diagnostic ? diagnostic.json(response) : response.json()); } catch {
    const detail = await readErrorBody(response, apiKey).catch(() => '');
    throw Object.assign(new Error(`${label}服务返回非 JSON（HTTP ${response.status}）${detail ? `：${detail}` : ''}`), {
      status: response.status,
    });
  }
  return payload;
}

/**
 * Probe capability endpoints with a real minimal request. OPTIONS is not used:
 * some gateways answer it for every path, which would produce false positives.
 */
export async function probeResearchCapabilities({
  endpointUrl, apiKey, webSearchEndpoint = DEFAULT_WEB_SEARCH_ENDPOINT,
  webFetchEndpoint = DEFAULT_WEB_FETCH_ENDPOINT, signal, fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const probeOne = async (kind, endpointName) => {
    try {
      if (kind === 'search') {
        const result = await requestGatewayWebSearch({
          endpointUrl, apiKey, endpointName, query: 'OpenAI', maxResults: 1,
          signal: controller.signal, fetchImpl,
        });
        if (!result.results.length) throw new Error('接口已响应，但没有返回可解析的搜索结果。');
        return { supported: true, endpoint: researchApiUrl(endpointUrl, endpointName, DEFAULT_WEB_SEARCH_ENDPOINT),
          endpointName: researchEndpointName(endpointName, DEFAULT_WEB_SEARCH_ENDPOINT),
          engine: result.engine, message: `可用，返回 ${result.results.length} 条结果` };
      }
      const result = await requestGatewayWebFetch({
        endpointUrl, apiKey, endpointName, url: 'https://example.com',
        signal: controller.signal, fetchImpl,
      });
      return { supported: true, endpoint: researchApiUrl(endpointUrl, endpointName, DEFAULT_WEB_FETCH_ENDPOINT),
        endpointName: researchEndpointName(endpointName, DEFAULT_WEB_FETCH_ENDPOINT),
        engine: result.engine, message: `可用${result.title ? `：${result.title}` : ''}` };
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      return { supported: false,
        endpoint: researchApiUrl(endpointUrl, endpointName, kind === 'search' ? DEFAULT_WEB_SEARCH_ENDPOINT : DEFAULT_WEB_FETCH_ENDPOINT),
        endpointName: researchEndpointName(endpointName, kind === 'search' ? DEFAULT_WEB_SEARCH_ENDPOINT : DEFAULT_WEB_FETCH_ENDPOINT),
        status: Number(error?.status) || null, message: boundedResearchText(error?.message || '接口不可用', 500) };
    }
  };
  const probe = async (kind, preferred) => {
    const candidates = [
      preferred,
      ...RESEARCH_ENDPOINT_CANDIDATES[kind],
    ].map(name => researchEndpointName(name, kind === 'search' ? DEFAULT_WEB_SEARCH_ENDPOINT : DEFAULT_WEB_FETCH_ENDPOINT));
    const tried = [];
    for (const endpointName of [...new Set(candidates)]) {
      const result = await probeOne(kind, endpointName);
      tried.push({ endpointName, supported: result.supported, status: result.status, message: result.message });
      if (result.supported) return { ...result, tried };
    }
    const last = tried.at(-1) || { endpointName: preferred, status: null, message: '接口不可用' };
    return {
      supported: false,
      endpoint: researchApiUrl(endpointUrl, preferred, kind === 'search' ? DEFAULT_WEB_SEARCH_ENDPOINT : DEFAULT_WEB_FETCH_ENDPOINT),
      endpointName: researchEndpointName(preferred, kind === 'search' ? DEFAULT_WEB_SEARCH_ENDPOINT : DEFAULT_WEB_FETCH_ENDPOINT),
      status: last.status,
      message: last.message,
      tried,
    };
  };
  try {
    const [search, fetch] = await Promise.all([
      probe('search', webSearchEndpoint),
      probe('fetch', webFetchEndpoint),
    ]);
    return { search, fetch };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Accept an API base URL or a complete legacy endpoint. Both forms are useful:
 * `http://localhost:7864/v1` and `https://api.example.com/v1/chat/completions`.
 */
export function resolveApiUrl(endpointUrl, kind = 'chat') {
  if (typeof endpointUrl !== 'string' || !endpointUrl.trim()) {
    throw new Error('请填写 API Base URL。');
  }
  const base = endpointUrl.trim().replace(/\/+$/, '').replace(ENDPOINT_SUFFIX, '');
  if (kind === 'models') return `${base}/models`;
  if (kind === 'chat') return `${base}/chat/completions`;
  throw new Error(`Unknown API endpoint kind: ${kind}`);
}

/** Normalize values such as 128000, "128k" and "1M" from model metadata. */
export function parseTokenLimit(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== 'string') return null;
  const match = value.trim().replaceAll(',', '').match(/^(\d+(?:\.\d+)?)\s*([km]?)$/i);
  if (!match) return null;
  const multiplier = match[2].toLowerCase() === 'm' ? 1_000_000 : match[2].toLowerCase() === 'k' ? 1000 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : null;
}

function numericValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : null;
}

function includesImageModality(value) {
  if (!Array.isArray(value)) return null;
  return value.some((item) => {
    const normalized = String(item).toLowerCase();
    return normalized === 'image' || normalized === 'images' || normalized === 'vision';
  });
}

/** Convert the common `/models` response shapes into UI-friendly metadata. */
export function normalizeModel(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id) return null;

  const reasoningEfforts = Array.isArray(item.reasoning_efforts)
    ? [...new Set(item.reasoning_efforts.map((effort) => String(effort).trim()).filter(Boolean))]
    : [];
  const modalities = item.input_modalities ?? item.modalities?.input ?? item.capabilities?.input_modalities;
  const supportsReasoning = booleanValue(item.supports_reasoning)
    ?? booleanValue(item.capabilities?.reasoning)
    ?? (reasoningEfforts.length > 0 || Boolean(item.reasoning_default_effort) ? true : null);
  const supportsVision = booleanValue(item.supports_images)
    ?? booleanValue(item.capabilities?.vision)
    ?? includesImageModality(modalities);
  const temperature = numericValue(
    item.temperature
    ?? item.default_temperature
    ?? item.generation_parameters?.temperature
    ?? item.generation?.temperature,
  );

  return {
    id,
    name: String(item.name || item.display_name || id),
    description: String(item.description || ''),
    contextLength: parseTokenLimit(
      item.context_length
      ?? item.context_window
      ?? item.max_allowed_size
      ?? item.input_token_limit,
    ),
    maxOutputTokens: parseTokenLimit(
      item.max_output_tokens
      ?? item.max_output
      ?? item.max_completion_tokens
      ?? item.output_token_limit,
    ),
    supportsReasoning,
    supportsVision,
    temperature,
    reasoningEfforts,
    reasoningDefaultEffort: String(item.reasoning_default_effort || ''),
  };
}

/** Fetch model IDs and capabilities from an OpenAI-compatible `/models` API. */
export async function fetchModels({ endpointUrl, apiKey, signal } = {}) {
  const url = resolveApiUrl(endpointUrl, 'models');
  const response = await fetch(url, {
    method: 'GET',
    headers: requestHeaders(apiKey),
    signal,
  });

  if (!response.ok) {
    const detail = await readErrorBody(response, apiKey);
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new Error(`获取模型失败（${status}）${detail ? `：${detail}` : ''}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('模型列表不是有效的 JSON 数据。');
  }

  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  const models = entries.map(normalizeModel).filter(Boolean);
  if (!models.length) throw new Error('服务已响应，但没有返回可用的模型列表。');
  return models.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

/**
 * Stream an OpenAI-compatible chat completion and resolve with its full text.
 * Cancellation is owned by the caller through signal. The only retry is a
 * single capability fallback when a provider rejects reasoning_effort.
 * Request headers and configuration are never logged.
 */
export async function streamChatCompletion(options = {}) {
  return diagnosticRequest({ ...options, toolMode: false }, streamCompletion);
}

/** A single model step, not an assistant lifecycle owner. The caller executes
 * validated tool calls and sends message plus tool results into the next step.
 * Tool support is mandatory here; no fallback silently removes tools. */
export async function streamChatToolCompletion(options = {}) {
  return diagnosticRequest({ ...options, toolMode: true }, streamCompletion);
}

async function streamCompletion({
  endpointUrl,
  apiKey,
  model,
  temperature,
  maxTokens,
  messages,
  reasoningEnabled,
  reasoningEffort,
  signal,
  onDelta,
  onReasoning,
  toolMode = false,
  tools = [],
  toolChoice,
  diagnostic,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (onDelta !== undefined && typeof onDelta !== 'function') {
    throw new TypeError('onDelta must be a function.');
  }
  if (onReasoning !== undefined && typeof onReasoning !== 'function') {
    throw new TypeError('onReasoning must be a function.');
  }

  const headers = requestHeaders(apiKey, 'text/event-stream');
  headers['Content-Type'] = 'application/json';
  const body = { model, messages, stream: true };
  if (toolMode) {
    if (!Array.isArray(tools)) throw new TypeError('tools must be an array.');
    if (toolChoice !== undefined && !['auto', 'none', 'required'].includes(toolChoice)
      && !(toolChoice?.type === 'function' && typeof toolChoice.function?.name === 'string')) throw new TypeError('toolChoice is invalid.');
    if (tools.length) body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }

  if (temperature !== undefined && temperature !== null && temperature !== '') {
    body.temperature = temperature;
  }
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') {
    body.max_tokens = maxTokens;
  }
  if (reasoningEnabled === false) {
    body.reasoning_effort = 'none';
  } else if (reasoningEnabled === true && reasoningEffort && reasoningEffort !== 'default') {
    body.reasoning_effort = reasoningEffort;
  }

  const url = resolveApiUrl(endpointUrl, 'chat');
  const wait = pending => toolMode ? awaitWithAbort(pending, signal) : pending;
  signal?.throwIfAborted();
  let response = await wait(fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }));
  if (toolMode) signal?.throwIfAborted();

  if (!response.ok && body.reasoning_effort && [400, 422].includes(response.status)) {
    const detail = await wait(response.text());
    // Some OpenAI-compatible providers reject reasoning_effort although they
    // expose reasoning models. Retry once without the optional capability.
    if ((toolMode ? /reasoning|thinking/i : /reasoning|thinking|参数/i).test(detail)
      && !(toolMode && /\btools?\b|tool_choice|function.call/i.test(detail))) {
      diagnostic.emit('fallback', { reason: 'unsupported-parameter' });
      const fallbackBody = { ...body };
      delete fallbackBody.reasoning_effort;
      if (toolMode) signal?.throwIfAborted();
      response = await wait(fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(fallbackBody),
        signal,
      }));
    } else {
      const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      throw new Error(`LLM request failed (${status})${detail ? `: ${redact(detail, apiKey)}` : ''}`);
    }
  }

  if (!response.ok) {
    const detail = await wait(readErrorBody(response, apiKey));
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new Error(`LLM request failed (${status})${detail ? `: ${detail}` : ''}`);
  }
  if (!response.body) { diagnostic.reason('missing-body'); throw new Error('Streaming response body is unavailable.'); }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = {
    text: '',
    reasoning: '',
    done: false,
    finishReason: null,
    apiKey,
    inThink: false,
    contentBuffer: '',
    diagnostic,
    toolMode,
    signal,
    ...(toolMode ? { toolCalls: new Map(), eventIds: new Map(), rawContent: '', nativeReasoning: '' } : {}),
    onDelta: diagnostic.active || toolMode ? (...args) => {
      if (toolMode) signal?.throwIfAborted();
      diagnostic.first('content'); onDelta?.(...args);
    } : onDelta,
    onReasoning: diagnostic.active || toolMode ? (...args) => {
      if (toolMode) signal?.throwIfAborted();
      diagnostic.first('reasoning'); onReasoning?.(...args);
    } : onReasoning,
  };
  let buffer = '';

  try {
    while (!state.done) {
      const { done, value } = await wait(reader.read());
      if (toolMode) signal?.throwIfAborted();
      if (done) break;
      diagnostic.chunk(value);
      buffer += decoder.decode(value, { stream: true });
      buffer = drainEvents(buffer, state);
    }

    buffer += decoder.decode();
    if (!state.done && buffer) drainEvents(buffer, state, true);
    flushContentBuffer(state);
    if (toolMode) signal?.throwIfAborted();
    if (state.finishReason && state.finishReason !== 'stop' && !(toolMode && state.finishReason === 'tool_calls')) {
      diagnostic.reason('truncated');
      const reason = state.finishReason === 'length'
        ? '已达到模型输出上限，回答未完成。'
        : state.finishReason === 'content_filter'
          ? '模型服务中止了回答。'
          : `模型以 ${state.finishReason} 结束，未返回完整文本回答。`;
      throw new Error(reason);
    }
    if (!state.done && state.finishReason !== 'stop' && !(toolMode && state.finishReason === 'tool_calls')) {
      diagnostic.reason('truncated');
      throw new Error('模型连接已结束，但没有收到完成标记，已保留部分回答。');
    }
    const result = toolMode ? completeToolTurn(state) : state.text;
    if (!toolMode && !state.text.trim()) diagnostic.reason(state.reasoning.trim() ? 'reasoning-only' : 'empty');
    diagnostic.emit('body-completed');
    return result;
  } finally {
    if (toolMode) {
      // Cancellation must not wait for a provider or reader cleanup that may
      // itself stall. Observe cleanup failures without reopening the request.
      try { Promise.resolve(reader.cancel?.()).catch(() => {}); } catch {}
    } else await reader.cancel?.().catch(() => {});
    if (toolMode) { try { reader.releaseLock(); } catch {} }
    else reader.releaseLock();
  }
}

function messageText(content) {
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || '').join('');
  }
  return typeof content === 'string' ? content : '';
}

/** Convert a Chat Completions payload into one raw agent decision. */
export function parseAgentDecisionPayload(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return null;
  const toolCall = Array.isArray(message.tool_calls) ? message.tool_calls[0] : null;
  if (toolCall) {
    const name = toolCall.function?.name || toolCall.name;
    let args = toolCall.function?.arguments ?? toolCall.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch {
        args = {};
      }
    }
    return {
      kind: 'tool',
      name: String(name || ''),
      args: args && typeof args === 'object' ? args : {},
      reason: messageText(message.content),
    };
  }
  if (message.function_call) {
    let args = message.function_call.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch {
        args = {};
      }
    }
    return {
      kind: 'tool',
      name: String(message.function_call.name || ''),
      args: args && typeof args === 'object' ? args : {},
      reason: '',
    };
  }
  const content = messageText(message.content);
  if (content) return { kind: 'content', content, args: {}, name: '', reason: '' };
  return null;
}

/**
 * Request one agent decision. Tools are preferred; providers that reject the
 * tools parameter automatically fall back to the JSON action protocol.
 */
export async function requestAgentDecision(options = {}) {
  return diagnosticRequest(options, agentDecision);
}

async function agentDecision({
  endpointUrl,
  apiKey,
  model,
  temperature,
  maxTokens,
  messages,
  tools = [],
  signal,
  diagnostic,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = resolveApiUrl(endpointUrl, 'chat');
  const headers = requestHeaders(apiKey, 'application/json');
  headers['Content-Type'] = 'application/json';
  const base = {
    model,
    messages,
    stream: false,
  };
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') base.max_tokens = maxTokens;
  if (temperature !== undefined && temperature !== null && temperature !== '') {
    base.temperature = temperature;
  }
  const attempts = tools.length
    ? [{ ...base, tools }, base]
    : [base];
  let lastError = null;
  for (const body of attempts) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) {
      let payload;
      try {
        payload = await diagnostic.json(response);
      } catch {
        throw new Error('模型返回的不是有效 JSON。');
      }
      const decision = parseAgentDecisionPayload(payload);
      if (!decision) { diagnostic.reason('empty'); throw new Error('模型没有返回可执行的浏览动作。'); }
      diagnostic.first('content');
      return decision;
    }
    const detail = await readErrorBody(response, apiKey);
    lastError = new Error(`Agent 决策请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    // Only retry without tools for a request-level rejection; auth/rate
    // limits and server failures must not be retried silently.
    if (!(body.tools && [400, 422].includes(response.status))) break;
    diagnostic.emit('fallback', { reason: 'unsupported-parameter' });
  }
  throw lastError || new Error('Agent 决策请求失败。');
}

/**
 * Produce a short user-facing completion summary for a finished browser task.
 * This is deliberately non-streaming: the task is already done, and the side
 * panel only needs one bounded result to persist into the conversation.
 */
export async function summarizeBrowserTask({
  endpointUrl,
  apiKey,
  model,
  messages,
  signal,
  maxTokens = 700,
} = {}) {
  const url = resolveApiUrl(endpointUrl, 'chat');
  const headers = requestHeaders(apiKey, 'application/json');
  headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0,
      max_tokens: maxTokens,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await readErrorBody(response, apiKey);
    throw new Error(`任务摘要请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  const payload = await response.json();
  const content = messageText(payload?.choices?.[0]?.message?.content);
  if (!content.trim()) throw new Error('模型没有返回任务摘要。');
  return content.trim();
}

/**
 * Ask the active model for short, answer-specific follow-up questions. This
 * is non-streaming and intentionally independent from the main answer request,
 * so a slow suggestion call can time out without delaying the answer.
 */
export async function requestFollowUpSuggestions({
  endpointUrl,
  apiKey,
  model,
  temperature,
  messages,
  signal,
  maxTokens = 420,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = resolveApiUrl(endpointUrl, 'chat');
  const headers = requestHeaders(apiKey, 'application/json');
  headers['Content-Type'] = 'application/json';
  const body = {
    model,
    messages,
    stream: false,
    max_tokens: maxTokens,
  };
  if (temperature !== undefined && temperature !== null && temperature !== '') {
    body.temperature = temperature;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await readErrorBody(response, apiKey);
    throw new Error(`建议问题请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  const payload = await response.json();
  const content = messageText(payload?.choices?.[0]?.message?.content).trim();
  if (!content) throw new Error('模型没有返回建议问题。');
  return content;
}

/** Strip provider thought prefixes without touching literal tags inside JSON. */
export function visibleCompletionText(content) {
  let text = messageText(content).trim();
  while (text.startsWith('<think>')) {
    const end = text.indexOf('</think>', 7);
    if (end < 0) return '';
    text = text.slice(end + 8).trimStart();
  }
  return text.trim();
}

/** One non-streaming text request. Purpose-specific parsing remains with the caller. */
export async function requestTextCompletion(options = {}) {
  return diagnosticRequest(options, textCompletion);
}

async function textCompletion({
  endpointUrl, apiKey, model, messages, temperature, maxTokens, signal,
  fetchImpl = globalThis.fetch, diagnostic,
} = {}) {
  signal?.throwIfAborted();
  const body = { model, messages, stream: false };
  if (temperature !== undefined && temperature !== null && temperature !== '') body.temperature = temperature;
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') body.max_tokens = maxTokens;
  const response = await fetchImpl(resolveApiUrl(endpointUrl, 'chat'), {
    method: 'POST', headers: { ...requestHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  signal?.throwIfAborted();
  if (!response.ok) {
    const detail = await readErrorBody(response, apiKey);
    throw new Error(`模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  const payload = await diagnostic.json(response);
  signal?.throwIfAborted();
  const content = visibleCompletionText(payload?.choices?.[0]?.message?.content);
  const message = payload?.choices?.[0]?.message;
  const hasReasoning = Boolean(message?.reasoning_content || message?.reasoning || messageText(message?.content).trim().startsWith('<think>'));
  if (hasReasoning) diagnostic.first('reasoning');
  if (!content) { diagnostic.reason(hasReasoning ? 'reasoning-only' : 'empty'); throw new Error('模型没有返回可用文本。'); }
  diagnostic.first('content');
  return content;
}
