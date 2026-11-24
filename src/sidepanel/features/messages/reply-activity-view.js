import { escapeHtml } from '../../core/dom.js';
import { icon } from '../../icons.js';
import { formatElapsedSeconds, replyActivity, replyElapsedLabel } from './reply-progress.js';
import { thinkingPresentation } from './thinking-view.js';
import { transitionReplyPhase } from './reply-motion.js';

function phaseOf(message, thinking, now) {
  const progress = replyActivity(message, now);
  if (progress && thinking.active && thinking.elapsedSeconds) {
    return { ...progress, details: ` · ${formatElapsedSeconds(thinking.elapsedSeconds)}…` };
  }
  if (progress) return progress;
  return thinking.visible ? { phase: '', iconName: 'brain', label: thinking.label, details: '' } : null;
}

function phaseMarkup({ phase, iconName, label, details }) {
  const attributes = phase ? ` data-message-progress data-request-phase="${escapeHtml(phase)}"` : '';
  return `<span class="thinking-phase" data-activity-phase${attributes}>
    <span class="thinking-phase-icon" aria-hidden="true">${icon(iconName)}</span>
    <span class="thinking-text" data-progress-text><span data-progress-label${phase ? ' role="status"' : ''}>${escapeHtml(label)}</span><span data-progress-detail>${escapeHtml(details)}</span></span>
  </span>`;
}

function isWorking({ phase }) {
  return Boolean(phase && phase !== 'answering');
}

function rowMarkup(message, thinking, phase) {
  const expanded = thinking.visible && thinking.expanded;
  const cursor = thinking.active ? '<span class="thinking-cursor" aria-hidden="true"></span>' : '';
  return `<div class="thinking-block${expanded ? ' is-open' : ''}${isWorking(phase) ? ' is-working' : ''}" data-reply-activity>
    <div class="thinking-header" title="${escapeHtml(phase.label + phase.details)}">
      ${phaseMarkup(phase)}
      <button type="button" class="thinking-toggle" data-action="toggle-thinking" aria-label="思考过程" aria-expanded="${expanded}"${thinking.visible ? '' : ' hidden'}>
        <span class="thinking-chevron">${icon('chevron-down')}</span>
      </button>
    </div>
    <div class="thinking-body"${expanded ? '' : ' inert'}><div class="thinking-clip"><div class="thinking-content"><span class="thinking-reason-text" data-thinking-text>${escapeHtml(message.reasoning || '')}</span>${cursor}</div></div></div>
  </div>`;
}

export function replyActivityMarkup(message, now = Date.now()) {
  const thinking = thinkingPresentation(message, now);
  const phase = phaseOf(message, thinking, now);
  return phase ? rowMarkup(message, thinking, phase) : '';
}

export function setThinkingExpanded(button, expanded) {
  const block = button.closest('[data-reply-activity]');
  block.querySelector('.thinking-body').inert = !expanded;
  block.classList.toggle('is-open', expanded);
  button.setAttribute('aria-expanded', String(expanded));
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

export function updateReplyActivity(article, message, now = Date.now()) {
  setText(article.querySelector('[data-message-elapsed]'), replyElapsedLabel(message, now));
  const activity = article.querySelector('.message-activity');
  const block = activity.querySelector('[data-reply-activity]');
  const thinking = thinkingPresentation(message, now);
  const phase = phaseOf(message, thinking, now);
  if (!phase) {
    block?.remove();
    return;
  }
  if (!block) {
    activity.insertAdjacentHTML('afterbegin', rowMarkup(message, thinking, phase));
    return;
  }

  const currentPhase = block.querySelector('[data-activity-phase]');
  const title = phase.label + phase.details;
  if (currentPhase.parentElement.title !== title) currentPhase.parentElement.title = title;
  if ((currentPhase.dataset.requestPhase || '') !== phase.phase) {
    const template = article.ownerDocument.createElement('template');
    template.innerHTML = phaseMarkup(phase);
    transitionReplyPhase(currentPhase, template.content.firstElementChild);
  } else {
    setText(currentPhase.querySelector('[data-progress-label]'), phase.label);
    setText(currentPhase.querySelector('[data-progress-detail]'), phase.details);
  }

  block.classList.toggle('is-working', isWorking(phase));
  const button = block.querySelector('.thinking-toggle');
  button.hidden = !thinking.visible;
  const expanded = thinking.visible && thinking.expanded;
  if (button.getAttribute('aria-expanded') !== String(expanded)) setThinkingExpanded(button, expanded);
  setText(block.querySelector('[data-thinking-text]'), message.reasoning || '');
  const cursor = block.querySelector('.thinking-cursor');
  if (thinking.active && !cursor) {
    block.querySelector('.thinking-content').insertAdjacentHTML('beforeend', '<span class="thinking-cursor" aria-hidden="true"></span>');
  } else if (!thinking.active) cursor?.remove();
}
