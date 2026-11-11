import { asksForCurrentPage } from '../../../utils/page-intent.js';
import { isReadablePageUrl } from './page-control-state.js';

/** Suggestions may ask for a source; they never grant permission to read it. */
export function needsPageQuestionChoice({ question, enabled, active, messages = [], attachments = [], selection,
  independent = false, agentMode = false } = {}) {
  if (enabled || independent || agentMode || !isReadablePageUrl(active?.url)) return false;
  const text = String(question || '').trim();
  const explicit = /当前页|当前网页|本页|这页|这个页面|这个网页|页面上|网页上|\b(?:this|current) (?:web)?page\b/i.test(text);
  if (explicit) return true;
  if (attachments.length || selection?.text) return false;
  if (asksForCurrentPage(text)) return true;
  const hasConversation = messages.some(message => message.role === 'assistant' && String(message.content || '').trim());
  return !hasConversation && /(?:这些|这个|这里|这几个).{0,8}(?:配置|设置|选项|参数|按钮)|(?:这个|这里)(?:怎么选|什么意思|怎么理解)/.test(text);
}

function sameDraft(left, right) {
  return left.conversation === right.conversation && left.draft === right.draft
    && left.tabId === right.tabId && left.url === right.url && left.mode === right.mode
    && left.source === right.source && left.selection === right.selection
    && left.attachments.length === right.attachments.length
    && left.attachments.every((item, index) => item === right.attachments[index]);
}

/** A pending choice owns no turn. Editing, navigation or a new conversation invalidates it. */
export function createPageQuestionChoice({ snapshot, render, submit, enablePage }) {
  let pending = null;
  const clear = () => { pending = null; render(null); };
  return {
    offer(text, options = {}) {
      pending = { snapshot: snapshot(), text, options: { ...options } };
      render({ title: pending.snapshot.title });
    },
    refresh() {
      if (pending && !sameDraft(pending.snapshot, snapshot())) clear();
    },
    clear,
    choose(usePage) {
      const request = pending;
      if (!request) return;
      const valid = sameDraft(request.snapshot, snapshot());
      clear();
      if (!valid) return;
      if (usePage) enablePage();
      return submit(request.text, { ...request.options, pageContextEnabled: usePage,
        directModelRequest: !usePage, requirePage: usePage });
    },
  };
}
