const PANELS = ['.thinking-content', '.message-agent-body', '.message-error-detail', '.md-table-scroll'];

function collapsedError(selector, panel) {
  return selector === '.message-error-detail'
    && !panel.closest?.('.message-error')?.classList.contains('is-expanded');
}

/** Preserve reading position when a message/markdown subtree is replaced. */
export function captureViewPosition(view, messages) {
  const top = view.scrollTop;
  const viewportTop = view.getBoundingClientRect?.().top || 0;
  const articles = [...messages.querySelectorAll('[data-message-id]')];
  const anchor = articles.find(article => article.getBoundingClientRect?.().bottom > viewportTop);
  const panels = [];
  for (const article of articles) {
    for (const selector of PANELS) {
      [...article.querySelectorAll(selector)].forEach((panel, index) => {
        if (collapsedError(selector, panel)) return;
        panels.push({
          id: article.dataset.messageId, selector, index,
          top: panel.scrollTop, left: panel.scrollLeft,
          atBottom: panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24,
        });
      });
    }
  }
  return { top, anchorId: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0, panels };
}

export function restoreViewPosition(view, messages, saved, follow = false) {
  if (!saved) return;
  const articles = [...messages.querySelectorAll('[data-message-id]')];
  for (const item of saved.panels) {
    const article = articles.find(node => node.dataset.messageId === item.id);
    const panel = article?.querySelectorAll(item.selector)[item.index];
    if (!panel) continue;
    if (collapsedError(item.selector, panel)) {
      panel.scrollTop = 0;
      panel.scrollLeft = 0;
      continue;
    }
    panel.scrollTop = item.atBottom ? Math.max(0, panel.scrollHeight - panel.clientHeight) : item.top;
    panel.scrollLeft = item.left;
  }
  view.dataset.scrollRestoringUntil = String(Date.now() + 100);
  if (follow) view.scrollTop = view.scrollHeight;
  else {
    view.scrollTop = saved.top;
    const anchor = articles.find(node => node.dataset.messageId === saved.anchorId);
    if (anchor && view.getBoundingClientRect) {
      view.scrollTop += anchor.getBoundingClientRect().top - view.getBoundingClientRect().top - saved.offset;
    }
  }
}
