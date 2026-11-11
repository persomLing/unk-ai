import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizePageSelection } from '../src/utils/selection.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { normalizeDraftSource } from '../src/sidepanel/features/welcome/draft-source.js';
import { isReadablePageUrl } from '../src/sidepanel/features/page-reading/page-control-state.js';
import { needsPageQuestionChoice } from '../src/sidepanel/features/page-reading/page-question-choice.js';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { appendArticleQuote, updateArticleQuote } from '../src/sidepanel/features/messages/article-quote-draft.js';

// These are entry-owned UI adapters. The main submission still uses the real
// ConversationService, repository and TurnRunner rather than copied core code.
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
function section(begin, end) {
  const start = entry.indexOf(begin), finish = entry.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `missing UI adapter: ${begin}`);
  return entry.slice(start, finish);
}
const uiSource = [
  section('function articleQuoteMutationBlocked() {', 'async function replaceWithSelectionChat('),
  section('function setPageSelection(value) {', 'function renderAttachments()'),
  section('const articleSelectionMenu = createArticleSelectionMenu(', 'let replyPaintPending = false;'),
  section('async function sendMessage(text = pastedText.getValue(), options = {})', 'function stopActiveReply()'),
  section('function watchSelectionInteractions() {', '\ninitialize();'),
].join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const noop = () => {};
const active = { id: 22, tabId: 22, url: 'https://unrelated.test/current', documentId: 'unrelated-document', title: '另一网页' };
const quote = {
  source: 'conversation', sourceVersion: 1, conversationId: 'original-conversation', messageId: 'original-answer',
  role: 'assistant', text: '配额只在成功请求时扣减。', context: '请求有缓存时复用结果。配额只在成功请求时扣减。失败保留明确状态。',
  question: '缓存和配额之间是什么关系？', title: '缓存机制', heading: '请求额度', selectedAt: '2026-11-11T03:00:00.000Z',
};

function fixture(t, options = {}) {
  const timers = [], requests = [], tabQueries = [], pageReads = [], visualReads = [], payloads = [], submitted = [], modes = [];
  const focusListeners = [], pointerListeners = [], notices = [];
  let menu, mode = options.agentMode === true, focusCount = 0, choiceClears = 0, choiceOffers = 0;
  const state = {
    ready: true, disablePageContext: false, activePageSignal: active,
    conversation: { id: 'original-conversation', messages: [
      { id: 'original-question', role: 'user', content: quote.question, status: 'complete' },
      { id: 'original-answer', role: 'assistant', content: quote.context, status: 'complete' },
    ], pageContext: { ...active, text: 'UNRELATED_PAGE_BODY 不属于原回答。', capturedAt: '2026-11-11' } },
    ...options.state,
  };
  const chrome = {
    tabs: {
      query: (query, callback) => {
        tabQueries.push(query);
        if (callback) { callback([active]); return; }
        return Promise.resolve([active]);
      },
      sendMessage: async (tabId, message) => { requests.push({ ...message, tabId }); return {}; },
    },
    runtime: { sendMessage: async message => {
      requests.push(message);
      if (message.type === 'GET_PAGE_SELECTION') return options.selectionResponse ? options.selectionResponse(message) : { selection: null };
      return {};
    } },
  };
  const value = createConversationServiceFixture({ state,
    agentSlot: { isMode: () => mode, isBusy: () => options.agentBusy === true,
      start: async () => { throw new Error('a conversation quotation must not start Agent'); } },
    browser: {
      queryActiveTab: async () => { tabQueries.push({ fromService: true }); return active; },
      sendMessage: chrome.runtime.sendMessage,
    },
    readCurrentPageForRequest: async (question, request) => { pageReads.push({ question, request }); return state.conversation.pageContext; },
    autoVisualAttachments: async (...args) => { visualReads.push(args); return []; },
    generateReply: async assistant => {
      payloads.push(requestMessagesFor(state.conversation, assistant.id, state.conversation.pageContext));
      return '引用内容的解释';
    },
  });
  t.after(() => value.service.dispose());
  value.input.focus = () => { focusCount++; };
  const ui = vm.createContext({ state, input: value.input, chrome, selectionClearing: false,
    pastedText: { getValue: () => value.input.value, setValue: text => { value.input.value = text; } },
    document: { addEventListener: (type, handler) => { if (type === 'pointerdown') pointerListeners.push(handler); } },
    window: { addEventListener: (type, handler) => { if (type === 'focus') focusListeners.push(handler); } },
    messagesElement: {}, createArticleSelectionMenu: ports => { menu = ports; return {}; },
    normalizePageSelection, normalizeDraftSource, isReadablePageUrl, needsPageQuestionChoice, appendArticleQuote,
    renderPageSelection: noop, updateComposer: noop,
    agentSlot: { isMode: () => mode, isBusy: () => options.agentBusy === true,
      setMode: next => { mode = next; modes.push(next); } },
    agentTaskRestart: { isPending: () => false }, historyMutationBusy: false,
    pageQuestionChoice: { clear: () => { choiceClears++; }, offer: () => { choiceOffers++; } },
    application: { conversations: { sendMessage: (text, request) => {
      submitted.push({ text, request }); return value.service.sendMessage(text, request);
    } } },
    toast: message => notices.push(message),
    setTimeout: callback => { timers.push(callback); return timers.length; },
  });
  vm.runInContext(`${uiSource}\nwatchSelectionInteractions();`, ui);
  return { ...value, ui, timers, requests, tabQueries, pageReads, visualReads, payloads, submitted, modes, notices,
    get focusCount() { return focusCount; }, get choiceClears() { return choiceClears; }, get choiceOffers() { return choiceOffers; },
    quote: (selection, comment = '') => menu.onQuote(selection, null, comment),
    send: text => { value.input.value = text; return ui.sendMessage(); },
    focus: () => focusListeners.forEach(handler => handler()),
    pointer: () => pointerListeners.forEach(handler => handler({ target: { closest: () => null } })),
    runTimer: () => timers.shift()?.(),
  };
}

test('quoting an answer submits through the main service without reading the newly active webpage or starting Agent', async t => {
  const value = fixture(t, { agentMode: true, state: { draftSource: { scope: 'independent', topicId: 'ai' } } });
  value.quote(quote);
  assert.deepEqual(value.modes, [false]);
  assert.equal(value.state.draftSource, null);
  assert.equal(value.focusCount, 1);
  assert.equal(value.state.pageSelection.source, 'conversation');
  await value.send('这里的配额指什么？');
  assert.equal(value.submitted.length, 1);
  const options = value.submitted[0].request;
  assert.equal(options.directModelRequest, true);
  assert.equal(options.pageContextEnabled, false);
  assert.equal(options.agentTask, false);
  assert.equal(await options.pageTargetPromise, null);
  assert.equal(value.tabQueries.length, 0);
  assert.equal(value.requests.length, 0);
  assert.equal(value.pageReads.length, 0);
  assert.equal(value.visualReads.length, 0);
  assert.equal(value.choiceOffers, 0);
  assert.equal(value.modelRequests.length, 1);
  const user = value.state.conversation.messages.at(-2);
  assert.equal(user.pageContextEnabled, false);
  assert.equal(user.agentTask, false);
  assert.equal(user.selection.messageId, quote.messageId);
  assert.equal(user.selection.question, quote.question);
  assert.equal(user.selection.context, quote.context);
  const payload = JSON.stringify(value.payloads[0]);
  assert.match(payload, /缓存和配额之间是什么关系/);
  assert.match(payload, /配额只在成功请求时扣减/);
  assert.match(payload, /请求有缓存时复用结果/);
  assert.doesNotMatch(payload, /UNRELATED_PAGE_BODY|https:\/\/unrelated\.test/);
  assert.equal(value.state.conversation.messages.filter(message => message.role === 'assistant').length, 2);
  assert.equal(value.state.conversation.messages.at(-1).status, 'complete');
});

for (const [name, selection] of [['a new webpage selection', { text: '新活动页选区', url: active.url, selectedAt: 'late' }], ['an empty webpage selection', null]]) {
  test(`an explicitly quoted answer survives a late refresh containing ${name}`, async t => {
    const response = deferred();
    const value = fixture(t, { selectionResponse: () => response.promise });
    value.focus();
    const pending = value.runTimer();
    await tick();
    assert.equal(value.requests.length, 1);
    assert.equal(value.requests[0].type, 'GET_PAGE_SELECTION');
    value.quote(quote);
    const captured = value.state.pageSelection;
    response.resolve({ selection });
    await pending;
    assert.equal(value.state.pageSelection, captured);
    assert.equal(value.state.pageSelection.messageId, quote.messageId);
  });
}

test('clearing a conversation quotation is local and permits the next webpage selection immediately', t => {
  const value = fixture(t);
  value.quote(quote);
  value.ui.clearPageSelection();
  assert.equal(value.state.pageSelection, null);
  assert.equal(value.requests.length, 0);
  assert.equal(value.tabQueries.length, 0);
  assert.equal(value.timers.length, 0);
  value.ui.setPageSelection({ text: '明确重新捕获的网页内容', url: active.url, selectedAt: 'new' });
  assert.equal(value.state.pageSelection.text, '明确重新捕获的网页内容');
  assert.equal(value.state.pageSelection.url, active.url);
});

test('clearing a webpage selection retains the browser clear actions and brief recapture guard', async t => {
  const value = fixture(t);
  value.ui.setPageSelection({ text: '网页选区', url: active.url, selectedAt: 'before' });
  value.ui.clearPageSelection();
  assert.equal(value.state.pageSelection, null);
  assert.equal(value.tabQueries.length, 1);
  assert.equal(value.requests.length, 2);
  assert.ok(value.requests.every(message => message.type === 'CLEAR_PAGE_SELECTION'));
  assert.equal(value.requests[1].tabId, active.id);
  value.ui.setPageSelection({ text: '迟到的旧网页选区', url: active.url, selectedAt: 'late' });
  assert.equal(value.state.pageSelection, null);
  await value.runTimer();
  value.ui.setPageSelection({ text: '新网页选区', url: active.url, selectedAt: 'new' });
  assert.equal(value.state.pageSelection.text, '新网页选区');
});

test('a busy Agent prevents quoting from changing the current selection or mode', t => {
  const oldSelection = { text: '原网页选区', url: active.url };
  const value = fixture(t, { agentMode: true, agentBusy: true, state: { pageSelection: oldSelection } });
  value.quote(quote);
  assert.equal(value.state.pageSelection, oldSelection);
  assert.equal(value.modes.length, 0);
  assert.equal(value.focusCount, 0);
  assert.equal(value.choiceClears, 0);
  assert.match(value.notices.join(' '), /停止页面操作/);
});

test('two reference notes preserve the existing draft and enter one ordinary reply with their semantic sources', async t => {
  const value = fixture(t);
  value.input.value = '已有的总问题草稿';
  value.quote(quote, '这里的额度为什么只计算成功请求？');
  const nextQuote = { ...quote, text: '失败保留明确状态。', heading: '请求失败', context: '配额只在成功请求时扣减。失败保留明确状态。', selectedAt: '2026-11-11T03:01:00.000Z' };
  value.quote(nextQuote, '失败时如何确认没有扣额度？');
  assert.equal(value.input.value, '已有的总问题草稿');
  assert.equal(value.state.pageSelection.sourceVersion, 2);
  assert.equal(value.state.pageSelection.annotations.length, 2);
  assert.equal(value.state.articleQuoteDraftOwnerId, value.state.conversation.id);
  await value.send('请分别解释这两条引用。');
  assert.equal(value.submitted.length, 1);
  assert.equal(value.pageReads.length, 0);
  assert.equal(value.visualReads.length, 0);
  const request = JSON.stringify(value.payloads[0]);
  assert.equal(request.split('这里的额度为什么只计算成功请求？').length - 1, 1);
  assert.equal(request.split('失败时如何确认没有扣额度？').length - 1, 1);
  assert.ok(request.includes('缓存和配额之间是什么关系？'));
  assert.ok(request.includes('请求失败'));
  assert.ok(!request.includes('UNRELATED_PAGE_BODY'));
});

test('editing an existing reference note changes the full selection even when the original text and timestamp stay fixed', t => {
  const value = fixture(t);
  value.quote(quote, '先解释缓存。');
  const first = value.state.pageSelection;
  const edited = updateArticleQuote(first, first.annotations[0].id, '再说明缓存失效。');
  value.ui.setPageSelection(edited);
  assert.equal(value.state.pageSelection.annotations[0].comment, '再说明缓存失效。');
  assert.equal(first.annotations[0].comment, '先解释缓存。');
});

test('a late reference confirmation cannot add a source from a conversation that is no longer visible', t => {
  const value = fixture(t);
  value.state.conversation = { id: 'different-conversation', messages: [] };
  assert.throws(() => value.quote(quote, '迟到注释'), /当前对话已切换/);
  assert.equal(value.state.pageSelection, undefined);
});

test('submission preparation cannot overwrite a newly modified annotation because new confirmations wait for preparation to finish', t => {
  const value = fixture(t);
  value.quote(quote, '已有注释');
  const previous = value.state.pageSelection;
  value.state.isSubmitting = true;
  assert.throws(() => value.quote(quote, '准备时的修改'), /正在准备发送/);
  assert.equal(value.state.pageSelection, previous);
  value.state.generatingId = value.state.conversation.id;
  value.quote({ ...quote, selectedAt: '2026-11-11T04:00:00.000Z' }, '生成中的下一问');
  assert.equal(value.state.pageSelection.annotations.length, 2);
  assert.equal(previous.annotations.length, 1);
});
