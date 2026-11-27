import {
  changeAccountPassword,
  DEFAULT_ACCOUNT_SERVER_URL,
  exitAccountMode,
  getAccountSession,
  hasSavedAccountSession,
  switchToAccountMode,
  switchToLocalMode,
  syncAccountProfile,
} from '../utils/account-auth.js';
import { createAccountLoginModal } from '../ui/account-login-modal.js';

function formatTime(iso) {
  if (!iso) return '尚未同步';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function readInitialRequestedMode() {
  try {
    const param = new URLSearchParams(globalThis.location?.search || '').get('mode');
    if (param === 'account') return 'account';
    if (param === 'api' || param === 'local') return 'local';
  } catch {}
  return '';
}

export function installAccountSettings({ root, onStateChange, builtInServerUrl = DEFAULT_ACCOUNT_SERVER_URL } = {}) {
  if (!root) return { dispose() {}, selectMode() {}, openLoginModal() {}, refresh: async () => null };

  const modeSwitch = root.querySelector('.account-mode-switch');
  const modeStage = root.querySelector('#account-mode-stage');
  const modeLocalBtn = root.querySelector('#account-mode-local');
  const modeAccountBtn = root.querySelector('#account-mode-account');
  const localNote = root.querySelector('#account-local-panel');
  const parkedBar = root.querySelector('#account-parked-bar');
  const parkedText = root.querySelector('#account-parked-text');
  const parkedResumeBtn = root.querySelector('#account-parked-resume');
  const parkedLogoutBtn = root.querySelector('#account-parked-logout');
  const loginPanel = root.querySelector('#account-login-panel');
  const loggedPanel = root.querySelector('#account-logged-panel');
  const openLoginBtn = root.querySelector('#account-open-login-btn');
  const reloginInlineBtn = root.querySelector('#account-relogin-inline-btn');
  const syncBtn = root.querySelector('#account-sync-btn');
  const syncLabel = syncBtn?.querySelector('.button-label');
  const togglePwdBtn = root.querySelector('#account-toggle-pwd');
  const pwdForm = root.querySelector('#account-password-form');
  const currentPwdInput = root.querySelector('#account-current-password');
  const newPwdInput = root.querySelector('#account-new-password');
  const confirmPwdInput = root.querySelector('#account-confirm-password');
  const pwdSubmitBtn = root.querySelector('#account-password-submit');
  const pwdCancelBtn = root.querySelector('#account-password-cancel');
  const logoutBtn = root.querySelector('#account-logout-btn');
  const feedbackEl = root.querySelector('#account-feedback');

  const summaryName = root.querySelector('#account-summary-name');
  const summaryMeta = root.querySelector('#account-summary-meta');
  const summaryBadge = root.querySelector('#account-summary-badge');
  const summaryPolicy = root.querySelector('#account-summary-policy');
  const summarySynced = root.querySelector('#account-summary-synced');

  let disposed = false;
  let busy = false;
  let activeController = null;
  let currentSession = null;
  let hasAppliedInitialSession = false;
  const requestedMode = readInitialRequestedMode();
  let selectedTabMode = requestedMode || 'local';

  function setFeedback(message, kind = '') {
    if (disposed || !feedbackEl) return;
    feedbackEl.hidden = !message;
    feedbackEl.textContent = message;
    feedbackEl.className = `inline-feedback ${kind}`.trim();
  }

  function setLoading(button, labelEl, loading, loadingText, idleText) {
    if (!button) return;
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
    button.classList.toggle('is-loading', loading);
    if (labelEl) labelEl.textContent = loading ? loadingText : idleText;
  }

  function renderSession(session, direction = '') {
    if (disposed) return;
    currentSession = session;
    const isAccountMode = session?.mode === 'account';
    const hasParked = !isAccountMode && hasSavedAccountSession(session);
    if (!isAccountMode && selectedTabMode !== 'account') selectedTabMode = 'local';
    if (isAccountMode) selectedTabMode = 'account';

    if (modeSwitch) modeSwitch.dataset.activeMode = selectedTabMode;
    if (modeStage && direction) {
      modeStage.dataset.direction = direction;
    } else if (modeStage && !direction && !hasAppliedInitialSession) {
      modeStage.dataset.direction = '';
    }

    modeLocalBtn?.setAttribute('aria-pressed', String(selectedTabMode === 'local'));
    modeAccountBtn?.setAttribute('aria-pressed', String(selectedTabMode === 'account'));
    modeLocalBtn?.classList.toggle('is-active', selectedTabMode === 'local');
    modeAccountBtn?.classList.toggle('is-active', selectedTabMode === 'account');

    if (localNote) localNote.hidden = selectedTabMode !== 'local';
    if (loginPanel) loginPanel.hidden = !(selectedTabMode === 'account' && !isAccountMode);
    if (loggedPanel) loggedPanel.hidden = !(selectedTabMode === 'account' && isAccountMode);

    if (parkedBar) {
      parkedBar.hidden = !(selectedTabMode === 'local' && hasParked);
      if (hasParked && parkedText) {
        const display = session.user?.displayName || session.user?.username || '已登录用户';
        parkedText.textContent = `已保留账号「${display}」的登录状态，切回「账户登录」即可直接使用。`;
      }
    }

    if (isAccountMode) {
      const display = session.user?.displayName || session.user?.username || '已登录用户';
      const uname = session.user?.username ? `@${session.user.username}` : '';
      if (summaryName) summaryName.textContent = uname ? `${display} (${uname})` : display;
      if (summaryMeta) summaryMeta.textContent = '云端托管服务 · 模型配置由管理员统一同步';
      if (summaryPolicy) {
        const modeText = session.configMode === 'custom' ? '管理员独立配置' : '跟随管理员默认配置';
        const yingmiText = session.yingmi?.enabled ? ' · 后台默认盈米可用' : '';
        summaryPolicy.textContent = `模型策略：${modeText}${yingmiText}`;
      }
      if (summarySynced) summarySynced.textContent = `最近同步：${formatTime(session.lastSyncedAt)}`;
      const status = session.status || 'active';
      if (summaryBadge) {
        summaryBadge.dataset.status = status;
        summaryBadge.textContent = status === 'disabled'
          ? '账号已停用'
          : status === 'expired'
            ? '登录已失效'
            : '账号已连接';
      }
      if (reloginInlineBtn) {
        reloginInlineBtn.hidden = status !== 'expired' && status !== 'disabled';
      }
    }
  }

  const loginModal = createAccountLoginModal({
    doc: root.ownerDocument || globalThis.document,
    builtInServerUrl,
    async onSuccess(session, loginResult) {
      if (disposed) return;
      selectedTabMode = 'account';
      renderSession(session, 'forward');
      onStateChange?.(session);
      const count = Array.isArray(loginResult?.profile?.models) ? loginResult.profile.models.length : 0;
      setFeedback(`登录成功，已同步 ${count} 个可用模型。`, 'success');
    },
  });

  function openLoginModal(options = {}) {
    if (disposed || busy) return;
    loginModal.open({
      initialUsername: options.initialUsername ?? currentSession?.user?.username ?? '',
      initialServerUrl: options.initialServerUrl ?? currentSession?.serverUrl ?? '',
      reason: options.reason ?? '',
    });
  }

  async function refresh() {
    const session = await getAccountSession();
    if (disposed) return null;
    const prevMode = selectedTabMode;
    const prevWasAccount = currentSession?.mode === 'account';
    const isInitialAccountLink = !hasAppliedInitialSession && requestedMode === 'account';
    if (session.mode === 'account') {
      selectedTabMode = 'account';
    } else if (isInitialAccountLink) {
      selectedTabMode = 'account';
    } else if (!hasAppliedInitialSession || prevWasAccount) {
      selectedTabMode = 'local';
    }
    const direction = hasAppliedInitialSession && prevMode !== selectedTabMode
      ? (selectedTabMode === 'account' ? 'forward' : 'backward')
      : '';
    renderSession(session, direction);
    hasAppliedInitialSession = true;
    onStateChange?.(session);
    return session;
  }

  const onModeLocalClick = async () => {
    if (busy || disposed) return;
    loginModal.close();
    if (currentSession?.mode === 'account') {
      busy = true;
      setFeedback('');
      try {
        const { session } = await switchToLocalMode();
        if (disposed) return;
        selectedTabMode = 'local';
        if (pwdForm) pwdForm.hidden = true;
        renderSession(session, 'backward');
        onStateChange?.(session);
        setFeedback('已切回 API 接入模式，账号登录状态已保留，随时可切回。', 'success');
      } catch (error) {
        setFeedback(error?.message || '切换到 API 接入模式失败，请重试。', 'error');
      } finally {
        busy = false;
      }
      return;
    }
    const changed = selectedTabMode !== 'local';
    selectedTabMode = 'local';
    setFeedback('');
    renderSession(currentSession, changed ? 'backward' : '');
  };

  const onModeAccountClick = async () => {
    if (busy || disposed) return;
    const changed = selectedTabMode !== 'account';
    setFeedback('');
    if (currentSession?.mode === 'account') {
      selectedTabMode = 'account';
      renderSession(currentSession, '');
      return;
    }
    if (hasSavedAccountSession(currentSession)) {
      busy = true;
      let resumedOk = false;
      try {
        const resumed = await switchToAccountMode();
        if (disposed) return;
        if (resumed.ok) {
          resumedOk = true;
          selectedTabMode = 'account';
          renderSession(resumed.session, changed ? 'forward' : '');
          onStateChange?.(resumed.session);
          const count = resumed.providerConfig?.models?.length;
          setFeedback(
            count !== undefined ? `已切回账户登录，已恢复 ${count} 个可用模型。` : '已切回账户登录。',
            'success',
          );
        }
      } catch (error) {
        if (!disposed) setFeedback(error?.message || '切回账户登录失败，请重试。', 'error');
        return;
      } finally {
        busy = false;
      }
      if (resumedOk && !disposed) {
        activeController?.abort();
        activeController = new AbortController();
        const syncCtrl = activeController;
        try {
          const synced = await syncAccountProfile({ signal: syncCtrl.signal });
          if (!disposed && synced?.session && currentSession?.mode === 'account') {
            renderSession(synced.session);
            if (synced.changed) onStateChange?.(synced.session);
          }
        } catch {} finally {
          if (activeController === syncCtrl) activeController = null;
        }
      }
      return;
    }

    selectedTabMode = 'account';
    renderSession(currentSession, changed ? 'forward' : '');
    openLoginModal();
  };

  function selectMode(nextMode) {
    if (disposed || busy) return;
    if (nextMode === 'account') {
      void onModeAccountClick();
      return;
    }
    void onModeLocalClick();
  }

  const onOpenLoginClick = () => {
    if (busy || disposed) return;
    const reason = currentSession?.status === 'disabled'
      ? '当前账号已被管理员停用，请重新登录其他账号或联系管理员。'
      : currentSession?.status === 'expired'
        ? '账号登录已失效，请重新输入账号密码登录。'
        : '';
    openLoginModal({ reason });
  };

  const onSyncClick = async () => {
    if (busy || disposed) return;
    busy = true;
    activeController?.abort();
    activeController = new AbortController();
    setFeedback('');
    setLoading(syncBtn, syncLabel, true, '同步中…', '立即同步配置');
    try {
      const result = await syncAccountProfile({ force: true, signal: activeController.signal });
      if (disposed) return;
      if (result.session) {
        renderSession(result.session);
        onStateChange?.(result.session);
      }
      if (result.ok) {
        const count = result.providerConfig?.models?.length;
        setFeedback(
          count !== undefined ? `已同步最新配置，当前共有 ${count} 个可用模型。` : '当前模型配置已是最新。',
          'success',
        );
      } else {
        setFeedback(result.message || '同步失败，请稍后重试。', 'error');
      }
    } catch (error) {
      if (error?.name === 'AbortError' || disposed) return;
      setFeedback(error?.message || '同步失败。', 'error');
    } finally {
      busy = false;
      activeController = null;
      if (!disposed) setLoading(syncBtn, syncLabel, false, '同步中…', '立即同步配置');
    }
  };

  const onTogglePwd = () => {
    if (!pwdForm) return;
    pwdForm.hidden = !pwdForm.hidden;
    if (!pwdForm.hidden) {
      pwdForm.reset?.();
      currentPwdInput?.focus();
    }
  };

  const onPwdSubmit = async event => {
    event.preventDefault();
    if (busy || disposed) return;
    const currentPassword = currentPwdInput?.value || '';
    const newPassword = newPwdInput?.value || '';
    const confirmPassword = confirmPwdInput?.value || '';
    if (newPassword.length < 6) {
      setFeedback('新密码长度至少为 6 位。', 'error');
      newPwdInput?.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      setFeedback('两次输入的新密码不一致。', 'error');
      confirmPwdInput?.focus();
      return;
    }
    busy = true;
    if (pwdSubmitBtn) pwdSubmitBtn.disabled = true;
    try {
      await changeAccountPassword({
        serverUrl: currentSession?.serverUrl || DEFAULT_ACCOUNT_SERVER_URL,
        token: currentSession?.token || '',
        currentPassword,
        newPassword,
      });
      if (disposed) return;
      if (pwdForm) {
        pwdForm.reset?.();
        pwdForm.hidden = true;
      }
      await refresh();
      setFeedback('密码已修改，新会话凭证已自动更新。', 'success');
    } catch (error) {
      if (!disposed) setFeedback(error?.message || '修改密码失败。', 'error');
    } finally {
      busy = false;
      if (!disposed && pwdSubmitBtn) pwdSubmitBtn.disabled = false;
    }
  };

  const onLogoutClick = async () => {
    if (busy || disposed) return;
    busy = true;
    setFeedback('');
    const wasAccountMode = currentSession?.mode === 'account';
    try {
      const { session } = await exitAccountMode();
      if (disposed) return;
      selectedTabMode = 'local';
      if (pwdForm) pwdForm.hidden = true;
      renderSession(session, wasAccountMode ? 'backward' : '');
      onStateChange?.(session);
      setFeedback(
        wasAccountMode ? '已退出登录并恢复原有的 API 接入配置。' : '已退出保存的 UNK AI 账号，当前保留本地 API 接入配置。',
        'success',
      );
    } catch (error) {
      if (!disposed) setFeedback(error?.message || '退出登录失败，请重试。', 'error');
    } finally {
      busy = false;
    }
  };

  const onParkedResumeClick = () => {
    void onModeAccountClick();
  };

  const onPwdCancelClick = () => {
    if (pwdForm) pwdForm.hidden = true;
  };

  modeLocalBtn?.addEventListener('click', onModeLocalClick);
  modeAccountBtn?.addEventListener('click', onModeAccountClick);
  openLoginBtn?.addEventListener('click', onOpenLoginClick);
  reloginInlineBtn?.addEventListener('click', onOpenLoginClick);
  parkedResumeBtn?.addEventListener('click', onParkedResumeClick);
  parkedLogoutBtn?.addEventListener('click', onLogoutClick);
  syncBtn?.addEventListener('click', onSyncClick);
  togglePwdBtn?.addEventListener('click', onTogglePwd);
  pwdCancelBtn?.addEventListener('click', onPwdCancelClick);
  pwdForm?.addEventListener('submit', onPwdSubmit);
  logoutBtn?.addEventListener('click', onLogoutClick);

  const onStorageChange = (changes, area) => {
    if (area !== 'local' || disposed) return;
    if (changes.accountSession) {
      void refresh();
    }
  };
  globalThis.chrome?.storage?.onChanged?.addListener?.(onStorageChange);

  return {
    selectMode,
    openLoginModal,
    refresh,
    dispose() {
      disposed = true;
      activeController?.abort();
      loginModal.dispose();
      modeLocalBtn?.removeEventListener('click', onModeLocalClick);
      modeAccountBtn?.removeEventListener('click', onModeAccountClick);
      openLoginBtn?.removeEventListener('click', onOpenLoginClick);
      reloginInlineBtn?.removeEventListener('click', onOpenLoginClick);
      parkedResumeBtn?.removeEventListener('click', onParkedResumeClick);
      parkedLogoutBtn?.removeEventListener('click', onLogoutClick);
      syncBtn?.removeEventListener('click', onSyncClick);
      togglePwdBtn?.removeEventListener('click', onTogglePwd);
      pwdCancelBtn?.removeEventListener('click', onPwdCancelClick);
      pwdForm?.removeEventListener('submit', onPwdSubmit);
      logoutBtn?.removeEventListener('click', onLogoutClick);
      globalThis.chrome?.storage?.onChanged?.removeListener?.(onStorageChange);
    },
  };
}
