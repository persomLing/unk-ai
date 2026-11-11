import { awaitWithTimeout } from '../utils/abortable.js';

const descriptions = {
  standard: '常规浏览操作直接执行；提交、删除、上传等操作会先请你确认。',
  strict: '点击、输入、选择和导航等操作前由你确认；读取、等待和滚动无需逐次确认。切换到严格模式会暂停当前任务。',
  automatic: '已授权站点中的提交、删除、上传等操作会直接执行，可随时停止或接管。新任务或明确继续任务时启用；新站点仍需授权。',
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

/** Options UI only. Execution authority remains in the background task lease. */
export function installAgentSettings({ root, getSettings, saveSettings, listGrants, revokeGrant, storageEvents, timeoutMs = 8000 }) {
  const enabled = root.querySelector('#agent-enabled');
  const mode = root.querySelector('#agent-approval-mode');
  const description = root.querySelector('#agent-approval-description');
  const steps = root.querySelector('#agent-max-steps');
  const minutes = root.querySelector('#agent-max-minutes');
  const sites = root.querySelector('#agent-site-list');
  const feedback = root.querySelector('#agent-settings-feedback');
  const controls = [enabled, mode, steps, minutes];
  const document = root.ownerDocument || root;
  let disposed = false, busy = false, refreshAfterSave = false, renderVersion = 0, saveVersion = 0, storageVersion = 0;
  let lastSettings;
  let writes = Promise.resolve();
  const listeners = [];

  function notify(message, kind = '') {
    if (disposed) return;
    feedback.hidden = !message;
    feedback.textContent = message;
    feedback.className = `inline-feedback ${kind}`;
  }
  function setBusy(value) {
    busy = value;
    if (!disposed) controls.forEach(control => { control.disabled = value; });
  }
  function budgetValue(input, value, unit) {
    const selected = String(value);
    if (![...input.options].some(option => option.value === selected)) {
      const option = document.createElement('option');
      option.value = selected;
      option.textContent = `${selected} ${unit}`;
      input.append(option);
    }
    input.value = selected;
  }
  function paint(settings) {
    enabled.checked = settings.enabled;
    mode.value = settings.strictMode ? 'strict' : settings.autoApprove ? 'automatic' : 'standard';
    description.textContent = descriptions[mode.value];
    budgetValue(steps, settings.maxSteps, '步');
    budgetValue(minutes, settings.maxMinutes, '分钟');
  }
  async function render() {
    const version = ++renderVersion;
    try {
      const [settings, grants] = await awaitWithTimeout(Promise.all([getSettings(), listGrants()]), { timeoutMs, message: '读取浏览器控制设置超时，请稍后重试。' });
      if (disposed || version !== renderVersion) return;
      lastSettings = settings;
      paint(settings);
      sites.innerHTML = grants.length ? grants.map(grant => `
        <div class="agent-site-row"><div><strong>${escape(grant.origin)}</strong><small>${grant.scope === 'always' ? '始终允许' : '仅当前任务'}</small></div>
          <button class="inline-action" type="button" data-agent-revoke="${escape(grant.origin)}">撤销</button></div>`).join('')
        : '<p class="agent-site-empty">还没有授权任何站点。</p>';
      sites.querySelectorAll('[data-agent-revoke]').forEach(button => {
        button.addEventListener('click', async () => {
          if (disposed) return;
          button.disabled = true;
          try {
            await awaitWithTimeout(revokeGrant(button.dataset.agentRevoke), { timeoutMs, message: '撤销授权等待超时，请核对站点列表。' });
            if (disposed) return;
            notify('已撤销站点授权。', 'success');
            await render();
          } catch (error) { if (!disposed) { button.disabled = false; notify(error.message || '撤销授权失败，请重试。', 'error'); } }
        });
      });
    } catch (error) { if (!disposed && version === renderVersion) notify(error.message || '读取浏览器控制设置失败，请重试。', 'error'); }
  }

  async function save(patch, successMessage) {
    if (disposed || busy) return;
    const version = ++saveVersion;
    const storageAtStart = storageVersion;
    ++renderVersion;
    setBusy(true);
    // A timeout ends local waiting, not the storage write. Later changes stay
    // behind the actual write so a delayed read/merge cannot overwrite them.
    const pending = writes.catch(() => {}).then(() => {
      if (disposed) throw new DOMException('设置页面已关闭。', 'AbortError');
      return saveSettings(patch);
    });
    writes = pending.catch(() => {});
    void pending.then(saved => {
      if (disposed || version !== saveVersion) return;
      // A completed write can return after a newer setting was observed in
      // another tab. Its receipt must not restore the older permission UI.
      if (storageAtStart !== storageVersion) {
        notify('浏览器控制设置已更新。', 'success');
        if (!busy) void render();
        return;
      }
      lastSettings = saved;
      paint(saved);
      notify(successMessage, 'success');
    }, () => {});
    try {
      await awaitWithTimeout(pending, { timeoutMs, message: '保存等待超时，仍会按顺序写入；请稍后核对设置。' });
    } catch (error) {
      if (!disposed && version === saveVersion) {
        if (lastSettings) paint(lastSettings);
        notify(error.message || '设置保存失败，请重试。', 'error');
      }
    } finally {
      if (!disposed && version === saveVersion) {
        setBusy(false);
        if (refreshAfterSave) { refreshAfterSave = false; void render(); }
      }
    }
  }
  function on(control, handler) { control.addEventListener('change', handler); listeners.push(() => control.removeEventListener('change', handler)); }
  on(enabled, () => void save({ enabled: enabled.checked }, `浏览器控制已${enabled.checked ? '开启' : '关闭'}，立即生效。`));
  on(mode, () => {
    const choice = mode.value;
    if (!Object.hasOwn(descriptions, choice)) { if (lastSettings) paint(lastSettings); return; }
    void save({ autoApprove: choice === 'automatic', strictMode: choice === 'strict' }, choice === 'automatic'
      ? '已选择自动批准操作，新任务或继续任务时启用。'
      : `已切换为${choice === 'strict' ? '逐次确认' : '标准确认'}；收紧操作权限会暂停当前任务。`);
  });
  for (const [input, field] of [[steps, 'maxSteps'], [minutes, 'maxMinutes']]) on(input, () => {
    const value = Number(input.value);
    if (input.value === '' || !Number.isSafeInteger(value) || value < 0) { if (lastSettings) paint(lastSettings); return; }
    void save({ [field]: value }, '任务预算已保存，新任务或继续任务时生效。');
  });
  function onStorageChanged(changes, area) {
    if (disposed || area !== 'local' || (!changes.agentSettings && !changes.agentOriginGrants)) return;
    ++storageVersion;
    if (busy) refreshAfterSave = true;
    else void render();
  }
  storageEvents?.addListener(onStorageChanged);
  return {
    render,
    dispose() { disposed = true; ++renderVersion; ++saveVersion; storageEvents?.removeListener(onStorageChanged); listeners.forEach(remove => remove()); },
  };
}
