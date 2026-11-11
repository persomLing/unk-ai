import { awaitWithAbort } from '../../../utils/abortable.js';

/** Own a history navigation until its real storage work has settled. */
export function createHistoryNavigation({ getCurrent, onBusy = () => {}, onLateError = () => {},
  timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = null;
  let disposed = false;

  function run(action, { label = '整理历史对话' } = {}) {
    if (disposed) return Promise.reject(new DOMException('侧栏已关闭。', 'AbortError'));
    if (active) return Promise.reject(new Error('上一项历史操作仍在保存，请稍后重试。'));
    const task = { owner: getCurrent(), controller: new AbortController(), writing: false, timedOut: false };
    active = task;
    const assertCurrent = () => {
      task.controller.signal.throwIfAborted();
      if (disposed || active !== task || getCurrent() !== task.owner) {
        throw new DOMException('当前会话已变化，未切换到迟到的历史记录。', 'AbortError');
      }
    };
    const read = async pending => {
      const result = await awaitWithAbort(pending, task.controller.signal);
      assertCurrent();
      return result;
    };
    const context = Object.freeze({
      assertCurrent,
      read,
      async persist(operation) {
        assertCurrent();
        // Temporary conversation writes share one slot. An observer timeout
        // cannot release this owner while such a write may still clear it.
        task.writing = true;
        return read(operation());
      },
      commit(operation) {
        assertCurrent();
        operation();
        task.owner = getCurrent();
      },
    });
    onBusy(true);
    let timer;
    const pending = Promise.resolve().then(() => { assertCurrent(); return action(context); })
      .finally(() => {
        clearTimer(timer);
        if (active === task) { active = null; if (!disposed) onBusy(false); }
      });
    // Observe a late failure even after the caller has received its timeout.
    pending.catch(error => { if (task.timedOut && task.writing && !disposed && error?.name !== 'AbortError') onLateError(error); });
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        task.timedOut = true;
        const error = new DOMException(task.writing
          ? `${label}仍在保存，完成后会自动恢复操作。请勿重复新建。`
          : `${label}超时，请重试。`, 'TimeoutError');
        if (!task.writing) task.controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([pending, timeout]);
  }

  return Object.freeze({
    run,
    get busy() { return Boolean(active); },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.controller.abort(new DOMException('侧栏已关闭。', 'AbortError'));
    },
  });
}
