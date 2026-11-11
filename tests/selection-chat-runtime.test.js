import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionChatRuntime } from '../src/sidepanel/features/messages/selection-chat-runtime.js';
import { createModelGateway } from '../src/app/model-gateway.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const selection = () => ({ source: 'conversation', sourceVersion: 1, conversationId: 'parent-conversation',
  messageId: 'parent-answer', role: 'assistant', text: 'metadata 是每个 chunk 附带的键值对',
  context: '在向量库和 RAG 中，metadata 用于过滤和引用来源。', question: 'metadata 是什么？',
  title: 'RAG 说明', selectedAt: '2026-11-11T02:00:00Z', truncated: false, originalLength: 29 });
const nextSelection = () => ({ ...selection(), messageId: 'parent-second-answer', text: 'embedding 是文本的向量表示',
  context: 'embedding 用于衡量文本的语义相似度。', selectedAt: '2026-11-11T02:01:00Z' });

function fixture(t, options = {}) {
  const quote = options.selection || selection();
  const requests = [], writes = [], errors = [], events = [], records = new Map();
  const sourceConversation = { id: 'main-conversation', title: '当前主对话', messages: [{ id: 'main-answer', role: 'assistant', content: '主回答' }] };
  const originalSource = structuredClone(sourceConversation);
  let profile = { id: 'model-a', model: 'model-a', endpointUrl: 'https://model.test/v1', apiKey: 'first-key',
    contextLength: 16000, maxTokens: 256, webSearchEnabled: false, reasoningEffort: 'low' };
  let config = { endpointUrl: 'https://model.test/v1', models: [{ id: 'model-a' }] };
  let ids = 0;
  const gateway = createModelGateway({ transport: async request => {
    requests.push(request);
    if (request.purpose === 'suggestions') return options.suggestionsTransport ? options.suggestionsTransport(request) : '[]';
    if (options.transport) return options.transport(request, requests.filter(item => item.purpose === 'answer').length);
    request.onDelta('解释结果', '解释结果');
    return '解释结果';
  } });
  const runtime = createSelectionChatRuntime({ selection: quote, getConfig: () => config, getProfile: () => profile,
    modelGateway: gateway, makeId: () => `branch-${++ids}`, flushTimeoutMs: options.flushTimeoutMs || 1000,
    writeConversation: async conversation => {
      writes.push(structuredClone(conversation));
      if (options.writeConversation) await options.writeConversation(conversation, writes.length);
      const saved = { ...structuredClone(conversation), storage: 'local', syncStatus: 'pending', syncDirectoryName: 'original-dir' };
      if (options.persistedStreamingToStopped) {
        saved.messages = saved.messages.map(message => message.status === 'streaming' ? { ...message, status: 'stopped' } : message);
      }
      records.set(saved.id, saved);
      return saved;
    },
    loadConversation: async id => structuredClone(records.get(id) || null),
    onError: error => errors.push(error),
  });
  runtime.subscribe(event => events.push(event));
  t.after(async () => { runtime.close(); await runtime.flush().catch(() => {}); });
  return { runtime, quote, requests, writes, records, errors, events, sourceConversation, originalSource,
    setProfile: value => { profile = value; }, setConfig: value => { config = value; },
    answers: () => requests.filter(item => item.purpose === 'answer') };
}

test('opening and closing an empty selection chat creates no saved conversation and leaves main chat untouched', async t => {
  const fx = fixture(t);
  assert.equal(fx.runtime.state.conversation.storage, 'local');
  assert.deepEqual(fx.runtime.state.conversation.messages, []);
  assert.equal(fx.runtime.state.conversation.groupId, undefined);
  assert.notEqual(fx.runtime.state.conversation.id, fx.quote.conversationId);
  fx.runtime.close();
  await fx.runtime.flush();
  assert.deepEqual(fx.writes, []);
  assert.deepEqual(fx.answers(), []);
  assert.deepEqual(fx.sourceConversation, fx.originalSource);
  assert.equal(await fx.runtime.send('关闭后提问'), false);
});

test('a selection question uses the real application, one main answer, fixed quote/context and durable ungrouped storage', async t => {
  const fx = fixture(t);
  fx.quote.text = '后来另一个选区';
  fx.quote.context = '无关页面正文';
  await fx.runtime.send('解释选中的 metadata');
  await fx.runtime.flush();
  assert.equal(fx.answers().length, 1);
  const body = JSON.stringify(fx.answers()[0].request.messages);
  assert.match(body, /metadata 是每个 chunk 附带的键值对/);
  assert.match(body, /metadata 用于过滤和引用来源/);
  assert.doesNotMatch(body, /后来另一个选区|无关页面正文|主回答/);
  const conversation = fx.runtime.state.conversation;
  assert.equal(conversation.messages.filter(item => item.role === 'user').length, 1);
  assert.equal(conversation.messages.filter(item => item.role === 'assistant').length, 1);
  assert.equal(conversation.messages.at(-1).status, 'complete');
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 1);
  assert.ok(fx.writes.length >= 2);
  const record = fx.records.get(conversation.id);
  assert.equal(record.storage, 'local');
  assert.equal(record.groupId, undefined);
  assert.equal(record.messages[0].pageContextEnabled, false);
  assert.equal(record.messages[0].selection.conversationId, 'parent-conversation');
  assert.deepEqual(fx.sourceConversation, fx.originalSource);
});

test('the profile is captured at send and follow-up questions use current configuration and original branch history', async t => {
  const held = deferred();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 1) await held.promise; } });
  const first = fx.runtime.send('第一轮解释');
  await tick();
  fx.setProfile({ id: 'model-b', model: 'model-b', endpointUrl: 'https://second.test/v1', apiKey: 'second-key',
    maxTokens: 256, contextLength: 16000, reasoningEffort: 'high', webSearchEnabled: false });
  fx.setConfig({ endpointUrl: 'https://second.test/v1', models: [{ id: 'model-b' }] });
  held.resolve();
  await first;
  await fx.runtime.flush();
  assert.equal(fx.answers()[0].profile.model, 'model-a');
  assert.equal(fx.answers()[0].profile.apiKey, 'first-key');
  await fx.runtime.send('再举一个例子');
  await fx.runtime.flush();
  assert.equal(fx.answers()[1].profile.model, 'model-b');
  assert.equal(fx.answers()[1].profile.apiKey, 'second-key');
  const history = JSON.stringify(fx.answers()[1].request.messages);
  assert.match(history, /第一轮解释/);
  assert.match(history, /解释结果/);
  assert.match(history, /再举一个例子/);
  assert.equal(fx.runtime.state.conversation.messages[2].selection, null);
});

test('a new selection reuses the same branch, keeps its history and is held as an independent bounded snapshot', async t => {
  const fx = fixture(t);
  const conversationId = fx.runtime.state.conversation.id;
  await fx.runtime.send('解释 metadata');
  assert.equal(fx.runtime.getSelection(), null);
  fx.runtime.state.draft = '我的未发送草稿';
  const selected = nextSelection();
  const result = fx.runtime.setSelection(selected);
  assert.equal(result.accepted, true);
  assert.equal(result.pending, false);
  assert.equal(fx.runtime.state.draft, '我的未发送草稿');
  selected.text = '外部对象已修改';
  result.selection.context = '返回对象已修改';
  fx.runtime.getSelection().text = '读取对象已修改';
  await fx.runtime.send('解释 embedding');
  await fx.runtime.flush();
  assert.equal(fx.runtime.state.conversation.id, conversationId);
  assert.equal(fx.runtime.state.conversation.messages.length, 4);
  assert.equal(fx.runtime.state.conversation.groupId, undefined);
  const request = JSON.stringify(fx.answers()[1].request.messages);
  assert.match(request, /解释 metadata|解释结果|embedding 是文本的向量表示|语义相似度/);
  assert.doesNotMatch(request, /外部对象已修改|返回对象已修改|读取对象已修改/);
  assert.equal(fx.runtime.state.conversation.messages[2].selection.messageId, 'parent-second-answer');
  assert.equal(fx.runtime.getSelection(), null);
  assert.ok(fx.events.some(event => event.type === 'selection-updated'));
});

test('a selection received during submission survives the old preparation writeback and belongs to the next turn', async t => {
  const held = deferred();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 1) await held.promise; } });
  const first = fx.runtime.send('先解释 metadata');
  await tick();
  const update = fx.runtime.setSelection(nextSelection());
  assert.equal(update.accepted, true);
  assert.equal(update.pending, true);
  assert.equal(fx.answers().length, 0);
  held.resolve();
  await first;
  assert.equal(fx.runtime.getSelection().messageId, 'parent-second-answer');
  assert.equal(fx.runtime.state.pageSelection.messageId, 'parent-second-answer');
  assert.match(JSON.stringify(fx.answers()[0].request.messages), /metadata 是每个 chunk/);
  assert.doesNotMatch(JSON.stringify(fx.answers()[0].request.messages), /embedding 是文本的向量表示/);
  await fx.runtime.send('再解释 embedding');
  await fx.runtime.flush();
  assert.equal(fx.runtime.state.conversation.messages[0].selection.messageId, 'parent-answer');
  assert.equal(fx.runtime.state.conversation.messages[2].selection.messageId, 'parent-second-answer');
  assert.match(JSON.stringify(fx.answers()[1].request.messages), /embedding 是文本的向量表示/);
});

test('an updated selection survives the old terminal and delayed completion save without starting another request', async t => {
  const held = deferred();
  const fx = fixture(t, { transport: request => { request.onDelta('部分解释', '部分解释'); return held.promise; } });
  const first = fx.runtime.send('先解释 metadata');
  await tick();
  const quote = nextSelection();
  fx.runtime.setSelection(quote);
  quote.context = '外部变更';
  assert.equal(fx.answers().length, 1);
  held.resolve('完整解释');
  await first;
  await fx.runtime.flush();
  assert.equal(fx.runtime.getSelection().text, nextSelection().text);
  assert.equal(fx.runtime.getSelection().context, nextSelection().context);
  assert.equal(fx.runtime.state.pageSelection.messageId, nextSelection().messageId);
  assert.equal(fx.answers().length, 1);
  assert.equal(fx.records.get(fx.runtime.state.conversation.id).messages[0].selection.messageId, 'parent-answer');
});

test('reselecting even the same quote during a run remains available for the next question', async t => {
  const held = deferred();
  const fx = fixture(t, { transport: () => held.promise });
  const first = fx.runtime.send('第一轮问题');
  await tick();
  fx.runtime.setSelection(selection());
  held.resolve('第一轮回答');
  await first;
  assert.equal(fx.runtime.getSelection().messageId, 'parent-answer');
});

test('invalid and cross-conversation references are rejected without affecting draft, saves or model requests', async t => {
  const fx = fixture(t);
  const original = fx.runtime.getSelection();
  fx.runtime.state.draft = '未发送草稿';
  for (const quote of [null, { ...nextSelection(), conversationId: 'another-source' },
    { ...nextSelection(), messageId: '' }, { ...nextSelection(), role: 'user' },
    { ...nextSelection(), source: 'page' }, { ...nextSelection(), sourceVersion: 2, annotations: [nextSelection()] }]) {
    assert.equal(fx.runtime.setSelection(quote).accepted, false);
  }
  assert.deepEqual(fx.runtime.getSelection(), original);
  assert.equal(fx.runtime.state.draft, '未发送草稿');
  assert.equal(fx.writes.length, 0);
  assert.equal(fx.answers().length, 0);
  fx.runtime.close();
  assert.equal(fx.runtime.setSelection(nextSelection()).accepted, false);
});

test('retry keeps its original quote and cannot consume a new pending selection', async t => {
  const fx = fixture(t);
  await fx.runtime.send('解释 metadata');
  const assistantId = fx.runtime.state.conversation.messages.at(-1).id;
  fx.runtime.setSelection(nextSelection());
  await fx.runtime.retry(assistantId);
  assert.equal(fx.runtime.state.conversation.messages.length, 2);
  assert.equal(fx.runtime.state.conversation.messages[0].selection.messageId, 'parent-answer');
  assert.doesNotMatch(JSON.stringify(fx.answers()[1].request.messages), /embedding 是文本的向量表示/);
  assert.equal(fx.runtime.getSelection().messageId, 'parent-second-answer');
  await fx.runtime.send('解释 embedding');
  await fx.runtime.flush();
  assert.equal(fx.runtime.state.conversation.messages[2].selection.messageId, 'parent-second-answer');
});

test('stop preserves a newly selected reference and late output cannot consume it before resending', async t => {
  const held = deferred();
  let oldRequest;
  const fx = fixture(t, { transport: (request, index) => {
    if (index === 1) { oldRequest = request; request.onDelta('部分回答', '部分回答'); return held.promise; }
    return '新引用的解释';
  } });
  const first = fx.runtime.send('解释 metadata');
  await tick();
  fx.runtime.setSelection(nextSelection());
  fx.runtime.stop();
  await first;
  oldRequest.onDelta('迟到回答', '迟到回答');
  held.resolve('迟到回答');
  await tick();
  assert.equal(fx.runtime.getSelection().messageId, 'parent-second-answer');
  await fx.runtime.send('解释 embedding');
  await fx.runtime.flush();
  assert.equal(fx.runtime.state.conversation.messages[0].selection.messageId, 'parent-answer');
  assert.equal(fx.runtime.state.conversation.messages[2].selection.messageId, 'parent-second-answer');
  assert.equal(fx.runtime.state.conversation.messages[1].content, '部分回答');
  assert.equal(fx.runtime.getSelection(), null);
});

test('transfer rejects incoming references and a failed transfer leaves the pending quote usable', async t => {
  const writing = deferred();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 3) await writing.promise; } });
  await fx.runtime.send('解释 metadata');
  await fx.runtime.flush();
  fx.runtime.setSelection(nextSelection());
  let current = true;
  const transfer = fx.runtime.takeConversation({ isCurrent: () => current });
  assert.equal(fx.runtime.setSelection(selection()).accepted, false);
  current = false;
  writing.resolve();
  await assert.rejects(transfer, { name: 'AbortError' });
  assert.equal(fx.runtime.getSelection().messageId, 'parent-second-answer');
  await fx.runtime.send('解释 embedding');
  assert.equal(fx.runtime.state.conversation.messages[2].selection.messageId, 'parent-second-answer');
});

test('a repeated click cannot queue or create a second main reply while the branch is submitting', async t => {
  const held = deferred();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 1) await held.promise; } });
  const first = fx.runtime.send('解释选区');
  assert.equal(fx.runtime.isBusy(), true);
  assert.equal(await fx.runtime.send('解释选区'), false);
  assert.equal(fx.runtime.state.messageQueue.length, 0);
  held.resolve();
  await first;
  await fx.runtime.flush();
  assert.equal(fx.answers().length, 1);
  assert.equal(fx.runtime.state.conversation.messages.length, 2);
});

test('persisted streaming normalization updates only save metadata and cannot stop the live in-memory branch', async t => {
  const fx = fixture(t, { persistedStreamingToStopped: true, transport: request => {
    assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'streaming');
    assert.equal(fx.runtime.state.conversation.syncStatus, 'pending');
    assert.equal(fx.runtime.state.conversation.syncDirectoryName, 'original-dir');
    request.onDelta('仍然生成成功', '仍然生成成功');
    return '仍然生成成功';
  } });
  await fx.runtime.send('解释选区');
  await fx.runtime.flush();
  assert.equal(fx.answers().length, 1);
  assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'complete');
  assert.equal(fx.runtime.state.conversation.messages.at(-1).content, '仍然生成成功');
  assert.equal(fx.records.get(fx.runtime.state.conversation.id).messages.at(-1).status, 'complete');
});

test('necessary save failure stays visible and never starts a model request', async t => {
  const fx = fixture(t, { writeConversation: async () => { throw new Error('磁盘同步入口失败'); } });
  await fx.runtime.send('解释选区');
  assert.equal(fx.answers().length, 0);
  assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'error');
  assert.equal(fx.runtime.isBusy(), false);
  assert.ok(fx.errors.length > 0);
  await assert.rejects(fx.runtime.takeConversation(), /磁盘同步入口失败/);
  assert.equal(fx.runtime.isBusy(), false);
});

test('stop releases a hung request, ignores late output and allows a new question with a unique terminal', async t => {
  const held = deferred();
  let oldRequest;
  const fx = fixture(t, { transport: (request, index) => {
    if (index === 1) { oldRequest = request; request.onDelta('已输出部分', '已输出部分'); return held.promise; }
    request.onDelta('新的回答', '新的回答');
    return '新的回答';
  } });
  const first = fx.runtime.send('原问题');
  await tick();
  fx.runtime.stop();
  await first;
  assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'stopped');
  await fx.runtime.send('新问题');
  oldRequest.onDelta('迟到的旧输出', '迟到的旧输出');
  held.resolve('迟到的旧结果');
  await tick();
  await fx.runtime.flush();
  assert.equal(fx.runtime.state.conversation.messages.at(-1).content, '新的回答');
  assert.equal(fx.runtime.state.conversation.messages[1].content, '已输出部分');
  assert.equal(fx.events.filter(event => event.type === 'run:terminal').length, 2);
});

test('closing during generation cancels local waiting and late callbacks cannot alter the stopped branch', async t => {
  const held = deferred();
  let oldRequest;
  const fx = fixture(t, { transport: request => { oldRequest = request; request.onDelta('部分内容', '部分内容'); return held.promise; } });
  const sending = fx.runtime.send('解释选区');
  await tick();
  fx.runtime.close();
  await sending;
  const stopped = structuredClone(fx.runtime.state.conversation);
  oldRequest.onDelta('迟到输出', '迟到输出');
  held.resolve('迟到输出');
  await tick();
  await fx.runtime.flush();
  assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'stopped');
  assert.equal(fx.runtime.state.conversation.messages.at(-1).content, '部分内容');
  assert.deepEqual(fx.runtime.state.conversation.messages, stopped.messages);
  assert.equal(fx.records.get(stopped.id).messages.at(-1).status, 'stopped');
  assert.equal(await fx.runtime.send('关闭后提问'), false);
});

test('retry replaces the assistant through the existing service without duplicating the selected user turn', async t => {
  const fx = fixture(t);
  await fx.runtime.send('解释选区');
  const before = fx.runtime.state.conversation.messages.at(-1).id;
  await fx.runtime.retry(before);
  await fx.runtime.flush();
  assert.equal(fx.answers().length, 2);
  assert.equal(fx.runtime.state.conversation.messages.filter(item => item.role === 'user').length, 1);
  assert.equal(fx.runtime.state.conversation.messages.filter(item => item.role === 'assistant').length, 1);
  assert.notEqual(fx.runtime.state.conversation.messages.at(-1).id, before);
  assert.equal(fx.runtime.state.conversation.messages[0].selection.text, selection().text);
});

test('takeover requires a settled saved branch and releases its application before returning an independent main object', async t => {
  const held = deferred();
  const fx = fixture(t, { transport: request => { request.onDelta('分支回复', '分支回复'); return held.promise; } });
  await assert.rejects(fx.runtime.takeConversation(), /发送|消息|对话/);
  const sending = fx.runtime.send('解释选区');
  await tick();
  await assert.rejects(fx.runtime.takeConversation(), /停止|结束|运行/);
  held.resolve('分支回复');
  await sending;
  const adopted = await fx.runtime.takeConversation();
  assert.notEqual(adopted, fx.runtime.state.conversation);
  assert.equal(adopted.id, fx.runtime.state.conversation.id);
  assert.equal(adopted.messages.at(-1).status, 'complete');
  adopted.messages.at(-1).content = '主窗口之后的编辑';
  assert.equal(fx.runtime.state.conversation.messages.at(-1).content, '分支回复');
  assert.equal(await fx.runtime.send('浮窗之后提问'), false);
  assert.equal(await fx.runtime.retry(adopted.messages.at(-1).id), false);
  assert.equal(fx.runtime.application.runner.active(), null);
});

test('a hung required takeover save is bounded and cannot allow a second active owner', async t => {
  const held = deferred();
  let holdWrites = false;
  const fx = fixture(t, { flushTimeoutMs: 25, writeConversation: async () => { if (holdWrites) await held.promise; } });
  await fx.runtime.send('解释选区');
  await fx.runtime.flush();
  holdWrites = true;
  const transferring = fx.runtime.takeConversation();
  assert.equal(fx.runtime.isBusy(), true);
  assert.equal(await fx.runtime.send('接管时另一个问题'), false);
  await assert.rejects(transferring, /保存.*超时|等待.*超时/);
  assert.equal(fx.runtime.isBusy(), false);
  held.resolve();
  await fx.runtime.flush();
  const adopted = await fx.runtime.takeConversation();
  assert.equal(adopted.messages.at(-1).status, 'complete');
});

test('optional suggestions arriving during transfer are committed before release and cannot schedule a later branch write', async t => {
  const suggestion = deferred(), writing = deferred();
  const fx = fixture(t, { suggestionsTransport: () => suggestion.promise,
    writeConversation: async (_conversation, count) => { if (count === 3) await writing.promise; } });
  await fx.runtime.send('解释 metadata 选区');
  await fx.runtime.flush();
  const transferring = fx.runtime.takeConversation();
  await tick();
  assert.equal(fx.writes.length, 3);
  suggestion.resolve('[{"question":"metadata 过滤如何设置？","focus":"metadata"}]');
  await tick();
  assert.deepEqual(fx.runtime.state.conversation.messages.at(-1).suggestions, ['metadata 过滤如何设置？']);
  writing.resolve();
  const adopted = await transferring;
  assert.equal(fx.writes.length, 4);
  assert.deepEqual(fx.records.get(adopted.id).messages.at(-1).suggestions, adopted.messages.at(-1).suggestions);
  await tick();
  assert.equal(fx.writes.length, 4);
  assert.equal(await fx.runtime.send('旧窗口发送'), false);
});

test('a failed transfer flush leaves the application usable for follow-up and a later transfer', async t => {
  const suggestion = deferred(), writing = deferred();
  const fx = fixture(t, { suggestionsTransport: () => suggestion.promise,
    writeConversation: async (_conversation, count) => {
      if (count === 3) await writing.promise;
      if (count === 4) throw new Error('后处理保存失败');
    } });
  await fx.runtime.send('解释 metadata 选区');
  await fx.runtime.flush();
  const transferring = fx.runtime.takeConversation();
  await tick();
  suggestion.resolve('[{"question":"metadata 过滤如何设置？","focus":"metadata"}]');
  await tick();
  writing.resolve();
  await assert.rejects(transferring, /后处理保存失败/);
  assert.equal(fx.runtime.isBusy(), false);
  await fx.runtime.send('继续解释 metadata 的来源');
  assert.equal(fx.answers().length, 2);
  assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'complete');
  const adopted = await fx.runtime.takeConversation();
  assert.equal(adopted.messages.length, 4);
});

test('closing during takeover stops the transfer wait while its original queued save remains bound to the branch', async t => {
  const writing = deferred();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 3) await writing.promise; } });
  await fx.runtime.send('解释 metadata 选区');
  await fx.runtime.flush();
  const transferring = fx.runtime.takeConversation();
  await tick();
  fx.runtime.close();
  await assert.rejects(transferring, { name: 'AbortError' });
  writing.resolve();
  await fx.runtime.flush();
  assert.deepEqual(fx.sourceConversation, fx.originalSource);
  assert.equal(fx.writes.at(-1).id, fx.runtime.state.conversation.id);
  assert.equal(await fx.runtime.send('窗口关闭后发送'), false);
});

test('a lost main-navigation owner cannot release the floating application after its save finishes late', async t => {
  const writing = deferred();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 3) await writing.promise; } });
  await fx.runtime.send('解释 metadata 选区');
  await fx.runtime.flush();
  let current = true;
  const transferring = fx.runtime.takeConversation({ isCurrent: () => current });
  await tick();
  current = false;
  writing.resolve();
  await assert.rejects(transferring, { name: 'AbortError' });
  assert.equal(fx.runtime.isBusy(), false);
  await fx.runtime.send('继续解释引用来源');
  assert.equal(fx.answers().length, 2);
  assert.equal(fx.runtime.state.conversation.messages.at(-1).status, 'complete');
});

test('external transfer cancellation stops waiting without closing the floating conversation', async t => {
  const writing = deferred(), controller = new AbortController();
  const fx = fixture(t, { writeConversation: async (_conversation, count) => { if (count === 3) await writing.promise; } });
  await fx.runtime.send('解释 metadata 选区');
  await fx.runtime.flush();
  const transferring = fx.runtime.takeConversation({ signal: controller.signal });
  await tick();
  controller.abort(new DOMException('用户取消对话切换', 'AbortError'));
  await assert.rejects(transferring, { name: 'AbortError' });
  assert.equal(fx.runtime.isBusy(), false);
  writing.resolve();
  await fx.runtime.flush();
  const adopted = await fx.runtime.takeConversation();
  assert.equal(adopted.messages.at(-1).status, 'complete');
});
