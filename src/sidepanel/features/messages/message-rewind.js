import { awaitWithTimeout } from '../../../utils/abortable.js';
import { normalizeDraftSource } from '../welcome/draft-source.js';

/** One edit action captures its conversation before touching the draft or save queue. */
export function createMessageRewind({ getConversation, getBlockReason = () => '', applyDraft,
  saveConversation, onChanged = () => {}, timeoutMs = 10000 }) {
  let active = null;

  async function rewind(messageId) {
    const blocked = getBlockReason();
    if (blocked) return { ok: false, message: blocked };
    if (active) return { ok: false, message: '正在保存回退，请稍后编辑。' };
    const conversation = getConversation();
    const messages = conversation?.messages;
    if (!Array.isArray(messages)) return { ok: false };
    const index = messages.findIndex(message => message?.id === messageId && message.role === 'user');
    if (index < 0) return { ok: false };
    const message = messages[index];
    // Clone before truncating: pixels, document text and capture origin belong
    // to the removed question and must survive as an independent editable draft.
    const draft = { text: message.displayContent || message.content || '',
      requestSource: normalizeDraftSource(message.requestSource),
      attachments: structuredClone(Array.isArray(message.attachments) ? message.attachments : []),
      selection: message.selection ? structuredClone(message.selection) : null };
    const retained = messages.slice(0, index);
    const ids = retained.map(message => message.id).join('\u0000');
    const operation = { conversation };
    active = operation;
    const isCurrent = () => active === operation && getConversation() === conversation
      && conversation.messages === retained && retained.map(message => message.id).join('\u0000') === ids;
    try {
      conversation.messages = retained;
      applyDraft(draft);
      onChanged(conversation);
      await awaitWithTimeout(Promise.resolve().then(() => saveConversation(conversation)), {
        timeoutMs, message: '保存回退超时，草稿已恢复，请保留当前侧栏并核对保存状态。',
      });
      const current = isCurrent();
      if (current) onChanged(conversation);
      return { ok: true, current };
    } finally {
      if (active === operation) active = null;
    }
  }
  return Object.freeze({ rewind });
}
