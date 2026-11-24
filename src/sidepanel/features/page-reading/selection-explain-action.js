import { PAGE_SELECTION_ACTION_KEY, normalizePageSelectionAction } from '../../../utils/selection.js';
import { assertPageTarget } from '../../../utils/page-target.js';

export function createSelectionExplainAction({
  storage,
  getTab,
  captureTarget,
  isReady = () => true,
  send,
  notify = () => {},
  locks = globalThis.navigator?.locks,
} = {}) {
  let pending = null;
  let running = '';
  const handled = new Set();

  async function process() {
    const action = pending;
    if (!action || !isReady() || handled.has(action.requestId) || running) return;
    running = action.requestId;
    const run = async () => {
      try {
        const current = await storage.get(PAGE_SELECTION_ACTION_KEY);
        const storedAction = normalizePageSelectionAction(current?.[PAGE_SELECTION_ACTION_KEY]);
        if (storedAction?.requestId !== action.requestId) return;
        const tab = await getTab(action.tabId);
        if (tab?.id !== action.tabId) throw new Error('原网页已关闭，请重新选择内容。');
        if (tab.windowId !== action.windowId) throw new Error('原网页窗口已改变，请回到原窗口重新选择。');
        if (tab.url !== action.url) {
          await storage.set({ [PAGE_SELECTION_ACTION_KEY]: null });
          handled.add(action.requestId);
          if (pending?.requestId === action.requestId) pending = null;
          notify('原网页已变化，请回到原页面重新选择后使用。', 'error');
          return;
        }
        const target = await captureTarget(action, tab);
        assertPageTarget(action, target);
        const latest = normalizePageSelectionAction((await storage.get(PAGE_SELECTION_ACTION_KEY))?.[PAGE_SELECTION_ACTION_KEY]);
        if (latest?.requestId !== action.requestId) return;
        await storage.set({ [PAGE_SELECTION_ACTION_KEY]: null });
        handled.add(action.requestId);
        if (pending?.requestId === action.requestId) pending = null;
        await send({ action, selection: action.selection, target });
      } catch (error) {
        if (pending?.requestId === action.requestId) pending = null;
        handled.add(action.requestId);
        try {
          const latest = normalizePageSelectionAction((await storage.get(PAGE_SELECTION_ACTION_KEY))?.[PAGE_SELECTION_ACTION_KEY]);
          if (latest?.requestId === action.requestId) await storage.set({ [PAGE_SELECTION_ACTION_KEY]: null });
        } catch {}
        notify(error?.message || '无法解释这段选区，请返回原网页重试。', 'error');
      }
    };
    try {
      if (locks?.request) await locks.request(PAGE_SELECTION_ACTION_KEY, run);
      else await run();
    } finally {
      if (running === action.requestId) running = '';
      if (pending && pending.requestId !== action.requestId) void process();
    }
  }

  return Object.freeze({
    receive(value) {
      const action = normalizePageSelectionAction(value);
      if (!action || handled.has(action.requestId)) return Promise.resolve();
      pending = action;
      return process();
    },
    retry() { return process(); },
    dispose() { pending = null; },
  });
}
