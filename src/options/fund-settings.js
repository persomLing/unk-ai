import {
  clearCachedMcpTools,
  DEFAULT_DAILY_QUOTA,
  DEFAULT_YINGMI_ENDPOINT,
  hasFundModeApiKey,
  loadFundModeConfig,
  loadOwnFundModeConfig,
  saveFundModeConfig,
  testFundModeConnection,
} from '../sidepanel/features/fund-mode/fund-mode-config.js';
import { clearDailyMarketTemperature, loadDailyFundUsage } from '../sidepanel/features/fund-mode/fund-tool-cache.js';
import { icon } from '../sidepanel/icons.js';

export function installFundSettings(document = globalThis.document) {
  const section = document.querySelector('#fund-section');
  if (!section) return { dispose() {} };

  const apiKeyInput = section.querySelector('#fund-api-key');
  const toggleKeyBtn = section.querySelector('#fund-toggle-key');
  const endpointInput = section.querySelector('#fund-endpoint');
  const saveBtn = section.querySelector('#fund-save-config');
  const testBtn = section.querySelector('#fund-test-connection');
  const testLabel = testBtn?.querySelector('.button-label');
  const clearCacheBtn = section.querySelector('#fund-clear-cache');
  const statusSummary = section.querySelector('#fund-connection-summary');
  const feedback = section.querySelector('#fund-feedback');

  let disposed = false;
  let testController = null;
  let busy = false;

  function setFeedback(text, kind = '') {
    if (disposed || !feedback) return;
    feedback.hidden = !text;
    feedback.textContent = text;
    feedback.className = `inline-feedback ${kind}`.trim();
  }

  async function refreshSummary(config) {
    if (disposed || !statusSummary) return;
    const usage = await loadDailyFundUsage();
    const connectedText = config?.source === 'server-default'
      ? (config?.lastToolCount > 0
        ? `当前使用后台默认盈米密钥（已发现 ${config.lastToolCount} 个只读工具，填写个人密钥可覆盖）`
        : '当前使用后台默认盈米密钥（留空自动生效；填写个人密钥可覆盖）')
      : config?.lastToolCount > 0
        ? `已发现 ${config.lastToolCount} 个只读工具`
        : hasFundModeApiKey(config)
          ? '已填写密钥，点击「测试连接」验证'
          : '尚未配置盈米 API Key';
    const usageText = usage.source === 'remote' && usage.limit
      ? `服务端今日额度 ${usage.count} / ${usage.limit}`
      : `本机今日兜底计数 ${usage.count} 次（全端准确用量请以盈米控制台为准）`;
    statusSummary.textContent = `${connectedText} · ${usageText}`;
  }

  async function loadInitial() {
    const [ownConfig, effectiveConfig] = await Promise.all([
      loadOwnFundModeConfig(),
      loadFundModeConfig(),
    ]);
    if (disposed) return;
    if (apiKeyInput) apiKeyInput.value = ownConfig.apiKey || '';
    if (endpointInput) endpointInput.value = ownConfig.endpoint || DEFAULT_YINGMI_ENDPOINT;
    await refreshSummary(effectiveConfig);
  }

  function currentDraft() {
    return {
      apiKey: String(apiKeyInput?.value || '').trim(),
      endpoint: String(endpointInput?.value || '').trim() || DEFAULT_YINGMI_ENDPOINT,
    };
  }

  const onToggleKey = () => {
    if (!apiKeyInput || !toggleKeyBtn) return;
    const visible = apiKeyInput.type === 'text';
    apiKeyInput.type = visible ? 'password' : 'text';
    toggleKeyBtn.innerHTML = icon(visible ? 'eye' : 'eye-off');
    toggleKeyBtn.setAttribute('aria-label', visible ? '显示盈米 API Key' : '隐藏盈米 API Key');
    toggleKeyBtn.title = visible ? '显示盈米 API Key' : '隐藏盈米 API Key';
  };

  const onSave = async () => {
    if (busy || disposed) return;
    try {
      const saved = await saveFundModeConfig(currentDraft());
      await refreshSummary(saved);
      const own = await loadOwnFundModeConfig();
      if (hasFundModeApiKey(own)) {
        setFeedback('盈米 MCP 配置已保存到本机浏览器。', 'success');
      } else if (saved.source === 'server-default') {
        setFeedback('已清除个人盈米密钥；当前自动回退使用后台默认盈米密钥。', 'success');
      } else {
        setFeedback('已清除盈米 API Key。', 'success');
      }
    } catch (error) {
      setFeedback(error?.message || '保存配置失败。', 'error');
    }
  };

  const onTest = async () => {
    if (busy || disposed) return;
    const draft = currentDraft();
    const effective = await loadFundModeConfig();
    if (disposed) return;
    const usingServerDefault = !draft.apiKey && effective.source === 'server-default';
    const testTarget = usingServerDefault
      ? { endpoint: effective.endpoint, apiKey: effective.apiKey, authMode: effective.authMode }
      : { endpoint: draft.endpoint, apiKey: draft.apiKey, authMode: 'x-api-key' };
    if (!testTarget.apiKey) {
      setFeedback('请先填写盈米 MCP API Key，或登录已启用默认盈米的账号。', 'error');
      apiKeyInput?.focus();
      return;
    }
    busy = true;
    testController?.abort();
    testController = new AbortController();
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.classList.add('is-busy');
    }
    if (testLabel) testLabel.textContent = '连接中…';
    setFeedback(usingServerDefault
      ? '正在通过账号服务器默认盈米通道握手并拉取工具清单…'
      : '正在握手盈米 Streamable HTTP MCP 并拉取工具清单…');

    try {
      const result = await testFundModeConnection({
        endpoint: testTarget.endpoint,
        apiKey: testTarget.apiKey,
        authMode: testTarget.authMode,
        signal: testController.signal,
      });
      if (disposed) return;
      const saved = await saveFundModeConfig({
        ...(usingServerDefault ? {} : { ...draft, endpoint: result.endpoint }),
        lastConnectedAt: new Date().toISOString(),
        lastToolCount: result.toolCount,
      });
      await refreshSummary(saved);
      setFeedback(`连接成功！已发现 ${result.toolCount} 个只读基金工具（耗时 ${result.latencyMs} ms）${usingServerDefault ? '（使用后台默认密钥）' : '，配置已自动保存'}。`, 'success');
    } catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      setFeedback(error?.message || '连接盈米 MCP 失败，请检查密钥与网络。', 'error');
    } finally {
      busy = false;
      testController = null;
      if (!disposed) {
        if (testBtn) {
          testBtn.disabled = false;
          testBtn.classList.remove('is-busy');
        }
        if (testLabel) testLabel.textContent = '测试连接';
      }
    }
  };

  const onClearCache = async () => {
    if (busy || disposed) return;
    await clearCachedMcpTools();
    await clearDailyMarketTemperature();
    const config = await loadFundModeConfig();
    await refreshSummary(config);
    setFeedback('已清空本地工具清单与今日市场温度缓存；下次进入基金模式时将重新同步。', 'success');
  };

  toggleKeyBtn?.addEventListener('click', onToggleKey);
  saveBtn?.addEventListener('click', onSave);
  testBtn?.addEventListener('click', onTest);
  clearCacheBtn?.addEventListener('click', onClearCache);

  const onStorageChange = (changes, area) => {
    if (area !== 'local' || disposed) return;
    if (changes.fundModeDailyUsage || changes.fundModeConfig || changes.accountSession) {
      void loadFundModeConfig().then(refreshSummary);
    }
  };
  globalThis.chrome?.storage?.onChanged?.addListener?.(onStorageChange);

  void loadInitial();

  return {
    dispose() {
      disposed = true;
      testController?.abort();
      toggleKeyBtn?.removeEventListener('click', onToggleKey);
      saveBtn?.removeEventListener('click', onSave);
      testBtn?.removeEventListener('click', onTest);
      clearCacheBtn?.removeEventListener('click', onClearCache);
      globalThis.chrome?.storage?.onChanged?.removeListener?.(onStorageChange);
    },
  };
}
