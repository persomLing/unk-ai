
async function initTheme() {
  try { const { theme = 'light' } = await chrome.storage.local.get('theme'); applySettingsTheme(theme); }
  catch { applySettingsTheme('light'); }
}

function applySettingsTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const button = document.querySelector('#settings-theme');
  if (button) {
    button.innerHTML = icon(dark ? 'sun' : 'moon');
    button.setAttribute('aria-label', dark ? '切换为浅色模式' : '切换为深色模式');
    button.title = dark ? '切换为浅色模式' : '切换为深色模式';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.theme) {
    applySettingsTheme(changes.theme.newValue || 'light');
  }
});

initTheme();

import { getProviderConfig, saveProviderConfig } from '../utils/storage.js';
import { fetchModels, probeResearchCapabilities, resolveApiUrl } from '../utils/llm-client.js';
import { credentialForModel, normalizeProfile } from '../utils/profiles.js';
import {
  chooseConversationDirectory,
  getDirectoryInfo,
  refreshDirectoryMeta,
} from '../utils/local-directory.js';
import {
  getAgentSettings,
  listOriginGrants,
  revokeOrigin,
  saveAgentSettings,
} from '../utils/agent-permissions.js';
import { icon, hydrateIcons } from '../sidepanel/icons.js';
import { createModelSelection, updateModelDraft } from './model-selection.js';
import { installSettingsNavigation } from './settings-navigation.js';
import { validateModelGeneration } from './model-validation.js';
import { awaitWithTimeout } from '../utils/abortable.js';
import { recordDiagnostic, getDiagnosticStatus, collectDiagnosticLogs, flushDiagnostics } from '../utils/diagnostic-log.js';
import { installRuntimeDiagnostics } from '../utils/diagnostic-observer.js';
import { createDiagnosticExporter, diagnosticStatusText } from '../sidepanel/features/diagnostics/diagnostic-export.js';
import { createExportDownloader } from '../sidepanel/features/export/download-export.js';

const form = document.querySelector('#settings-form');
const statusElement = document.querySelector('#settings-status');
const saveButton = document.querySelector('#save-settings');
const testButton = document.querySelector('#test-connection');
const loadModelsButton = document.querySelector('#load-models');
const loadModelsLabel = loadModelsButton.querySelector('.button-label');
const loadModelsFeedback = document.querySelector('#load-models-feedback');
const addModelButton = document.querySelector('#add-model');
const modelSelect = document.querySelector('#model-select');
const modelMeta = document.querySelector('#model-meta');
const modelLibrary = document.querySelector('#model-library');
const reasoningEnabled = document.querySelector('#reasoning-enabled');
const visionEnabled = document.querySelector('#vision-enabled');
const reasoningEffort = document.querySelector('#reasoning-effort');
const reasoningEffortField = document.querySelector('#reasoning-effort-field');
const storageLocation = document.querySelector('#storage-location');
const storageStatus = document.querySelector('#storage-status');
const storageFeedback = document.querySelector('#storage-feedback');
const agentEnabled = document.querySelector('#agent-enabled');
const agentStrict = document.querySelector('#agent-strict');
const agentSiteList = document.querySelector('#agent-site-list');
const agentSettingsFeedback = document.querySelector('#agent-settings-feedback');
const setupBanner = document.querySelector('#setup-banner');
const chooseDirectoryButton = document.querySelector('#choose-directory');
const parametersModelName = document.querySelector('#parameters-model-name');
const webSearchEndpoint = document.querySelector('#web-search-endpoint');
const webFetchEndpoint = document.querySelector('#web-fetch-endpoint');
const webResearchEnabled = document.querySelector('#web-research-enabled');
const detectResearchButton = document.querySelector('#detect-research');
const detectResearchLabel = detectResearchButton.querySelector('.button-label');
const researchFeedback = document.querySelector('#research-feedback');
let testController = null;
let modelsController = null;
let researchController = null;
let discoveredModels = [];
let hasDiscoveredModels = false;
let discoveredCredentials = '';
let profileLibrary = [];
const modelSelection = createModelSelection({
  getProfiles: () => profileLibrary,
  setProfiles: profiles => { profileLibrary = profiles; },
  readGeneration: currentGenerationSettings,
});
const autofilledFields = new Set();
let settingsReady = false;
let settingsRevision = 0;
let savedRevision = 0;
let hasSavedConfig = false;
let disposed = false;
let configBusy = false;
let agentSettingsBusy = false;
let diagnosticStatusVersion = 0;
const diagnosticStatus = document.querySelector('#diagnostic-status');
const diagnosticFeedback = document.querySelector('#diagnostic-feedback');
const diagnosticExporter = createDiagnosticExporter({ collect: collectDiagnosticLogs,
  download: createExportDownloader({ download: options => chrome.downloads.download(options) }),
  notify: (message, kind = '') => {
    if (disposed) return;
    diagnosticFeedback.hidden = !message;
    diagnosticFeedback.textContent = message;
    diagnosticFeedback.className = `inline-feedback ${kind}`;
  },
});
const removeRuntimeDiagnostics = installRuntimeDiagnostics(window, recordDiagnostic, 'options');
async function renderDiagnostics(flush = false) {
  const version = ++diagnosticStatusVersion;
  try {
    const status = await awaitWithTimeout(flush ? flushDiagnostics() : getDiagnosticStatus(), { timeoutMs: 8000 });
    if (!disposed && version === diagnosticStatusVersion) diagnosticStatus.textContent = diagnosticStatusText(status);
  } catch {
    if (!disposed && version === diagnosticStatusVersion) diagnosticStatus.textContent = '日志状态暂不可用，可重试或直接导出浏览器中仍可用的记录。';
  }
}
document.querySelector('#export-diagnostics').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await diagnosticExporter.exportToday({ all: true }); }
  finally { if (!disposed) button.disabled = false; }
});
document.querySelector('#flush-diagnostics').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await renderDiagnostics(true); }
  finally { if (!disposed) button.disabled = false; }
});

hydrateIcons();
const navigation = installSettingsNavigation(document);
document.querySelector('#settings-theme')?.addEventListener('click', async () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { await chrome.storage.local.set({ theme }); applySettingsTheme(theme); }
  catch { setStatus('主题保存失败，请重试。', 'error'); }
});

function renderSaveState() {
  const node = document.querySelector('#save-state');
  if (!node) return;
  const dirty = settingsRevision !== savedRevision;
  node.dataset.state = dirty ? 'dirty' : 'saved';
  node.textContent = !settingsReady ? '正在读取配置…' : dirty ? '有未保存的修改' : hasSavedConfig ? '模型配置已保存' : '配置后保存以开始使用';
}
function markDirty() { if (settingsReady) { settingsRevision += 1; renderSaveState(); } }
renderSaveState();

function setStatus(message, kind = '') {
  statusElement.hidden = !message;
  statusElement.textContent = message;
  statusElement.className = `settings-status ${kind}`;
}

function setStorageFeedback(message, kind = '') {
  storageFeedback.hidden = !message;
  storageFeedback.textContent = message;
  storageFeedback.className = `inline-feedback ${kind}`;
}

function setAgentFeedback(message, kind = '') {
  agentSettingsFeedback.hidden = !message;
  agentSettingsFeedback.textContent = message;
  agentSettingsFeedback.className = `inline-feedback ${kind}`;
}

function setResearchFeedback(message, kind = '') {
  researchFeedback.hidden = !message;
  researchFeedback.textContent = message;
  researchFeedback.className = `inline-feedback ${kind}`;
}

function setResearchLoading(loading) {
  detectResearchButton.disabled = loading;
  detectResearchButton.setAttribute('aria-busy', String(loading));
  detectResearchButton.classList.toggle('is-loading', loading);
  detectResearchLabel.textContent = loading ? '检测中…' : '检测接口';
}

function agentEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function renderAgentSettings() {
  const settings = await getAgentSettings();
  agentEnabled.checked = settings.enabled;
  agentStrict.checked = settings.strictMode;
  const grants = await listOriginGrants();
  if (!grants.length) {
    agentSiteList.innerHTML = '<p class="agent-site-empty">还没有授权任何站点。</p>';
    return;
  }
  agentSiteList.innerHTML = grants.map((grant) => `
    <div class="agent-site-row">
      <div>
        <strong>${agentEscape(grant.origin)}</strong>
        <small>${grant.scope === 'always' ? '始终允许' : '仅当前任务'}</small>
      </div>
      <button class="inline-action" type="button" data-agent-revoke="${agentEscape(grant.origin)}">撤销</button>
    </div>
  `).join('');
  agentSiteList.querySelectorAll('[data-agent-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await revokeOrigin(button.dataset.agentRevoke);
        if (disposed) return;
        setAgentFeedback('已撤销站点授权。', 'success');
        await renderAgentSettings();
      } catch (error) { if (!disposed) { button.disabled = false; setAgentFeedback(error.message || '撤销授权失败，请重试。', 'error'); } }
    });
  });
}

async function changeAgentSetting(field, input) {
  if (agentSettingsBusy) return;
  const requested = input.checked;
  agentSettingsBusy = true;
  agentEnabled.disabled = agentStrict.disabled = true;
  try {
    const saved = await saveAgentSettings({ [field]: requested });
    if (disposed) return;
    agentEnabled.checked = saved.enabled;
    agentStrict.checked = saved.strictMode;
    setAgentFeedback(`${field === 'enabled' ? '浏览器控制' : '严格模式'}已${requested ? '开启' : '关闭'}，立即生效。`, 'success');
  } catch (error) {
    if (!disposed) { input.checked = !requested; setAgentFeedback(error.message || '开关保存失败，请重试。', 'error'); }
  } finally {
    agentSettingsBusy = false;
    if (!disposed) agentEnabled.disabled = agentStrict.disabled = false;
  }
}
agentEnabled?.addEventListener('change', () => changeAgentSetting('enabled', agentEnabled));
agentStrict?.addEventListener('change', () => changeAgentSetting('strictMode', agentStrict));

async function renderStorage() {
  void renderDiagnostics();
  const info = await getDirectoryInfo();
  storageLocation.textContent = info.configured
    ? `已选择：${info.name || '本地文件夹'}`
    : '尚未选择保存位置';
  storageStatus.textContent = info.granted
    ? '正式对话会写入此文件夹，并同步删除对应文件'
    : info.configured
      ? '文件夹授权已失效，请重新选择或授权'
      : '首次使用需授权一个本地文件夹';
  chooseDirectoryButton.lastChild.textContent = info.configured ? (info.granted ? '更换文件夹' : '恢复权限') : '选择文件夹';
  const hasModel = Boolean(form.elements.endpointUrl.value.trim() && profileLibrary.length);
  const setupRequired = !info.granted || !hasModel;
  setupBanner.hidden = !setupRequired;
  saveButton.disabled = configBusy || !info.granted;
  if (!info.configured) {
    setupBanner.querySelector('strong').textContent = '先选择本地对话存储位置';
    setupBanner.querySelector('span').textContent = '保存模型前，请先授权一个用于保存正式对话的本地文件夹。';
  } else if (!info.granted) {
    setupBanner.querySelector('strong').textContent = '文件夹授权已失效';
    setupBanner.querySelector('span').textContent = '请重新点击“选择文件夹”恢复读写权限，再保存模型设置。';
  } else if (!hasModel) {
    setupBanner.querySelector('strong').textContent = '还差一个模型';
    setupBanner.querySelector('span').textContent = '请填写服务地址，获取模型并添加到模型库。';
  }
  const setupAction = document.querySelector('#setup-action');
  if (setupAction) { setupAction.href = !info.granted ? '#storage-section' : '#connection-section'; setupAction.textContent = !info.granted ? '前往本地数据' : '连接模型'; }
  return info;
}

function setLoadModelsFeedback(message, kind = '') {
  loadModelsFeedback.hidden = !message;
  loadModelsFeedback.textContent = message;
  loadModelsFeedback.className = `inline-feedback ${kind}`;
}

function setLoadModelsLoading(loading) {
  loadModelsButton.disabled = loading;
  loadModelsButton.setAttribute('aria-busy', String(loading));
  loadModelsButton.classList.toggle('is-loading', loading);
  loadModelsLabel.textContent = loading ? '获取中…' : '获取模型';
}

function markAutofilled(input, value, autofill) {
  input.classList.remove('is-autofilled');
  if (autofill && value !== undefined && value !== null && value !== '') {
    input.classList.add('is-autofilled');
    autofilledFields.add(input);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function numberFromField(name) {
  const value = form.elements[name].value.trim();
  return value === '' ? undefined : Number(value);
}

function findDiscoveredModel(id) {
  return discoveredModels.find((model) => model.id === id) || null;
}

function currentCredentials() {
  return credentialForModel(
    form.elements.endpointUrl.value.trim(),
    form.elements.apiKey.value.trim(),
  );
}

function restoreDiscoveredModels() {
  const credentials = currentCredentials();
  if (discoveredCredentials !== credentials) {
    modelsController?.abort(new DOMException('连接信息已变化，请重新获取模型。', 'AbortError'));
    researchController?.abort(new DOMException('连接信息已变化，请重新检测。', 'AbortError'));
    discoveredModels = [];
    hasDiscoveredModels = false;
    discoveredCredentials = credentials;
    renderModelMeta(null);
    renderDiscoveredModels();
    return;
  }
  discoveredModels = discoveredModels.filter((model) =>
    !profileLibrary.some((profile) => profile.id === model.id));
  renderDiscoveredModels();
}

function activeProfile() {
  return modelSelection.current();
}

function currentGenerationSettings() {
  return {
    contextLength: numberFromField('contextLength'),
    maxOutputTokens: numberFromField('maxTokens'),
    temperature: numberFromField('temperature'),
    reasoningEnabled: reasoningEnabled.checked,
    visionEnabled: visionEnabled.checked,
    reasoningEffort: reasoningEffort.value || 'default',
  };
}

function applyProfileSettings(profile, { preserve = false } = {}) {
  if (!profile) return;
  const previousEffort = reasoningEffort.value;
  if (!preserve) {
    form.elements.contextLength.value = profile.contextLength ?? '';
    form.elements.maxTokens.value = profile.maxOutputTokens ?? '';
    form.elements.temperature.value = profile.temperature ?? '';
  } else if (!form.elements.contextLength.value) {
    form.elements.contextLength.value = profile.contextLength || '';
  }
  if (preserve && !form.elements.maxTokens.value) {
    form.elements.maxTokens.value = profile.maxOutputTokens || '';
  }
  markAutofilled(form.elements.contextLength, profile.contextLength, !preserve);
  markAutofilled(form.elements.maxTokens, profile.maxOutputTokens, !preserve);
  markAutofilled(form.elements.temperature, profile.temperature, !preserve);
  reasoningEnabled.disabled = false;
  visionEnabled.disabled = false;
  if (!preserve) {
    reasoningEnabled.checked = profile.supportsReasoning;
    visionEnabled.checked = profile.supportsVision;
  }
  reasoningEffort.disabled = !reasoningEnabled.checked;
  reasoningEffortField.hidden = !reasoningEnabled.checked;
  document.querySelector('#reasoning-hint').textContent = profile.supportsReasoning === null
    ? '服务商未声明思考能力；支持时可手动开启'
    : '按服务商实际能力设置；开启后可切换思考强度';
  document.querySelector('#vision-hint').textContent = profile.supportsVision === null
    ? '服务商未声明视觉能力；支持时可手动开启'
    : '按服务商实际能力设置；开启后可发送图片';
  const efforts = profile.reasoningEfforts?.length ? profile.reasoningEfforts : ['low', 'medium', 'high'];
  const selected = preserve
    ? (previousEffort || profile.reasoningDefaultEffort || 'default')
    : (profile.reasoningDefaultEffort || 'default');
  reasoningEffort.innerHTML = '<option value="default">跟随服务商默认</option>' + efforts
    .map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`).join('');
  reasoningEffort.value = ['default', ...efforts].includes(selected) ? selected : 'default';
  renderParametersModelName(profile);
}
function renderLibrary() {
  const selectedProfile = activeProfile();
  const selectedId = selectedProfile?.id;
  modelLibrary.innerHTML = profileLibrary.map((profile) => `
    <article class="library-item ${profile.id === selectedId ? 'is-selected' : ''}" data-library-model-id="${escapeHtml(profile.id)}" tabindex="0" role="button" aria-label="编辑模型 ${escapeHtml(profile.name)}">
      <div><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.id)} · ${profile.contextLength ? `${Number(profile.contextLength).toLocaleString('zh-CN')} 上下文` : '上下文跟随服务商'}</small></div>
      <div class="library-actions"><span class="library-current">${profile.id === selectedId ? '编辑中' : '编辑'}</span><button class="library-remove" type="button" data-model-id="${escapeHtml(profile.id)}" aria-label="移除 ${escapeHtml(profile.name)}">${icon('trash')}</button></div>
    </article>`).join('') || '<div class="library-empty">还没有添加模型。填写服务连接，获取列表后即可添加。</div>';
  renderParametersModelName(selectedProfile);
}

function renderParametersModelName(profile) {
  parametersModelName.hidden = !profile;
  parametersModelName.textContent = profile ? `正在编辑：${profile.name}` : '';
}
function renderModelMeta(model) {
  modelMeta.hidden = !model;
  if (!model) return;
  const details = [model.description, model.contextLength ? `上下文 ${Number(model.contextLength).toLocaleString(`zh-CN`)}` : ``, model.maxOutputTokens ? `输出 ${Number(model.maxOutputTokens).toLocaleString(`zh-CN`)}` : ``, model.temperature !== undefined && model.temperature !== null ? `Temperature ${model.temperature}` : ``, model.supportsReasoning ? `思考` : ``, model.supportsVision ? `视觉` : ``].filter(Boolean);
  modelMeta.innerHTML = `<strong>${escapeHtml(model.name)}</strong><span>${escapeHtml(model.id)}</span><small>${escapeHtml(details.join(` · `))}</small>`;
}


function addDiscoveredModel(model) {
  modelSelection.remember();
  const profile = normalizeProfile({
    ...model,
    maxOutputTokens: model.maxOutputTokens || model.maxTokens,
    reasoningEnabled: model.supportsReasoning,
    visionEnabled: model.supportsVision,
  });
  if (!profile) return;
  profile.temperature = model.temperature ?? null;
  const exists = profileLibrary.some((item) => item.id === profile.id);
  if (exists) {
    profileLibrary = profileLibrary.map((item) => item.id === profile.id ? profile : item);
  } else {
    profileLibrary.push(profile);
  }
  modelSelection.reset(profile.id);
  renderLibrary();
  applyProfileSettings(profile);
  renderParametersModelName(profile);
  markDirty();
  setStatus(exists ? `已更新模型：${profile.name}` : `已添加模型：${profile.name}`, 'success');
  renderStorage();
}

function renderDiscoveredModels() {
  if (!discoveredModels.length) {
    modelSelect.innerHTML = '<option value="">' + (hasDiscoveredModels ? '已获取的模型均已加入' : '请先获取模型列表') + '</option>';
    modelSelect.disabled = true;
    addModelButton.disabled = true;
    return;
  }
  modelSelect.innerHTML = '<option value="">选择要添加的模型</option>' + discoveredModels.map((model) => {
      const tags = [model.supportsReasoning ? '思考' : '', model.supportsVision ? '视觉' : ''].filter(Boolean).join(' / ');
      return `<option value="${escapeHtml(model.id)}">${escapeHtml(`${model.name}${model.name !== model.id ? ` · ${model.id}` : ''}${tags ? ` · ${tags}` : ''}`)}</option>`;
    }).join('');
  modelSelect.disabled = !discoveredModels.length;
  addModelButton.disabled = !modelSelect.value;
  if (discoveredModels.length) {
    modelSelect.selectedIndex = 0;
    renderModelMeta(findDiscoveredModel(modelSelect.value) || discoveredModels[0]);
  }
}

async function loadModels({ quiet = false } = {}) {
  const endpointUrl = form.elements.endpointUrl.value.trim();
  if (!endpointUrl) {
    form.elements.endpointUrl.setAttribute('aria-invalid', 'true');
    throw new Error('请先填写 API Base URL。');
  }
  try {
    const url = new URL(endpointUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    form.elements.endpointUrl.setAttribute('aria-invalid', 'true');
    throw new Error('API Base URL 需为有效的 HTTP 或 HTTPS 地址。');
  }
  setLoadModelsLoading(true);
  setLoadModelsFeedback('');
  const controller = new AbortController();
  modelsController = controller;
  const credentials = currentCredentials();
  if (!quiet) setStatus('正在读取模型列表…', 'testing');
  try {
    const options = {
      endpointUrl,
      apiKey: form.elements.apiKey.value.trim(),
      signal: controller.signal,
    };
    let allModels;
    try {
      allModels = await fetchModels(options);
    } catch (error) {
      controller.signal.throwIfAborted();
      // Some OpenAI-compatible servers expose /models at the origin instead of
      // under /v1. Retry that common shape once, without hiding other errors.
      if (!/\b404\b|not found/i.test(error.message || '')) throw error;
      const origin = endpointUrl.replace(/\/+$/, '').replace(/\/v1(?:\/(?:chat\/completions|models))?$/i, '');
      allModels = await fetchModels({ ...options, endpointUrl: origin });
    }
    controller.signal.throwIfAborted();
    if (disposed || credentials !== currentCredentials()) throw new DOMException('连接信息已变化，请重新获取模型。', 'AbortError');
    discoveredModels = allModels.filter((model) => !profileLibrary.some((profile) => profile.id === model.id));
    hasDiscoveredModels = true;
    discoveredCredentials = credentials;
    renderDiscoveredModels();
    const withParameters = allModels.filter((model) => model.contextLength || model.maxOutputTokens || (model.temperature !== undefined && model.temperature !== null)).length;
    const message = `已获取 ${allModels.length} 个模型${withParameters ? `，其中 ${withParameters} 个带生成参数` : ''}。选择后添加到模型库。`;
    setStatus(message, 'success');
    setLoadModelsFeedback(message, 'success');
    return allModels;
  } finally {
    if (modelsController === controller) { modelsController = null; if (!disposed) setLoadModelsLoading(false); }
  }
}

function readForm() {
  return {
    version: 5,
    endpointUrl: form.elements.endpointUrl.value.trim(),
    apiKey: form.elements.apiKey.value.trim(),
    webSearchEndpoint: form.elements.webSearchEndpoint.value.trim() || 'web_search',
    webFetchEndpoint: form.elements.webFetchEndpoint.value.trim() || 'web_fetch',
    webSearchEnabled: webResearchEnabled.checked,
    webFetchEnabled: webResearchEnabled.checked,
    temperature: numberFromField('temperature'),
    contextLength: numberFromField('contextLength'),
    maxTokens: numberFromField('maxTokens'),
    selectedModelId: activeProfile()?.id || profileLibrary[0]?.id || '',
    selectedModelName: activeProfile()?.name || profileLibrary[0]?.name || '',
    selectedEffort: reasoningEffort.value || 'default',
    models: profileLibrary.map((profile) => {
      if (profile.id !== activeProfile()?.id) return profile;
      return updateModelDraft(profile, currentGenerationSettings());
    }),
  };
}

function validate(config) {
  form.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
  if (!config.endpointUrl) {
    form.elements.endpointUrl.setAttribute('aria-invalid', 'true');
    throw new Error('请填写 API Base URL。');
  }
  if (!config.models.length) throw new Error('请先获取模型并添加到模型库。');
  for (const [name, label] of [['webSearchEndpoint', '搜索接口名'], ['webFetchEndpoint', '抓取接口名']]) {
    if (config[name] && (!/^[a-z0-9][a-z0-9_./-]*$/i.test(config[name]) || config[name].includes('..'))) {
      form.elements[name]?.setAttribute('aria-invalid', 'true');
      throw new Error(`${label}只能包含路径字符，且不能包含 ..。`);
    }
  }
  try { validateModelGeneration(config); }
  catch (error) {
    if (error.modelId && error.modelId !== activeProfile()?.id) {
      const profile = modelSelection.select(error.modelId);
      if (profile) { applyProfileSettings(profile); renderLibrary(); }
    }
    const field = form.elements[error.field];
    field?.setAttribute('aria-invalid', 'true');
    field?.focus();
    throw error;
  }
}

async function persist({ quiet = false } = {}) {
  const revision = settingsRevision;
  const config = readForm();
  validate(config);
  const saved = await saveProviderConfig(config);
  hasSavedConfig = true;
  savedRevision = revision;
  if (settingsRevision === revision) profileLibrary = saved.models;
  renderSaveState();
  if (!quiet) setStatus(settingsRevision === revision ? '设置已保存，可以在侧边栏切换模型和强度。' : '已保存刚才提交的配置；新的修改仍未保存。', 'success');
  return saved;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (configBusy) return;
  configBusy = true;
  saveButton.disabled = testButton.disabled = true;
  try {
    const storage = await getDirectoryInfo();
    if (!storage.granted) {
      setStorageFeedback('请先选择并授权本地对话存储文件夹，再保存设置。', 'error');
      storageLocation.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setupBanner.hidden = false;
      return;
    }
    await persist();
  } catch (error) {
    setStatus(error.message || '设置保存失败，请重试。', 'error');
  } finally {
    configBusy = false;
    testButton.disabled = false;
    saveButton.disabled = !(await getDirectoryInfo()).granted;
  }
});

loadModelsButton.addEventListener('click', async () => {
  try {
    await loadModels();
  } catch (error) {
    const message = error.name === 'AbortError' ? '获取模型已取消。' : error.message || '获取模型失败。';
    setStatus(message, 'error');
    setLoadModelsFeedback(message, 'error');
  }
});

detectResearchButton.addEventListener('click', async () => {
  const endpointUrl = form.elements.endpointUrl.value.trim();
  if (!endpointUrl) {
    form.elements.endpointUrl.setAttribute('aria-invalid', 'true');
    setResearchFeedback('请先填写 API Base URL。', 'error');
    return;
  }
  researchController?.abort();
  const controller = new AbortController();
  researchController = controller;
  const credentials = currentCredentials();
  const endpointNames = [webSearchEndpoint.value, webFetchEndpoint.value].join('\u0000');
  setResearchLoading(true);
  setResearchFeedback('正在检测搜索与抓取接口…', 'testing');
  try {
    const result = await probeResearchCapabilities({
      endpointUrl,
      apiKey: form.elements.apiKey.value.trim(),
      webSearchEndpoint: form.elements.webSearchEndpoint.value.trim() || 'web_search',
      webFetchEndpoint: form.elements.webFetchEndpoint.value.trim() || 'web_fetch',
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (disposed || credentials !== currentCredentials() || endpointNames !== [webSearchEndpoint.value, webFetchEndpoint.value].join('\u0000')) {
      throw new DOMException('检测期间配置已变化，请重新检测。', 'AbortError');
    }
    if (result.search.supported) {
      form.elements.webSearchEndpoint.value = result.search.endpointName;
      form.elements.webSearchEndpoint.classList.add('is-autofilled');
    }
    if (result.fetch.supported) {
      form.elements.webFetchEndpoint.value = result.fetch.endpointName;
      form.elements.webFetchEndpoint.classList.add('is-autofilled');
    }
    const lines = [
      result.search.supported
        ? `搜索可用：${result.search.endpointName}（${result.search.message}）`
        : `未检测到搜索接口。最后尝试 ${result.search.endpointName}：${result.search.message}`,
      result.fetch.supported
        ? `抓取可用：${result.fetch.endpointName}（${result.fetch.message}）`
        : `未检测到抓取接口。最后尝试 ${result.fetch.endpointName}：${result.fetch.message}`,
    ];
    if (result.search.tried?.length > 1) lines.push(`搜索已尝试：${result.search.tried.map(item => item.endpointName).join('、')}`);
    if (result.fetch.tried?.length > 1) lines.push(`抓取已尝试：${result.fetch.tried.map(item => item.endpointName).join('、')}`);
    const either = result.search.supported || result.fetch.supported;
    if (either) markDirty();
    setResearchFeedback(lines.join('\n'), either ? 'success' : 'error');
    setStatus(either ? '联网能力检测完成。可保存设置，也可手动填写中转站接口名。' : '没有检测到联网接口；可手动填写接口名后再检测。', either ? 'success' : 'error');
  } catch (error) {
    if (!disposed) setResearchFeedback(error.name === 'AbortError' ? '配置已变化或检测已取消，请重新检测。' : error.message || '联网能力检测失败。', 'error');
  } finally {
    if (researchController === controller) { researchController = null; if (!disposed) setResearchLoading(false); }
  }
});

modelSelect.addEventListener('change', () => {
  if (discoveredModels.length) {
    addModelButton.disabled = !modelSelect.value;
  }
  const discovered = findDiscoveredModel(modelSelect.value);
  if (discovered) {
    renderModelMeta(discovered);
    return;
  }
  renderModelMeta(null);
});

addModelButton.addEventListener('click', () => {
  const model = findDiscoveredModel(modelSelect.value);
  if (!model) return;
  discoveredModels = discoveredModels.filter((item) => item.id !== model.id);
  addDiscoveredModel(model);
  renderDiscoveredModels();
});

chooseDirectoryButton.addEventListener('click', async () => {
  chooseDirectoryButton.disabled = true;
  setStorageFeedback('正在等待文件夹授权…', 'testing');
  try {
    const info = await chooseConversationDirectory();
    await refreshDirectoryMeta();
    setStorageFeedback(`已选择“${info.name}”，正式对话会保存到 conversations/。`, 'success');
    await renderStorage();
  } catch (error) {
    if (error.name !== 'AbortError') setStorageFeedback(error.message || '文件夹选择或授权失败。', 'error');
    else setStorageFeedback('');
  } finally {
    chooseDirectoryButton.disabled = false;
  }
});

modelLibrary.addEventListener('click', (event) => {
  const button = event.target.closest('[data-model-id]');
  if (button) {
    const id = button.dataset.modelId;
    const previousId = activeProfile()?.id;
    modelSelection.remember();
    profileLibrary = profileLibrary.filter((profile) => profile.id !== id);
    const selected = modelSelection.reset(previousId);
    renderLibrary();
    if (selected) {
      applyProfileSettings(selected);
    } else {
      renderModelMeta(null);
    }
    markDirty();
    setStatus('已从模型库移除；保存后生效。', 'success');
    renderStorage();
    return;
  }
  const card = event.target.closest('[data-library-model-id]');
  if (!card) return;
  const profile = modelSelection.select(card.dataset.libraryModelId);
  if (!profile) return;
  applyProfileSettings(profile);
  renderParametersModelName(profile);
  renderLibrary();
  markDirty();
  setStatus(`正在编辑：${profile.name}。参数修改后保存即可生效。`, 'success');
  document.querySelector('#parameters-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

modelLibrary.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const card = event.target.closest('[data-library-model-id]');
  if (!card || event.target.closest('button')) return;
  event.preventDefault();
  card.click();
});

testButton.addEventListener('click', async () => {
  if (configBusy) return;
  configBusy = true;
  testButton.disabled = true;
  saveButton.disabled = true;
  setStatus('正在测试当前模型，不会读取或发送网页内容…', 'testing');
  const revision = settingsRevision;
  testController = new AbortController();
  const timeout = setTimeout(() => testController.abort(), 45000);
  try {
    const config = readForm();
    validate(config);
    const profile = config.models.find((model) => model.id === config.selectedModelId) || config.models[0];
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetch(resolveApiUrl(config.endpointUrl, 'chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: profile.id,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        stream: false,
        max_tokens: Math.min(32, profile.maxOutputTokens || 32),
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        ...(profile.supportsReasoning && config.selectedEffort && config.selectedEffort !== 'default'
          ? { reasoning_effort: config.selectedEffort }
          : {}),
      }),
      signal: testController.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.replaceAll(config.apiKey || '\u0000', '[redacted]').replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`连接失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    const payload = JSON.parse(text);
    if (payload.error) throw new Error(payload.error.message || '服务返回了错误。');
    if (!disposed) setStatus(settingsRevision === revision ? '连接成功，模型服务已响应。测试不会保存修改。' : '刚才提交的配置连接成功；当前的新修改尚未测试。', 'success');
  } catch (error) {
    setStatus(error.name === 'AbortError' ? '连接测试超时，请检查网络与服务地址后重试。' : error.message || '连接测试失败，请检查配置。', 'error');
  } finally {
    configBusy = false;
    clearTimeout(timeout);
    testController = null;
    testButton.disabled = false;
    saveButton.disabled = !(await getDirectoryInfo()).granted;
  }
});

document.querySelector('#toggle-key').addEventListener('click', (event) => {
  const input = document.querySelector('#api-key');
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  event.currentTarget.innerHTML = icon(visible ? 'eye' : 'eye-off');
  event.currentTarget.setAttribute('aria-label', visible ? '显示 API Key' : '隐藏 API Key');
  event.currentTarget.title = visible ? '显示 API Key' : '隐藏 API Key';
});

reasoningEnabled.addEventListener('change', () => {
  reasoningEffort.disabled = !reasoningEnabled.checked;
  reasoningEffortField.hidden = !reasoningEnabled.checked;
});

form.addEventListener('input', event => { setStatus(''); if (event.target !== modelSelect) markDirty(); });
form.elements.endpointUrl.addEventListener('input', restoreDiscoveredModels);
form.elements.apiKey.addEventListener('input', restoreDiscoveredModels);
for (const field of [webSearchEndpoint, webFetchEndpoint]) field.addEventListener('input', () => researchController?.abort());
form.addEventListener('input', (event) => {
  if (autofilledFields.has(event.target)) {
    event.target.classList.remove('is-autofilled');
    autofilledFields.delete(event.target);
  }
});
window.addEventListener('pagehide', () => {
  disposed = true;
  diagnosticExporter.dispose();
  removeRuntimeDiagnostics();
  void flushDiagnostics();
  testController?.abort();
  modelsController?.abort();
  researchController?.abort();
  navigation.dispose();
});

try {
  await renderStorage();
  const config = await getProviderConfig();
  if (config) {
    hasSavedConfig = true;
    form.elements.endpointUrl.value = config.endpointUrl || '';
    form.elements.apiKey.value = config.apiKey || '';
    form.elements.webSearchEndpoint.value = config.webSearchEndpoint || 'web_search';
    form.elements.webFetchEndpoint.value = config.webFetchEndpoint || 'web_fetch';
    webResearchEnabled.checked = config.webSearchEnabled !== false || config.webFetchEnabled !== false;
    form.elements.temperature.value = config.temperature ?? '';
    form.elements.contextLength.value = config.contextLength ?? '';
    form.elements.maxTokens.value = config.maxTokens ?? '';
    profileLibrary = config.models || [];
    modelSelection.reset(config.selectedModelId);
    discoveredCredentials = currentCredentials();
    renderLibrary();
    const profile = activeProfile() || profileLibrary[0];
    if (profile) {
      applyProfileSettings(profile);
      reasoningEffort.value = config.selectedEffort || profile.reasoningDefaultEffort || 'default';
    } else {
      renderDiscoveredModels();
    }
  } else {
    renderLibrary();
  }
  renderDiscoveredModels();
  await renderStorage();
  await renderAgentSettings();
} catch (error) {
  setStatus(`无法读取已有设置：${error.message}`, 'error');
} finally {
  settingsReady = true;
  renderSaveState();
}
