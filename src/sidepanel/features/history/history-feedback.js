/** Short-lived feedback and the last reversible deletion have separate lifetimes. */
export function createHistoryFeedback({ durationMs = 3000, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  let notice = null;
  let undoToken = null;
  let timer = null;
  let deadline = 0;
  let remaining = durationMs;
  let revision = 0;
  let disposed = false;
  const pauses = new Set();

  const snapshot = () => ({ notice: notice ? { ...notice } : null, undoToken });
  const publish = () => { if (!disposed) onChange(snapshot()); };
  function cancelTimer() {
    revision += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule() {
    if (disposed || !notice || pauses.size || timer !== null) return;
    const expected = ++revision;
    deadline = now() + remaining;
    timer = setTimer(() => {
      if (disposed || expected !== revision || !notice) return;
      timer = null;
      notice = null;
      publish();
    }, remaining);
  }

  return Object.freeze({
    snapshot,
    show(message, { undoToken: noticeUndo = null } = {}) {
      if (disposed) return;
      cancelTimer();
      notice = message ? { message: String(message), undoToken: noticeUndo } : null;
      if (noticeUndo) undoToken = noticeUndo;
      remaining = durationMs;
      schedule();
      publish();
    },
    rememberUndo(token) {
      if (disposed) return;
      undoToken = token || null;
      publish();
    },
    resolveUndo(token, { pending = false } = {}) {
      if (disposed || pending || undoToken !== token) return;
      undoToken = null;
      if (notice?.undoToken === token) notice = { ...notice, undoToken: null };
      publish();
    },
    dismiss() {
      if (disposed) return;
      cancelTimer();
      notice = null;
      publish();
    },
    pause(reason, paused = true) {
      if (disposed) return;
      if (paused) {
        if (pauses.has(reason)) return;
        pauses.add(reason);
        if (timer !== null) {
          remaining = Math.max(0, deadline - now());
          cancelTimer();
        }
      } else {
        pauses.delete(reason);
        schedule();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      pauses.clear();
      notice = null;
      undoToken = null;
    },
  });
}
