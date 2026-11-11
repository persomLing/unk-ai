import { escapeHtml } from '../../core/dom.js';
import { icon } from '../../icons.js';

function errorText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

/** Present old errorMessage records and newer summary/detail records alike. */
export function normalizeMessageError(message) {
  if (message?.status !== 'error') return null;
  const fallback = message.agent ? '浏览器任务未完成。' : '请求未完成，请重试。';
  const content = errorText(message.content);
  let summary = errorText(message.errorMessage);
  let detail = errorText(message.errorDetail);
  // Older Agent turns stored the entire answer as an error as well. Keep the
  // answer in its normal bubble, and never repeat it inside the error card.
  if (content && summary === content) summary = '';
  if (content && detail === content) detail = '';
  if (detail === summary) detail = '';
  summary ||= fallback;
  const text = detail.startsWith(`${summary}\n`)
    ? detail
    : [summary, detail].filter(Boolean).join('\n');
  return { summary, detail, text, expanded: message.errorExpanded === true };
}

export function messageModeBadgeMarkup(message) {
  if (message?.role !== 'user') return '';
  if (message.agentTask === true) return `<div class="message-mode"><span class="message-mode-badge" title="以页面操作模式发送">${icon('globe')}<span>页面操作</span></span></div>`;
  const reading = message.pageSource?.reading;
  if (!reading || !(reading.supplemented || reading.rechecked || reading.status === 'limited' || reading.mode === 'deep' || reading.networkStatus)) return '';
  const label = reading.networkStatus === 'reused' ? '已复用接口资料'
    : reading.supplemented ? '已补充页面结构' : reading.rechecked ? '已重新核验页面' : '页面读取说明';
  const details = [reading.note, reading.networkNote].filter(value => typeof value === 'string').join('\n').slice(0, 1200);
  return `<div class="message-mode"><details class="message-reading-note"><summary>${escapeHtml(label)}${reading.networkCount ? ` · ${Math.min(6, Number(reading.networkCount) || 0)} 个接口响应` : ''}</summary><small>${escapeHtml(details || '本轮按所选方式读取了页面。')}</small></details></div>`;
}

export function messageErrorMarkup(message) {
  const error = normalizeMessageError(message);
  if (!error) return '';
  const detailId = `message-error-${encodeURIComponent(String(message.id || 'detail'))}`;
  return `<div class="message-error${error.expanded ? ' is-expanded' : ''}">
    <div class="message-error-detail" id="${escapeHtml(detailId)}">${escapeHtml(error.text)}</div>
    <button class="message-error-toggle" data-action="toggle-error" type="button" aria-expanded="${String(error.expanded)}" aria-controls="${escapeHtml(detailId)}" hidden>${error.expanded ? '收起' : '展开详情'}</button>
    <div class="message-diagnostic-help"><span>需要协助排查？导出后可发给支持人员。</span>
      <button class="message-diagnostic-export" data-action="export-diagnostics" type="button" title="导出本对话今天（北京时间）的诊断记录，不含对话正文、附件或密钥；不会自动发送">${icon('download')}导出今天的诊断日志</button>
      <small class="message-diagnostic-feedback" role="status" aria-live="polite"></small>
    </div>
  </div>`;
}

/** Measure real wrapping, including narrow panels, instead of guessing by length. */
export function syncMessageErrorToggle(root) {
  if (!root?.querySelectorAll) return;
  for (const card of root.querySelectorAll('.message-error')) {
    const detail = card.querySelector('.message-error-detail');
    const toggle = card.querySelector('.message-error-toggle');
    if (!detail || !toggle || !detail.clientWidth) continue;
    const view = detail.ownerDocument?.defaultView;
    const lineHeight = Number.parseFloat(view?.getComputedStyle(detail).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) continue;
    toggle.hidden = detail.scrollHeight <= lineHeight * 2 + 1;
  }
}

let resizeListenerInstalled = false;

export function syncMessageDecorations(root) {
  syncMessageErrorToggle(root);
  if (!resizeListenerInstalled && typeof globalThis.addEventListener === 'function') {
    resizeListenerInstalled = true;
    globalThis.addEventListener('resize', () => syncMessageErrorToggle(globalThis.document));
  }
}
