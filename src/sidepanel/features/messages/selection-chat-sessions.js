import { normalizeConversationSelection } from '../../../utils/selection.js';

const detachedNotice = '已切换主对话；新的选区将另开追问。';
const rejected = (reason, chat = null, reused = false) => ({ chat, reused, accepted: false, reason });

/** Track only the current follow-up. Detached windows remain owned by the caller. */
export function createSelectionChatSessions({ getConversationId, createChat } = {}) {
  if (typeof getConversationId !== 'function' || typeof createChat !== 'function') {
    throw new TypeError('追问会话需要主对话来源与窗口工厂。');
  }
  let tracking = null;
  let disposed = false;

  function syncConversation(currentId) {
    if (disposed) return { released: false, chat: null, reason: 'disposed' };
    if (!tracking || tracking.originId === currentId) return { released: false, chat: tracking?.chat || null };
    const previous = tracking;
    // Relinquish ownership before notifying the view: a closing old window
    // cannot clear a new tracking session created by its own callback.
    tracking = null;
    try {
      previous.chat.setTracking(false, detachedNotice);
      return { released: true, chat: previous.chat };
    } catch {
      return { released: true, chat: previous.chat, reason: 'tracking-update-failed' };
    }
  }

  function open(selection, anchorRect) {
    if (disposed) return rejected('disposed');
    let currentId;
    try { currentId = getConversationId(); } catch { return rejected('conversation-unavailable'); }
    syncConversation(currentId);
    if (disposed) return rejected('disposed');
    if (typeof currentId !== 'string' || !currentId) return rejected('conversation-unavailable');
    let source;
    try { source = normalizeConversationSelection(selection); } catch { return rejected('invalid-selection'); }
    if (!source || source.sourceVersion !== 1) return rejected('invalid-selection');
    if (source.conversationId !== currentId) return rejected('source-mismatch');

    if (tracking) {
      const chat = tracking.chat;
      try {
        const result = chat.acceptSelection(source, anchorRect);
        if (result === true || result?.accepted === true) return { chat, reused: true, accepted: true };
        return rejected(typeof result?.reason === 'string' && result.reason ? result.reason : 'selection-rejected', chat, true);
      } catch { return rejected('accept-failed', chat, true); }
    }

    let chat;
    try { chat = createChat(source, anchorRect); } catch { return rejected('create-failed'); }
    if (disposed) return rejected('disposed');
    if (!chat || typeof chat.acceptSelection !== 'function' || typeof chat.setTracking !== 'function') {
      return rejected('invalid-chat');
    }
    tracking = { originId: currentId, chat };
    return { chat, reused: false, accepted: true };
  }

  function forget(chat) {
    if (disposed || !tracking || tracking.chat !== chat) return false;
    tracking = null;
    return true;
  }

  return Object.freeze({ open, syncConversation, forget, dispose() {
    if (disposed) return;
    disposed = true;
    tracking = null;
  } });
}
