import {
  DEFAULT_ACCOUNT_SERVER_URL,
  enterAccountMode,
  loginAccount,
  normalizeServerUrl,
} from '../utils/account-auth.js';
import { icon } from '../sidepanel/icons.js';

const BUILTIN_NOTICE = '还没有账号？请联系管理员获取专属账号与密码。本地对话仅保存在你的本地目录，不上传账号服务。';
const CUSTOM_SERVER_NOTICE = '还没有账号？请联系管理员获取专属账号、密码与服务地址。本地对话仅保存在你的本地目录，不上传账号服务。';

/**
 * Create a shared branded Paper & Ink `<dialog>` modal for UNK AI account login.
 * Hides the server address automatically when built with a default `VITE_UNK_ACCOUNT_SERVER_URL`,
 * and prompts for the server URL when built without a preconfigured server (e.g. open-source builds).
 */
export function createAccountLoginModal({
  doc = globalThis.document,
  mountNode = null,
  iconFn = icon,
  builtInServerUrl = DEFAULT_ACCOUNT_SERVER_URL,
  onSuccess,
} = {}) {
  const noop = {
    open() {},
    close() {},
    isOpen: () => false,
    getElement: () => null,
    dispose() {},
  };
  if (!doc?.createElement) return noop;

  let resolvedBuiltIn = '';
  if (typeof builtInServerUrl === 'string' && builtInServerUrl.trim()) {
    try {
      resolvedBuiltIn = normalizeServerUrl(builtInServerUrl);
    } catch {
      resolvedBuiltIn = '';
    }
  }
  const hasBuiltInServer = Boolean(resolvedBuiltIn);
  const defaultNotice = hasBuiltInServer ? BUILTIN_NOTICE : CUSTOM_SERVER_NOTICE;

  const dialog = doc.createElement('dialog');
  dialog.className = 'account-login-dialog';
  dialog.setAttribute('aria-labelledby', 'account-login-dialog-title');
  dialog.innerHTML = `
    <div class="account-login-surface">
      <button type="button" class="icon-button account-login-close" data-modal-close aria-label="关闭登录弹窗" title="关闭">
        ${iconFn('close')}
      </button>
      <div class="account-login-hero">
        <div class="account-login-brand">
          <img class="account-login-logo" src="/icons/icon-48.png" alt="UNK AI" width="44" height="44" />
        </div>
        <span class="account-login-eyebrow">UNK AI · 账号服务</span>
        <h2 id="account-login-dialog-title">登录 UNK AI 账号</h2>
        <p class="account-login-subtitle">登录后自动同步管理员分配的模型与配置</p>
      </div>
      <div class="account-login-notice" data-modal-notice data-kind="info">
        ${iconFn('info')}
        <span data-modal-notice-text>${defaultNotice}</span>
      </div>
      <form class="account-login-form" data-modal-form novalidate>
        ${hasBuiltInServer ? '' : `
        <label class="account-login-field">
          <span>账号服务地址</span>
          <input data-modal-server-url type="url" placeholder="例如 https://your-gateway.example.com" autocomplete="url" required />
        </label>
        `}
        <label class="account-login-field">
          <span>账号</span>
          <input data-modal-username type="text" placeholder="输入管理员分配的用户名" autocomplete="username" required />
        </label>
        <label class="account-login-field">
          <span>密码</span>
          <div class="account-login-secret">
            <input data-modal-password type="password" placeholder="输入登录密码" autocomplete="current-password" required />
            <button type="button" class="icon-button account-login-eye" data-modal-toggle-pwd aria-label="显示密码" aria-pressed="false" title="显示密码">
              ${iconFn('eye')}
            </button>
          </div>
        </label>
        <p class="account-login-feedback" data-modal-feedback role="status" hidden></p>
        <div class="account-login-actions">
          <button type="button" class="account-login-btn account-login-btn-secondary" data-modal-cancel>取消</button>
          <button type="submit" class="account-login-btn account-login-btn-primary" data-modal-submit>
            <span class="button-spinner" aria-hidden="true"></span>
            <span class="button-label">登录并同步模型</span>
          </button>
        </div>
      </form>
    </div>
  `;

  const hostParent = mountNode || doc.body || doc.documentElement;
  hostParent?.appendChild?.(dialog);

  const form = dialog.querySelector('[data-modal-form]');
  const closeBtn = dialog.querySelector('[data-modal-close]');
  const cancelBtn = dialog.querySelector('[data-modal-cancel]');
  const noticeBox = dialog.querySelector('[data-modal-notice]');
  const noticeText = dialog.querySelector('[data-modal-notice-text]');
  const serverUrlInput = dialog.querySelector('[data-modal-server-url]');
  const usernameInput = dialog.querySelector('[data-modal-username]');
  const passwordInput = dialog.querySelector('[data-modal-password]');
  const togglePwdBtn = dialog.querySelector('[data-modal-toggle-pwd]');
  const feedbackEl = dialog.querySelector('[data-modal-feedback]');
  const submitBtn = dialog.querySelector('[data-modal-submit]');
  const submitLabel = submitBtn?.querySelector('.button-label');

  let disposed = false;
  let busy = false;
  let opened = false;
  let activeController = null;
  let previousFocus = null;

  function setFeedback(message = '', kind = '') {
    if (disposed || !feedbackEl) return;
    feedbackEl.hidden = !message;
    feedbackEl.textContent = message;
    feedbackEl.className = `account-login-feedback ${kind}`.trim();
  }

  function setPasswordVisible(visible) {
    if (!passwordInput || !togglePwdBtn) return;
    passwordInput.type = visible ? 'text' : 'password';
    togglePwdBtn.innerHTML = iconFn(visible ? 'eye-off' : 'eye');
    togglePwdBtn.setAttribute('aria-pressed', String(visible));
    togglePwdBtn.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    togglePwdBtn.title = visible ? '隐藏密码' : '显示密码';
  }

  function setLoading(loading) {
    if (submitBtn) {
      submitBtn.disabled = loading;
      submitBtn.setAttribute('aria-busy', String(loading));
      submitBtn.classList.toggle('is-loading', loading);
    }
    if (cancelBtn) cancelBtn.disabled = loading;
    if (closeBtn) closeBtn.disabled = loading;
    if (submitLabel) submitLabel.textContent = loading ? '登录并同步中…' : '登录并同步模型';
  }

  function restoreFocus() {
    try {
      if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected !== false) {
        previousFocus.focus();
      }
    } catch {}
    previousFocus = null;
  }

  function close() {
    if (disposed) return;
    activeController?.abort();
    activeController = null;
    busy = false;
    setLoading(false);
    setFeedback('');
    setPasswordVisible(false);
    if (passwordInput) passwordInput.value = '';
    opened = false;
    if (typeof dialog.close === 'function') {
      try { if (dialog.open) dialog.close(); } catch { dialog.removeAttribute?.('open'); }
    } else {
      dialog.removeAttribute?.('open');
      dialog.open = false;
    }
    restoreFocus();
  }

  function open({ initialUsername = '', initialServerUrl = '', reason = '' } = {}) {
    if (disposed) return;
    previousFocus = doc.activeElement || null;
    setFeedback('');
    setPasswordVisible(false);
    setLoading(false);
    if (serverUrlInput) serverUrlInput.value = String(initialServerUrl || '').trim();
    if (usernameInput) usernameInput.value = String(initialUsername || '').trim();
    if (passwordInput) passwordInput.value = '';
    if (noticeBox && noticeText) {
      const cleanReason = String(reason || '').trim();
      noticeBox.dataset.kind = cleanReason ? 'warning' : 'info';
      noticeText.textContent = cleanReason || defaultNotice;
    }
    opened = true;
    if (typeof dialog.showModal === 'function') {
      try { if (!dialog.open) dialog.showModal(); } catch { dialog.setAttribute?.('open', ''); }
    } else {
      dialog.setAttribute?.('open', '');
      dialog.open = true;
    }
    const focusTarget = (serverUrlInput && !serverUrlInput.value.trim())
      ? serverUrlInput
      : (String(initialUsername || '').trim() ? passwordInput : usernameInput);
    if (focusTarget?.focus) {
      queueMicrotask(() => {
        if (!disposed && opened) focusTarget.focus();
      });
    }
  }

  const onDialogClick = event => {
    if (disposed || busy) return;
    if (event.target === dialog) {
      close();
    }
  };

  const onDialogCancel = event => {
    if (busy) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close();
  };

  const onCloseClick = () => {
    if (!busy) close();
  };

  const onTogglePwd = () => {
    if (disposed) return;
    setPasswordVisible(passwordInput?.type !== 'text');
    passwordInput?.focus?.();
  };

  const onSubmit = async event => {
    event.preventDefault();
    if (busy || disposed) return;
    const targetServerUrl = hasBuiltInServer ? resolvedBuiltIn : (serverUrlInput?.value?.trim() || '');
    const username = usernameInput?.value?.trim() || '';
    const password = passwordInput?.value || '';
    if (!targetServerUrl) {
      setFeedback('请填写管理员提供的账号服务地址。', 'error');
      serverUrlInput?.focus?.();
      return;
    }
    if (!username) {
      setFeedback('请输入管理员分配的账号。', 'error');
      usernameInput?.focus?.();
      return;
    }
    if (!password) {
      setFeedback('请输入登录密码。', 'error');
      passwordInput?.focus?.();
      return;
    }

    busy = true;
    activeController?.abort();
    activeController = new AbortController();
    setFeedback('');
    setLoading(true);
    try {
      const loginResult = await loginAccount({
        serverUrl: targetServerUrl,
        username,
        password,
        signal: activeController.signal,
      });
      const { session } = await enterAccountMode(loginResult);
      if (disposed) return;
      if (passwordInput) passwordInput.value = '';
      await onSuccess?.(session, loginResult);
      if (!disposed) close();
    } catch (error) {
      if (error?.name === 'AbortError' || disposed) return;
      setFeedback(error?.message || '登录失败，请检查账号与密码。', 'error');
    } finally {
      busy = false;
      activeController = null;
      if (!disposed) setLoading(false);
    }
  };

  dialog.addEventListener('click', onDialogClick);
  dialog.addEventListener('cancel', onDialogCancel);
  closeBtn?.addEventListener('click', onCloseClick);
  cancelBtn?.addEventListener('click', onCloseClick);
  togglePwdBtn?.addEventListener('click', onTogglePwd);
  form?.addEventListener('submit', onSubmit);

  return {
    open,
    close,
    isOpen: () => Boolean(dialog.open || opened),
    getElement: () => dialog,
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      dialog.removeEventListener('click', onDialogClick);
      dialog.removeEventListener('cancel', onDialogCancel);
      closeBtn?.removeEventListener('click', onCloseClick);
      cancelBtn?.removeEventListener('click', onCloseClick);
      togglePwdBtn?.removeEventListener('click', onTogglePwd);
      form?.removeEventListener('submit', onSubmit);
      dialog.remove?.();
    },
  };
}
