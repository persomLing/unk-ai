import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRestartControl, createAgentTaskRestart } from '../src/sidepanel/features/agent/agent-task-restart.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = { tabId: 7, url: 'https://site.test/app?model=2#config', documentId: 'old-document' };
const originalTab = () => ({ id: 7, url: source.url, windowId: 1 });
function fixture(extra = {}) {
  const question = { id: 'question', role: 'user', content: '模型上下文', displayContent: '按参考图生成动画', agentTask: true,
    pageSource: { ...source }, attachments: [{ id: 'image', type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', capture: { documentId: 'image-document' } }] };
  const assistant = { id: 'answer', role: 'assistant', agent: { status: 'failed' } };
  const conversation = { id: 'conversation', messages: [question, assistant] };
  let visible = conversation, activeTab = originalTab(), blocked = '';
  const calls = [];
  const value = createAgentTaskRestart({
    getConversation: () => visible, getBlockReason: () => blocked,
    queryActiveTab: async () => activeTab, getTab: async () => originalTab(),
    activateTab: async id => { calls.push(['activate', id]); activeTab = originalTab(); },
    captureTarget: async () => ({ ...originalTab(), documentId: 'fresh-document' }),
    onTarget: tab => calls.push(['target', tab]), setMode: mode => calls.push(['mode', mode]),
    submit: async (goal, options) => calls.push(['submit', goal, options]),
    notify: message => calls.push(['notify', message]), onPending: pending => calls.push(['pending', pending]),
    timeoutMs: 30, ...extra,
  });
  return { value, conversation, question, assistant, calls,
    show: next => { visible = next; }, tab: next => { activeTab = next; }, block: reason => { blocked = reason; } };
}

test('page-off and unavailable-page restarts stay clickable with a useful explanation', () => {
  assert.equal(agentRestartControl({ pagePreference: false }).disabled, false);
  assert.match(agentRestartControl({ pagePreference: false }).title, /基于当前页/);
  assert.equal(agentRestartControl({ busy: true }).disabled, true);
  assert.match(agentRestartControl().title, /原任务页面/);
});

test('a failed image task restarts once with cloned original images and a freshly captured document', async () => {
  const value = fixture();
  assert.equal(await value.value.restart('answer'), true);
  const [, goal, options] = value.calls.find(([name]) => name === 'submit');
  assert.equal(goal, value.question.displayContent);
  assert.deepEqual(options.attachments, value.question.attachments);
  options.attachments[0].capture.documentId = 'changed';
  assert.equal(value.question.attachments[0].capture.documentId, 'image-document');
  assert.equal((await options.pageTargetPromise).documentId, 'fresh-document');
  assert.equal(options.agentTask, true);
  assert.equal(options.selection, null);
  assert.equal(value.conversation.messages.length, 2, 'restart preparation must not truncate the original turn');
});

test('a missing external original image blocks restart before returning to the page or submitting a new task', async () => {
  let pageQueries = 0;
  const value = fixture({ queryActiveTab: () => { pageQueries++; return originalTab(); } });
  value.question.attachments = [{ id: 'image', type: 'image', name: 'reference.png', imageStorageVersion: 1,
    imagePath: `images/${'a'.repeat(64)}.png`, loadError: '原图片文件缺失，请重新添加。' }];
  const original = structuredClone(value.conversation);
  assert.equal(await value.value.restart('answer'), false);
  assert.equal(pageQueries, 0);
  assert.equal(value.calls.some(([name]) => ['activate', 'mode', 'target', 'submit'].includes(name)), false);
  assert.match(value.calls.find(([name]) => name === 'notify')[1], /reference\.png.*原图片文件缺失/);
  assert.deepEqual(value.conversation, original);
  assert.equal(value.value.isPending(), false);
});

test('restart returns to the still-open original tab even from an unreadable or unrelated active tab', async () => {
  for (const tab of [{ id: 9, url: 'chrome://newtab', windowId: 1 }, { id: 8, url: 'https://other.test', windowId: 1 }]) {
    const value = fixture(); value.tab(tab);
    assert.equal(await value.value.restart('answer'), true);
    assert.deepEqual(value.calls.find(([name]) => name === 'activate'), ['activate', source.tabId]);
    assert.equal(value.calls.filter(([name]) => name === 'submit').length, 1);
  }
});

test('closed original tabs and changed full URLs never rebind to a similar open tab', async () => {
  for (const getTab of [async () => { throw new Error('No tab'); }, async () => ({ ...originalTab(), url: 'https://site.test/app?model=3#config' })]) {
    const value = fixture({ getTab }); value.tab({ id: 8, url: source.url, windowId: 1 });
    assert.equal(await value.value.restart('answer'), false);
    assert.equal(value.calls.some(([name]) => ['activate', 'mode', 'submit'].includes(name)), false);
    assert.match(value.calls.find(([name]) => name === 'notify')[1], /回退.*图片/);
  }
});

test('page-off, busy or independent drafts show their reason without querying or submitting', async () => {
  const value = fixture({ queryActiveTab: () => { throw new Error('must not query'); } });
  value.block('请先开启“基于当前页”再重新开始。');
  assert.equal(await value.value.restart('answer'), false);
  assert.match(value.calls[0][1], /基于当前页/);
  assert.equal(value.value.isPending(), false);
});

test('legacy missing source or mode records get an actionable message', async () => {
  for (const field of ['agentTask', 'pageSource']) {
    const value = fixture(); delete value.question[field];
    assert.equal(await value.value.restart('answer'), false);
    assert.match(value.calls.find(([name]) => name === 'notify')[1], /回退/);
    assert.equal(value.calls.some(([name]) => name === 'submit'), false);
  }
});

test('a conversation switch during a suspended target query cannot activate or submit into the new chat', async () => {
  const pending = deferred();
  const value = fixture({ queryActiveTab: () => pending.promise });
  const starting = value.value.restart('answer');
  value.show({ id: 'new', messages: [] }); pending.resolve(originalTab());
  assert.equal(await starting, false);
  assert.equal(value.calls.some(([name]) => ['activate', 'mode', 'target', 'submit', 'notify'].includes(name)), false);
});

test('duplicate restart clicks and cancellation cannot create two task submissions', async () => {
  const pending = deferred();
  const value = fixture({ captureTarget: () => pending.promise });
  const starting = value.value.restart('answer'); await tick();
  assert.equal(value.value.isPending(), true);
  assert.equal(await value.value.restart('answer'), false);
  value.value.cancel(); assert.equal(await starting, false);
  pending.resolve({ ...originalTab(), documentId: 'late' }); await tick();
  assert.equal(value.calls.some(([name]) => name === 'submit'), false);
  assert.equal(value.value.isPending(), false);
});

test('page permission changes during preparation prevent the next side effect', async () => {
  const pending = deferred();
  const value = fixture({ queryActiveTab: () => pending.promise });
  const starting = value.value.restart('answer'); value.block('页面读取已关闭。'); pending.resolve(originalTab());
  assert.equal(await starting, false);
  assert.equal(value.calls.some(([name]) => ['target', 'mode', 'submit'].includes(name)), false);
  assert.match(value.calls.find(([name]) => name === 'notify')[1], /关闭/);
});

test('capture source changes or bounded query waits leave the original image turn intact', async () => {
  for (const extra of [{ captureTarget: async () => ({ id: 7, url: 'https://site.test/other', documentId: 'new' }) },
    { queryActiveTab: () => new Promise(() => {}), timeoutMs: 5 }]) {
    const value = fixture(extra);
    assert.equal(await value.value.restart('answer'), false);
    assert.equal(value.conversation.messages.length, 2);
    assert.equal(value.question.attachments.length, 1);
    assert.equal(value.calls.some(([name]) => name === 'submit'), false);
    assert.ok(value.calls.some(([name]) => name === 'notify'));
  }
});
