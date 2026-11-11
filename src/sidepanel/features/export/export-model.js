import { assertImageAttachmentsAvailable, safeAttachmentDataUrl } from '../../../utils/attachments.js';

const MAX_TURNS = 50;
const MAX_TEXT = 120_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const text = value => typeof value === 'string' ? value : '';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function sourceFor(value) {
  try {
    const url = new URL(text(value?.url));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { title: text(value.title) || url.hostname, url: url.href };
  } catch { return null; }
}

function attachmentFor(file) {
  const image = file?.type === 'image' && safeAttachmentDataUrl(file.dataUrl);
  return { name: text(file?.name) || '附件', type: file?.type === 'image' ? 'image' : 'document',
    ...(image ? { dataUrl: image } : file?.type === 'image' ? {
      ...(text(file.imagePath) ? { imagePath: file.imagePath } : {}),
      ...(text(file.loadError) ? { loadError: file.loadError } : {}),
    } : {}) };
}

/** Freeze visible content only; never clone provider config or hidden model context. */
export function createExportSnapshot(conversation) {
  if (!conversation?.id) throw new Error('当前没有可导出的对话。');
  const turns = [];
  let turn;
  for (const message of Array.isArray(conversation.messages) ? conversation.messages : []) {
    if (message?.role === 'user') {
      const index = turns.length + 1;
      turn = { id: `turn-${index}`, index,
        user: { id: text(message.id), content: text(message.displayContent ?? message.content),
          attachments: (Array.isArray(message.attachments) ? message.attachments : []).map(attachmentFor) },
        assistant: null };
      turns.push(turn);
    } else if (message?.role === 'assistant' && turn && !turn.assistant) {
      turn.assistant = { id: text(message.id), content: text(message.content),
        status: ['complete', 'streaming', 'stopped', 'error'].includes(message.status) ? message.status : 'complete',
        errorMessage: text(message.errorMessage),
        sources: (Array.isArray(message.sources) ? message.sources : []).map(sourceFor).filter(Boolean) };
    }
  }
  return freeze({ id: text(conversation.id), title: text(conversation.title) || '未命名对话',
    createdAt: text(conversation.createdAt), turns });
}

export function selectExportSnapshot(snapshot, selectedIds) {
  const ids = new Set(selectedIds || []);
  if (!ids.size) throw new Error('请至少选择一轮对话。');
  if (!snapshot?.turns?.length) throw new Error('当前没有可导出的对话。');
  const turns = snapshot.turns.filter(turn => ids.has(turn.id));
  if (turns.length !== ids.size) throw new Error('所选回合已失效，请重新打开导出。');
  return freeze({ ...snapshot, turns });
}

export function exportSelectionIssue(snapshot, selectedIds, { includeQuestions = true } = {}) {
  try {
    const { turns } = selectExportSnapshot(snapshot, selectedIds);
    if (turns.length > MAX_TURNS) return '一次最多导出 50 轮，请减少选择。';
    const chars = turns.reduce((sum, turn) => sum + (includeQuestions ? turn.user.content.length : 0) + (turn.assistant?.content.length || 0), 0);
    if (chars > MAX_TEXT) return '所选内容超过 12 万字符，请分批导出。';
    if (includeQuestions) for (const turn of turns) assertImageAttachmentsAvailable(turn.user.attachments);
    const bytes = !includeQuestions ? 0 : turns.reduce((sum, turn) => sum + turn.user.attachments.reduce((size, file) =>
      size + (file.dataUrl ? Math.ceil(file.dataUrl.split(',')[1].length * 3 / 4) : 0), 0), 0);
    if (bytes > MAX_IMAGE_BYTES) return '所选图片超过 8 MB，请分批导出。';
    return '';
  } catch (error) { return error.message; }
}

export function exportFilename(snapshot, extension) {
  if (!['png', 'pdf'].includes(extension)) throw new Error('不支持的导出格式。');
  let title = text(snapshot?.title).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ').trim().slice(0, 64).replace(/[. ]+$/g, '') || '对话';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `对话-${title}`;
  const id = text(snapshot?.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'export';
  return `${title}-${id}.${extension}`;
}
