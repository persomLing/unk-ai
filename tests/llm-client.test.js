import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchModels,
  normalizeModel,
  parseTokenLimit,
  probeResearchCapabilities,
  requestGatewayWebFetch,
  requestGatewayWebSearch,
  researchApiUrl,
  resolveApiUrl,
  streamChatCompletion,
} from '../src/utils/llm-client.js';

const encoder = new TextEncoder();

test('transport diagnostics describe controlled SSE progress without exposing payloads', async () => {
  const events = [];
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const pending = streamChatCompletion(requestOptions({ onDiagnostic: event => events.push(event),
    fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream; private=SECRET_HEADER' } }) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.type === 'transport.headers' && event.status === 200 && event.contentType === 'text/event-stream'));
  controller.enqueue(encoder.encode(': heartbeat\n\n'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.find(event => event.type === 'transport.first-byte')?.chunkCount, 1);
  assert.equal(events.find(event => event.type === 'transport.first-byte')?.eventCount, 0);
  controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"PRIVATE_THOUGHT"}}]}\n\n'));
  controller.enqueue(encoder.encode(`${completion('PRIVATE_ANSWER')}\n\ndata: [DONE]\n\n`));
  controller.close();
  assert.equal(await pending, 'PRIVATE_ANSWER');
  const finished = events.find(event => event.type === 'transport.completed');
  assert.equal(finished.chunkCount, 3);
  assert.equal(finished.eventCount, 3);
  assert.ok(finished.byteCount > 0);
  assert.ok(finished.firstByteMs >= 0);
  assert.ok(finished.durationMs >= finished.firstByteMs);
  for (const type of ['first-byte', 'first-reasoning', 'first-content']) {
    assert.equal(events.filter(event => event.type === `transport.${type}`).length, 1);
  }
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|SECRET_HEADER|test-secret|llm\.example|Hello|Authorization/);
});

test('diagnostics distinguish existing empty, reasoning-only and failed stream outcomes', async () => {
  const cases = [
    { chunks: ['data: [DONE]\n\n'], result: '', reason: 'empty' },
    { chunks: ['data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\ndata: [DONE]\n\n'], result: '', reason: 'reasoning-only' },
    { chunks: [completion('partial')], error: /完成标记/, reason: 'truncated' },
    { chunks: ['data: broken JSON\n\n'], error: /Invalid JSON/, reason: 'malformed' },
    { chunks: ['data: {"error":{"message":"PRIVATE_PROVIDER_DETAIL"}}\n\n'], error: /流式响应失败/, reason: 'error-event' },
  ];
  for (const fixture of cases) {
    const events = [];
    const pending = streamChatCompletion(requestOptions({ onDiagnostic: event => events.push(event), fetchImpl: async () => streamingResponse(fixture.chunks) }));
    if (fixture.error) await assert.rejects(pending, fixture.error);
    else assert.equal(await pending, fixture.result);
    const terminal = events.filter(event => ['transport.completed', 'transport.failed', 'transport.cancelled'].includes(event.type));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].reason, fixture.reason);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_PROVIDER_DETAIL|thought|partial/);
  }
});

test('diagnostics preserve HTTP failures and the single unsupported-parameter fallback', async () => {
  const events = [];
  let calls = 0;
  await assert.rejects(streamChatCompletion(requestOptions({ onDiagnostic: event => events.push(event),
    fetchImpl: async () => { calls++; return new Response('PRIVATE_HTTP_DETAIL', { status: 429 }); } })), /429/);
  assert.equal(calls, 1);
  assert.equal(events.find(event => event.type === 'transport.failed')?.reason, 'rate-limit');
  assert.equal(events.find(event => event.type === 'transport.failed')?.status, 429);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_HTTP_DETAIL/);
  const fallback = [];
  calls = 0;
  const result = await streamChatCompletion(requestOptions({ reasoningEnabled: true, reasoningEffort: 'high',
    onDiagnostic: event => fallback.push(event), fetchImpl: async () => ++calls === 1
      ? new Response('reasoning unsupported PRIVATE_DETAIL', { status: 400 })
      : streamingResponse([`${completion('answer')}\n\ndata: [DONE]\n\n`]) }));
  assert.equal(result, 'answer');
  assert.equal(calls, 2);
  assert.equal(fallback.find(event => event.type === 'transport.fallback')?.reason, 'unsupported-parameter');
  assert.deepEqual(fallback.filter(event => event.type === 'transport.headers').map(event => event.status), [400, 200]);
});

test('diagnostic observers may throw or reject without interrupting stream callbacks', async () => {
  for (const onDiagnostic of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    const deltas = [];
    assert.equal(await streamChatCompletion(requestOptions({ onDiagnostic, onDelta: value => deltas.push(value),
      fetchImpl: async () => streamingResponse([`${completion('answer')}\n\ndata: [DONE]\n\n`]) })), 'answer');
    assert.deepEqual(deltas, ['answer']);
  }
});

test('aborted streams emit one cancellation and no successful diagnostic outcome', async () => {
  const events = [];
  const stop = new AbortController();
  const pending = streamChatCompletion(requestOptions({ signal: stop.signal, onDiagnostic: event => events.push(event),
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      stop.signal.addEventListener('abort', () => controller.error(stop.signal.reason), { once: true });
    } })) }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  stop.abort();
  await rejected;
  assert.equal(events.filter(event => event.type === 'transport.cancelled').length, 1);
  assert.equal(events.some(event => event.type === 'transport.completed'), false);
});

test('one-byte stream diagnostics are bounded while final counts remain exact', async () => {
  const events = [];
  const bytes = encoder.encode(`${completion('content')}\n\ndata: [DONE]\n\n`);
  const chunks = [...bytes].map(byte => Uint8Array.of(byte));
  assert.equal(await streamChatCompletion(requestOptions({ onDiagnostic: event => events.push(event),
    fetchImpl: async () => streamingResponse(chunks) })), 'content');
  const result = events.find(event => event.type === 'transport.completed');
  assert.equal(result.chunkCount, bytes.length);
  assert.equal(result.byteCount, bytes.length);
  assert.equal(result.eventCount, 2);
  assert.ok(events.filter(event => event.type === 'transport.progress').length < 10);
});

function streamingResponse(chunks, { status = 200, statusText = '' } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  return new Response(stream, { status, statusText });
}

function completion(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

function requestOptions(overrides = {}) {
  return {
    endpointUrl: 'https://llm.example/chat/completions',
    apiKey: 'test-secret',
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

test('sends the expected request and returns ordered deltas', async (t) => {
  const events = [
    ': connected\r\n\r\n',
    'event: message\r\n',
    'data: {"choices":[{"delta":{"reasoning_content":"private",',
    '"content":"Hello"}}]}\r\n',
    '\r\ndata: {"choices":[',
    '{"delta":{"content":""}}]}\n\n',
    `${completion(' world')}\n\n`,
    'data: [DONE]\n\n',
  ];
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url, options };
    return streamingResponse(events);
  });
  const deltas = [];
  const reasoningDeltas = [];

  const result = await streamChatCompletion(requestOptions({
    temperature: 0,
    maxTokens: 512,
    onDelta: (delta, fullText) => deltas.push([delta, fullText]),
    onReasoning: (delta, full) => reasoningDeltas.push([delta, full]),
  }));

  assert.equal(result, 'Hello world');
  assert.deepEqual(deltas, [['Hello', 'Hello'], [' world', 'Hello world']]);
  assert.deepEqual(reasoningDeltas, [['private', 'private']]);
  assert.equal(captured.url, requestOptions().endpointUrl);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(captured.options.body), {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
    temperature: 0,
    max_tokens: 512,
  });
});

test('handles lone CR delimiters, split CRLF, multiline data and tail without newline', async (t) => {
  const payload = JSON.stringify({ choices: [{ delta: { content: 'tail' } }] });
  const chunks = [
    `${completion('a')}\r`,
    `\r${completion('b')}\r`,
    '\r',
    'data: {"choices":[{"delta":{\n',
    'data: "content":"multiline"}}]}\r\r',
    'data: [DONE]',
  ];
  t.mock.method(globalThis, 'fetch', async () => streamingResponse(chunks));

  const deltas = [];
  const result = await streamChatCompletion(requestOptions({ onDelta: (delta) => deltas.push(delta) }));
  assert.equal(result, 'abmultiline');
  assert.deepEqual(deltas, ['a', 'b', 'multiline']);
});

test('accepts an unterminated final event with an explicit finish reason', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamingResponse([
    'data: {"choices":[{"delta":{"content":"without a terminator"},"finish_reason":"stop"}]}',
  ]));
  assert.equal(await streamChatCompletion(requestOptions()), 'without a terminator');
});

test('preserves partial text but rejects EOF without any completion marker', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamingResponse([completion('partial')]));
  const deltas = [];
  await assert.rejects(streamChatCompletion(requestOptions({ onDelta: (text) => deltas.push(text) })), /没有收到完成标记/);
  assert.deepEqual(deltas, ['partial']);
});

test('surfaces an SSE error after partial content without exposing credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamingResponse([
    `${completion('partial')}\n\n`,
    'data: {"error":{"message":"upstream rejected test-secret"}}\n\n',
  ]));
  const deltas = [];
  await assert.rejects(streamChatCompletion(requestOptions({ onDelta: (text) => deltas.push(text) })), (error) => {
    assert.match(error.message, /模型流式响应失败/);
    assert.equal(error.message.includes('test-secret'), false);
    return true;
  });
  assert.deepEqual(deltas, ['partial']);
});

test('does not mark an output-limit truncation as a complete answer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamingResponse([
    `${completion('partial')}\n\n`,
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
  ]));
  await assert.rejects(streamChatCompletion(requestOptions()), /输出上限/);
});

test('parses <think> tags in content stream and routes to onReasoning without leaking into text', async (t) => {
  const chunks = [
    `${completion('<think>analyzing ')}\n\n`,
    `${completion('the user request</think>The answer is 42')}\n\n`,
    'data: [DONE]\n\n',
  ];
  t.mock.method(globalThis, 'fetch', async () => streamingResponse(chunks));

  const textDeltas = [];
  const reasoningDeltas = [];
  const result = await streamChatCompletion(requestOptions({
    onDelta: (delta) => textDeltas.push(delta),
    onReasoning: (delta) => reasoningDeltas.push(delta),
  }));

  assert.equal(result, 'The answer is 42');
  assert.deepEqual(textDeltas, ['The answer is 42']);
  assert.deepEqual(reasoningDeltas, ['analyzing ', 'the user request']);
});

test('handles split <think> and </think> tags spanning across separate chunks', async (t) => {
  const chunks = [
    `${completion('Prefix <th')}\n\n`,
    `${completion('ink>step 1</th')}\n\n`,
    `${completion('ink>Suffix')}\n\n`,
    'data: [DONE]\n\n',
  ];
  t.mock.method(globalThis, 'fetch', async () => streamingResponse(chunks));

  const textDeltas = [];
  const reasoningDeltas = [];
  const result = await streamChatCompletion(requestOptions({
    onDelta: (delta) => textDeltas.push(delta),
    onReasoning: (delta) => reasoningDeltas.push(delta),
  }));

  assert.equal(result, 'Prefix Suffix');
  assert.deepEqual(reasoningDeltas, ['step 1']);
  assert.deepEqual(textDeltas, ['Prefix ', 'Suffix']);
});

test('decodes UTF-8 characters split between network chunks', async (t) => {
  const bytes = encoder.encode(`${completion('你好🌍')}\n\ndata: [DONE]\n\n`);
  const chunks = [];
  for (const byte of bytes) chunks.push(Uint8Array.of(byte));
  t.mock.method(globalThis, 'fetch', async () => streamingResponse(chunks));
  assert.equal(await streamChatCompletion(requestOptions()), '你好🌍');
});

test('stops consuming after DONE, including a tail DONE', async (t) => {
  let reads = 0;
  let released = false;
  const body = {
    getReader() {
      return {
        async read() {
          reads += 1;
          if (reads === 1) return { done: false, value: encoder.encode(`${completion('first')}\n\ndata: [DONE]\n\n${completion('late')}`) };
          throw new Error('Reader must not be consumed after DONE');
        },
        releaseLock() { released = true; },
      };
    },
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, body }));

  assert.equal(await streamChatCompletion(requestOptions()), 'first');
  assert.equal(reads, 1);
  assert.equal(released, true);
});

test('omits empty optional settings and Authorization for local providers', async (t) => {
  let options;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    options = init;
    return streamingResponse(['data: [DONE]\n\n']);
  });
  await streamChatCompletion(requestOptions({ apiKey: ' ', temperature: '', maxTokens: null }));

  assert.equal('Authorization' in options.headers, false);
  assert.deepEqual(JSON.parse(options.body), {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  });
});

test('reports bounded HTTP error details without exposing the API key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`secret-key ${'x'.repeat(2000)}`, {
    status: 401,
    statusText: 'Unauthorized',
  }));

  await assert.rejects(streamChatCompletion(requestOptions({ apiKey: 'secret-key' })), (error) => {
    assert.match(error.message, /401 Unauthorized/);
    assert.equal(error.message.includes('secret-key'), false);
    assert.ok(error.message.length < 1100);
    return true;
  });
});

test('propagates abort and does not retry or emit later deltas', async (t) => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls += 1;
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(encoder.encode(`${completion('partial')}\n\n`));
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      },
    });
    return new Response(body);
  });
  const deltas = [];
  const pending = streamChatCompletion(requestOptions({
    signal: controller.signal,
    onDelta: (delta) => deltas.push(delta),
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reason = new DOMException('Stopped', 'AbortError');
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['partial']);
});

test('rejects malformed event data and always releases its reader', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamingResponse(['data: not-json\n\n']));
  await assert.rejects(streamChatCompletion(requestOptions()), /Invalid JSON in streaming response/);
});

test('accepts a base URL and resolves both compatible API endpoints', () => {
  assert.equal(resolveApiUrl('http://localhost:7864/v1', 'models'), 'http://localhost:7864/v1/models');
  assert.equal(resolveApiUrl('http://localhost:7864/v1', 'chat'), 'http://localhost:7864/v1/chat/completions');
  assert.equal(resolveApiUrl('https://api.example.com/v1/chat/completions', 'models'), 'https://api.example.com/v1/models');
  assert.equal(resolveApiUrl('https://api.example.com/v1/models/', 'chat'), 'https://api.example.com/v1/chat/completions');
});

test('uses resolved chat endpoint and forwards reasoning controls', async (t) => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url, options };
    return streamingResponse(['data: [DONE]\n\n']);
  });
  await streamChatCompletion(requestOptions({
    endpointUrl: 'http://localhost:7864/v1',
    reasoningEnabled: true,
    reasoningEffort: 'high',
  }));
  assert.equal(captured.url, 'http://localhost:7864/v1/chat/completions');
  assert.equal(JSON.parse(captured.options.body).reasoning_effort, 'high');

  await streamChatCompletion(requestOptions({
    endpointUrl: 'http://localhost:7864/v1',
    reasoningEnabled: false,
    reasoningEffort: 'high',
  }));
  assert.equal(JSON.parse(captured.options.body).reasoning_effort, 'none');
});

test('parses token limits and model capabilities from common metadata', () => {
  assert.equal(parseTokenLimit(128000), 128000);
  assert.equal(parseTokenLimit('128k'), 128000);
  assert.equal(parseTokenLimit('1M'), 1000000);
  assert.equal(parseTokenLimit('garbage'), null);

  const model = normalizeModel({
    id: 'cn:demo',
    name: 'Demo',
    context_length: 192000,
    max_output_tokens: 64000,
    supports_reasoning: true,
    supports_images: true,
    temperature: 0.6,
    reasoning_efforts: ['low', 'high'],
    reasoning_default_effort: 'high',
  });
  assert.deepEqual(model, {
    id: 'cn:demo',
    name: 'Demo',
    description: '',
    contextLength: 192000,
    maxOutputTokens: 64000,
    supportsReasoning: true,
    supportsVision: true,
    temperature: 0.6,
    reasoningEfforts: ['low', 'high'],
    reasoningDefaultEffort: 'high',
  });
  assert.equal(normalizeModel({ id: 'external', context_window: '1M', max_output: '128k' }).maxOutputTokens, 128000);
  assert.equal(normalizeModel({ id: 'external', context_window: '1M', max_output: '128k' }).temperature, null);
  assert.equal(normalizeModel({ id: 'nested', generation_parameters: { temperature: '0.4' } }).temperature, 0.4);
  assert.equal(normalizeModel({ id: 'invalid', temperature: 3 }).temperature, null);
});

test('fetches model metadata and redacts failed /models responses', async (t) => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      data: [
        { id: 'small', name: 'Small' },
        { id: 'vision', name: 'Vision', supports_images: true, supports_reasoning: true },
        { name: 'Missing ID' },
      ],
    }), { status: 200 });
  });
  const models = await fetchModels({ endpointUrl: 'http://localhost:7864/v1', apiKey: 'secret' });
  assert.equal(captured.url, 'http://localhost:7864/v1/models');
  assert.equal(captured.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(models.map((model) => model.id), ['small', 'vision']);

  t.mock.method(globalThis, 'fetch', async () => new Response('bad secret-key', { status: 401 }));
  await assert.rejects(fetchModels({ endpointUrl: 'http://localhost:7864/v1', apiKey: 'secret-key' }), (error) => {
    assert.match(error.message, /获取模型失败（401）/);
    assert.equal(error.message.includes('secret-key'), false);
    return true;
  });
});

test('supports DeepSeek tools/search schema and editable paths', async (t) => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return Response.json({
      results: [{
        rerank_score: 1.8,
        title: 'DeepSeek docs',
        url: 'https://api-docs.deepseek.com/',
        snippet: 'short',
        summary: 'long summary',
        content: '',
        site_name: 'DeepSeek',
        site_icon: 'https://api-docs.deepseek.com/favicon.ico',
        date: '2026-11-03T00:00:00Z',
        authority: 4,
      }],
    });
  });
  const result = await requestGatewayWebSearch({
    endpointUrl: 'https://api.deepseek.com/v1',
    apiKey: 'secret',
    endpointName: 'tools/search',
    query: 'DeepSeek',
    maxResults: 3,
  });
  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(captured.body.query, 'DeepSeek');
  assert.equal(captured.body.count, 3);
  assert.equal(captured.body.need_content, false);
  assert.equal(result.results[0].snippet, 'long summary');
  assert.equal(result.results[0].site, 'DeepSeek');
  assert.equal(result.results[0].publishedAt, '2026-11-03T00:00:00Z');
});

test('supports DeepSeek tools/fetch and builds escaped editable capability URLs', async (t) => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return Response.json({ title: 'Example', content: '# Readable\n\n' + 'body '.repeat(40) });
  });
  const result = await requestGatewayWebFetch({
    endpointUrl: 'https://api.deepseek.com/v1',
    apiKey: 'secret',
    endpointName: 'tools/fetch',
    url: 'https://example.com/page',
  });
  assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(captured.body.url, 'https://example.com/page');
  assert.equal(result.title, 'Example');
  assert.match(result.content, /# Readable/);
  assert.equal(researchApiUrl('https://api.deepseek.com/v1', '/tools/search/'), 'https://api.deepseek.com/v1/tools/search');
});

test('capability probing discovers common names and rejects false-positive OPTIONS support', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/tools/search')) {
      return Response.json({ results: [{ title: 'One', url: 'https://one.test', snippet: 'result' }] });
    }
    if (url.endsWith('/tools/fetch')) return Response.json({ title: 'Example', content: 'readable body '.repeat(10) });
    return new Response('not found', { status: 404 });
  });
  const result = await probeResearchCapabilities({
    endpointUrl: 'https://api.deepseek.com/v1',
    apiKey: 'secret',
    webSearchEndpoint: 'web_search',
    webFetchEndpoint: 'web_fetch',
  });
  assert.equal(result.search.supported, true);
  assert.equal(result.search.endpointName, 'tools/search');
  assert.equal(result.fetch.supported, true);
  assert.equal(result.fetch.endpointName, 'tools/fetch');
  assert.ok(calls.every(call => call.method === 'POST'));
  assert.ok(calls.some(call => call.url.endsWith('/web_search')));
  assert.ok(calls.some(call => call.url.endsWith('/tools/search')));
});

test('capability probing reports missing endpoints without claiming support', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
  const result = await probeResearchCapabilities({
    endpointUrl: 'https://relay.test/v1', webSearchEndpoint: 'custom/search', webFetchEndpoint: 'custom/fetch',
  });
  assert.equal(result.search.supported, false);
  assert.equal(result.fetch.supported, false);
  assert.equal(result.search.tried[0].endpointName, 'custom/search');
  assert.ok(result.search.tried.length > 1);
  assert.match(result.search.message, /404/);
});
test('retries once without reasoning_effort when a provider rejects it', async (t) => {
  let calls = 0;
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls += 1;
    bodies.push(JSON.parse(options.body));
    if (calls === 1) return new Response('unknown parameter reasoning_effort', { status: 400 });
    return streamingResponse([`${completion('ok')}\n\ndata: [DONE]\n\n`]);
  });

  const result = await streamChatCompletion(requestOptions({ reasoningEnabled: true, reasoningEffort: 'high' }));
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal('reasoning_effort' in bodies[1], false);
});

test('does not retry unrelated 400 errors', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('invalid model id', { status: 400 });
  });
  await assert.rejects(streamChatCompletion(requestOptions({ reasoningEnabled: true, reasoningEffort: 'high' })), /400/);
  assert.equal(calls, 1);
});
