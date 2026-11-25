import { formatTokenCount } from '../../../utils/context.js';
import { tokenShares } from '../../../utils/token-usage.js';
import { tickNumber } from '../../core/motion.js';

export function renderContextUsageView({ find, usage, hasModel, hasRequest }) {
  const button = find('#context-meter-button');
  const scopeName = usage.scope === 'request' ? '最近请求' : '下一次提问';
  const overBudget = usage.overBudget;
  const pressure = usage.budgetPercent;
  button.classList.toggle('warning', pressure >= 75 && pressure < 90);
  button.classList.toggle('danger', pressure >= 90);
  const ratio = Math.min(100, Math.max(0, Number(usage.percent) || 0));
  button.style?.setProperty?.('--context-angle', `${(ratio * 3.6).toFixed(1)}deg`);
  button.classList.toggle('has-usage', ratio > 0);
  const capacityLabel = overBudget ? '输入估算超过可用空间' : `输入估算占容量 ${usage.percent}%`;
  const description = `会话整理 · ${scopeName} · ${capacityLabel}，点击查看详情`;
  button.setAttribute('aria-label', description);
  button.title = description;
  button.dataset.tooltip = description;
  button.hidden = !hasModel;
  const put = (selector, value) => { const node = find(selector); if (node) node.textContent = value; };
  const progressBar = find('#context-progress-bar');
  if (progressBar) progressBar.style.width = `${Math.min(100, usage.percent)}%`;
  put('#context-meter-label', overBudget ? '超预算' : `${usage.percent}%`);
  put('#context-model-name', hasModel ? usage.modelName : '');
  tickNumber(find('#context-used-percent'), overBudget ? '输入超过可用空间' : `${usage.percent}% 输入估算`);
  put('#context-remaining-percent', `（${usage.remainingPercent}% 可用）`);
  put('#context-token-count', `约 ${formatTokenCount(usage.used)} Tokens / 总容量 ${formatTokenCount(usage.total)}`);
  put('#context-reserve-label', `输入可用 ${formatTokenCount(usage.inputBudget)} · 输出预留 ${usage.reservedOutputTokens ? formatTokenCount(usage.reservedOutputTokens) : '未设置'} · 安全余量 ${formatTokenCount(usage.safetyTokens)}`);
  put('#context-threshold-label', `输入达到约 ${formatTokenCount(usage.threshold)}（可用空间的 90%）时，自动整理较早记录。`);
  let note = usage.scope === 'request'
    ? '最近一次主回答请求，含实际携带的资料和工具往返；不累加多次请求。'
    : '含草稿与已知资料，补读、整理和裁剪后的组成见“最近请求”。';
  if (usage.pendingContext) note += '部分待准备资料尚未计入。';
  if (usage.unestimatedParts) note += '文件等非文本内容的用量未知。';
  if (usage.imageCount) note += '图片按粗略固定值估算。';
  note += '数值为估算，非精确分词或账单。';
  if (!usage.reservedOutputTokens) note += '服务默认输出上限未知。';
  put('#context-estimate-note', note);
  const shares = tokenShares(usage.breakdown);
  for (const [key, value] of Object.entries(usage.breakdown)) {
    put(`#context-tokens-${key}`, `${formatTokenCount(value)} · ${shares[key]}%`);
    const node = find(`#context-tokens-${key}`);
    if (node) node.title = `${value.toLocaleString('zh-CN')} Tokens（估算）`;
  }
  const scope = find('#context-usage-scope');
  if (scope) scope.value = usage.scope;
  const requestOption = find('#context-request-option');
  if (requestOption) requestOption.disabled = !hasRequest;
}
