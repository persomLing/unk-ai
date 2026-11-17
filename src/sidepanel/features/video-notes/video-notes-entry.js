import { parseVideoUrl, captureVideoRequest, VIDEO_ILLUSTRATION_MODES } from './video-request.js';

const MODE_LABELS = Object.freeze({ off: '配图·关', frame: '截帧', generate: '生图' });
const MODE_NAMES = Object.freeze({ off: '关', frame: '方案A·视频截帧', generate: '生成图片' });

export function videoNotesBlockReason({ ready, pageEnabled, target, busy } = {}) {
  if (!ready) return '请等待侧栏准备完成。';
  if (!pageEnabled) return '请先选中当前页面。';
  if (!parseVideoUrl(target?.url)) return '目前支持 B 站普通视频，请打开视频页面。';
  if (busy) return '请等待当前任务完成或停止后，再整理视频笔记。';
  return '';
}

/** The menu only captures intent; the existing application owns the entire run.
 * The row-end mode button is a user opt-in for illustration; it never submits. */
export function createVideoNotesEntry({ button, modeButton, getState, submit, leaveAgent = () => {},
  closeMenu = () => {}, onNotice = () => {}, createId = () => crypto.randomUUID() }) {
  let disposed = false, pending = null, mode = 'off';
  function syncMode() {
    if (!modeButton || disposed) return;
    modeButton.textContent = MODE_LABELS[mode];
    modeButton.setAttribute('aria-pressed', String(mode !== 'off'));
    modeButton.setAttribute('aria-label', `视频配图方式：${MODE_NAMES[mode]}`);
    modeButton.title = `视频配图方式：${MODE_NAMES[mode]}（点击切换）${mode === 'frame' ? '；截帧期间请不要离开视频页面或切换分 P' : ''}`;
  }
  function sync() {
    if (disposed) return;
    const reason = videoNotesBlockReason(getState());
    button.disabled = Boolean(reason || pending);
    button.title = reason || '读取当前视频字幕，用中文整理笔记';
    syncMode();
  }
  async function activate() {
    if (disposed || pending) return;
    const state = getState(), reason = videoNotesBlockReason(state);
    if (reason) { onNotice(reason, 'info'); sync(); return; }
    const operation = {};
    pending = operation;
    try {
      const pageCommand = captureVideoRequest({ kind: 'video-notes', version: 1, target: state.target, illustration: mode });
      // This action disables itself immediately; close before the parent's
      // bubbling menu listener sees the now-disabled button.
      closeMenu(); sync();
      leaveAgent();
      if (pageCommand.illustration === 'frame') onNotice('截帧期间请不要离开当前视频页面，也不要切换分 P。', 'info');
      await submit('整理当前视频的笔记', { pageCommand, commandId: createId() });
    } catch (error) { if (!disposed) onNotice(error.message || '无法开始视频笔记。', 'error'); }
    finally { if (pending === operation) { pending = null; sync(); } }
  }
  const click = () => { void activate(); };
  const cycleMode = event => {
    event.preventDefault(); event.stopPropagation();
    if (disposed) return;
    mode = VIDEO_ILLUSTRATION_MODES[(VIDEO_ILLUSTRATION_MODES.indexOf(mode) + 1) % VIDEO_ILLUSTRATION_MODES.length];
    syncMode();
  };
  button.addEventListener('click', click);
  modeButton?.addEventListener('click', cycleMode);
  sync();
  return Object.freeze({ sync, activate, getMode: () => mode,
    dispose() {
      if (disposed) return;
      disposed = true;
      button.removeEventListener('click', click);
      modeButton?.removeEventListener('click', cycleMode);
    } });
}
