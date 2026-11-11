import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../src/utils/llm-client.js';

const encoder = new TextEncoder();
const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }];
const event = (delta = {}, finish_reason, id) => `${id ? `id: ${id}\n` : ''}data: ${JSON.stringify({ id: 'same-completion-id', choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] })}\n\n`;
const tool = (index, id, name, args) => ({ index, ...(id ? { id, type: 'function' } : {}), function: { ...(name ? { name } : {}), arguments: args } });
const stream = chunks => new Response(new ReadableStream({ start(controller) {
  for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  controller.close();
} }), { headers: { 'Content-Type': 'text/event-stream' } });
const options = extra => ({ endpointUrl: 'https://model.example/v1', model: 'test', apiKey: 'secret-key',
  messages: [{ role: 'user', content: '查资料' }], tools, ...extra });

test('tool-enabled stream can directly answer and keeps the ordinary string API intact', async () => {
  const chunks = [event({ content: '直接' }), event({ content: '回答' }, 'stop'), 'data: [DONE]\n\n'];
  let body;
  const deltas = [];
  const result = await client.streamChatToolCompletion(options({ toolChoice: 'auto', onDelta: (delta, full) => deltas.push([delta, full]),
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return stream(chunks); } }));
  assert.deepEqual(result, { content: '直接回答', reasoning: '', toolCalls: [], message: { role: 'assistant', content: '直接回答' }, finishReason: 'stop' });
  assert.deepEqual(deltas, [['直接', '直接'], ['回答', '直接回答']]);
  assert.deepEqual(body.tools, tools);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(await client.streamChatCompletion(options({ fetchImpl: async () => stream(chunks) })), '直接回答');
});

test('assembles interleaved tool fragments and preserves provider thinking for continuation', async () => {
  const chunks = [event({ reasoning_content: '先核对' }), event({ reasoning_content: '最新资料', content: '我来查一下。' }),
    event({ tool_calls: [tool(0, 'call-1', 'web_', '{"query":"'), tool(1, 'call-2', 'web_search', '{"query":"二')] }),
    event({ tool_calls: [tool(1, undefined, undefined, '"}'), tool(0, undefined, 'search', '一"}')] }),
    event({}, 'tool_calls'), 'data: [DONE]\n\n'];
  const reasoning = [];
  const bytes = encoder.encode(chunks.join(''));
  const result = await client.streamChatToolCompletion(options({ onReasoning: (_delta, full) => reasoning.push(full),
    fetchImpl: async () => stream([...bytes].map(byte => Uint8Array.of(byte))) }));
  assert.deepEqual(result.toolCalls, [
    { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"一"}' } },
    { id: 'call-2', type: 'function', function: { name: 'web_search', arguments: '{"query":"二"}' } },
  ]);
  assert.equal(result.reasoning, '先核对最新资料');
  assert.equal(result.message.reasoning_content, '先核对最新资料');
  assert.equal(result.message.content, '我来查一下。');
  assert.deepEqual(result.message.tool_calls, result.toolCalls);
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(reasoning, ['先核对', '先核对最新资料']);
});

test('allows complete tools without answer text and an explicit finish reason at EOF', async () => {
  const result = await client.streamChatToolCompletion(options({ fetchImpl: async () => stream([
    event({ tool_calls: [tool(0, 'call-1', 'web_search', '{"query":"q"}')] }, 'tool_calls').trimEnd(),
  ]) }));
  assert.equal(result.content, '');
  assert.equal(result.message.content, null);
  assert.equal(result.toolCalls.length, 1);
});

test('deduplicates SSE event IDs without confusing the common completion ID', async () => {
  const first = event({ tool_calls: [tool(0, 'call-1', 'web_search', '{"query":"')] }, undefined, 'event-1');
  const next = event({ tool_calls: [tool(0, undefined, undefined, 'q"}')] }, undefined, 'event-2');
  const result = await client.streamChatToolCompletion(options({ fetchImpl: async () => stream([first, first, next, next, event({}, 'tool_calls', 'event-3')]) }));
  assert.equal(result.toolCalls[0].function.arguments, '{"query":"q"}');
  await assert.rejects(client.streamChatToolCompletion(options({ fetchImpl: async () => stream([
    event({ content: 'a' }, undefined, 'one'), event({ content: 'b' }, 'stop', 'one'),
  ]) })), /重复|冲突/);
});

test('rejects truncated, empty, malformed and conflicting tool responses', async () => {
  const good = tool(0, 'call-1', 'web_search', '{"query":"q"}');
  const cases = [
    [event({ tool_calls: [good] }), 'data: [DONE]\n\n'],
    [event({ tool_calls: [good] }, 'length'), 'data: [DONE]\n\n'],
    [event({ tool_calls: [good] }, 'stop')],
    [event({}, 'tool_calls')],
    [event({ tool_calls: [tool(0, 'call-1', 'web_search', '{')] }, 'tool_calls')],
    [event({ tool_calls: [tool(0, 'call-1', 'web_search', 'null')] }, 'tool_calls')],
    [event({ tool_calls: [tool(0, 'call-1', 'web_search', '{}'), tool(1, 'call-1', 'web_search', '{}')] }, 'tool_calls')],
    [event({ tool_calls: [tool(0, 'call-1', 'web_search', '{')] }), event({ tool_calls: [tool(0, 'other-call', undefined, '}')] }, 'tool_calls')],
    [event({ tool_calls: [tool(-1, 'call-1', 'web_search', '{}')] }, 'tool_calls')],
    [event({ tool_calls: [tool(0, 'call-1', 'web_search', ' '.repeat(8200) + '{}')] }, 'tool_calls')],
    [event({ tool_calls: [good] }, 'tool_calls'), event({ content: 'late' }, 'stop')],
  ];
  for (const chunks of cases) await assert.rejects(client.streamChatToolCompletion(options({ fetchImpl: async () => stream(chunks) })));
});

test('empty and reasoning-only final responses remain failures', async () => {
  for (const delta of [{}, { reasoning_content: 'still thinking' }, { content: '<think>only thinking</think>' }]) {
    await assert.rejects(client.streamChatToolCompletion(options({ fetchImpl: async () => stream([event(delta, 'stop')]) })), /空|思考/);
  }
});

test('does not remove tools or retry unsupported tool requests', async () => {
  let count = 0;
  await assert.rejects(client.streamChatToolCompletion(options({ reasoningEnabled: true, reasoningEffort: 'high',
    fetchImpl: async () => { count++; return new Response('tools 参数不支持', { status: 400 }); } })), /400/);
  assert.equal(count, 1);
});

test('reasoning parameter fallback keeps tools and tool choice intact', async () => {
  const bodies = [];
  const result = await client.streamChatToolCompletion(options({ reasoningEnabled: true, reasoningEffort: 'high', toolChoice: 'auto',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1
      ? new Response('unsupported reasoning_effort', { status: 400 })
      : stream([event({ content: 'ok' }, 'stop')]); } }));
  assert.equal(result.content, 'ok');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].tools, tools);
  assert.equal(bodies[1].tool_choice, 'auto');
  assert.equal('reasoning_effort' in bodies[1], false);
});

test('stream errors preserve partial output, redact secrets, and never replay', async () => {
  let count = 0;
  const deltas = [];
  await assert.rejects(client.streamChatToolCompletion(options({ onDelta: delta => deltas.push(delta), fetchImpl: async () => {
    count++; return stream([event({ content: 'partial' }), 'data: {"error":{"message":"secret-key rejected"}}\n\n']);
  } })), error => /流式响应失败/.test(error.message) && !error.message.includes('secret-key'));
  assert.deepEqual(deltas, ['partial']);
  assert.equal(count, 1);
});

test('stop releases a stalled tool stream even when the reader ignores abort', async () => {
  const stop = new AbortController();
  let cancelled = false;
  const pending = client.streamChatToolCompletion(options({ signal: stop.signal, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(event({ reasoning_content: 'thinking' }))); },
    cancel() { cancelled = true; },
  })) }));
  await new Promise(resolve => setImmediate(resolve));
  stop.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('stop during a callback prevents later events from the same network chunk', async () => {
  const stop = new AbortController();
  const seen = [];
  await assert.rejects(client.streamChatToolCompletion(options({ signal: stop.signal, onDelta: delta => {
    seen.push(delta); stop.abort(new DOMException('stopped', 'AbortError'));
  }, fetchImpl: async () => stream([event({ content: 'first' }) + event({ content: 'late' }, 'stop')]) })), { name: 'AbortError' });
  assert.deepEqual(seen, ['first']);
});
