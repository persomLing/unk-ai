import { escapeHtml } from '../../core/dom.js';
import { icon } from '../../icons.js';

/**
 * Render the persisted Agent timeline as part of an assistant message.
 * Kept dependency-free from markdown/highlighting so it can be tested in Node
 * and reused when only the execution trace needs to be refreshed.
 */
export function agentPanelMarkup(agent) {
  if (!agent || typeof agent !== 'object') return '';
  const steps = Array.isArray(agent.steps) ? agent.steps : [];
  const status = agent.status || 'running';
  const collapsed = ['finished', 'failed', 'cancelled'].includes(status);
  const statusLabel = status === 'finished'
    ? '已完成'
    : status === 'failed'
      ? '未完成'
      : status === 'cancelled'
        ? '已停止'
        : status === 'paused'
          ? '已暂停'
        : '正在执行';
  const rows = steps.map((step) => `
    <div class="message-agent-step ${escapeHtml(step.kind || 'info')}">
      <span class="message-agent-dot"></span>
      <div>
        <strong>${escapeHtml(step.title || '')}</strong>
        ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}
      </div>
    </div>
  `).join('');
  return `<section class="message-agent ${collapsed ? 'is-collapsed' : 'is-running'}" data-agent-task="${escapeHtml(agent.taskId || '')}">
    <details class="message-agent-details"${collapsed ? '' : ' open'}>
    <summary class="message-agent-head">
      <span class="message-agent-icon">${icon('globe')}</span>
      <div>
        <strong>浏览器任务</strong>
        <small>${escapeHtml(agent.goal || '')}</small>
      </div>
      <span class="message-agent-state ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
      <span class="message-agent-chevron" aria-hidden="true">${icon('chevron-down')}</span>
    </summary>
    <div class="message-agent-body">
    ${rows ? `<div class="message-agent-steps">${rows}</div>` : ''}
    ${status === 'paused'
      ? `<div class="message-agent-actions">
          <button type="button" class="action-text" data-agent-action="resume">${icon('play')}继续任务</button>
          <button type="button" class="action-text" data-agent-action="stop">${icon('stop')}结束任务</button>
        </div>`
      : ''}
    ${agent.result && status !== 'running'
      ? `<div class="message-agent-result">${escapeHtml(agent.result)}</div>`
      : ''}
    </div>
    </details>
  </section>`;
}
