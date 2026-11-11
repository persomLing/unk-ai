export const PASTED_TEXT_CHAR_THRESHOLD = 1000;
export const PASTED_TEXT_LINE_THRESHOLD = 15;
export const PASTED_TEXT_LIMIT = 6;
export const PASTED_TEXT_CHAR_LIMIT = 200_000;

export function isLongPastedText(value) {
  return typeof value === 'string' && Boolean(value.trim())
    && (value.length >= PASTED_TEXT_CHAR_THRESHOLD || value.split(/\r\n?|\n/).length >= PASTED_TEXT_LINE_THRESHOLD);
}

const bounded = (value, length) => Math.max(0, Math.min(length, Number.isInteger(value) ? value : length));

function changedRange(previous, next) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let end = previous.length, nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end -= 1; nextEnd -= 1; }
  return { start, end, inserted: nextEnd - start };
}

/** Fold only the view of pasted text. The application still submits one complete
 * user string through its existing draft and queue path; no attachment is made. */
export function createPastedTextDraft({ input, container, onChange = () => {},
  onPreview = () => {}, notify = () => {}, getScope = () => null, canEdit = () => true }) {
  const document = input.ownerDocument;
  let scope = getScope() ?? null;
  let visible = String(input.value || '');
  let parts = [];
  let nextId = 0;
  let beforeInput = null;
  let disposed = false;

  function compose() {
    let value = '', cursor = 0;
    for (const part of parts) {
      value += visible.slice(cursor, part.at) + part.text;
      cursor = part.at;
    }
    return value + visible.slice(cursor);
  }

  function sync(nextScope) {
    if (disposed) return false;
    const next = nextScope ?? null;
    if (next === scope) return false;
    scope = next;
    parts = [];
    visible = '';
    input.value = '';
    beforeInput = null;
    render();
    return true;
  }

  function inputRange(next) {
    const saved = beforeInput;
    beforeInput = null;
    if (saved?.value === visible) {
      let { start, end } = saved;
      const removed = visible.length - next.length;
      if (start === end && removed > 0) {
        if (saved.type?.endsWith('Backward')) start = Math.max(0, start - removed);
        else if (saved.type?.startsWith('delete')) end = Math.min(visible.length, end + removed);
      }
      const inserted = next.length - (visible.length - (end - start));
      if (inserted >= 0 && next.slice(0, start) === visible.slice(0, start)
        && next.slice(start + inserted) === visible.slice(end)) return { start, end, inserted };
    }
    return changedRange(visible, next);
  }

  function reconcile() {
    const next = String(input.value || '');
    if (next === visible) { beforeInput = null; return; }
    const { start, end, inserted } = inputRange(next);
    const delta = inserted - (end - start);
    for (const part of parts) {
      if (part.at > end) part.at += delta;
      else if (part.at > start) part.at = start + inserted;
      // At the caret, collapsed text precedes subsequently typed characters.
    }
    visible = next;
  }

  function changed() { onChange(compose()); }

  function titleFor(part) {
    const firstLine = part.text.split(/\r\n?|\n/).find(line => line.trim()) || '粘贴的文本';
    const title = firstLine.trim();
    return title.length > 48 ? `${title.slice(0, 48)}…` : title;
  }

  function render() {
    container.replaceChildren();
    container.hidden = parts.length === 0;
    container.setAttribute('role', 'list');
    container.setAttribute('aria-label', '粘贴的长文本');
    for (const part of parts) {
      const card = document.createElement('div');
      card.className = 'pasted-text-card';
      card.setAttribute('role', 'listitem');
      card.dataset.pastedTextId = part.id;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'pasted-text-open';
      open.dataset.pastedTextAction = 'preview';
      open.setAttribute('aria-haspopup', 'dialog');
      open.setAttribute('aria-label', `查看粘贴文本：${titleFor(part)}`);
      const icon = document.createElement('span');
      icon.className = 'pasted-text-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '≡';
      const copy = document.createElement('span');
      copy.className = 'pasted-text-copy';
      const title = document.createElement('strong');
      title.textContent = titleFor(part);
      const detail = document.createElement('small');
      detail.textContent = `粘贴的文本 · ${part.text.length.toLocaleString('zh-CN')} 字符`;
      copy.append(title, detail);
      open.append(icon, copy);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'pasted-text-edit';
      edit.dataset.pastedTextAction = 'edit';
      edit.textContent = '编辑';
      edit.title = '放回输入框编辑';
      edit.setAttribute('aria-label', `编辑粘贴文本：${titleFor(part)}`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pasted-text-remove';
      remove.dataset.pastedTextAction = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除粘贴文本：${titleFor(part)}`);
      card.append(open, edit, remove);
      container.append(card);
    }
  }

  function handlePaste(event) {
    if (disposed || event.defaultPrevented) return false;
    if (Array.from(event.clipboardData?.files || []).some(file => file.type?.startsWith('image/'))) return false;
    const text = event.clipboardData?.getData?.('text/plain');
    if (!isLongPastedText(text)) return false;
    event.preventDefault();
    if (!canEdit()) { notify('当前暂时无法修改输入，请稍后粘贴。'); return true; }
    reconcile();
    if (parts.length >= PASTED_TEXT_LIMIT) { notify(`最多保留 ${PASTED_TEXT_LIMIT} 段粘贴文本，请先移除或放回输入框。`); return true; }
    if (text.length + parts.reduce((total, part) => total + part.text.length, 0) > PASTED_TEXT_CHAR_LIMIT) {
      notify('粘贴文本合计不能超过 200,000 字符，请拆分后再添加。');
      return true;
    }
    const start = bounded(input.selectionStart, visible.length);
    const end = Math.max(start, bounded(input.selectionEnd, visible.length));
    const insertion = parts.findIndex(part => part.at > start);
    for (const part of parts) {
      if (part.at > start) part.at = part.at >= end ? part.at - (end - start) : start;
    }
    parts.splice(insertion < 0 ? parts.length : insertion, 0, { id: `pasted-text-${++nextId}`, at: start, text });
    visible = visible.slice(0, start) + visible.slice(end);
    input.value = visible;
    input.setSelectionRange(start, start);
    beforeInput = null;
    render();
    changed();
    return true;
  }

  function onBeforeInput(event) {
    if (disposed) return;
    reconcile();
    beforeInput = { value: visible, start: bounded(input.selectionStart, visible.length),
      end: bounded(input.selectionEnd, visible.length), type: event.inputType };
  }

  function handleInput() {
    if (disposed) return;
    reconcile();
    changed();
  }

  function onClick(event) {
    if (disposed || !container.contains(event.target)) return;
    const button = event.target.closest('[data-pasted-text-action]');
    const card = button?.closest('[data-pasted-text-id]');
    const index = parts.findIndex(part => part.id === card?.dataset.pastedTextId);
    if (index < 0) return;
    const part = parts[index];
    if (button.dataset.pastedTextAction === 'preview') {
      onPreview({ text: part.text, title: '粘贴的文本', trigger: button });
      return;
    }
    if (!canEdit()) { notify('当前暂时无法修改输入，请稍后再试。'); return; }
    reconcile();
    parts.splice(index, 1);
    if (button.dataset.pastedTextAction === 'edit') {
      // Native textarea editing normalizes line endings. Use that length before
      // moving the remaining anchors, rather than relying on a later DOM diff.
      const editableText = part.text.replace(/\r\n?/g, '\n');
      visible = visible.slice(0, part.at) + editableText + visible.slice(part.at);
      parts.forEach((other, otherIndex) => {
        if (other.at > part.at || (other.at === part.at && otherIndex >= index)) other.at += editableText.length;
      });
      input.value = visible;
      input.focus({ preventScroll: true });
      input.setSelectionRange(part.at, part.at + editableText.length);
    } else input.focus({ preventScroll: true });
    beforeInput = null;
    render();
    changed();
  }

  input.addEventListener('beforeinput', onBeforeInput);
  container.addEventListener('click', onClick);
  render();

  return {
    handlePaste,
    handleInput,
    getValue() {
      if (disposed) return String(input.value || '');
      reconcile();
      return compose();
    },
    setValue(value) {
      if (disposed) return;
      reconcile();
      const next = String(value ?? '');
      if (next === compose()) return;
      parts = [];
      visible = next;
      input.value = next;
      beforeInput = null;
      render();
    },
    sync,
    dispose() {
      if (disposed) return;
      reconcile();
      input.value = compose();
      visible = String(input.value || '');
      parts = [];
      disposed = true;
      beforeInput = null;
      input.removeEventListener('beforeinput', onBeforeInput);
      container.removeEventListener('click', onClick);
      render();
    },
  };
}
