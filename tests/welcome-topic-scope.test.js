import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizeDraftSource } from '../src/sidepanel/features/welcome/draft-source.js';
import { welcomePromptsFor } from '../src/sidepanel/features/welcome/welcome-prompts.js';
import { isReadablePageUrl, pageControlState, pageContextEnabledForNavigation } from '../src/sidepanel/features/page-reading/page-control-state.js';
import { normalizePageContext } from '../src/utils/reading-context.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { createPageReadState } from '../src/sidepanel/features/page-reading/page-read-state.js';
import { createPageQuestionChoice, needsPageQuestionChoice } from '../src/sidepanel/features/page-reading/page-question-choice.js';

const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
function section(begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `missing UI section: ${begin}`);
  return source.slice(start, finish);
}
const uiSource = [
  section('const pageReadState = createPageReadState(', 'function renderQueueBar()'),
  section('function renderQueueBar()', 'async function processQueue()'),
  section('function updatePageToolbar()', 'async function resolveCurrentPageSource('),
  section('async function sendMessage(text = pastedText.getValue(), options = {})', 'function stopActiveReply()'),
  section('const pastedText = createPastedTextDraft(', 'const sourceIcons = createSourceIconFallback('),
  section('let lastSummarizeAt = 0;', 'async function switchToActivePage()'),
  section("input.addEventListener('input',", "input.addEventListener('keydown',"),
  section("$('#welcome')?.addEventListener('click',", "$('#queue-recall')"),
  section("\nconst composerPageToggle = $('#composer-page-toggle');", '// Global outside-click'),
].join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};
const target = { id: 7, tabId: 7, url: 'https://tutorial.test/docs/start', documentId: 'tutorial-doc', title: 'AI 开发教程' };
const tutorial = { ...target, text: 'UNRELATED_TUTORIAL_BODY：智能体与电商系统章节。'.repeat(4), capturedAt: '2026-11-02' };
const topics = welcomePromptsFor(target).topics;

function fixture(t, options = {}) {
  const handlers = new Map(), nodes = new Map(), reads = [], browserCalls = [], payloads = [], modes = [];
  let agentMode = options.agentMode === true;
  let ui;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, checked: true, dataset: { favicon: '' }, textContent: '',
      classList: { add: noop, remove: noop, toggle: noop },
      addEventListener: (event, handler) => handlers.set(`${id}:${event}`, handler),
      querySelector: () => ({ textContent: '' }),
    });
    return nodes.get(id);
  };
  const state = { ready: true, pageContextPreference: true, disablePageContext: false, draftSource: null, activePageSignal: target,
    conversation: { id: 'topic-conversation', messages: [], pageContext: tutorial }, ...options.state };
  const service = createConversationServiceFixture({ state,
    agentSlot: { isMode: () => agentMode },
    ensureConfigured: options.ensureConfigured,
    browser: {
      queryActiveTab: async () => ({ ...state.activePageSignal, id: state.activePageSignal.tabId }),
      sendMessage: async message => {
        browserCalls.push(message);
        return message.type === 'CAPTURE_SITE_RESEARCH'
          ? { error: 'UNSUPPORTED', message: 'Fixture has no directory' } : { ...target };
      },
    },
    readCurrentPageForRequest: async (question, readOptions) => { reads.push({ question, ...readOptions }); return tutorial; },
    generateReply: async assistant => {
      payloads.push(requestMessagesFor(state.conversation, assistant.id, state.conversation.pageContext));
      return 'Configured model response';
    },
    updateComposer: () => ui?.updatePageToolbar(),
  });
  t.after(() => service.service.dispose());
  const input = service.input;
  input.addEventListener = (event, handler) => handlers.set(`input:${event}`, handler);
  input.focus = noop;
  ui = vm.createContext({ state, input, normalizeDraftSource, welcomePromptsFor, normalizePageContext, historyMutationBusy: false,
    createPastedTextDraft: ({ input, onChange }) => ({
      getValue: () => input.value,
      setValue: value => { input.value = value; },
      handleInput: () => onChange(input.value),
    }),
    createPageReadState, createPageQuestionChoice, needsPageQuestionChoice,
    pageControlState, pageContextEnabledForNavigation, isReadablePageUrl,
    application: { conversations: service.service },
    agentTaskRestart: { isPending: () => false, cancel: noop },
    composition: { status: () => ({ status: 'ready' }) },
    readingControls: { update() {} },
    visualPreparation: { cancel: noop },
    $: node, icon: () => '', pageFaviconUrl: () => '',
    agentSlot: { isBusy: () => false, isMode: () => agentMode, setMode: mode => { agentMode = mode; modes.push(mode); } },
    clearPageSelection: () => { state.pageSelection = null; },
    setPageSelection: value => { state.pageSelection = value; },
    resizeInput: noop, renderAttachments: noop, renderWelcomePrompts: noop,
    updateComposer: () => ui.updatePageToolbar(),
    processQueue: () => service.processQueue(), stopActiveReply: () => service.stopActiveReply(),
    truncateText: (text, size) => String(text).slice(0, size), toast: noop,
  });
  vm.runInContext(uiSource, ui);
  return { ...service, state, input, nodes, reads, browserCalls, payloads, modes, ui,
    choose: topicId => handlers.get('#welcome:click')({
      target: { closest: () => ({ dataset: { action: 'fill-prompt', topicId } }) }, preventDefault: noop, stopPropagation: noop,
    }),
    choosePagePrompt: prompt => handlers.get('#welcome:click')({
      target: { closest: () => ({ dataset: { action: 'fill-prompt', prompt } }) }, preventDefault: noop, stopPropagation: noop,
    }),
    edit: text => { input.value = text; handlers.get('input:input')(); },
    setPageEnabled: enabled => { node('#composer-page-toggle').checked = enabled; handlers.get('#composer-page-toggle:change')(); },
    chooseSource: action => handlers.get('#composer-page-choice:click')({ target: { closest: () => ({ dataset: { pageChoice: action } }) } }),
    send: () => ui.sendMessage(),
  };
}

test('topic source normalization clones only the four supported independent descriptors', () => {
  for (const topic of topics) {
    const candidate = { ...topic.draftSource, label: 'Untrusted label', pageContextEnabled: true, agentTask: true, execute: noop };
    const normalized = normalizeDraftSource(candidate);
    assert.deepEqual(normalized, { scope: 'independent', topicId: topic.id, label: topic.label });
    assert.notEqual(normalized, candidate);
    assert.notEqual(normalized, normalizeDraftSource(candidate));
  }
  for (const invalid of [null, '', {}, { scope: 'page', topicId: 'news' }, { scope: 'independent', topicId: '__proto__' }]) {
    assert.equal(normalizeDraftSource(invalid), null);
  }
});

test('navigation changes only availability and keeps manual mode through internal tabs', t => {
  const fx = fixture(t);
  for (const enabled of [false, true]) {
    fx.setPageEnabled(enabled);
    fx.ui.syncActivePageSignal({ id: 8, url: 'https://other.test/page', title: '另一页' });
    fx.ui.updatePageToolbar();
    assert.equal(fx.nodes.get('#composer-page-toggle').checked, enabled);
    fx.ui.syncActivePageSignal({ id: 9, url: 'chrome://newtab' });
    fx.ui.updatePageToolbar();
    assert.equal(fx.state.disablePageContext, true);
    assert.equal(fx.nodes.get('#composer-page-control').hidden, true);
    fx.ui.syncActivePageSignal(target);
    fx.ui.updatePageToolbar();
    assert.equal(fx.nodes.get('#composer-page-toggle').checked, enabled);
  }
});

test('the composer source choice reads only after selection and dispatches once', async t => {
  for (const action of ['page', 'plain']) {
    const fx = fixture(t);
    fx.setPageEnabled(false);
    fx.edit('不太懂这些配置啥的跟我讲一讲');
    await fx.send();
    assert.equal(fx.nodes.get('#composer-page-choice').hidden, false);
    assert.equal(fx.reads.length, 0);
    assert.equal(fx.modelRequests.length, 0);
    fx.chooseSource(action);
    fx.chooseSource(action);
    await tick();
    await tick();
    assert.equal(fx.reads.length, action === 'page' ? 1 : 0);
    assert.equal(fx.modelRequests.length, 1);
    assert.equal(fx.state.disablePageContext, action !== 'page');
  }
});

test('an abandoned suggested-question choice cannot replace a later unrelated submission', async t => {
  const fx = fixture(t);
  fx.setPageEnabled(false);
  fx.edit('总结当前页');
  fx.state.directReplaceReply = true;
  await fx.send();
  assert.equal(fx.state.directReplaceReply, false, 'the pending choice owns the one-shot replace intent');
  fx.edit('解释vCPU是什么');
  assert.equal(fx.nodes.get('#composer-page-choice').hidden, true);
  fx.chooseSource('page');
  assert.equal(fx.modelRequests.length, 0);
  await fx.send();
  assert.equal(fx.modelRequests.length, 1);
  assert.equal(fx.reads.length, 0);
});

test('topic clicks only fill editable independent drafts, turn off Agent and clear the old selection', async t => {
  const attachment = { id: 'file', type: 'document', name: 'notes.txt', text: 'User supplied notes' };
  const fx = fixture(t, { agentMode: true, state: { attachments: [attachment], pageSelection: { text: 'Old tutorial selection', url: target.url } } });
  for (const topic of topics) {
    await fx.choose(topic.id);
    assert.match(fx.input.value, /北京时间/);
    assert.deepEqual(fx.state.draftSource, topic.draftSource);
    assert.equal(fx.state.pageSelection, null);
    assert.deepEqual(fx.state.attachments, [attachment]);
    assert.equal(fx.nodes.get('#composer-page-toggle').checked, false);
    assert.equal(fx.state.disablePageContext, false, 'topic scope must not replace the page visit preference');
    const hint = fx.nodes.get('#composer-mode-hint');
    assert.equal(hint.hidden, false);
    assert.match(hint.textContent, /独立话题.*本轮不携带当前网页/);
    assert.ok(hint.textContent.includes(topic.label));
  }
  assert.ok(fx.modes.every(mode => mode === false));
  assert.equal(fx.modelRequests.length, 0);
  assert.equal(fx.reads.length, 0);
  assert.equal(fx.browserCalls.length, 0);
});

test('editing a nonempty topic keeps its source until the draft is cleared', async t => {
  const fx = fixture(t);
  await fx.choose('news');
  fx.edit('改成最近一周，重点说国内经济政策。');
  assert.equal(fx.state.draftSource.topicId, 'news');
  assert.equal(fx.nodes.get('#composer-page-toggle').checked, false);
  fx.ui.syncActivePageSignal({ id: 8, url: 'https://other.test/article', title: 'Another page' });
  fx.ui.updatePageToolbar();
  assert.equal(fx.state.draftSource.topicId, 'news', 'navigation cannot broaden a draft into a page request');
  assert.equal(fx.nodes.get('#composer-page-toggle').checked, false);
  fx.edit('   ');
  assert.equal(fx.state.draftSource, null);
  fx.edit('解释当前网页的主要观点');
  assert.equal(fx.state.draftSource, null);
  assert.equal(fx.nodes.get('#composer-page-toggle').checked, true);
});

test('explicitly enabling the page clears independent scope and immediately updates the visible control', async t => {
  const fx = fixture(t);
  await fx.choose('news');
  fx.setPageEnabled(true);
  assert.equal(fx.state.draftSource, null);
  assert.equal(fx.state.disablePageContext, false);
  assert.equal(fx.nodes.get('#composer-page-toggle').checked, true);
  assert.equal(fx.nodes.get('#composer-mode-hint').hidden, true);
});

test('a normal page shortcut replaces the topic scope and reads the requested page when sent', async t => {
  const fx = fixture(t);
  await fx.choose('news');
  await fx.choosePagePrompt('这份文档有哪些容易忽略的使用前提？');
  assert.equal(fx.state.draftSource, null);
  await fx.send();
  assert.equal(fx.reads.length, 1);
  assert.equal(fx.state.conversation.messages[0].pageSource.url, target.url);
});

test('explicit page summarization clears a topic and uses a page summary instead of its news draft', async t => {
  const fx = fixture(t);
  await fx.choose('news');
  await fx.ui.summarizePage();
  assert.equal(fx.state.draftSource, null);
  assert.equal(fx.reads.length, 1);
  assert.match(fx.reads[0].question, /总结这个网页/);
  assert.doesNotMatch(fx.reads[0].question, /近24小时/);
});

for (const topic of topics) {
  test(`${topic.label}: direct sending keeps explicit files but excludes a late page selection and cached tutorial`, async t => {
    const attachment = { id: 'explicit-file', type: 'document', name: 'notes.txt', text: 'USER_SUPPLIED_NOTES' };
    const fx = fixture(t, { state: { attachments: [attachment] } });
    await fx.choose(topic.id);
    fx.edit(`${fx.input.value}\n请再简洁一些。`);
    // A browser selection update may arrive after the topic click cleared it.
    fx.state.pageSelection = { text: 'UNRELATED_TUTORIAL_BODY', url: target.url };
    await fx.send();
    assert.equal(fx.modelRequests.length, 1, fx.notices.join('\n'));
    const user = fx.state.conversation.messages.find(message => message.role === 'user');
    assert.deepEqual(user.requestSource, topic.draftSource);
    assert.equal(user.selection, null);
    assert.equal(user.pageSource, null);
    assert.equal(user.pageContextEnabled, false);
    assert.equal(user.readingPolicy.scope, 'none');
    assert.deepEqual(user.attachments, [attachment]);
    assert.equal(fx.reads.length, 0);
    assert.equal(fx.browserCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(fx.payloads), /UNRELATED_TUTORIAL_BODY/);
    assert.equal(fx.state.draftSource, null);
  });

  test(`${topic.label}: an edited topic sends, queues and retries without reading or attaching the tutorial`, async t => {
    const fx = fixture(t);
    await fx.choose(topic.id);
    fx.edit(`${fx.input.value}\n请保留原有范围，补充简短背景。`);
    fx.state.generatingId = fx.state.conversation.id;
    await fx.send();
    const queued = fx.state.messageQueue[0];
    assert.deepEqual(queued.requestSource, topic.draftSource);
    assert.equal(queued.pageContextEnabled, false);
    assert.equal(queued.readingPolicy.scope, 'none');
    assert.equal(queued.agentTask, false);
    assert.equal(fx.state.draftSource, null);
    fx.ui.renderQueueBar();
    assert.match(fx.nodes.get('#queue-preview').textContent, /^独立话题 · /);
    fx.state.disablePageContext = true;
    fx.state.generatingId = null;
    await fx.processQueue();
    await tick();
    assert.equal(fx.modelRequests.length, 1, fx.notices.join('\n'));
    const user = fx.state.conversation.messages.find(message => message.role === 'user');
    assert.deepEqual(user.requestSource, topic.draftSource);
    assert.equal(user.pageContextEnabled, false);
    assert.equal(user.pageSource, null);
    assert.equal(user.readingPolicy.scope, 'none');
    fx.state.disablePageContext = false;
    const assistantId = fx.state.conversation.messages.find(message => message.role === 'assistant').id;
    await fx.regenerate(assistantId);
    assert.equal(fx.modelRequests.length, 2, fx.notices.join('\n'));
    assert.equal(fx.state.conversation.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(fx.state.conversation.messages.filter(message => message.role === 'assistant').length, 1);
    assert.equal(fx.reads.length, 0);
    assert.equal(fx.browserCalls.length, 0, 'independent topics need neither page identity binding nor directory/selection capture');
    for (const payload of fx.payloads) assert.doesNotMatch(JSON.stringify(payload), /UNRELATED_TUTORIAL_BODY/);
  });
}

test('recalling a queued topic restores its source and preserves it through edits and a direct send', async t => {
  const fx = fixture(t, { state: { generatingId: 'topic-conversation' } });
  await fx.choose('ai');
  await fx.send();
  const queuedSource = fx.state.messageQueue[0].requestSource;
  fx.ui.recallQueueItem();
  assert.deepEqual(fx.state.draftSource, queuedSource);
  assert.notEqual(fx.state.draftSource, queuedSource);
  assert.equal(fx.nodes.get('#composer-page-toggle').checked, false);
  fx.edit(`${fx.input.value}\n只保留正式发布。`);
  fx.state.generatingId = null;
  await fx.send();
  assert.equal(fx.modelRequests.length, 1);
  assert.equal(fx.reads.length, 0);
  assert.equal(fx.state.conversation.messages[0].requestSource.topicId, 'ai');
});

test('configuration refusal restores the topic draft and its source together', async t => {
  let configured = false;
  const fx = fixture(t, { ensureConfigured: async () => configured });
  await fx.choose('tech');
  const original = fx.input.value;
  await fx.send();
  assert.equal(fx.input.value, original);
  assert.equal(fx.state.draftSource.topicId, 'tech');
  assert.equal(fx.nodes.get('#composer-page-toggle').checked, false);
  assert.equal(fx.modelRequests.length, 0);
  configured = true;
  await fx.send();
  assert.equal(fx.modelRequests.length, 1);
  assert.equal(fx.reads.length, 0);
});

test('a consumed topic does not change the source of a later ordinary page question', async t => {
  const fx = fixture(t);
  await fx.choose('business');
  await fx.send();
  assert.equal(fx.state.draftSource, null);
  assert.equal(fx.reads.length, 0);
  fx.edit('解释当前网页的主要观点');
  await fx.send();
  assert.equal(fx.reads.length, 1);
  assert.equal(fx.state.conversation.messages.filter(message => message.role === 'user').at(-1).pageSource.url, target.url);
});
