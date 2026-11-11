import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidepanelApplication, readingDiagnosticEvidence } from '../src/sidepanel/composition/application-root.js';
import { createSidepanelComposition } from '../src/sidepanel/composition/composition-root.js';
import { createConversationSaver } from '../src/sidepanel/features/storage/conversation-save.js';
import { createModelGateway } from '../src/app/model-gateway.js';
import { createResearchToolSession } from '../src/sidepanel/features/web-research/research-tools.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const now = () => new Date().toISOString();

function reply(request, content = 'root answer', reasoning = 'reasoning') {
  if (reasoning) request.onReasoning(reasoning, reasoning);
  request.onDelta(content, content);
  return Array.isArray(request.request.tools)
    ? { content, reasoning, toolCalls: [], message: { role: 'assistant', content, reasoning_content: reasoning }, finishReason: 'stop' }
    : content;
}

function toolReply(calls, reasoning = 'Need evidence') {
  const toolCalls = calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
  return { content: '', reasoning, toolCalls, finishReason: 'tool_calls',
    message: { role: 'assistant', content: null, reasoning_content: reasoning, tool_calls: toolCalls } };
}

test('reading diagnostics use persisted network reuse and real page sources instead of nonexistent fields', () => {
  const evidence = readingDiagnosticEvidence({ url: 'https://page.test/', text: 'page text', networkReading: { status: 'reused', truncated: true } });
  assert.equal(evidence.cached, true);
  assert.equal(evidence.sourceCount, 1);
  assert.equal(evidence.truncated, true);
  assert.equal(readingDiagnosticEvidence(null).hasPageContext, false);
});

const defaultFactories = {
  reading: () => ({ read: async () => ({ text: 'unused page text' }) }),
  visual: () => ({ decide: async () => ({ screenshot: false }), resolve: async () => [] }),
  agent: () => ({
    isBusy: () => false, isMode: () => false, getTask: () => null,
    setMode() {}, toggleMode() {}, closePanel() {},
    start: async () => true, stop: async () => {}, resume: async () => {}, restore: async () => {},
  }),
};

function fixture(t, { enabled, factories, providers = [], transport, config = null, supportsVision = false,
  researchTools = createResearchToolSession, researchOptions, recordDiagnostic } = {}) {
  const state = { config, conversation: { id: 'conversation', storage: 'temporary', title: '新对话', messages: [] },
    ready: true, attachments: [], messageQueue: [], selectedEffort: 'default', selectedModelId: 'model',
    disablePageContext: true, directModelRequest: '', draft: '', saveQueue: Promise.resolve() };
  const records = new Map();
  const calls = [];
  const events = [];
  const profile = { id: 'model', endpointUrl: 'https://model.test/v1', model: 'fixture', contextLength: 8192, maxTokens: 256 };
  const configuredProfile = () => ({ ...profile, supportsVision, webSearchEnabled: state.config?.webSearchEnabled !== false,
    webFetchEnabled: state.config?.webFetchEnabled !== false });
  let id = 0;
  const saver = createConversationSaver({ getConversation: () => state.conversation,
    loadConversation: async value => structuredClone(records.get(value) || null),
    writeConversation: async conversation => {
      const saved = structuredClone(conversation);
      records.set(saved.id, saved);
      return saved;
    },
    getQueue: () => state.saveQueue, setQueue: queue => { state.saveQueue = queue; },
    setTimer: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; },
  });
  const composition = createSidepanelComposition({}, { enabled, factories: { ...defaultFactories, ...factories } });
  const modelGateway = createModelGateway({ transport: request => {
    calls.push(request);
    if (transport) return transport(request);
    if (request.purpose === 'suggestions') return '[]';
    assert.equal(request.purpose, 'answer', 'the model chooses tools without a separate classifier');
    return reply(request);
  } });
  const application = createSidepanelApplication({
    state, conversationSaver: saver, modelGateway, agentSlot: composition.agent, contextProviders: providers,
    researchTools, researchOptions, recordDiagnostic,
    browser: { queryActiveTab: async () => null, sendMessage: async () => ({}) },
    ensureConversation: async signal => { signal?.throwIfAborted(); return state.conversation; },
    ensureConfigured: async signal => { signal?.throwIfAborted(); return true; },
    saveCurrent: options => saver.save(options?.conversation || state.conversation, options),
    scheduleSave: () => saver.schedule(state.conversation),
    getDirectoryInfo: async () => ({ granted: false }),
    promoteTemporaryConversation: async conversation => conversation,
    readCurrentPageForRequest: (_question, options) => composition.reading.read(options),
    autoVisualAttachments: (question, page, signal) => composition.visual.resolve(question, page, { signal }).catch(() => []),
    activeChatProfile: configuredProfile, profileFor: configuredProfile,
    conversationTitle: text => text.slice(0, 34), hasVision: () => supportsVision,
    makeId: () => `id-${++id}`, now,
  });
  application.subscribe(event => events.push(event));
  async function flush() {
    await tick();
    saver.flush();
    await state.saveQueue;
  }
  t.after(async () => {
    application.dispose();
    await composition.dispose();
    await application.contextAssembler.dispose();
    await flush();
  });
  return { state, records, calls, events, saver, composition, application, flush };
}

test('diagnostic observers receive bound lifecycles and cannot hold or fail the composed main reply', async t => {
  for (const behavior of ['throw', 'reject', 'hang']) {
    const observed = [];
    const fx = fixture(t, { recordDiagnostic: event => {
      observed.push(event);
      if (behavior === 'throw') throw new Error('log unavailable');
      if (behavior === 'reject') return Promise.reject(new Error('log unavailable'));
      return new Promise(() => {});
    } });
    await fx.application.conversations.sendMessage('普通问题');
    const terminal = observed.filter(event => event.event === 'turn.terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].context.conversationId, 'conversation');
    assert.equal(terminal[0].data.status, 'completed');
    assert.equal(fx.state.conversation.messages.at(-1).content, 'root answer');
    assert.equal(JSON.stringify(observed).includes('普通问题'), false);
  }
});

test('the real application root runs a plain command through preparation, streaming, final projection and saving', async t => {
  const fx = fixture(t);
  await fx.application.conversations.sendMessage('普通问题');
  await fx.flush();
  const answer = fx.state.conversation.messages.find(message => message.role === 'assistant');
  assert.equal(answer.content, 'root answer');
  assert.equal(answer.reasoning, 'reasoning');
  assert.equal(answer.status, 'complete');
  assert.equal(fx.state.isSubmitting, false);
  assert.equal(fx.state.sendInFlight, false);
  assert.equal(fx.state.generatingId, null);
  assert.equal(fx.state.activeAssistantId, null);
  assert.equal(fx.application.runner.active(), null);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.ok(fx.events.some(event => event.type === 'run:message' && event.assistantId === answer.id));
  assert.ok(fx.events.some(event => event.type === 'reply-started'));
  assert.ok(fx.events.some(event => event.type === 'reply-ended'));
  assert.equal(fx.records.get('conversation').messages[1].content, 'root answer');
});

test('a page-off screenshot question reaches the sole answer without page reading or a search decision', async t => {
  const fx = fixture(t, { supportsVision: true,
    factories: {
      reading: () => ({ read: async () => assert.fail('Page reading is disabled') }),
      visual: () => ({ decide: async () => assert.fail('Uploaded image needs no screenshot decision'), resolve: async () => assert.fail('No automatic capture') }),
    },
  });
  const image = { id: 'image-1', type: 'image', name: 'response.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' };
  fx.state.attachments = [image];
  await fx.application.conversations.sendMessage('这里是正常的嘛');
  await fx.flush();
  assert.deepEqual(fx.calls.map(call => call.purpose), ['answer', 'suggestions']);
  const message = fx.calls[0].request.messages.at(-1);
  assert.ok(message.content.some(part => part.type === 'image_url' && part.image_url.url === image.dataUrl));
  assert.equal(fx.state.conversation.messages.length, 2);
  assert.equal(fx.state.conversation.messages[0].pageContextEnabled, false);
  assert.equal(fx.state.conversation.messages[1].status, 'complete');
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.equal(fx.records.get('conversation').messages[1].content, 'root answer');
});

test('the real application root lets the answer model choose search for a question without local topic rules', async t => {
  const queries = [];
  const fx = fixture(t, { transport(request) {
    if (request.purpose === 'suggestions') return '[]';
    if (request.purpose === 'web-search') {
      queries.push(request.request.query);
      return { results: [{ title: 'Official', url: 'https://official.test/release', content: 'VERIFIED_WEB_DATA '.repeat(10) }] };
    }
    assert.equal(request.purpose, 'answer');
    const messages = request.request.messages;
    const question = messages.findLast(message => message.role === 'user').content;
    if (question.includes('闭包') || messages.some(message => message.role === 'tool')) return reply(request);
    return toolReply([['search-1', 'web_search', { query: '方案的官方依据' }]]);
  } });
  await fx.application.conversations.sendMessage('什么是闭包？');
  await fx.application.conversations.sendMessage('这个方案有依据吗？');
  assert.deepEqual(queries, ['方案的官方依据']);
  assert.equal(fx.calls.some(call => call.purpose === 'research-decision'), false);
  assert.match(fx.calls.filter(call => call.purpose === 'answer').at(-1).request.messages.findLast(message => message.role === 'tool').content, /VERIFIED_WEB_DATA/);
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 3);
  assert.equal(fx.state.conversation.messages.filter(message => message.role === 'assistant').length, 2);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 2);
  assert.deepEqual(fx.state.conversation.messages.filter(message => message.role === 'assistant').at(-1).sources.map(source => source.url), ['https://official.test/release']);
});

test('the production root routes model-selected search and parallel source reads through the same frozen gateway', async t => {
  let searchRequest;
  const reads = [];
  const bothReads = deferred();
  const fx = fixture(t, { transport(request) {
    if (request.purpose === 'web-search') {
      searchRequest = request;
      return { ok: true, engine: 'workbuddy', results: [
        { title: '广州天气', url: 'https://weather.test/gz', snippet: '2026-11-03 广州 27°C 多云' },
        { title: '广州天气预报', url: 'https://forecast.test/gz', snippet: '2026-11-03 24~29°C' },
      ] };
    }
    if (request.purpose === 'suggestions') return '[]';
    if (request.purpose === 'web-fetch') {
      reads.push(request);
      if (reads.length === 2) bothReads.resolve();
      return bothReads.promise.then(() => ({ url: request.request.url, content: '广州天气公开正文。'.repeat(15) }));
    }
    if (request.purpose === 'answer') {
      const results = request.request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      if (!results.length) return toolReply([['search-1', 'web_search', { query: '今天广州天气如何' }]]);
      if (!results.some(result => result.kind === 'read')) return toolReply(results[0].sources.map((source, index) => [`read-${index}`, 'read_webpage', { sourceId: source.sourceId }]));
      return reply(request, 'answer');
    }
    assert.fail(`Unexpected purpose ${request.purpose}`);
  }, researchOptions: { fetchImpl: async () => assert.fail('The configured gateway must provide the research') } });
  await fx.application.conversations.sendMessage('今天广州天气如何');
  await fx.flush();
  assert.ok(searchRequest, JSON.stringify(fx.calls.map(call => call.purpose)));
  assert.equal(searchRequest.purpose, 'web-search');
  assert.equal(searchRequest.request.query, '今天广州天气如何');
  assert.equal(searchRequest.request.maxResults, 6);
  assert.equal(searchRequest.profile.endpointUrl, 'https://model.test/v1');
  assert.equal(fx.calls.filter(call => call.purpose === 'web-fetch').length, 2);
  assert.equal(fx.state.conversation.messages.at(-1).status, 'complete');
  const finalMessages = fx.calls.filter(call => call.purpose === 'answer').at(-1).request.messages;
  assert.match(finalMessages.findLast(message => message.role === 'tool').content, /广州天气公开正文/);
  assert.equal(finalMessages.filter(message => message.role === 'tool').length, 3);
  assert.ok(finalMessages.some(message => message.role === 'assistant' && message.reasoning_content === 'Need evidence'));
  assert.equal(fx.state.conversation.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.deepEqual(fx.state.conversation.messages.at(-1).sources.map(source => source.url).sort(), ['https://forecast.test/gz', 'https://weather.test/gz']);
});

function researchBudgetFixture(t, finish) {
  const queries = [];
  let models = 0, finalRequest;
  const fx = fixture(t, { transport(request) {
    if (request.purpose === 'suggestions') return '[]';
    if (request.purpose === 'web-search') {
      const query = request.request.query;
      queries.push(query);
      assert.notEqual(query, 'over-budget', 'a denied tool must never dispatch a search');
      const count = query === 'first' ? 6 : query === 'second' ? 5 : 1;
      return { results: Array.from({ length: count }, (_, index) => ({ title: `${query}-${index}`,
        url: `https://evidence.test/${query}/${index}`, snippet: '公开来源的搜索摘要。'.repeat(8) })) };
    }
    assert.equal(request.purpose, 'answer');
    if (++models === 1) {
      request.onDelta('先核对公开资料。', '先核对公开资料。');
      const result = toolReply([['search-first', 'web_search', { query: 'first' }], ['search-second', 'web_search', { query: 'second' }]]);
      return { ...result, content: '先核对公开资料。', message: { ...result.message, content: '先核对公开资料。' } };
    }
    if (models === 2) {
      const results = request.request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.equal(results.flatMap(result => result.sources || []).length, 11);
      return toolReply([['search-allowed', 'web_search', { query: 'remaining' }], ['search-denied', 'web_search', { query: 'over-budget' }]]);
    }
    finalRequest = request;
    assert.equal(models, 3, 'the budget denial permits only the existing final answer request');
    assert.deepEqual(request.request.tools, []);
    assert.equal(request.request.toolChoice, 'none');
    const messages = request.request.messages;
    const calls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
    const results = messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), calls.map(call => call.id));
    const denied = JSON.parse(results.find(message => message.tool_call_id === 'search-denied').content);
    assert.equal(denied.kind, 'budget');
    assert.equal(denied.code, 'ERR_RESEARCH_TOOL_LIMIT');
    assert.equal(denied.ok, false);
    assert.equal(denied.executed, false);
    assert.equal(denied.source, undefined);
    assert.equal(denied.sources, undefined);
    return finish(request);
  } });
  return { ...fx, queries, get finalRequest() { return finalRequest; } };
}

test('research budget overflow completes and saves the sole answer with already obtained sources', async t => {
  const fx = researchBudgetFixture(t, request => reply(request, '依据已有来源总结；其余事项尚未核实。', '综合已有证据'));
  await fx.application.conversations.sendMessage('核对最近24小时的AI动态，选3至5件。');
  await fx.flush();
  const [user, answer] = fx.state.conversation.messages;
  assert.deepEqual(fx.queries, ['first', 'second', 'remaining']);
  assert.equal(fx.state.conversation.messages.length, 2);
  assert.equal(user.role, 'user');
  assert.equal(answer.role, 'assistant');
  assert.equal(answer.status, 'complete');
  assert.equal(answer.content, '先核对公开资料。\n\n依据已有来源总结；其余事项尚未核实。');
  assert.equal(answer.sources.length, 12);
  assert.ok(answer.sources.every(source => source.readStatus === 'search-summary'));
  assert.equal(answer.sources.some(source => source.url.includes('over-budget')), false);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.equal(fx.application.runner.active(), null);
  assert.equal(fx.state.generatingId, null);
  assert.equal(fx.records.get('conversation').messages.length, 2);
  assert.equal(fx.records.get('conversation').messages[1].status, 'complete');
  assert.equal(fx.records.get('conversation').messages[1].content, answer.content);
  assert.deepEqual(fx.records.get('conversation').messages[1].sources, answer.sources);
});

test('stopping research budget finalization keeps the original terminal unique and rejects late output', async t => {
  const pending = deferred(), started = deferred();
  const fx = researchBudgetFixture(t, () => { started.resolve(); return pending.promise; });
  const sending = fx.application.conversations.sendMessage('核对最近24小时的AI动态。');
  await Promise.race([started.promise, sending]);
  assert.ok(fx.finalRequest, 'the available evidence must reach a final answer request');
  fx.application.conversations.stopActiveReply();
  await sending;
  const stopped = fx.state.conversation.messages[1];
  const content = stopped.content;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.sources.length, 12);
  assert.equal(fx.finalRequest.signal.aborted, true);
  fx.finalRequest.onDelta('LATE', 'LATE');
  pending.resolve({ content: 'LATE_FINAL', reasoning: '', toolCalls: [],
    message: { role: 'assistant', content: 'LATE_FINAL' }, finishReason: 'stop' });
  await fx.flush();
  assert.equal(fx.state.conversation.messages.length, 2);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.content, content);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.deepEqual(fx.queries, ['first', 'second', 'remaining']);
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 3);
  assert.equal(fx.calls.filter(call => call.purpose === 'suggestions').length, 0);
  assert.equal(fx.records.get('conversation').messages[1].status, 'stopped');
  assert.equal(fx.records.get('conversation').messages[1].content, content);
  assert.equal(fx.application.runner.active(), null);
  assert.equal(fx.state.generatingId, null);
});

test('config loaded after application creation disables all research and the next enabled turn resumes it', async t => {
  const publicRequests = [];
  const fx = fixture(t, { researchOptions: { fetchImpl: async url => {
    publicRequests.push(url);
    throw new Error('Public research must remain disabled');
  } }, transport(request) {
    if (request.purpose === 'web-search') return { results: [
      { title: 'Official', url: 'https://official.test/release', content: 'VERIFIED_RELEASE' },
      { title: 'Report', url: 'https://report.test/release', content: 'VERIFIED_RELEASE' },
    ] };
    if (request.purpose === 'suggestions') return '[]';
    assert.equal(request.purpose, 'answer');
    if (Array.isArray(request.request.tools)) {
      assert.deepEqual(request.request.tools.map(tool => tool.function.name), ['web_search']);
      if (!request.request.messages.some(message => message.role === 'tool')) return toolReply([['search-1', 'web_search', { query: '方案核验' }]]);
    }
    return reply(request, 'answer');
  } });
  assert.equal(fx.state.config, null);
  fx.state.config = { webSearchEnabled: false, webFetchEnabled: false };
  for (const question of ['今天有哪些新闻？', '这个方案可以吗？']) {
    await fx.application.conversations.sendMessage(question);
    await fx.flush();
    assert.deepEqual(publicRequests, [], 'disabled research must not fall back to public search');
    assert.equal(fx.calls.some(call => ['research-decision', 'web-search', 'web-fetch'].includes(call.purpose)), false);
    assert.equal(fx.state.conversation.messages.at(-1).status, 'complete');
  }
  fx.state.config = { webSearchEnabled: true, webFetchEnabled: false };
  await fx.application.conversations.sendMessage('这个方案可以吗？');
  await fx.flush();
  assert.equal(fx.calls.filter(call => call.purpose === 'research-decision').length, 0);
  assert.equal(fx.calls.filter(call => call.purpose === 'web-search').length, 1);
  assert.deepEqual(publicRequests, []);
  assert.match(fx.calls.filter(call => call.purpose === 'answer').at(-1).request.messages.findLast(message => message.role === 'tool').content, /VERIFIED_RELEASE/);
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 4);
  assert.equal(fx.state.conversation.messages.filter(message => message.role === 'assistant').length, 3);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 3);
});

test('an application created with research disabled can enable it for a later turn', async t => {
  const sessions = [];
  const fx = fixture(t, { config: { webSearchEnabled: false }, researchTools: options => {
    sessions.push(options);
    return createResearchToolSession(options);
  } });
  await fx.application.conversations.sendMessage('先直接回答');
  assert.equal(sessions.length, 0);
  fx.state.config = { webSearchEnabled: true };
  await fx.application.conversations.sendMessage('今天有哪些新闻？');
  await fx.flush();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].connection.modelInfo.webSearchEnabled, true);
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 2);
  assert.ok(fx.calls.filter(call => call.purpose === 'answer').at(-1).request.tools.length > 0);
  assert.equal(fx.state.conversation.messages.at(-1).status, 'complete');
});

test('all disabled feature slots leave the application root usable for ordinary chat', async t => {
  const fx = fixture(t, { enabled: { reading: false, visual: false, agent: false } });
  await fx.application.conversations.sendMessage('直接聊天');
  await fx.flush();
  assert.equal(fx.state.conversation.messages[1].status, 'complete');
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 1);
  assert.equal(fx.composition.agent.isBusy(), false);
  assert.equal(fx.composition.agent.isMode(), false);
  assert.deepEqual((await fx.composition.ready).map(item => item.status), ['disabled', 'disabled', 'disabled']);
});

test('optional slot initialization failures and bad context providers are isolated by the actual root', async t => {
  const pending = deferred();
  let cleaned = 0;
  const fx = fixture(t, {
    factories: {
      visual: () => { throw new Error('visual failed'); },
      agent: ({ onCleanup }) => { onCleanup(() => cleaned++); throw new Error('agent failed'); },
    },
    providers: [
      { id: 'factory-failure', create: () => { throw new Error('context initialization failed'); } },
      { id: 'hang', timeoutMs: 15, collect: () => pending.promise },
    ],
  });
  await fx.application.conversations.sendMessage('基础问答仍可用');
  await fx.flush();
  assert.equal(cleaned, 1);
  assert.equal(fx.state.conversation.messages[1].status, 'complete');
  assert.deepEqual(fx.state.conversation.messages[1].contextIssues.map(item => item.providerId), ['factory-failure', 'hang']);
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 1);
  assert.equal(fx.composition.status('agent').status, 'failed');
  assert.equal(fx.state.isSubmitting, false);
  pending.resolve([]);
});

test('required context failure through the root emits a terminal error and releases the composer', async t => {
  const fx = fixture(t, { providers: [{ id: 'required', required: true, create: () => { throw new Error('required data missing'); } }] });
  await fx.application.conversations.sendMessage('必须用指定资料回答');
  await fx.flush();
  const answer = fx.state.conversation.messages[1];
  assert.equal(answer.status, 'error');
  assert.match(answer.errorMessage, /required data missing/);
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.state.isSubmitting, false);
  assert.equal(fx.state.generatingId, null);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.equal(fx.records.get('conversation').messages[1].status, 'error');
});

test('application disposal aborts an in-flight model and rejects late output without reopening its turn', async t => {
  const pending = deferred();
  const started = deferred();
  let request;
  const fx = fixture(t, { transport(value) {
    assert.equal(value.purpose, 'answer');
    request = value; value.onDelta('partial', 'partial'); started.resolve(); return pending.promise;
  } });
  const sending = fx.application.conversations.sendMessage('等待中的问题');
  await started.promise;
  fx.application.dispose();
  await sending;
  request.onDelta('LATE', 'LATE');
  pending.resolve({ content: 'LATE_FINAL', reasoning: '', toolCalls: [], message: { role: 'assistant', content: 'LATE_FINAL' }, finishReason: 'stop' });
  await fx.flush();
  assert.equal(request.signal.aborted, true);
  assert.equal(fx.state.conversation.messages[1].status, 'stopped');
  assert.equal(fx.state.conversation.messages[1].content, 'partial');
  assert.equal(fx.state.isSubmitting, false);
  assert.equal(fx.state.generatingId, null);
  assert.equal(fx.application.runner.active(), null);
  assert.deepEqual(fx.calls.map(call => call.purpose), ['answer']);
});

test('stopping a hanging search releases the turn and its late result cannot affect a new answer', async t => {
  const pending = deferred();
  const started = deferred();
  let searchRequest;
  const fx = fixture(t, { transport(request) {
    if (request.purpose === 'suggestions') return '[]';
    if (request.purpose === 'web-search') {
      searchRequest = request;
      started.resolve();
      return pending.promise;
    }
    assert.equal(request.purpose, 'answer');
    const question = request.request.messages.findLast(message => message.role === 'user').content;
    if (question.includes('新问题')) return reply(request, 'new answer');
    request.onDelta('正在核对资料。', '正在核对资料。');
    return { ...toolReply([['search-1', 'web_search', { query: '待核对资料' }]]), content: '正在核对资料。' };
  } });
  const sending = fx.application.conversations.sendMessage('核对这个说法');
  await started.promise;
  fx.application.conversations.stopActiveReply();
  await sending;
  const stopped = fx.state.conversation.messages[1];
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.content, '正在核对资料。');
  assert.equal(searchRequest.signal.aborted, true);
  await fx.application.conversations.sendMessage('新问题直接回答');
  pending.resolve({ results: [{ title: 'late', url: 'https://late.test/result', content: 'LATE_SOURCE '.repeat(20) }] });
  await fx.flush();
  const answer = fx.state.conversation.messages.at(-1);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.content, 'new answer');
  assert.deepEqual(answer.sources, []);
  assert.equal(stopped.status, 'stopped');
  assert.equal(fx.calls.filter(call => call.purpose === 'answer').length, 2);
  assert.equal(fx.calls.filter(call => call.purpose === 'web-fetch').length, 0);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 2);
  assert.equal(fx.state.isSubmitting, false);
  assert.equal(fx.application.runner.active(), null);
});

test('retrying a failed tool turn replaces the original answer without appending the user question', async t => {
  let searches = 0;
  const fx = fixture(t, { researchOptions: { fetchImpl: async () => assert.fail('Permission failures cannot invoke public fallback') }, transport(request) {
    if (request.purpose === 'suggestions') return '[]';
    if (request.purpose === 'web-search') {
      searches += 1;
      if (searches === 1) throw Object.assign(new Error('search permission denied'), { status: 403 });
      return { results: [{ title: 'Verified', url: 'https://verified.test/source', content: 'VERIFIED_SOURCE '.repeat(20) }] };
    }
    assert.equal(request.purpose, 'answer');
    if (!request.request.messages.some(message => message.role === 'tool')) return toolReply([['search-1', 'web_search', { query: '核实来源' }]]);
    return reply(request, 'verified answer');
  } });
  await fx.application.conversations.sendMessage('核实这个说法');
  const userId = fx.state.conversation.messages[0].id;
  const failedId = fx.state.conversation.messages[1].id;
  assert.equal(fx.state.conversation.messages[1].status, 'error');
  assert.match(fx.state.conversation.messages[1].errorMessage, /permission denied/);
  await fx.application.conversations.regenerate(failedId);
  await fx.flush();
  assert.equal(fx.state.conversation.messages.length, 2);
  assert.equal(fx.state.conversation.messages[0].id, userId);
  assert.notEqual(fx.state.conversation.messages[1].id, failedId);
  assert.equal(fx.state.conversation.messages[1].status, 'complete');
  assert.equal(fx.state.conversation.messages[1].content, 'verified answer');
  assert.equal(searches, 2);
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 2);
  assert.equal(fx.records.get('conversation').messages.length, 2);
  assert.equal(fx.records.get('conversation').messages[1].content, 'verified answer');
});

test('a disposed application cannot accept a late UI command or append another turn', async t => {
  const fx = fixture(t);
  fx.application.dispose();
  const before = structuredClone(fx.state.conversation);
  await fx.application.conversations.sendMessage('迟到的页面事件');
  await fx.flush();
  assert.deepEqual(fx.state.conversation.messages, before.messages);
  assert.equal(fx.calls.length, 0);
});
