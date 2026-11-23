import { includes, map } from 'lodash-es';
import { normalizeProviderConfig } from '../../../utils/profiles.js';
import { $, escapeHtml } from '../../core/dom.js';
import { hydrateIcons, icon } from '../../icons.js';

const EFFORT_LABELS = Object.freeze({
  default: '默认',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
});

export function activeModel(config, selectedModelId) {
  return selectModelOption(config, selectedModelId);
}

export function renderModelSwitcher({
  config,
  selectedModelId,
  selectedEffort,
  generating,
  onClose,
}) {
  const normalized = normalizeProviderConfig(config);
  const switcher = $('#model-switcher');
  const trigger = $('#model-trigger');
  const dropdown = $('#model-dropdown');
  const select = $('#chat-model');
  const effort = $('#chat-effort');
  const displayName = $('#model-display-name');
  const effortBadge = $('#effort-display-badge');
  if (!switcher) return null;
  const chatModels = normalized?.models?.filter((model) => model.kind !== 'image') || [];
  switcher.hidden = false;
  const active = chatModels.find(item => item.id === selectedModelId) || null;
  const modelIndex = (item) => String(chatModels.indexOf(item));
  if (select) {
    select.innerHTML = '<option value="">选择模型</option>' + map(chatModels, (item) =>
      `<option value="${escapeHtml(modelIndex(item))}">${escapeHtml(item.name)}</option>`).join('');
    select.value = active ? modelIndex(active) : '';
  }
  const efforts = active?.reasoningEfforts?.length
    ? active.reasoningEfforts
    : ['low', 'medium', 'high'];
  if (effort) {
    if (active?.supportsReasoning) {
      effort.disabled = generating;
      effort.hidden = false;
      effort.innerHTML = '<option value="default">默认</option>' + map(efforts, (item) =>
        `<option value="${escapeHtml(item)}">${escapeHtml(EFFORT_LABELS[item] || item)}</option>`).join('');
      effort.value = includes(['default', ...efforts], selectedEffort) ? selectedEffort : 'default';
    } else {
      effort.hidden = true;
      effort.disabled = true;
    }
  }
  if (trigger) {
    trigger.disabled = generating;
    if (generating) onClose?.();
  }
  if (displayName) {
    displayName.textContent = active?.name || '选择模型';
    displayName.title = active?.name || '';
  }
  if (effortBadge) {
    effortBadge.hidden = !active?.supportsReasoning;
    if (active?.supportsReasoning) {
      effortBadge.textContent = selectedEffort === 'default'
        ? '思考'
        : `思考 · ${EFFORT_LABELS[selectedEffort] || selectedEffort}`;
      effortBadge.title = `思考强度：${EFFORT_LABELS[selectedEffort] || selectedEffort}`;
    }
  }
  if (dropdown) {
    const modelItems = map(chatModels, (item) => {
      const isActive = item.id === active?.id;
      return `
        <button type="button" class="dropdown-model-item ${isActive ? 'is-active' : ''}" role="option" aria-selected="${isActive}" data-model-id="${escapeHtml(item.id)}">
          <div class="dropdown-model-info"><span class="dropdown-model-name">${escapeHtml(item.name)}</span>
            <div class="dropdown-model-tags">
              ${item.supportsReasoning ? '<span class="model-tag reasoning">思考</span>' : ''}
              ${item.supportsVision ? '<span class="model-tag vision">视觉</span>' : ''}
            </div>
          </div>${isActive ? `<span class="dropdown-check">${icon('check')}</span>` : ''}
        </button>`;
    }).join('') || '<p class="dropdown-model-empty">请在设置中添加对话模型。</p>';
    const effortHtml = active?.supportsReasoning
      ? `<div class="dropdown-section"><span class="dropdown-section-title">思考强度</span><div class="dropdown-effort-pills">${
        map(['default', ...efforts], (item) =>
          `<button type="button" class="effort-pill ${selectedEffort === item ? 'is-active' : ''}" data-effort="${escapeHtml(item)}">${escapeHtml(EFFORT_LABELS[item] || item)}</button>`).join('')
      }</div></div>`
      : '';
    dropdown.innerHTML = `<div class="dropdown-header"><span>选择模型</span><button type="button" class="dropdown-settings-link" id="dropdown-open-settings" title="管理模型"><i data-icon="settings"></i></button></div><div class="dropdown-model-list">${modelItems}</div>${effortHtml}`;
    hydrateIcons(dropdown);
  }
  return { model: active, config: normalized };
}

export function toggleModelDropdown(force) {
  const dropdown = $('#model-dropdown');
  const trigger = $('#model-trigger');
  if (!dropdown || !trigger) return;
  const show = force !== undefined ? Boolean(force) : dropdown.hidden;
  dropdown.hidden = !show;
  trigger.setAttribute('aria-expanded', String(show));
}

export function selectModelOption(config, modelId) {
  const normalized = normalizeProviderConfig(config);
  return normalized?.models?.find((model) => model.kind !== 'image' && model.id === modelId) || null;
}
