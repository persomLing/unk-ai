import { parseVideoUrl, captureVideoRequest } from './video-request.js';

export function videoNotesBlockReason({ ready, pageEnabled, target, busy } = {}) {
  if (!ready) return '请等待侧栏准备完成。';
  if (!pageEnabled) return '请先选中当前页面。';
  if (!parseVideoUrl(target?.url)) return '目前支持 B 站普通视频，请打开视频页面。';
  if (busy) return '请等待当前任务完成或停止后，再整理视频笔记。';
  return '';
}

/** The menu only captures intent; the existing application owns the entire run. */
export function createVideoNotesEntry({ button, getState, submit, leaveAgent = () => {},
  closeMenu = () => {}, onNotice = () => {}, createId = () => crypto.randomUUID() }) {
  let disposed = false, pending = null;
  function sync() {
    if (disposed) return;
    const reason = videoNotesBlockReason(getState());
    button.disabled = Boolean(reason || pending);
    button.title = reason || '读取当前视频字幕，用中文整理笔记';
  }
  async function activate() {
    if (disposed || pending) return;
    const state = getState(), reason = videoNotesBlockReason(state);
    if (reason) { onNotice(reason, 'info'); sync(); return; }
    const operation = {};
    pending = operation;
    try {
      const pageCommand = captureVideoRequest({ kind: 'video-notes', version: 1, target: state.target });
      // This action disables itself immediately; close before the parent's
      // bubbling menu listener sees the now-disabled button.
      closeMenu(); sync();
      leaveAgent();
      await submit('整理当前视频的笔记', { pageCommand, commandId: createId() });
    } catch (error) { if (!disposed) onNotice(error.message || '无法开始视频笔记。', 'error'); }
    finally { if (pending === operation) { pending = null; sync(); } }
  }
  const click = () => { void activate(); };
  button.addEventListener('click', click);
  sync();
  return Object.freeze({ sync, activate,
    dispose() { if (disposed) return; disposed = true; button.removeEventListener('click', click); } });
}
