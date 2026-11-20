import { NEXT_EXPLORATION_KEY, watchNextExploration } from '../sidepanel/features/messages/suggestion-preference.js';
import { awaitWithTimeout } from '../utils/abortable.js';

export function installSuggestionSettings({ toggle, feedback, storage, changes }) {
  const controller = new AbortController();
  let enabled = true;
  let available = false;
  let saving = false;
  let revision = 0;
  const render = () => {
    toggle.checked = enabled;
    toggle.disabled = !available || saving;
  };
  const stopWatching = watchNextExploration({ storage, changes, onChange(value) {
    revision += 1;
    available = true;
    enabled = value;
    if (!saving) feedback.textContent = '';
    render();
  }, onError(error) {
    revision += 1;
    available = false;
    feedback.textContent = error.message || '无法读取下一步探索设置。';
    render();
  } });
  toggle.addEventListener('change', async () => {
    if (saving || !available) return;
    const next = toggle.checked;
    const previousRevision = revision;
    saving = true;
    toggle.disabled = true;
    feedback.textContent = '正在保存…';
    try {
      await awaitWithTimeout(storage.set({ [NEXT_EXPLORATION_KEY]: { version: 1, enabled: next } }), {
        signal: controller.signal, timeoutMs: 5000, message: '保存结果待确认，请稍后核对开关。',
      });
      if (controller.signal.aborted) return;
      if (revision === previousRevision) enabled = next;
      if (available) feedback.textContent = '已保存。';
    } catch (error) {
      if (!controller.signal.aborted) feedback.textContent = error.name === 'TimeoutError' ? error.message : '保存失败，请重试。';
    } finally {
      saving = false;
      if (!controller.signal.aborted) render();
    }
  }, { signal: controller.signal });
  return () => { controller.abort(); stopWatching(); };
}
