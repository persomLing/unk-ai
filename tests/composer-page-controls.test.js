import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizePageContext } from '../src/utils/reading-context.js';
import { normalizeDraftSource } from '../src/sidepanel/features/welcome/draft-source.js';
import {
  isReadablePageUrl,
  pageContextEnabledForNavigation,
  pageControlState,
  pageFaviconUrl,
} from '../src/sidepanel/features/page-reading/page-control-state.js';

const source = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
function section(begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `missing composer UI section: ${begin}`);
  return source.slice(start, finish);
}
// Exercise the real entry's DOM projection and page-switch handlers only.
// Agent execution and conversation services retain their direct-import tests.
const toolbarSource = section('function updatePageToolbar()', 'function activePageSignal(');
const pageModeSource = section('function setPageMode(enabled)', 'function renderQueueBar()');
const navigationSource = section('function activePageSignal(', 'async function resolveCurrentPageSource(');
const sendSource = section('async function sendMessage(text = pastedText.getValue(), options = {})', 'function stopActiveReply()');
const regenerateSource = section('async function regenerate(assistantId)', 'async function exportChat(');
const article = { tabId: 7, url: 'https://example.test/article', title: 'Article' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden: false, disabled: false, checked: false, textContent: '', title: '', dataset: {},
    classList: {
      toggle(name, value) { value ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    querySelector() { return null; },
  };
}

function fixture({ active = article, enabled = true, mode = false, busy = false, historyMutationBusy = false, draftSource = null, stopWait, restartPending = false } = {}) {
  const nodes = new Map();
  for (const id of ['composer', 'composer-page-control', 'composer-page-toggle', 'composer-page-pill',
    'composer-page-name', 'composer-page-mode', 'composer-page-status', 'composer-mode-hint',
    'composer-modes', 'agent-toggle']) nodes.set(`#${id}`, element());
  nodes.set('.composer-modes', nodes.get('#composer-modes'));
  nodes.get('#composer').querySelector = selector => nodes.get(selector) || null;
  const state = {
    ready: true, activePageSignal: active, pageContextPreference: enabled,
    disablePageContext: !enabled || !active, draftSource, draftPageTarget: null,
    conversation: { id: 'conversation', messages: [] }, attachments: [],
  };
  const input = { value: '', placeholder: '' };
  const agent = { mode, busy };
  const calls = [];
  let context;
  const agentSlot = {
    isMode: () => agent.mode,
    isBusy: () => agent.busy,
    setMode(value) { agent.mode = value; calls.push(['mode', value]); },
    async stop(reason) { calls.push(['stop-agent', reason]); agent.busy = false; await stopWait; },
  };
  context = vm.createContext({
    state, input, agentSlot, normalizePageContext, normalizeDraftSource, historyMutationBusy,
    pastedText: { getValue: () => input.value, setValue: value => { input.value = value; } },
    agentTaskRestart: { isPending: () => restartPending, cancel: () => { restartPending = false; calls.push(['cancel-restart']); } },
    composition: { status: () => ({ status: 'ready' }) },
    isReadablePageUrl, pageContextEnabledForNavigation, pageControlState, pageFaviconUrl,
    $: selector => nodes.get(selector) || null,
    document: { querySelector: selector => nodes.get(selector) || null },
    pageQuestionChoice: { refresh() {}, clear() {}, offer: () => calls.push(['page-choice']) },
    readingControls: { update() {} },
    pageReadState: { current: () => null }, needsPageQuestionChoice: () => false,
    application: { conversations: { sendMessage: (text, options) => { calls.push(['submit', text, options]); return 'submitted'; },
      regenerate: id => { calls.push(['retry', id]); return 'retried'; } } },
    updateComposer: () => { calls.push(['composer']); context.updatePageToolbar(); },
    renderQueueBar: () => calls.push(['queue']), processQueue: () => calls.push(['process-queue']),
    stopActiveReply: () => calls.push(['stop-reply']),
    visualPreparation: { cancel: () => calls.push(['cancel-visual']) },
    renderWelcomePrompts: () => calls.push(['welcome']),
    toast: (...args) => calls.push(['toast', ...args]),
  });
  vm.runInContext(`${pageModeSource}\n${toolbarSource}\n${navigationSource}\n${sendSource}\n${regenerateSource}`, context);
  return { state, input, agent, calls, node: id => nodes.get(id),
    render: () => context.updatePageToolbar(),
    setPageMode: enabled => context.setPageMode(enabled),
    send: (text, options) => context.sendMessage(text, options),
    retry: id => context.regenerate(id),
    navigate: tab => { context.syncActivePageSignal(tab); context.updatePageToolbar(); },
  };
}

test('Enter and normal retry dispatch cannot enter the service while a task restart is preparing', async () => {
  const value = fixture({ restartPending: true });
  value.input.value = '原来输入框里有一份草稿';
  await value.send(value.input.value);
  await value.retry('answer');
  assert.equal(value.calls.some(([name]) => name === 'submit' || name === 'retry'), false);
  assert.equal(value.input.value, '原来输入框里有一份草稿');
  assert.ok(value.calls.filter(([name, text]) => name === 'toast' && /准备重新开始/.test(text)).length === 2);
});

test('closing page mode cancels restart preparation synchronously and cancels a pending submission too', () => {
  const value = fixture({ restartPending: true, mode: true });
  value.state.isSubmitting = true;
  value.setPageMode(false);
  assert.deepEqual(value.calls[0], ['cancel-restart']);
  assert.equal(value.calls.some(([name]) => name === 'stop-reply'), true);
  assert.equal(value.state.pageContextPreference, false);
});

test('an unreadable page removes the page source, optional mode row and plain-mode hint', () => {
  const value = fixture({ active: null });
  value.render();
  assert.equal(value.node('#composer-page-control').hidden, true);
  assert.equal(value.node('#composer-modes').hidden, true, 'hide the whole row so its spacing is removed');
  assert.equal(value.node('#composer-mode-hint').hidden, true);
  assert.equal(value.node('#composer-page-status').hidden, true);
  assert.equal(value.input.placeholder, '输入问题…');
});

test('history mutations keep draft submission out of the conversation service until navigation settles', async () => {
  const value = fixture({ historyMutationBusy: true });
  await value.send('尚未发送的草稿');
  assert.equal(value.calls.some(call => call[0] === 'submit'), false);
  assert.equal(value.calls.some(call => call[0] === 'toast' && call[1].includes('整理历史对话')), true);
});

test('ordinary questions retain the readable-page switch but no operation row or status text', () => {
  const value = fixture({ enabled: false });
  value.render();
  assert.equal(value.node('#composer-page-control').hidden, false, 'the switch remains available to opt in');
  assert.equal(value.node('#composer-page-toggle').checked, false);
  assert.equal(value.node('#composer-modes').hidden, true);
  assert.equal(value.node('#composer-page-status').hidden, true);
  assert.equal(value.node('#composer-mode-hint').hidden, true);
});

test('enabling page mode restores the page-operation option and required-read status', () => {
  const value = fixture({ enabled: false });
  value.render();
  value.setPageMode(true);
  assert.equal(value.state.disablePageContext, false);
  assert.equal(value.node('#composer-page-toggle').checked, true);
  assert.equal(value.node('#composer-modes').hidden, false);
  assert.equal(value.node('#composer-page-status').hidden, false);
  assert.match(value.node('#composer-page-status').textContent, /发送时读取/);
});

test('page operations keep their required page switch visibly on and allow it to be closed', () => {
  const value = fixture({ mode: true });
  value.render();
  assert.equal(value.node('#composer-page-toggle').checked, true);
  assert.equal(value.node('#composer-page-toggle').disabled, false);
  assert.equal(value.node('#composer-page-mode').textContent, '基于当前页');
  assert.equal(value.node('#composer-modes').hidden, false);
  assert.equal(value.node('#composer-mode-hint').hidden, false);
  assert.match(value.node('#composer-mode-hint').textContent, /页面动作/);
});

test('page synchronization refreshes operation availability and preserves the idle exit button', () => {
  const value = fixture({ active: null });
  value.render();
  assert.equal(value.node('#agent-toggle').disabled, true);
  value.navigate({ id: 7, url: article.url, title: article.title });
  assert.equal(value.node('#composer-page-toggle').checked, true);
  assert.equal(value.node('#agent-toggle').disabled, false, 'navigation alone refreshes the available button');
  value.setPageMode(false);
  assert.equal(value.node('#agent-toggle').disabled, true);
  value.setPageMode(true);
  assert.equal(value.node('#agent-toggle').disabled, false);
  value.agent.mode = true;
  value.render();
  assert.equal(value.node('#agent-toggle').disabled, false, 'an idle operation mode can still be exited');
  assert.equal(value.node('#agent-toggle').title, '关闭页面操作');
  value.agent.busy = true;
  value.render();
  assert.equal(value.node('#agent-toggle').disabled, true);
  assert.equal(value.node('#composer-page-toggle').disabled, false, 'the page switch can still cancel the running task');
});

test('independent topics retain their scope hint and hide page-operation affordances', () => {
  const value = fixture({ draftSource: { scope: 'independent', topicId: 'news' } });
  value.render();
  assert.equal(value.node('#composer-page-toggle').checked, false);
  assert.equal(value.node('#composer-modes').hidden, true);
  assert.equal(value.node('#composer-mode-hint').hidden, false);
  assert.match(value.node('#composer-mode-hint').textContent, /独立话题.*国内外大事/);
});

test('closing page mode stops active page operations and does not reopen the page preference', async () => {
  const value = fixture({ mode: true, busy: true });
  value.setPageMode(false);
  assert.equal(value.state.pageContextPreference, false);
  assert.equal(value.state.disablePageContext, true);
  assert.equal(value.node('#composer-page-toggle').checked, false);
  assert.equal(value.node('#composer-modes').hidden, true);
  assert.equal(value.calls.filter(([name]) => name === 'stop-agent').length, 1);
  assert.equal(value.calls.some(([name]) => name === 'stop-reply'), false);
  await tick();
  assert.equal(value.agent.mode, false);
  assert.equal(value.state.pageContextPreference, false);
});

test('a late Agent stop settlement cannot close a newly enabled page-operation mode', async () => {
  let finishStop;
  const stopWait = new Promise(resolve => { finishStop = resolve; });
  const value = fixture({ mode: true, busy: true, stopWait });
  value.setPageMode(false);
  assert.equal(value.agent.mode, false, 'closing the mode does not wait for background cleanup');
  value.setPageMode(true);
  value.agent.mode = true;
  value.render();
  finishStop();
  await tick();
  assert.equal(value.state.pageContextPreference, true);
  assert.equal(value.agent.mode, true);
  assert.equal(value.node('#composer-page-toggle').checked, true);
});

test('navigation restores the chosen page mode without leaving ordinary-mode rows visible', () => {
  for (const enabled of [false, true]) {
    const value = fixture({ enabled });
    value.navigate({ id: 8, url: 'chrome://newtab' });
    assert.equal(value.state.pageContextPreference, enabled);
    assert.equal(value.node('#composer-page-control').hidden, true);
    assert.equal(value.node('#composer-modes').hidden, true);
    assert.equal(value.node('#composer-mode-hint').hidden, true);
    value.navigate({ id: 9, url: 'https://example.test/other', title: 'Other' });
    assert.equal(value.node('#composer-page-control').hidden, false);
    assert.equal(value.node('#composer-page-toggle').checked, enabled);
    assert.equal(value.node('#composer-modes').hidden, !enabled);
    assert.equal(value.node('#composer-page-status').hidden, !enabled);
  }
});

test('the UI submission boundary refuses stale or explicit Agent requests without page mode', async () => {
  for (const setup of [
    { enabled: false, mode: true },
    { enabled: false },
    { active: null },
    { draftSource: { scope: 'independent', topicId: 'news' } },
  ]) {
    const value = fixture(setup);
    value.input.value = '保留这份任务草稿';
    await value.send(value.input.value, { agentTask: true });
    assert.equal(value.calls.some(([name]) => name === 'submit'), false);
    assert.equal(value.calls.some(([name]) => name === 'page-choice'), false);
    assert.equal(value.input.value, '保留这份任务草稿');
    assert.match(value.calls.find(([name]) => name === 'toast')?.[1] || '', /基于当前页/);
  }
});

test('enabled page operations and ordinary questions each reach the existing submit path once', async () => {
  for (const [setup, options] of [[{ mode: true }, { agentTask: true }], [{ enabled: false }, {}]]) {
    const value = fixture(setup);
    value.input.value = '任务内容';
    assert.equal(await value.send(value.input.value, options), 'submitted');
    const submissions = value.calls.filter(([name]) => name === 'submit');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0][1], '任务内容');
    assert.equal(submissions[0][2], options);
  }
});
