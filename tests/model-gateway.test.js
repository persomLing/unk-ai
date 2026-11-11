import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelGateway, createModelTransport } from '../src/app/model-gateway.js';
import { visibleCompletionText } from '../src/utils/llm-client.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const messages = () => [{ role: 'user', content: 'Question' }];
const profile = () => ({ endpointUrl: 'https://model.test/v1', apiKey: 'private-key', model: 'model-a',
  contextLength: 64000, maxTokens: 3000, temperature: 0.6, reasoningEnabled: true, reasoningEffort: 'high', supportsVision: true });

test('diagnostic ownership is a frozen metadata snapshot and never enters model requests', async () => {
  const events = [];
  let transportInput;
  const diagnosticContext = { conversationId: 'conversation-a', turnId: 'turn-a', content: 'PRIVATE_CONTENT', apiKey: 'PRIVATE_KEY' };
  const run = createModelGateway({ onEvent: event => events.push(event), transport: input => { transportInput = input; return '[]'; } })
    .createRun({ runId: 'suggestions', profile: profile(), diagnosticContext });
  diagnosticContext.conversationId = 'conversation-b';
  diagnosticContext.turnId = 'turn-b';
  assert.equal(await run.request({ requestId: 'suggestions', purpose: 'suggestions', messages: messages() }), '[]');
  assert.ok(events.every(event => event.conversationId === 'conversation-a' && event.turnId === 'turn-a'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|conversation-b|turn-b/);
  assert.doesNotMatch(JSON.stringify(transportInput.request), /conversation-a|turn-a|PRIVATE_/);
  run.dispose();
});

test('global and run diagnostics both observe bounded transport metadata', async () => {
  const globalEvents = []; const runEvents = [];
  const run = createModelGateway({ onEvent: event => globalEvents.push(event), transport: createModelTransport({
    fetchImpl: async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"PRIVATE_THOUGHT","content":"PRIVATE_ANSWER"}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }),
  }) }).createRun({ runId: 'run', profile: profile(), onEvent: event => runEvents.push(event) });
  assert.equal(await run.request({ requestId: 'answer', purpose: 'answer', messages: messages() }), 'PRIVATE_ANSWER');
  assert.deepEqual(globalEvents, runEvents);
  for (const type of ['model.request.started', 'model.transport.headers', 'model.transport.first-byte',
    'model.transport.first-reasoning', 'model.transport.first-content', 'model.request.completed']) {
    assert.equal(globalEvents.filter(event => event.type === type).length, 1, type);
  }
  const completed = globalEvents.find(event => event.type === 'model.request.completed');
  assert.equal(completed.eventCount, 2);
  assert.ok(completed.firstByteMs >= 0);
  assert.doesNotMatch(JSON.stringify(globalEvents), /PRIVATE_|private-key|model\.test|Question/);
  run.dispose();
});

test('global and run observers reject safely and custom diagnostics are filtered', async () => {
  const events = [];
  const run = createModelGateway({ onEvent: async event => { events.push(event); throw new Error('observer'); },
    transport: input => {
      input.onDiagnostic({ type: 'transport.headers', status: 200, contentType: 'application/json',
        body: 'PRIVATE_BODY', url: 'https://private.test', reason: 'PRIVATE_REASON' });
      input.onDiagnostic({ type: 'PRIVATE_EVENT', status: 200 });
      input.onDelta('answer', 'answer');
      return 'answer';
    } }).createRun({ runId: 'run', profile: profile(), onEvent: async () => { throw new Error('run observer'); } });
  assert.equal(await run.request({ requestId: 'answer', purpose: 'answer', messages: messages() }), 'answer');
  assert.ok(events.some(event => event.type === 'model.transport.headers'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|private\.test/);
  run.dispose();
});

test('non-streaming decisions report headers and body completion without inventing first-byte timing', async () => {
  const events = [];
  const run = createModelGateway({ onEvent: event => events.push(event), transport: createModelTransport({
    fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"search":false}' } }] }),
  }) }).createRun({ runId: 'run', profile: profile() });
  assert.equal(await run.request({ requestId: 'research-decision', purpose: 'research-decision', messages: messages() }), '{"search":false}');
  assert.ok(events.some(event => event.type === 'model.transport.headers'));
  assert.ok(events.some(event => event.type === 'model.transport.body-completed'));
  assert.equal(events.some(event => event.type === 'model.transport.first-byte'), false);
  run.dispose();
});

test('reasoning carried beside an empty content callback is not a first content event', async () => {
  const events = [];
  const run = createModelGateway({ onEvent: event => events.push(event), transport: input => {
    input.onReasoning('thought', 'thought');
    input.onDelta('', '', 'thought');
    return '';
  } }).createRun({ runId: 'run', profile: profile() });
  assert.equal(await run.request({ requestId: 'answer', purpose: 'answer', messages: messages() }), '');
  assert.equal(events.filter(event => event.type === 'model.transport.first-reasoning').length, 1);
  assert.equal(events.some(event => event.type === 'model.transport.first-content'), false);
  run.dispose();
});

function fakeClock() {
  let current = 1000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout: (callback, delay) => { timers.set(++nextId, { callback, at: current + delay }); return nextId; },
    clearTimeout: id => timers.delete(id),
    advance(ms, { fire = true } = {}) {
      current += ms;
      if (!fire) return;
      for (const [id, timer] of [...timers]) if (timer.at <= current) { timers.delete(id); timer.callback(); }
    },
    timers,
  };
}

test('run configuration and request input are frozen snapshots and safe metadata omits credentials', async () => {
  const config = profile();
  const prompt = messages();
  let captured;
  const run = createModelGateway({ transport: input => { captured = input; return 'Answer'; } })
    .createRun({ runId: 'run-a', profile: config });
  config.apiKey = 'replaced-key'; config.model = 'model-b'; config.maxTokens = 99;
  const pending = run.request({ requestId: 'answer', purpose: 'answer', messages: prompt });
  prompt[0].content = 'Changed later';
  assert.equal(await pending, 'Answer');
  assert.equal(captured.profile.model, 'model-a');
  assert.equal(captured.profile.apiKey, 'private-key');
  assert.equal(captured.request.messages[0].content, 'Question');
  assert.equal(captured.request.maxTokens, 3000);
  assert.ok(Object.isFrozen(captured.profile));
  assert.ok(Object.isFrozen(captured.request.messages[0]));
  assert.equal('profile' in run, false);
  assert.equal('apiKey' in run.modelInfo, false);
  assert.equal('endpointUrl' in run.modelInfo, false);
  assert.equal(run.modelInfo.contextLength, 64000);
  run.dispose();
});

test('duplicate requests use one transport call and only the original stream subscriber', async () => {
  const waiting = deferred();
  let transportInput;
  let calls = 0;
  const firstDeltas = []; const secondDeltas = [];
  const run = createModelGateway({ transport: input => { calls += 1; transportInput = input; return waiting.promise; } })
    .createRun({ runId: 'run', profile: profile() });
  const options = { requestId: 'answer', purpose: 'answer', messages: messages() };
  const first = run.request({ ...options, onDelta: text => firstDeltas.push(text) });
  const second = run.request({ ...options, signal: new AbortController().signal, onDelta: text => secondDeltas.push(text) });
  assert.equal(first, second);
  await Promise.resolve();
  transportInput.onDelta('Part', 'Part', '');
  waiting.resolve('Part');
  assert.equal(await first, 'Part');
  assert.equal(calls, 1);
  assert.deepEqual(firstDeltas, ['Part']);
  assert.deepEqual(secondDeltas, []);
  assert.equal(run.request(options), first);
  await assert.rejects(run.request({ ...options, messages: [{ role: 'user', content: 'Different' }] }), { code: 'ERR_MODEL_REQUEST_ID_REUSED' });
  run.dispose();
});

test('cancelling a request rejects immediately and discards late deltas, reasoning and completion', async () => {
  const waiting = deferred();
  let captured;
  const deltas = []; const reasoning = []; const events = [];
  const stop = new AbortController();
  const run = createModelGateway({ transport: input => { captured = input; return waiting.promise; } })
    .createRun({ runId: 'run', profile: profile(), onEvent: event => events.push(event) });
  const pending = run.request({ requestId: 'answer', purpose: 'answer', messages: messages(), signal: stop.signal,
    onDelta: text => deltas.push(text), onReasoning: text => reasoning.push(text) });
  const rejected = assert.rejects(pending, { name: 'AbortError', code: 'ERR_MODEL_CANCELLED' });
  await Promise.resolve();
  captured.onDelta('Before', 'Before');
  stop.abort(new Error('User stopped'));
  await rejected;
  captured.onDelta('Late', 'BeforeLate');
  captured.onReasoning('Late thought', 'Late thought');
  captured.onDiagnostic({ type: 'transport.headers', status: 299 });
  waiting.resolve('Late result');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(captured.signal.aborted, true);
  assert.deepEqual(deltas, ['Before']);
  assert.deepEqual(reasoning, []);
  assert.deepEqual(events.map(event => event.type), ['model.request.started', 'model.transport.first-content', 'model.request.cancelled']);
  run.dispose();
});

test('an already cancelled run or request never starts a transport', async () => {
  let calls = 0;
  const gateway = createModelGateway({ transport: () => { calls += 1; return 'bad'; } });
  const stop = new AbortController(); stop.abort();
  const run = gateway.createRun({ runId: 'run', profile: profile() });
  await assert.rejects(run.request({ requestId: 'request', purpose: 'answer', messages: messages(), signal: stop.signal }), { name: 'AbortError' });
  run.cancel();
  await assert.rejects(run.request({ requestId: 'new-request', purpose: 'answer', messages: messages() }), { name: 'AbortError' });
  const cancelled = gateway.createRun({ runId: 'cancelled', profile: profile(), signal: stop.signal });
  await assert.rejects(cancelled.request({ requestId: 'answer', purpose: 'answer', messages: messages() }), { name: 'AbortError' });
  assert.equal(calls, 0);
  cancelled.dispose();
});

test('a deadline bounds a non-cooperating transport and the run deadline caps a request timeout', async () => {
  const clock = fakeClock();
  const waiting = deferred();
  let captured;
  const run = createModelGateway({ clock, transport: input => { captured = input; return waiting.promise; } })
    .createRun({ runId: 'run', profile: profile(), deadlineAt: clock.now() + 20 });
  const pending = run.request({ requestId: 'answer', purpose: 'answer', messages: messages(), timeoutMs: 1000 });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await Promise.resolve();
  clock.advance(20);
  await rejected;
  assert.equal(captured.signal.aborted, true);
  assert.equal(clock.timers.size, 0);
  waiting.resolve('Late');
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(run.request({ requestId: 'later', purpose: 'suggestions', messages: messages() }), { name: 'TimeoutError' });
  run.dispose();
});

test('deadline checks reject late callbacks even when the timer itself has not fired', async () => {
  const clock = fakeClock();
  const waiting = deferred();
  let captured;
  const deltas = [];
  const run = createModelGateway({ clock, transport: input => { captured = input; return waiting.promise; } })
    .createRun({ runId: 'run', profile: profile() });
  const pending = run.request({ requestId: 'answer', purpose: 'answer', messages: messages(), timeoutMs: 10, onDelta: text => deltas.push(text) });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await Promise.resolve();
  clock.advance(11, { fire: false });
  captured.onDelta('Too late', 'Too late');
  await rejected;
  assert.deepEqual(deltas, []);
  waiting.reject(new Error('Late rejected transport'));
  await Promise.resolve(); await Promise.resolve();
  run.dispose();
});

test('auxiliary failure and cancellation do not terminate the main answer', async () => {
  const answer = deferred(); const visual = deferred();
  const seen = [];
  const stopVisual = new AbortController();
  const run = createModelGateway({ transport: input => {
    seen.push(input);
    if (input.purpose === 'answer') return answer.promise;
    if (input.purpose === 'visual-decision') return visual.promise;
    throw new Error('Auxiliary failed');
  } }).createRun({ runId: 'run', profile: profile() });
  const main = run.request({ requestId: 'answer', purpose: 'answer', messages: messages() });
  const optional = run.request({ requestId: 'visual', purpose: 'visual-decision', messages: messages(), signal: stopVisual.signal });
  const optionalFailure = assert.rejects(optional, { name: 'AbortError' });
  await assert.rejects(run.request({ requestId: 'suggestions', purpose: 'suggestions', messages: messages() }), /Auxiliary failed/);
  stopVisual.abort(); await optionalFailure;
  assert.equal(seen.find(input => input.purpose === 'answer').signal.aborted, false);
  assert.equal(run.signal.aborted, false);
  for (const input of seen.filter(input => input.purpose !== 'answer')) {
    assert.equal(input.onDelta, undefined); assert.equal(input.onReasoning, undefined);
  }
  answer.resolve('Main answer');
  assert.equal(await main, 'Main answer');
  visual.resolve('Late visual');
  run.dispose();
});

test('auxiliary requests cannot publish answer callbacks or declare tools', async () => {
  let calls = 0;
  const run = createModelGateway({ transport: () => { calls += 1; } }).createRun({ runId: 'run', profile: profile() });
  await assert.rejects(run.request({ requestId: 'visual', purpose: 'visual-decision', messages: messages(), onDelta: () => {} }), { code: 'ERR_MODEL_PURPOSE' });
  await assert.rejects(run.request({ requestId: 'compression', purpose: 'compression', messages: messages(), tools: [] }), { code: 'ERR_MODEL_PURPOSE' });
  assert.equal(calls, 0);
  run.dispose();
});

test('answer tools and tool choice are frozen, deduplicated and part of the request identity', async () => {
  const captured = [];
  const waiting = deferred();
  const run = createModelGateway({ transport: input => { captured.push(input); return waiting.promise; } })
    .createRun({ runId: 'tool-answer', profile: profile() });
  const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }];
  const options = { requestId: 'answer-0', purpose: 'answer', messages: messages(), tools, toolChoice: 'auto' };
  const pending = run.request(options);
  assert.equal(run.request(structuredClone(options)), pending);
  tools[0].function.name = 'changed-after-submit';
  await Promise.resolve();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].request.tools[0].function.name, 'web_search');
  assert.equal(captured[0].request.toolChoice, 'auto');
  assert.ok(Object.isFrozen(captured[0].request.tools[0].function));
  const original = { ...options, tools: captured[0].request.tools };
  await assert.rejects(run.request({ ...original, toolChoice: 'none' }), { code: 'ERR_MODEL_REQUEST_ID_REUSED' });
  await assert.rejects(run.request({ ...original, tools: [] }), { code: 'ERR_MODEL_REQUEST_ID_REUSED' });
  const result = { content: '', reasoning: '', toolCalls: [{ id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } }] };
  waiting.resolve(result);
  assert.deepEqual(await pending, result);
  assert.equal(captured.length, 1);
  run.dispose();
});

test('tool choice cannot silently alter auxiliary or ordinary answer request semantics', async () => {
  let calls = 0;
  const run = createModelGateway({ transport: () => { calls += 1; return 'unexpected'; } })
    .createRun({ runId: 'invalid-tool-choice', profile: profile() });
  for (const purpose of ['suggestions', 'compression', 'agent-decision']) {
    await assert.rejects(run.request({ requestId: purpose, purpose, messages: messages(), toolChoice: 'none' }), { code: 'ERR_MODEL_PURPOSE' });
  }
  await assert.rejects(run.request({ requestId: 'missing-tools', purpose: 'answer', messages: messages(), toolChoice: 'none' }), { code: 'ERR_MODEL_PURPOSE' });
  await assert.rejects(run.request({ requestId: 'invalid-tools', purpose: 'answer', messages: messages(), tools: {} }), { code: 'ERR_MODEL_PURPOSE' });
  await assert.rejects(run.request({ requestId: 'invalid-choice', purpose: 'answer', messages: messages(), tools: [], toolChoice: 'required' }), { code: 'ERR_MODEL_PURPOSE' });
  assert.equal(calls, 0);
  run.dispose();
});

test('default answer transport supports native tool calls and an explicitly tool-free final round', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    const choice = body.tool_choice === 'none'
      ? { delta: { content: 'Final answer' }, finish_reason: 'stop' }
      : { delta: { reasoning_content: 'Need a source', tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } }] }, finish_reason: 'tool_calls' };
    return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const run = createModelGateway({ transport: createModelTransport({ fetchImpl }) })
    .createRun({ runId: 'tool-transport', profile: profile() });
  const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }];
  const thoughts = [];
  const decision = await run.request({ requestId: 'answer-0', purpose: 'answer', messages: messages(), tools, toolChoice: 'auto', onReasoning: text => thoughts.push(text) });
  assert.equal(decision.toolCalls[0].function.name, 'web_search');
  assert.equal(decision.message.reasoning_content, 'Need a source');
  assert.deepEqual(thoughts, ['Need a source']);
  const deltas = [];
  const final = await run.request({ requestId: 'answer-1', purpose: 'answer', messages: messages(), tools: [], toolChoice: 'none', onDelta: text => deltas.push(text) });
  assert.equal(final.content, 'Final answer');
  assert.deepEqual(final.toolCalls, []);
  assert.deepEqual(deltas, ['Final answer']);
  assert.deepEqual(bodies[0].tools, tools);
  assert.equal(bodies[0].tool_choice, 'auto');
  assert.equal(bodies[1].tool_choice, 'none');
  assert.equal(bodies.length, 2);
  run.dispose();
});

test('run cancellation aborts all active purposes and rejects future use of completed ids', async () => {
  const captured = [];
  const run = createModelGateway({ transport: input => { captured.push(input); return input.request.messages[0].content === 'Complete' ? 'Done' : new Promise(() => {}); } })
    .createRun({ runId: 'run', profile: profile() });
  const complete = { requestId: 'complete', purpose: 'suggestions', messages: [{ role: 'user', content: 'Complete' }] };
  assert.equal(await run.request(complete), 'Done');
  const answer = run.request({ requestId: 'answer', purpose: 'answer', messages: messages() });
  const auxiliary = run.request({ requestId: 'aux', purpose: 'compression', messages: messages() });
  const done = Promise.all([assert.rejects(answer, { name: 'AbortError' }), assert.rejects(auxiliary, { name: 'AbortError' })]);
  await Promise.resolve();
  run.dispose(); await done;
  assert.ok(captured.slice(1).every(input => input.signal.aborted));
  await assert.rejects(run.request(complete), { name: 'AbortError' });
});

test('errors and telemetry redact keys and never include prompts, config or raw output', async () => {
  const events = [];
  const run = createModelGateway({ transport: () => { throw new Error('Rejected private-key Bearer second-secret'); } })
    .createRun({ runId: 'run', profile: profile(), onEvent: event => { events.push(event); throw new Error('broken diagnostics'); } });
  await assert.rejects(run.request({ requestId: 'answer', purpose: 'answer', messages: [{ role: 'user', content: 'sensitive-prompt' }] }), error => {
    assert.doesNotMatch(error.message, /private-key|second-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(events), /private-key|second-secret|sensitive-prompt|model\.test|apiKey|endpointUrl/);
  assert.deepEqual(events.map(event => event.type), ['model.request.started', 'model.request.failed']);
  run.dispose();
});

test('existing generation and tool budgets pass through and compression retains its request body rules', async () => {
  const captured = [];
  const gateway = createModelGateway({ transport: input => { captured.push(input); return 'ok'; } });
  const run = gateway.createRun({ runId: 'run', profile: profile() });
  const tools = [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object' } } }];
  await run.request({ requestId: 'decision', purpose: 'agent-decision', messages: messages(), tools, maxTokens: 913, temperature: 0 });
  await run.request({ requestId: 'compression', purpose: 'compression', messages: messages(), maxTokens: 777 });
  await run.request({ requestId: 'suggestions', purpose: 'suggestions', messages: messages() });
  assert.deepEqual(captured[0].request.tools, tools);
  assert.equal(captured[0].request.maxTokens, 913);
  assert.equal(captured[1].request.maxTokens, 777);
  assert.equal(captured[1].request.temperature, undefined);
  assert.equal(captured[2].request.maxTokens, 420);
  run.dispose();
});

test('gateway web search uses the configured model endpoint, key and bounded query', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ ok: true, engine: 'workbuddy', query: '广州天气',
      results: [{ title: '广州天气', url: 'https://weather.test/guangzhou', snippet: '27°C 多云' }] });
  };
  const run = createModelGateway({ transport: createModelTransport({ fetchImpl }) })
    .createRun({ runId: 'search-run', profile: profile() });
  const result = await run.request({ requestId: 'search-1', purpose: 'web-search', query: '广州天气', maxResults: 8 });
  assert.equal(requests[0].url, 'https://model.test/v1/web_search');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-key');
  assert.deepEqual(JSON.parse(requests[0].options.body), { query: '广州天气', max_results: 8 });
  assert.deepEqual(result.results, [{ title: '广州天气', url: 'https://weather.test/guangzhou', snippet: '27°C 多云', site: '', favicon: '' }]);
  run.dispose();
});

test('web capability failures retain only a safe HTTP status for explicit fallback decisions', async () => {
  for (const purpose of ['web-search', 'web-fetch']) {
    for (const status of [404, 405, 501, 401, 403, 429, 500]) {
      const run = createModelGateway({ transport: createModelTransport({ fetchImpl: async () =>
        Response.json({ error: { message: 'rejected private-key' } }, { status }) }) })
        .createRun({ runId: `capability-${purpose}-${status}`, profile: profile() });
      await assert.rejects(run.request({ requestId: 'tool', purpose, query: 'weather', url: 'https://public.test/page' }), failure => {
        assert.equal(failure.status, status);
        assert.equal(failure.code, 'ERR_MODEL_REQUEST_FAILED');
        assert.equal(failure.endpoint, undefined);
        assert.equal(failure.cause, undefined);
        assert.doesNotMatch(failure.message, /private-key/);
        return true;
      });
      run.dispose();
    }
  }
  for (const failure of [Object.assign(new Error('bad status'), { status: '404' }),
    Object.assign(new Error('bad status'), { status: 999 }),
    Object.assign(new DOMException('stopped', 'AbortError'), { status: 404 }),
    Object.assign(new DOMException('late', 'TimeoutError'), { status: 404 })]) {
    const run = createModelGateway({ transport: () => { throw failure; } })
      .createRun({ runId: 'unsafe-status', profile: profile() });
    await assert.rejects(run.request({ requestId: 'tool', purpose: 'web-search', query: 'weather' }), safe => {
      assert.equal(safe.status, undefined);
      return true;
    });
    run.dispose();
  }
  const run = createModelGateway({ transport: () => { throw Object.assign(new Error('answer failure'), { status: 404 }); } })
    .createRun({ runId: 'answer-http', profile: profile() });
  await assert.rejects(run.request({ requestId: 'answer', purpose: 'answer', messages: messages() }), failure => failure.status === undefined);
  run.dispose();
});

test('web tools honor each run\'s configured search and fetch capability paths', async () => {
  const requests = [];
  const config = { ...profile(), webSearchEndpoint: 'tools/search', webFetchEndpoint: 'tools/fetch' };
  const run = createModelGateway({ transport: createModelTransport({ fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return url.endsWith('/tools/search')
      ? Response.json({ results: [{ title: 'Source', url: 'https://public.test/source', snippet: 'Search summary' }] })
      : Response.json({ title: 'Source', content: 'Readable source body '.repeat(10) });
  } }) }).createRun({ runId: 'custom-capabilities', profile: config });
  config.webSearchEndpoint = 'changed/search';
  config.webFetchEndpoint = 'changed/fetch';
  await run.request({ requestId: 'search', purpose: 'web-search', query: 'source', maxResults: 6 });
  await run.request({ requestId: 'fetch', purpose: 'web-fetch', url: 'https://public.test/source' });
  assert.deepEqual(requests.map(request => request.url), ['https://model.test/v1/tools/search', 'https://model.test/v1/tools/fetch']);
  assert.deepEqual(requests[0].body, { query: 'source', max_results: 6, count: 6, need_content: false });
  assert.deepEqual(requests[1].body, { url: 'https://public.test/source' });
  run.dispose();
});

test('default transport preserves SSE parsing and non-streaming visual/compression semantics', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"<think>Reason</think>Answer"}}]}\n\ndata: [DONE]\n\n');
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>Private reasoning</think> {"screenshot":false,"note":"literal <think> stays"}' } }] }));
  };
  const run = createModelGateway({ transport: createModelTransport({ fetchImpl }) }).createRun({ runId: 'run', profile: profile() });
  const deltas = []; const thoughts = [];
  assert.equal(await run.request({ requestId: 'answer', purpose: 'answer', messages: messages(), onDelta: text => deltas.push(text), onReasoning: text => thoughts.push(text) }), 'Answer');
  const visual = await run.request({ requestId: 'visual', purpose: 'visual-decision', messages: messages() });
  assert.deepEqual(JSON.parse(visual), { screenshot: false, note: 'literal <think> stays' });
  await run.request({ requestId: 'compression', purpose: 'compression', messages: messages(), maxTokens: 1000 });
  assert.deepEqual(deltas, ['Answer']); assert.deepEqual(thoughts, ['Reason']);
  assert.equal(bodies[1].max_tokens, 80); assert.equal(bodies[1].temperature, 0);
  assert.deepEqual(bodies[2], { model: 'model-a', messages: messages(), stream: false, max_tokens: 1000 });
  run.dispose();
});

test('non-streaming thought stripping preserves JSON strings and handles content parts', () => {
  assert.equal(visibleCompletionText([{ type: 'text', text: '<think>one</think>' }, { type: 'text', text: '<think>two</think>{"value":"<think>literal</think>"}' }]), '{"value":"<think>literal</think>"}');
  assert.equal(visibleCompletionText('<think>unfinished'), '');
  assert.equal(visibleCompletionText('{"value":"<think>literal</think>"}'), '{"value":"<think>literal</think>"}');
});

test('default Agent transport preserves tool decisions and only its existing capability fallback', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.tools) return new Response('tools unsupported', { status: 422 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"read_page","args":{}}' } }] }));
  };
  const run = createModelGateway({ transport: createModelTransport({ fetchImpl }) }).createRun({ runId: 'run', profile: profile() });
  const options = { requestId: 'step-1', purpose: 'agent-decision', messages: messages(), tools: [{ type: 'function', function: { name: 'read_page' } }] };
  const decision = await run.request(options);
  assert.equal(decision.kind, 'content');
  assert.equal(decision.content, '{"action":"read_page","args":{}}');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 1200);
  assert.equal(bodies[1].tools, undefined);
  assert.equal(await run.request(options), decision);
  assert.equal(bodies.length, 2);
  run.dispose();
});

test('cancellation of a parent run prevents independent request signals from keeping it alive', async () => {
  const parent = new AbortController();
  const child = new AbortController();
  let captured;
  const run = createModelGateway({ transport: input => { captured = input; return new Promise(() => {}); } })
    .createRun({ runId: 'run', profile: profile(), signal: parent.signal });
  const request = run.request({ requestId: 'answer', purpose: 'answer', messages: messages(), signal: child.signal });
  const cancelled = assert.rejects(request, { name: 'AbortError' });
  await Promise.resolve();
  parent.abort();
  await cancelled;
  assert.equal(captured.signal.aborted, true);
  assert.equal(child.signal.aborted, false);
  run.dispose();
});

test('equivalent payload key ordering deduplicates and a transport failure is not retried', async () => {
  let calls = 0;
  const run = createModelGateway({ transport: () => { calls += 1; throw new Error('Unavailable'); } })
    .createRun({ runId: 'run', profile: profile() });
  const first = run.request({ requestId: 'answer', purpose: 'answer', messages: [{ role: 'user', content: 'Question' }] });
  const second = run.request({ requestId: 'answer', purpose: 'answer', messages: [{ content: 'Question', role: 'user' }] });
  assert.equal(first, second);
  await assert.rejects(first, /Unavailable/);
  await assert.rejects(second, /Unavailable/);
  assert.equal(calls, 1);
  run.dispose();
});
