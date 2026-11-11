import { compact, uniqBy } from 'lodash-es';
import { imageAttachmentLoadError, prepareAttachment, safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { attachmentOriginLabel } from '../../../utils/reading-context.js';
import { $, escapeHtml, text, toast } from '../../core/dom.js';
import { formatBytes } from '../../core/format.js';
import { icon } from '../../icons.js';

export const ATTACHMENT_LIMIT = 6;

export function attachmentIcon(attachment) {
  return attachment?.type === 'image' ? 'image' : 'file';
}

export function attachmentDetail(attachment) {
  if (attachment?.type === 'image') return `${attachment.width || '—'} × ${attachment.height || '—'}`;
  return [
    formatBytes(attachment?.size),
    attachment?.pages ? `${attachment.pages} 页` : '',
    attachment?.truncated ? '内容已截断' : '',
  ].filter(Boolean).join(' · ');
}

export function renderAttachmentList(attachments) {
  const list = $('#attachment-list');
  if (!list) return;
  list.hidden = !attachments.length;
  list.innerHTML = attachments.map((attachment) => {
    const image = attachment.type === 'image' ? safeAttachmentDataUrl(attachment.dataUrl) : '';
    const origin = attachmentOriginLabel(attachment);
    const loadError = imageAttachmentLoadError(attachment);
    return `<div class="attachment-item ${escapeHtml(attachment.type)}${loadError ? ' attachment-unavailable' : ''}" title="${escapeHtml(loadError || attachment.name)}">
      ${image ? `<img data-image-preview tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看图片 ${escapeHtml(attachment.name)}" title="点击放大" src="${image}" alt="${escapeHtml(attachment.name)}" />` : `<span class="attachment-file-icon">${icon('file')}</span>`}
      <span class="attachment-copy"><strong>${escapeHtml(attachment.name)}</strong><small>${escapeHtml(attachmentDetail(attachment))}</small>${origin ? `<small class="attachment-origin">${escapeHtml(origin)}</small>` : ''}${loadError ? `<small class="attachment-error">${escapeHtml(loadError)}</small>` : ''}</span>
      <button class="attachment-remove" type="button" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="移除附件 ${escapeHtml(attachment.name)}">${icon('close')}</button>
    </div>`;
  }).join('');
  const button = $('#attach-button');
  if (button) button.disabled = false;
}

export function mergeAttachments(current, incoming) {
  return uniqBy([...current, ...incoming], (item) =>
    `${item.type}\u0000${item.name}\u0000${item.size}`).slice(0, ATTACHMENT_LIMIT);
}

export function removeAttachment(attachments, id) {
  return attachments.filter((attachment) => attachment.id !== id);
}

export function hasImage(attachments) {
  return attachments.some((attachment) => attachment.type === 'image');
}

export function hasDocument(attachments) {
  return attachments.some((attachment) => attachment.type === 'document');
}

export function describeAttachmentError(error) {
  return text(error?.message) || '无法读取附件。';
}

export function createAttachmentSlot({
  getAttachments,
  setAttachments,
  canAddImage,
  onChanged,
}) {
  async function add(files, kind) {
    const selected = Array.from(files || []);
    if (!selected.length) return { added: 0, errors: [] };
    if (kind === 'image' && !canAddImage()) {
      toast('当前模型未标记视觉能力，图片无法被理解。', 'error');
      return { added: 0, errors: ['当前模型不支持视觉。'] };
    }
    const prepared = [];
    const errors = [];
    for (const file of selected) {
      try {
        prepared.push(await prepareAttachment(file, kind));
      } catch (error) {
        errors.push(describeAttachmentError(error));
      }
    }
    const before = getAttachments();
    const next = mergeAttachments(before, prepared);
    if (next.length === before.length && prepared.length) {
      toast('附件已经添加。');
    } else if (before.length + prepared.length > ATTACHMENT_LIMIT) {
      toast(`每条消息最多添加 ${ATTACHMENT_LIMIT} 个附件。`);
    }
    const added = Math.max(0, next.length - before.length);
    if (added) setAttachments(next);
    onChanged?.();
    for (const message of compact(errors)) toast(message, 'error');
    return { added, errors };
  }

  return { add };
}
