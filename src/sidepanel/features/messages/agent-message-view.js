import { escapeHtml } from '../../core/dom.js';
import { icon } from '../../icons.js';
import { playMotion } from '../../core/motion.js';
import { syncNode } from './dom-reconcile.js';

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
  const rows = steps.map((step) => {
    const completed = !['warning', 'error'].includes(step.kind) && step.title !== '任务已停止'
      && (!step.status || step.status === 'done');
    return `
    <div class="message-agent-step ${escapeHtml(step.kind || 'info')}" data-agent-step="${escapeHtml(`${step.at || ''}:${step.title || ''}`)}">
      <span class="message-agent-dot${completed ? ' is-done' : ''}" aria-hidden="true">${completed ? icon('check') : ''}</span>
      <span class="message-agent-link" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(step.title || '')}</strong>
        ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}
      </div>
    </div>`;
  }).join('');
  const running = ['preparing', 'running'].includes(status)
    ? '<div class="message-agent-step is-active" aria-current="step"><span class="message-agent-dot" aria-hidden="true"></span><strong>正在执行任务</strong></div>' : '';
  return `<section class="message-agent ${collapsed ? 'is-collapsed' : 'is-running'}" data-agent-task="${escapeHtml(agent.taskId || '')}" data-agent-status="${escapeHtml(status)}">
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
    ${rows || running ? `<div class="message-agent-steps">${rows}${running}</div>` : ''}
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

export function syncAgentPanel(current, next) {
  const done = '[data-agent-step]';
  const previousStep = [...current.querySelectorAll(done)].at(-1)?.dataset.agentStep;
  if (current.dataset.agentStatus === next.dataset.agentStatus) {
    next.querySelector('details').open = current.querySelector('details').open;
  }
  syncNode(current, next);
  const step = [...current.querySelectorAll(done)].at(-1);
  if (step?.dataset.agentStep && previousStep !== step.dataset.agentStep) {
    playMotion(step.querySelector('.message-agent-link'), 'agent-step-link', [{ scale: '1 0' }, { scale: '1 1' }], { duration: 175 });
    revealAgentStep(step.querySelector('.message-agent-dot.is-done svg'));
  }
}

function revealAgentStep(check) {
  playMotion(check, 'agent-step-check', [{ opacity: 0, scale: 0.65 }, { opacity: 1, scale: 1 }], { duration: 150 });
}
