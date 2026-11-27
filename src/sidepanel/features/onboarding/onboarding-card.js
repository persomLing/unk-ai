import { hasSavedAccountSession } from '../../../utils/account-auth.js';
import { normalizeProviderConfig } from '../../../utils/profiles.js';
import { icon } from '../../icons.js';

export function shouldShowOnboarding({ config, accountSession, hasConversation = false } = {}) {
  if (hasConversation) return false;
  if (accountSession?.mode === 'account') return false;
  return !(normalizeProviderConfig(config)?.models?.length);
}

export function createOnboardingCard({ host, onOpenOptions, onRequestLogin, onResumeAccount } = {}) {
  const noop = {
    sync() {},
    setMode() {},
    getMode: () => 'api',
    dispose() {},
  };
  if (!host) return noop;

  let disposed = false;
  let mode = 'api';

  host.innerHTML = `
    <div class="onboarding-card">
      <div class="onboarding-head">
        <span class="onboarding-eyebrow">初次使用 · 接入方式</span>
        <h2>选择连接方式开始对话</h2>
      </div>
      <div class="onboarding-switch" role="group" aria-label="选择初始化接入方式" data-mode="api">
        <span class="onboarding-glider" aria-hidden="true"></span>
        <button type="button" class="onboarding-tab is-active" data-onboarding-mode="api" aria-pressed="true">
          <span class="onboarding-tab-icon">${icon('plug')}</span>
          <span class="onboarding-tab-copy">
            <strong>API 接入</strong>
            <small>自备接口与密钥</small>
          </span>
          <span class="onboarding-tab-check" aria-hidden="true">${icon('check')}</span>
        </button>
        <button type="button" class="onboarding-tab" data-onboarding-mode="account" aria-pressed="false">
          <span class="onboarding-tab-icon">${icon('user')}</span>
          <span class="onboarding-tab-copy">
            <strong>账户登录</strong>
            <small>联系管理员获取账号</small>
          </span>
          <span class="onboarding-tab-check" aria-hidden="true">${icon('check')}</span>
        </button>
      </div>
      <div class="onboarding-stage" data-direction="">
        <div class="onboarding-panel" data-onboarding-panel="api">
          <p class="onboarding-copy">支持任意兼容 OpenAI 的模型服务，自由配置接口地址、API Key 与个人模型库；对话与密钥仅保存在本地。</p>
          <div class="onboarding-api-actions">
            <button type="button" class="onboarding-primary-btn" data-onboarding-action="open-api">
              <span>前往配置 API 接入</span>
              ${icon('arrow-right')}
            </button>
          </div>
        </div>
        <div class="onboarding-panel" data-onboarding-panel="account" hidden>
          <div class="onboarding-admin-note">
            ${icon('info')}
            <span>还没有账号？请联系管理员获取专属账号与密码；登录后自动同步模型，对话仍保存在本地。</span>
          </div>
          <div class="onboarding-actions">
            <button type="button" class="onboarding-link-btn" data-onboarding-action="open-account">打开设置页</button>
            <div class="onboarding-account-cta">
              <button type="button" class="onboarding-secondary-btn" data-onboarding-action="resume-account" hidden>恢复已登录账号</button>
              <button type="button" class="onboarding-primary-btn" data-onboarding-action="open-login-modal">
                <span>登录 UNK AI 账号</span>
                ${icon('arrow-right')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const switchEl = host.querySelector('.onboarding-switch');
  const stageEl = host.querySelector('.onboarding-stage');
  const tabBtns = [...host.querySelectorAll('[data-onboarding-mode]')];
  const apiPanel = host.querySelector('[data-onboarding-panel="api"]');
  const accountPanel = host.querySelector('[data-onboarding-panel="account"]');
  const resumeBtn = host.querySelector('[data-onboarding-action="resume-account"]');
  const loginModalBtn = host.querySelector('[data-onboarding-action="open-login-modal"]');

  function setMode(nextMode) {
    if (disposed) return;
    const normalized = nextMode === 'account' ? 'account' : 'api';
    const prev = mode;
    mode = normalized;

    if (switchEl) switchEl.dataset.mode = mode;
    tabBtns.forEach(btn => {
      const active = btn.dataset.onboardingMode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    if (prev !== mode && stageEl) {
      stageEl.dataset.direction = mode === 'account' ? 'forward' : 'backward';
    }
    if (apiPanel) apiPanel.hidden = mode !== 'api';
    if (accountPanel) accountPanel.hidden = mode !== 'account';
    if (prev !== mode && mode === 'account') {
      loginModalBtn?.focus?.();
    }
  }

  const onHostClick = event => {
    if (disposed) return;
    const modeBtn = event.target.closest('[data-onboarding-mode]');
    if (modeBtn) {
      setMode(modeBtn.dataset.onboardingMode);
      return;
    }
    const actionBtn = event.target.closest('[data-onboarding-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.onboardingAction;
    if (action === 'open-login-modal') {
      onRequestLogin?.();
      return;
    }
    if (action === 'resume-account') {
      void onResumeAccount?.();
      return;
    }
    onOpenOptions?.(action === 'open-account' ? 'account' : 'api');
  };

  host.addEventListener('click', onHostClick);

  return {
    sync({ config, accountSession, hasConversation } = {}) {
      if (disposed) return false;
      const visible = shouldShowOnboarding({ config, accountSession, hasConversation });
      host.hidden = !visible;
      if (resumeBtn) {
        const hasSaved = hasSavedAccountSession(accountSession);
        resumeBtn.hidden = !hasSaved;
        if (hasSaved) {
          const display = accountSession.user?.displayName || accountSession.user?.username;
          resumeBtn.textContent = `恢复账号 (@${display})`;
        }
      }
      return visible;
    },
    setMode,
    getMode: () => mode,
    dispose() {
      disposed = true;
      host.removeEventListener('click', onHostClick);
    },
  };
}
