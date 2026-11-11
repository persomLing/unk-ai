import { awaitWithAbort, awaitWithTimeout } from '../../../utils/abortable.js';
import { assertPageTarget } from '../../../utils/page-target.js';
import { assertImageAttachmentsAvailable } from '../../../utils/attachments.js';

const fail = message => new Error(message);

/** Keep blocked restarts clickable so the user can see the actual reason. */
export function agentRestartControl({ busy = false, pagePreference = true, independent = false } = {}) {
  return { disabled: busy, title: busy ? '任务正在运行，请先停止'
    : !pagePreference || independent ? '请先开启“基于当前页”再重新开始任务'
      : '返回原任务页面，携带原附件重新开始任务' };
}

/** Restart is a new controlled task on the original tab, not an action replay. */
export function createAgentTaskRestart({ getConversation, getBlockReason = () => '',
  queryActiveTab, getTab, activateTab, captureTarget, onTarget = () => {}, setMode,
  submit, notify = () => {}, onPending = () => {}, timeoutMs = 10000 } = {}) {
  let active = null;
  let disposed = false;
  const current = operation => !disposed && active === operation && !operation.controller.signal.aborted
    && getConversation() === operation.conversation
    && operation.conversation.messages.includes(operation.assistant)
    && operation.conversation.messages.includes(operation.question);
  const assertCurrent = operation => {
    if (!current(operation)) throw new DOMException('重新开始任务已取消。', 'AbortError');
    const blocked = getBlockReason();
    if (blocked) throw fail(blocked);
  };
  const notifyCurrent = (operation, message) => {
    if (getConversation() === operation.conversation && !disposed) notify(message, 'error');
  };
  async function restart(assistantId) {
    if (disposed || active) return false;
    const blocked = getBlockReason();
    if (blocked) { notify(blocked, 'error'); return false; }
    const conversation = getConversation();
    const messages = conversation?.messages;
    if (!Array.isArray(messages)) return false;
    const index = messages.findIndex(message => message.id === assistantId && message.role === 'assistant');
    const assistant = messages[index];
    if (!assistant?.agent || !['failed', 'cancelled'].includes(assistant.agent.status)) return false;
    const question = messages.slice(0, index).findLast(message => message.role === 'user');
    if (!question?.agentTask) { notify('原任务提问记录不完整，请回退到原提问后重新发送。', 'error'); return false; }
    const source = structuredClone(question.pageSource || {});
    if (!/^https?:\/\//i.test(source.url || '')) {
      notify('原任务没有有效的页面来源，请回退到原提问，选择目标页面后重新发送。', 'error'); return false;
    }
    const goal = question.displayContent || question.content || '';
    if (!goal.trim()) { notify('原任务提问为空，请回退编辑后重新发送。', 'error'); return false; }
    const attachments = structuredClone(question.attachments || []);
    try { assertImageAttachmentsAvailable(attachments); }
    catch (error) { notify(error.message, 'error'); return false; }
    const operation = { conversation, assistant, question, controller: new AbortController() };
    const deadline = Date.now() + timeoutMs;
    active = operation;
    onPending(true);
    const wait = pending => awaitWithTimeout(pending, { signal: operation.controller.signal, timeoutMs: Math.max(1, deadline - Date.now()),
      message: '准备重新开始任务超时，原对话和图片已保留，请重试。' });
    try {
      let tab = await wait(queryActiveTab());
      assertCurrent(operation);
      if (Number.isInteger(source.tabId) && tab?.id !== source.tabId) {
        let original;
        try { original = await wait(getTab(source.tabId)); }
        catch (error) {
          if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
          throw fail('原任务标签页已关闭，不能改用另一个标签页。请回退原提问，保留图片后在目标页面重新发送。');
        }
        assertCurrent(operation);
        if (!original || original.id !== source.tabId || original.url !== source.url) {
          throw fail('原任务标签页已关闭或地址已变化。请回退原提问，保留图片后在目标页面重新发送。');
        }
        if (Number.isInteger(tab?.windowId) && Number.isInteger(original.windowId) && tab.windowId !== original.windowId) {
          throw fail('原任务在另一个浏览器窗口，请在原窗口打开侧栏后重新开始。');
        }
        await wait(activateTab(original.id));
        assertCurrent(operation);
        tab = await wait(queryActiveTab());
        assertCurrent(operation);
      }
      try { assertPageTarget({ tabId: source.tabId, url: source.url }, tab); }
      catch { throw fail('当前标签页不是原任务的完整页面地址，请回到原页面，或回退提问后重新发送。'); }
      // Refresh availability from the tab we explicitly returned to; this does
      // not enable a page preference that the user has switched off.
      onTarget(tab);
      assertCurrent(operation);
      const target = await wait(captureTarget(operation.controller.signal));
      assertCurrent(operation);
      try { assertPageTarget({ tabId: tab.id, url: source.url }, target); }
      catch { throw fail('准备期间页面已切换，任务未重新开始；原提问和图片已保留。'); }
      if (setMode(true) === false) throw fail('当前页面未开启页面操作，请核对页面开关后重试。');
      assertCurrent(operation);
      await awaitWithAbort(submit(goal, { fromQueue: true, attachments, selection: null,
        agentTask: true, pageContextEnabled: false, pageTargetPromise: Promise.resolve(target) }), operation.controller.signal);
      return current(operation);
    } catch (error) {
      if (error.name !== 'AbortError') notifyCurrent(operation, error.message || '重新开始失败，原提问和图片已保留。');
      return false;
    } finally {
      operation.controller.abort();
      if (active === operation) { active = null; onPending(false); }
    }
  }
  const cancel = () => { active?.controller.abort(new DOMException('重新开始任务已取消。', 'AbortError')); };
  return Object.freeze({ restart, isPending: () => Boolean(active), cancel,
    dispose() { disposed = true; cancel(); } });
}
