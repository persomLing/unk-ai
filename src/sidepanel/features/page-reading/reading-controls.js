import { awaitWithTimeout } from '../../../utils/abortable.js';
import { isReadablePageUrl } from './page-control-state.js';

const MODES = new Set(['auto', 'basic', 'deep']);
const MODE_LABELS = Object.freeze({ auto: '自动', basic: '基础', deep: '深入' });
const MODE_HINTS = Object.freeze({
  auto: '自动：根据资料缺口决定是否补读',
  basic: '基础：读取页面正文，不自动补充深度结构',
  deep: '深入：补充页面结构并核验资料，可能需要更多时间',
});
export const normalizeReadingDepth = value => MODES.has(value) ? value : 'auto';

function pageOrigin(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : '';
  } catch { return ''; }
}

/** UI preferences only. Reading, task permissions and submission remain with their existing owners. */
export function createReadingControls({
  root = document,
  getNetworkAllowed = async () => false,
  setNetworkAllowed,
  onModeChange = () => {},
  onNetworkChange = () => {},
  onGrantState = () => {},
  onError = () => {},
  timeoutMs = 8000,
} = {}) {
  const query = id => root.querySelector(`#${id}`);
  const controls = query('composer-reading-controls');
  const depth = query('composer-reading-depth');
  const depthLabel = query('composer-reading-depth-label');
  const menu = query('composer-reading-menu');
  const modeItems = [...(menu?.querySelectorAll('button[data-reading-mode]') || [])]
    .filter(item => MODES.has(item.dataset.readingMode));
  const networkContainer = query('composer-network-control');
  const network = query('composer-network-allowed');
  const networkLabel = query('composer-network-label');
  const note = query('composer-network-note');
  const listeners = [];
  let disposed = false;
  let epoch = 0;
  let pendingRead = null;
  let pendingWrite = null;
  let publishedGrant = '';
  let menuOpen = false;
  let activeModeIndex = 0;
  let state = { url: '', origin: '', visible: false, busy: false, mode: 'auto', allowed: false, loaded: false, error: '' };

  const active = token => !disposed && token.epoch === epoch && token.origin === state.origin && state.visible;
  const snapshot = () => ({ ...state, loading: Boolean(pendingRead), saving: Boolean(pendingWrite), menuOpen });
  const grantState = () => {
    const confirmed = !disposed && state.visible && Boolean(state.origin) && state.loaded && !pendingRead && !pendingWrite;
    return { origin: state.origin, url: state.url, allowed: confirmed && state.allowed, confirmed };
  };
  function publishGrant() {
    const value = grantState();
    const signature = JSON.stringify(value);
    if (signature === publishedGrant) return;
    publishedGrant = signature;
    onGrantState(value);
  }
  function listen(element, event, callback) {
    if (!element?.addEventListener) return;
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  }
  function tooltip(element, value) {
    if (!element) return;
    element.title = value;
    element.dataset.tooltip = value;
  }
  function closeMenu(restoreFocus = false) {
    menuOpen = false;
    if (menu) menu.hidden = true;
    depth?.setAttribute('aria-expanded', 'false');
    for (const item of modeItems) item.tabIndex = -1;
    if (restoreFocus && state.visible && !state.busy && !disposed) depth?.focus();
  }
  function focusMode(index) {
    if (!modeItems.length) return;
    activeModeIndex = (index + modeItems.length) % modeItems.length;
    modeItems.forEach((item, position) => { item.tabIndex = position === activeModeIndex ? 0 : -1; });
    modeItems[activeModeIndex].focus();
  }
  function openMenu(position = 'selected') {
    if (disposed || !state.visible || state.busy || depth?.disabled || !menu || !modeItems.length) return;
    menuOpen = true;
    menu.hidden = false;
    depth.setAttribute('aria-expanded', 'true');
    const selected = Math.max(0, modeItems.findIndex(item => item.dataset.readingMode === state.mode));
    focusMode(position === 'first' ? 0 : position === 'last' ? modeItems.length - 1 : selected);
  }
  function networkPresentation() {
    if (pendingWrite) return { status: 'saving', label: '保存中', hint: '正在保存本站接口设置，请稍候。', name: '接口数据，正在保存' };
    if (pendingRead) return { status: 'loading', label: '核对中', hint: '正在核对本站接口设置，请稍候。', name: '接口数据，正在核对' };
    if (!state.loaded) return { status: 'unknown', label: '未确认', hint: '接口设置尚未确认，点击重新核对；本次点击不会更改设置。', name: '接口数据，未确认，点击重新核对' };
    return state.allowed
      ? { status: 'enabled', label: '接口', hint: '本站接口读取已开启，点击关闭。仅在页面任务需要时读取，不主动刷新或重放请求。', name: '接口数据，已开启，点击关闭' }
      : { status: 'disabled', label: '接口', hint: '本站接口读取已关闭，点击开启，允许页面任务按需读取本站接口数据。', name: '接口数据，已关闭，点击开启' };
  }
  function paint() {
    if (disposed) return;
    if (controls) controls.hidden = !state.visible;
    if (!state.visible || state.busy) closeMenu();
    if (depth) {
      depth.disabled = !state.visible || state.busy;
      depth.setAttribute('aria-haspopup', 'menu');
      depth.setAttribute('aria-expanded', String(menuOpen));
      depth.setAttribute('aria-controls', 'composer-reading-menu');
      depth.setAttribute('aria-label', `页面阅读强度：${MODE_LABELS[state.mode]}`);
      tooltip(depth, MODE_HINTS[state.mode]);
      (depthLabel || depth).textContent = MODE_LABELS[state.mode];
    }
    if (menu) { menu.hidden = !menuOpen; menu.setAttribute('role', 'menu'); }
    for (const item of modeItems) {
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(item.dataset.readingMode === state.mode));
      item.disabled = !state.visible || state.busy;
      if (!menuOpen) item.tabIndex = -1;
    }
    const presentation = networkPresentation();
    if (networkContainer) networkContainer.hidden = !state.origin;
    if (network) {
      network.hidden = !state.origin;
      network.classList.toggle('is-enabled', grantState().allowed);
      network.classList.toggle('is-unconfirmed', presentation.status === 'unknown');
      network.dataset.state = presentation.status;
      network.setAttribute('aria-pressed', String(grantState().allowed));
      network.setAttribute('aria-busy', String(Boolean(pendingRead || pendingWrite)));
      network.setAttribute('aria-label', presentation.name);
      network.disabled = !state.visible || !state.origin || state.busy || Boolean(pendingRead || pendingWrite) || typeof setNetworkAllowed !== 'function';
      tooltip(network, presentation.hint);
      (networkLabel || network).textContent = presentation.label;
    }
    const message = pendingWrite ? '正在保存本站设置…' : pendingRead ? '正在核对本站设置…' : state.error;
    if (note) {
      note.textContent = message;
      note.hidden = false;
      note.classList.toggle('is-error', Boolean(state.error) && !pendingRead && !pendingWrite);
    }
    publishGrant();
  }
  function cancelPending() {
    ++epoch;
    pendingRead?.controller.abort();
    pendingWrite?.controller.abort();
    pendingRead = null;
    pendingWrite = null;
  }
  function refresh() {
    if (disposed || !state.visible || !state.origin || pendingWrite) return Promise.resolve(snapshot());
    pendingRead?.controller.abort();
    const token = { epoch: ++epoch, origin: state.origin, url: state.url, controller: new AbortController() };
    pendingRead = token;
    state.loaded = false;
    state.error = '';
    paint();
    token.promise = (async () => {
      try {
        const allowed = await awaitWithTimeout(Promise.resolve().then(() => {
          token.controller.signal.throwIfAborted();
          return getNetworkAllowed(token.url);
        }), { signal: token.controller.signal, timeoutMs, message: '读取本站接口设置超时，请重新核对。' });
        if (!active(token)) return snapshot();
        state.allowed = allowed === true;
        state.loaded = true;
      } catch (error) {
        if (!active(token)) return snapshot();
        state.allowed = false;
        state.loaded = false;
        state.error = error?.message || '未能读取本站接口设置，请重新核对。';
        onError(error);
      } finally {
        if (pendingRead === token) { pendingRead = null; paint(); }
      }
      return snapshot();
    })();
    return token.promise;
  }
  async function changeNetwork() {
    if (disposed || network?.disabled || !state.visible || !state.origin || pendingRead || pendingWrite || state.busy) { paint(); return; }
    closeMenu();
    // Unconfirmed writes can still settle later. Re-read first; never blindly invert a stale value.
    if (!state.loaded) { await refresh(); return; }
    const requested = !state.allowed;
    const token = { epoch, origin: state.origin, url: state.url, controller: new AbortController() };
    pendingWrite = token;
    state.error = '';
    paint();
    try {
      await awaitWithTimeout(Promise.resolve().then(() => {
        token.controller.signal.throwIfAborted();
        return setNetworkAllowed(token.url, requested);
      }), { signal: token.controller.signal, timeoutMs, message: '保存结果尚未确认，请重新核对本站设置。' });
      if (!active(token)) return;
      state.allowed = requested;
      state.loaded = true;
      onNetworkChange(requested, { url: token.url, origin: token.origin });
    } catch (error) {
      if (!active(token)) return;
      // A timed-out write may still finish in storage. Require a fresh read before displaying consent.
      state.loaded = false;
      state.error = error?.message || '设置保存失败，请重新核对。';
      onError(error);
    } finally {
      if (pendingWrite === token) { pendingWrite = null; paint(); }
    }
  }
  listen(depth, 'click', () => {
    if (disposed || depth.disabled || !state.visible || state.busy) return;
    if (menuOpen) closeMenu(true);
    else openMenu();
  });
  listen(depth, 'keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape') {
      if (!menuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    event.preventDefault();
    openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
  });
  for (const item of modeItems) {
    listen(item, 'focus', () => { activeModeIndex = modeItems.indexOf(item); });
    listen(item, 'click', () => {
      if (disposed || !menuOpen || item.disabled || !state.visible || state.busy) return;
      const selected = item.dataset.readingMode;
      const changed = selected !== state.mode;
      state.mode = selected;
      closeMenu(true);
      paint();
      if (changed) onModeChange(state.mode);
    });
  }
  listen(menu, 'keydown', event => {
    if (!menuOpen) return;
    if (event.key === 'Tab') {
      // Place focus at the trigger before native Tab navigation so focus leaves the popup normally.
      closeMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') closeMenu(true);
    else if (event.key === 'Home') focusMode(0);
    else if (event.key === 'End') focusMode(modeItems.length - 1);
    else focusMode(activeModeIndex + (event.key === 'ArrowDown' ? 1 : -1));
  });
  listen(network, 'click', () => { void changeNetwork(); });
  listen(root, 'focusin', event => {
    if (menuOpen && !menu?.contains(event.target) && !depth?.contains(event.target)) closeMenu();
  });
  listen(root, 'pointerdown', event => {
    if (menuOpen && !menu?.contains(event.target) && !depth?.contains(event.target)) closeMenu();
  });
  paint();
  return Object.freeze({
    update({ url = state.url, pageEnabled = false, busy = false, agentMode = false, mode } = {}) {
      if (disposed) return Promise.resolve(snapshot());
      const origin = pageOrigin(url);
      const visible = pageEnabled === true && agentMode !== true && isReadablePageUrl(url);
      const changed = state.origin !== origin || state.visible !== visible;
      if (state.url !== url || changed) closeMenu();
      if (changed) cancelPending();
      state = { ...state, url, origin, visible, busy: busy === true,
        mode: mode === undefined ? state.mode : normalizeReadingDepth(mode),
        ...(changed ? { allowed: false, loaded: false, error: '' } : {}),
      };
      paint();
      if (visible && origin && changed) return refresh();
      return pendingRead?.promise || Promise.resolve(snapshot());
    },
    getMode: () => state.mode,
    getNetworkAllowed: () => grantState().allowed,
    snapshot,
    refresh,
    dispose() {
      if (disposed) return;
      cancelPending();
      closeMenu();
      disposed = true;
      publishGrant();
      for (const remove of listeners) remove();
      if (controls) controls.hidden = true;
    },
  });
}
