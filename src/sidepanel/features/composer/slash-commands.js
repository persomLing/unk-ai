import { icon } from '../../icons.js';

/** Parse a leading single-line `/query` from composer text. Returns null when not in slash mode. */
export function parseSlashQuery(value) {
  const text = String(value || '');
  if (!text.startsWith('/') || text.includes('\n') || text.includes(' ')) return null;
  return text.slice(1).trim().toLowerCase();
}

export function filterSlashCommands(commands, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(item => {
    const haystack = [item.command, item.label, item.description, ...(item.keywords || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** Keyboard-navigable slash command palette anchored to the composer. */
export function createSlashCommandPalette({ input, container, getCommands, onExecute }) {
  const document = input.ownerDocument;
  const menu = document.createElement('div');
  menu.className = 'slash-command-menu ui-popover';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', '快捷指令');
  menu.hidden = true;
  container.append(menu);

  let visible = false;
  let items = [];
  let activeIndex = 0;
  let disposed = false;

  function close() {
    if (!visible && menu.hidden) return;
    visible = false;
    items = [];
    activeIndex = 0;
    menu.hidden = true;
    menu.replaceChildren();
  }

  function render() {
    menu.replaceChildren();
    if (!items.length) {
      close();
      return;
    }
    const heading = document.createElement('div');
    heading.className = 'slash-menu-heading';
    heading.textContent = '快捷指令 · ↑↓ 选择 · Enter 确认';
    menu.append(heading);
    const hasGroups = new Set(items.map(item => item.group || '')).size > 1;
    let lastGroup = null;
    items.forEach((item, index) => {
      const groupName = item.group || '';
      if (hasGroups && groupName && groupName !== lastGroup) {
        lastGroup = groupName;
        const groupLabel = document.createElement('div');
        groupLabel.className = 'slash-menu-group';
        groupLabel.setAttribute('role', 'presentation');
        groupLabel.textContent = groupName;
        menu.append(groupLabel);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slash-menu-item';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === activeIndex));
      button.dataset.slashIndex = String(index);
      if (item.tip) button.dataset.fundTip = item.tip;
      if (item.example) button.dataset.fundExample = item.example;
      if (item.disabled) button.disabled = true;
      button.innerHTML = `<span class="slash-menu-icon">${icon(item.icon || 'sparkles')}</span>
        <span class="slash-menu-cmd"></span>
        <span class="slash-menu-desc"></span>`;
      button.querySelector('.slash-menu-cmd').textContent = item.command;
      button.querySelector('.slash-menu-desc').textContent = item.description || item.label || '';
      menu.append(button);
    });
    visible = true;
    menu.hidden = false;
  }

  function updateActive(nextIndex) {
    if (!items.length) return;
    activeIndex = (nextIndex + items.length) % items.length;
    for (const option of menu.querySelectorAll('.slash-menu-item')) {
      const isSelected = Number(option.dataset.slashIndex) === activeIndex;
      option.setAttribute('aria-selected', String(isSelected));
      if (isSelected) option.scrollIntoView?.({ block: 'nearest' });
    }
  }

  function execute(item) {
    if (!item || item.disabled) return;
    close();
    onExecute(item);
  }

  function sync() {
    if (disposed) return;
    const query = parseSlashQuery(input.value);
    if (query === null) { close(); return; }
    const all = getCommands() || [];
    const matched = filterSlashCommands(all, query);
    if (!matched.length) { close(); return; }
    items = matched;
    activeIndex = Math.min(activeIndex, items.length - 1);
    render();
  }

  function handleKeydown(event) {
    if (!visible || !items.length) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      updateActive(activeIndex + 1);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      updateActive(activeIndex - 1);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      execute(items[activeIndex]);
      return true;
    }
    return false;
  }

  const onMenuPointerDown = event => {
    const button = event.target.closest('.slash-menu-item');
    if (!button || button.disabled) return;
    event.preventDefault();
    const index = Number(button.dataset.slashIndex);
    execute(items[index]);
  };
  const onMenuPointerOver = event => {
    const button = event.target.closest('.slash-menu-item');
    if (!button || button.disabled) return;
    const index = Number(button.dataset.slashIndex);
    if (Number.isInteger(index) && index !== activeIndex) updateActive(index);
  };
  const onDocPointerDown = event => {
    if (!visible) return;
    if (!menu.contains(event.target) && event.target !== input) close();
  };

  menu.addEventListener('pointerdown', onMenuPointerDown);
  menu.addEventListener('pointerover', onMenuPointerOver);
  input.addEventListener('input', sync);
  document.addEventListener('pointerdown', onDocPointerDown);

  return {
    sync,
    close,
    handleKeydown,
    isOpen: () => visible,
    dispose() {
      disposed = true;
      close();
      menu.removeEventListener('pointerdown', onMenuPointerDown);
      menu.removeEventListener('pointerover', onMenuPointerOver);
      input.removeEventListener('input', sync);
      document.removeEventListener('pointerdown', onDocPointerDown);
      menu.remove();
    },
  };
}
