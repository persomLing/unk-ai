import { icon } from '../../icons.js';
import { projectHistory, historySelection, toggleHistorySelection } from './history-model.js';
import { installPressDrag } from './history-press-drag.js';
import { createHistoryFeedback } from './history-feedback.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** A single drawer controller. Storage, conversation switching and deletion are injected. */
export function createHistorySidebar({ drawer, organization, onOpen, onNew, onRenamed,
  onDelete, onRestore, onRefresh, onBusy = () => {}, onQuery = () => {},
  deletionBlocked = () => '', formatDate = value => value || '', onError = () => {} }) {
  const doc = drawer.ownerDocument;
  const win = doc.defaultView;
  const list = drawer.querySelector('#history-list');
  const feedback = drawer.querySelector('#history-feedback');
  const batch = drawer.querySelector('#history-batch');
  const selectView = drawer.querySelector('#history-view');
  const controller = new AbortController();
  const signal = controller.signal;
  const state = { entries: [], organization: null, query: '', activeId: null, busy: false,
    working: false, multi: false, selected: new Set(), form: null, menu: null, drag: null,
    view: 'groups', collapsed: new Set(), initialized: false, loadError: '' };
  let disposed = false, expandTimer = null, scrollFrame = null, dragPoint = null;
  let overlay = null;
  const dialog = doc.createElement('dialog');
  dialog.className = 'app-dialog ho-dialog';
  dialog.setAttribute('aria-labelledby', 'history-action-title');
  dialog.setAttribute('aria-describedby', 'history-action-description');
  doc.body.append(dialog);
  let pendingDelete = null;
  let feedbackMarkup = '';
  const feedbackState = createHistoryFeedback({
    now: () => win.performance.now(),
    setTimer: (callback, delay) => win.setTimeout(callback, delay),
    clearTimer: timer => win.clearTimeout(timer),
    onChange: renderFeedback,
  });
  const blocked = () => state.busy || state.working || !state.organization || disposed;
  const projection = () => projectHistory(state.entries, state.organization,
    { query: state.query, view: state.view, collapsed: state.collapsed });
  const groupName = id => projection().groups.find(group => group.id === id)?.name || '未分组';
  const btn = (attrs, text = '', symbol = '', extra = '') => `<button type="button" ${attrs} class="${extra}" ${blocked() || state.form ? 'disabled' : ''}>${symbol ? icon(symbol) : ''}${text}</button>`;
  const focusAttributes = ['id', 'data-open-chat', 'data-collapse', 'data-menu-id', 'data-new-in-group', 'data-select-chat', 'data-select-group', 'data-action', 'data-move-to', 'data-set-view'];
  const focusKey = node => node && focusAttributes.map(name => [name, node.getAttribute?.(name)]).find(([, value]) => value);
  function restoreFocus(key, root = drawer) {
    const node = key && [...root.querySelectorAll('button,input,select')].find(node => node.getAttribute(key[0]) === key[1] && !node.disabled);
    node?.focus({ preventScroll: true });
  }

  function announce(message, undoToken = null) { feedbackState.show(message, { undoToken }); }
  function renderFeedback(value = feedbackState.snapshot()) {
    if (disposed) return;
    const notice = value.notice;
    const focused = feedback.contains(doc.activeElement)
      ? doc.activeElement?.hasAttribute('data-undo') ? '[data-undo]' : '[data-dismiss-feedback]' : null;
    feedback.hidden = !notice;
    const markup = notice ? `<div class="ho-toast"><span>${escape(notice.message)}</span>${notice.undoToken && notice.undoToken === value.undoToken ? `<button type="button" data-undo ${blocked() || state.form ? 'disabled' : ''}>撤销删除</button>` : ''}<button type="button" data-dismiss-feedback class="ho-icon" aria-label="关闭提示" title="关闭提示">${icon('close')}</button></div>` : '';
    // Timers and hover changes never replace the list or an active name editor.
    if (markup === feedbackMarkup) return;
    feedbackMarkup = markup;
    feedback.innerHTML = markup;
    if (focused && notice) feedback.querySelector(focused)?.focus({ preventScroll: true });
  }
  function dismissFeedback() {
    const focused = feedback.contains(doc.activeElement);
    feedbackState.dismiss();
    if (focused) (drawer.querySelector('#history-manage:not(:disabled)') || drawer.querySelector('#close-history'))?.focus({ preventScroll: true });
  }
  function applyOrganization(snapshot, forceRender = false) {
    if (disposed) return;
    if (state.organization && snapshot.revision < state.organization.revision) { if (forceRender) render(); return; }
    const content = value => value && JSON.stringify([value.groups, value.assignments, value.titles]);
    const changed = content(snapshot) !== content(state.organization);
    state.organization = snapshot;
    if (!state.initialized) {
      state.view = snapshot.preferences.view;
      state.collapsed = new Set(snapshot.preferences.collapsed);
      state.initialized = true;
    }
    if (changed || forceRender) render();
  }
  function clearQuery() {
    state.query = '';
    drawer.querySelector('#history-search-input').value = '';
    drawer.querySelector('#history-search-clear').hidden = true;
    onQuery('');
  }
  function remember() {
    organization.updatePreferences({ view: state.view, collapsed: [...state.collapsed] })
      .then(applyOrganization).catch(error => { if (!disposed) { announce(error.message); render(); onError(error); } });
  }
  async function run(action, { allowUninitialized = false } = {}) {
    if (disposed || state.busy || state.working || (!state.organization && !allowUninitialized) || state.form) return;
    state.working = true; state.menu = null; onBusy(true); render();
    try { await action(); }
    catch (error) { if (!disposed) { announce(error.message || '整理失败，请重试。'); onError(error); } }
    finally { if (!disposed) { state.working = false; onBusy(false); render(); } }
  }
  function editMarkup() {
    const form = state.form;
    return `<div class="ho-inline"><div class="ho-inline-line"><input data-name-input aria-label="${form.kind === 'group' ? '分组名称' : '对话名称'}" maxlength="${form.kind === 'group' ? 24 : 120}" value="${escape(form.value)}" aria-invalid="${Boolean(form.error)}" ${form.error ? 'aria-describedby="history-name-error"' : ''} ${state.working ? 'disabled' : ''}><button type="button" data-save-name aria-label="保存名称" ${state.working ? 'disabled' : ''}>${icon('check')}</button><button type="button" data-cancel-name aria-label="取消改名" ${state.working ? 'disabled' : ''}>${icon('close')}</button></div>${form.error ? `<div id="history-name-error" class="ho-error" role="alert">${escape(form.error)}</div>` : ''}</div>`;
  }
  function row(entry) {
    const editing = state.form?.kind === 'chat' && state.form.id === entry.id;
    const sync = entry.syncStatus === 'pending' ? ' · 待同步' : '';
    const details = `${entry.title} · ${groupName(entry.group)} · ${formatDate(entry.updatedAt)} · ${entry.messageCount || 0} 条消息${sync}`;
    return `<article class="ho-row ${state.activeId === entry.id ? 'is-active' : ''} ${state.selected.has(entry.id) ? 'is-selected' : ''} ${state.drag?.ids.includes(entry.id) ? 'is-drag-source' : ''}" data-chat-id="${escape(entry.id)}" data-context-kind="chat" data-context-id="${escape(entry.id)}">
      ${state.multi ? `<input type="checkbox" data-select-chat="${escape(entry.id)}" aria-label="选择：${escape(entry.title)}" ${state.selected.has(entry.id) ? 'checked' : ''} ${state.working ? 'disabled' : ''}>` : ''}
      ${editing ? editMarkup() : `${btn(`data-open-chat="${escape(entry.id)}" title="${escape(details)}"`, `<span class="ho-chat-title">${escape(entry.title)}</span><span class="ho-date">${escape(formatDate(entry.updatedAt))}${sync}</span>`, '', 'ho-open')}${!state.multi ? btn(`data-menu-kind="chat" data-menu-id="${escape(entry.id)}" aria-label="对话操作：${escape(entry.title)}" aria-haspopup="menu"`, '', 'ellipsis', 'ho-icon') : ''}`}
    </article>`;
  }
  function groupSection(group, projected) {
    const all = projected.all.filter(entry => entry.group === group.id);
    const entries = projected.filtered.filter(entry => entry.group === group.id);
    if (projected.searching && !entries.length) return '';
    const open = !state.collapsed.has(group.id) || projected.searching;
    const renaming = state.form?.kind === 'group' && state.form.id === group.id;
    return `<section class="ho-group" data-group-id="${escape(group.id)}" data-drop-group="${escape(group.id)}"><header class="ho-group-head" data-context-kind="group" data-context-id="${escape(group.id)}">
      ${state.multi ? `<input type="checkbox" data-select-group="${escape(group.id)}" aria-label="选择${escape(group.name)}中的 ${entries.length} 条对话" ${entries.length && entries.every(entry => state.selected.has(entry.id)) ? 'checked' : ''} ${!entries.length || state.working ? 'disabled' : ''}>` : ''}
      ${renaming ? editMarkup() : `${btn(`data-collapse="${escape(group.id)}" aria-expanded="${open}"`, `<span class="ho-group-name">${escape(group.name)}</span><span class="ho-count">${all.length}</span>`, open ? 'chevron-down' : 'chevron-right', 'ho-group-toggle')}${!state.multi ? `${btn(`data-new-in-group="${escape(group.id)}" aria-label="在${escape(group.name)}新建对话" title="在${escape(group.name)}新建对话"`, '', 'plus', 'ho-icon')}${btn(`data-menu-kind="group" data-menu-id="${escape(group.id)}" aria-label="分组操作：${escape(group.name)}" aria-haspopup="menu"`, '', 'ellipsis', 'ho-icon')}` : ''}`}
      </header><div class="ho-group-body" ${open ? '' : 'hidden'}>${entries.map(row).join('') || '<div class="ho-empty">暂无对话</div>'}</div></section>`;
  }
  function render() {
    if (disposed) return;
    const projected = projection();
    if (state.form?.id && (state.form.kind === 'chat'
      ? !projected.filtered.some(entry => entry.id === state.form.id)
      : !projected.groups.some(group => group.id === state.form.id) || (projected.searching && !projected.filtered.some(entry => entry.group === state.form.id)))) {
      state.form = null;
      announce('改名目标已变化，请重新选择。');
    }
    const selection = historySelection(projected, state.selected);
    state.selected = new Set(selection.ids);
    const oldInput = doc.activeElement?.matches?.('[data-name-input]') ? doc.activeElement : null;
    const previousFocus = list.contains(doc.activeElement) ? focusKey(doc.activeElement) : null;
    const caret = oldInput ? [oldInput.selectionStart, oldInput.selectionEnd] : null;
    const top = list.scrollTop;
    const loadErrorMarkup = state.loadError ? `<div class="ho-load-error" role="alert"><span>${escape(state.loadError)}</span><button type="button" data-retry-history ${state.working ? 'disabled' : ''}>重试</button></div>` : '';
    list.innerHTML = loadErrorMarkup + (state.organization ? state.view === 'all'
      ? projected.filtered.map(row).join('') || '<div class="ho-empty">没有匹配的对话</div>'
      : `${state.form?.kind === 'group' && !state.form.id ? `<div class="ho-group-head">${icon('folder-plus')}${editMarkup()}</div>` : ''}${projected.groups.map(group => groupSection(group, projected)).join('')}`
      : state.loadError ? '' : '<div class="ho-empty">正在读取历史分组…</div>');
    list.scrollTop = top;
    const viewLabel = selectView.querySelector('[data-view-label]');
    if (viewLabel) viewLabel.textContent = state.view === 'all' ? '全部对话' : '按分组';
    selectView.disabled = state.working || Boolean(state.form) || !state.organization;
    drawer.querySelector('#history-count').textContent = state.query ? `${projected.filtered.length}/${projected.all.length}` : String(projected.all.length);
    for (const id of ['history-new-chat', 'history-manage']) {
      const node = drawer.querySelector('#' + id); node.hidden = state.multi;
      node.disabled = blocked() || Boolean(state.form);
    }
    const allButton = drawer.querySelector('#history-select-visible');
    allButton.hidden = !state.multi; allButton.disabled = state.working || !projected.visible.length;
    allButton.textContent = selection.allVisible ? '取消全选' : '全选当前';
    const done = drawer.querySelector('#history-selection-done'); done.hidden = !state.multi; done.disabled = state.working;
    drawer.querySelector('#history-search-input').disabled = state.working || Boolean(state.form);
    drawer.querySelector('#history-search-clear').disabled = state.working || Boolean(state.form);
    batch.hidden = !state.multi;
    const reason = deletionBlocked(selection.ids);
    batch.innerHTML = `<span class="ho-batch-count" role="status">已选 ${selection.ids.length} 条</span><button type="button" data-batch-move ${!selection.ids.length || blocked() ? 'disabled' : ''}>移至分组${icon('chevron-down')}</button><button type="button" data-batch-delete class="ho-danger" title="${escape(reason || '删除所选对话')}" ${!selection.ids.length || blocked() || reason ? 'disabled' : ''}>${icon('trash')}删除</button>${selection.hidden ? `<span class="ho-batch-note">其中 ${selection.hidden} 条当前未显示</span>` : ''}`;
    renderFeedback();
    list.querySelectorAll('[data-select-group]').forEach(node => {
      const entries = projected.filtered.filter(entry => entry.group === node.dataset.selectGroup);
      const count = entries.filter(entry => state.selected.has(entry.id)).length;
      node.indeterminate = count > 0 && count < entries.length;
    });
    renderOverlay();
    if (caret && state.form && !state.working) { const input = list.querySelector('[data-name-input]'); input?.focus({ preventScroll: true }); input?.setSelectionRange(...caret); }
    else restoreFocus(previousFocus);
  }
  const menuItem = (action, label, symbol, extra = '') => `<button type="button" role="menuitem" data-action="${action}" class="${extra}">${icon(symbol)}<span>${escape(label)}</span>${action === 'move-menu' ? `<span class="ho-menu-end">${icon('chevron-right')}</span>` : ''}</button>`;
  function renderOverlay() {
    const previousFocus = overlay?.contains(doc.activeElement) ? focusKey(doc.activeElement) : null;
    overlay?.remove(); overlay = null;
    selectView.setAttribute('aria-expanded', String(state.menu?.kind === 'view'));
    drawer.querySelector('#history-manage').setAttribute('aria-expanded', String(state.menu?.kind === 'global'));
    if (!state.menu && !state.drag) return;
    overlay = doc.createElement('div'); overlay.className = 'ho-overlay-root';
    const menu = state.menu;
    if (menu) {
      let items;
      if (menu.kind === 'view') {
        items = [['groups', '按分组', 'folder'], ['all', '全部对话', 'list-checks']].map(([view, label, symbol]) => `<button type="button" role="menuitemradio" aria-checked="${state.view === view}" data-set-view="${view}">${icon(symbol)}<span>${label}</span><span class="ho-menu-end">${state.view === view ? icon('check') : ''}</span></button>`).join('');
      } else if (menu.page === 'move') {
        const ids = menu.kind === 'chat' ? [menu.id] : [...state.selected];
        const entries = projection().all.filter(entry => ids.includes(entry.id));
        items = `${menuItem('back-menu', '返回', 'arrow-left')}<hr><div class="ho-menu-heading">移至分组</div>${projection().groups.map(group => `<button type="button" role="menuitem" data-move-to="${escape(group.id)}" ${entries.length && entries.every(entry => entry.group === group.id) ? 'disabled' : ''}>${icon(group.id === 'none' ? 'inbox' : 'folder')}<span>${escape(group.name)}</span></button>`).join('')}`;
      } else if (menu.kind === 'global') items = menuItem('new-group', '新建分组', 'folder-plus') + menuItem('select-many', '选择多个', 'list-checks') + (feedbackState.snapshot().undoToken ? '<hr>' + menuItem('undo-last-delete', '撤销上次删除', 'rewind') : '');
      else if (menu.kind === 'group') items = menuItem('new-in-group', '新建对话', 'edit') + (menu.id === 'none' ? '' : menuItem('rename', '重命名', 'pencil')) + menuItem('select-group', '选择组内对话', 'list-checks') + (menu.id === 'none' ? '' : '<hr>' + menuItem('delete-group', '删除分组…', 'trash', 'ho-danger'));
      else if (menu.kind === 'selection') items = `<div class="ho-menu-heading">已选 ${state.selected.size} 条对话</div>` + menuItem('move-menu', '移动所选对话', 'folder-input') + menuItem('delete-chats', '删除所选对话…', 'trash', 'ho-danger');
      else items = menuItem('rename', '重命名', 'pencil') + menuItem('move-menu', '移至分组', 'folder-input') + menuItem('select-many', '选择多个', 'list-checks') + '<hr>' + menuItem('delete-chats', '删除对话…', 'trash', 'ho-danger');
      overlay.innerHTML = `<div ${menu.kind === 'view' ? 'id="history-view-menu"' : ''} class="ho-menu ${menu.kind === 'view' ? 'ho-view-menu' : ''}" role="menu" aria-label="${menu.kind === 'view' ? '对话视图' : menu.kind === 'group' ? '分组操作' : '对话操作'}">${items}</div>`;
      drawer.append(overlay);
      const node = overlay.firstElementChild;
      node.style.left = Math.max(8, Math.min(menu.x, drawer.clientWidth - node.offsetWidth - 8)) + 'px';
      node.style.top = Math.max(8, Math.min(menu.y, drawer.clientHeight - node.offsetHeight - 8)) + 'px';
      restoreFocus(previousFocus, overlay);
    } else {
      const name = projection().all.find(entry => entry.id === state.drag.ids[0])?.title || '对话';
      overlay.innerHTML = `${state.view === 'all' ? `<div class="ho-drop-tray"><div class="ho-menu-heading">松开以移至分组</div>${projection().groups.map(group => `<div class="ho-drop-choice" data-drop-group="${escape(group.id)}">${icon(group.id === 'none' ? 'inbox' : 'folder')}${escape(group.name)}</div>`).join('')}</div>` : ''}<div class="ho-ghost" aria-hidden="true">${escape(state.drag.ids.length > 1 ? `${state.drag.ids.length} 条对话` : name)}<small>拖到分组，Esc 取消</small></div>`;
      drawer.append(overlay);
    }
  }
  function showMenu(kind, id, anchor, point) {
    if (blocked() || state.form || state.drag) return;
    const bounds = drawer.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
    const focusTarget = anchor.matches('button,input,select') ? anchor : anchor.querySelector('[data-open-chat],[data-collapse]') || drawer.querySelector('#history-manage');
    state.menu = { kind, id, page: 'main', focusKey: focusKey(focusTarget), x: (point?.x ?? (kind === 'view' ? rect.left : rect.right - 220)) - bounds.left, y: (point?.y ?? rect.bottom + 5) - bounds.top };
    renderOverlay(); (overlay?.querySelector('[aria-checked="true"]') || overlay?.querySelector('button:not(:disabled)'))?.focus();
  }
  function closeMenu(focus = false) { const key = state.menu?.focusKey; state.menu = null; renderOverlay(); if (focus) restoreFocus(key); }
  function beginName(kind, id = null) {
    if (blocked()) return;
    const item = kind === 'group' ? state.organization.groups.find(group => group.id === id) : projection().all.find(entry => entry.id === id);
    if (id && !item) return;
    state.menu = null; state.multi = false; state.selected.clear();
    state.form = { kind, id, value: item ? kind === 'group' ? item.name : item.title : '', error: '' };
    if (kind === 'group') { state.view = 'groups'; if (!id) clearQuery(); }
    render(); const input = list.querySelector('[data-name-input]'); input?.focus(); input?.select();
  }
  async function saveName() {
    if (!state.form || blocked()) return;
    const form = state.form, value = form.value.trim();
    if (!value) { form.error = '名称不能为空'; render(); list.querySelector('[data-name-input]')?.focus(); return; }
    state.working = true; onBusy(true); render();
    try {
      const snapshot = form.kind === 'group' ? await (form.id ? organization.renameGroup(form.id, value) : organization.createGroup(value)) : await organization.renameConversation(form.id, value);
      if (disposed) return;
      state.organization = snapshot; state.form = null;
      if (form.kind === 'chat') onRenamed(form.id, value);
      announce(form.id ? '名称已保存' : '分组已创建');
    } catch (error) { if (!disposed) form.error = error.message; }
    finally { if (!disposed) { state.working = false; onBusy(false); render(); if (state.form) list.querySelector('[data-name-input]')?.focus(); } }
  }
  function selectMany(ids = []) { if (blocked()) return; state.multi = true; state.menu = null; ids.forEach(id => state.selected.add(id)); render(); }
  function exitSelection() { if (state.working) return; state.multi = false; state.selected.clear(); state.menu = null; render(); }
  function move(ids, group) { return run(async () => {
    applyOrganization(await organization.moveConversations(ids, group === 'none' ? null : group));
    if (disposed) return;
    state.collapsed.delete(group); state.selected.clear(); announce(`已将 ${ids.length} 条对话移至“${groupName(group)}”`); remember();
  }); }
  function requestDelete(kind, target) {
    if (blocked()) return;
    const ids = kind === 'group' ? [] : [...target];
    if (ids.length > 200) { closeMenu(); announce('每次最多删除 200 条对话，请减少选择后重试。'); render(); return; }
    if (kind !== 'group' && !ids.length) return;
    const reason = deletionBlocked(ids);
    if (reason) { closeMenu(); announce(reason); render(); return; }
    const projected = projection(), visibleIds = new Set(projected.visible.map(entry => entry.id));
    pendingDelete = { kind, id: kind === 'group' ? target : null, ids };
    closeMenu();
    const entries = projected.all.filter(entry => ids.includes(entry.id)), hidden = ids.filter(id => !visibleIds.has(id)).length;
    dialog.innerHTML = `<h2 id="history-action-title">${kind === 'group' ? `删除分组“${escape(groupName(target))}”？` : `删除 ${ids.length} 条对话？`}</h2><p id="history-action-description">${kind === 'group' ? `组内 ${projected.all.filter(entry => entry.group === target).length} 条对话会移至“未分组”，内容保留。` : '删除后可撤销。恢复记录保存在当前浏览器中。'}</p>${entries.length ? `<ul>${entries.slice(0, 3).map(entry => `<li>${escape(entry.title)}</li>`).join('')}${entries.length > 3 ? `<li>以及另外 ${entries.length - 3} 条</li>` : ''}</ul>` : ''}${hidden ? `<p>包含 ${hidden} 条当前未显示的对话。</p>` : ''}<div class="ho-dialog-actions"><button type="button" data-cancel-delete class="button button-secondary">取消</button><button type="button" data-confirm-delete class="button button-danger">${kind === 'group' ? '删除分组' : `删除 ${ids.length} 条`}</button></div>`;
    dialog.showModal(); dialog.querySelector('[data-cancel-delete]').focus();
  }
  function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    return run(async () => {
      dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
      dialog.querySelector('[data-confirm-delete]').textContent = '正在删除…';
      try {
        if (target.kind === 'group') { applyOrganization(await organization.deleteGroup(target.id)); announce('分组已删除，对话已移至未分组'); state.collapsed.delete('none'); remember(); }
        else {
          const reason = deletionBlocked(target.ids); if (reason) throw new Error(reason);
          const result = await onDelete(target.ids);
          if (disposed) return;
          const removed = [...result.deletedIds, ...result.pendingIds]; removed.forEach(id => state.selected.delete(id));
          announce(`已删除 ${result.deletedIds.length} 条${result.pendingIds.length ? `，${result.pendingIds.length} 条文件删除待核验` : ''}${result.failed.length ? `；${result.failed.length} 条失败：${result.failed[0].message}` : ''}`, removed.length ? result.token : null);
          await onRefresh();
        }
      } finally { if (!disposed) { pendingDelete = null; dialog.close(); } }
    });
  }
  function contextFor(row, point) {
    if (state.multi) {
      if (row.dataset.contextKind === 'chat') state.selected.add(row.dataset.contextId);
      else projection().filtered.filter(entry => entry.group === row.dataset.contextId).forEach(entry => state.selected.add(entry.id));
      render(); if (state.selected.size) showMenu('selection', null, drawer, point);
    } else showMenu(row.dataset.contextKind, row.dataset.contextId, row, point);
  }
  function restoreDeleted() {
    const token = feedbackState.snapshot().undoToken;
    if (!token) return;
    return run(async () => {
      const result = await onRestore(token);
      if (disposed) return;
      const pending = Boolean(result.failed.length || result.pendingIds?.length);
      const syncing = result.conversations?.filter(entry => entry.syncStatus === 'pending').length || 0;
      feedbackState.resolveUndo(token, { pending });
      announce(`已恢复 ${result.restoredIds.length} 条${syncing ? `，${syncing} 条待同步到文件夹` : ''}${result.pendingIds?.length ? `；${result.pendingIds.length} 条恢复仍待核验，请稍后重试` : ''}${result.failed.length ? `；${result.failed.length} 条失败：${result.failed[0].message}` : ''}`, pending ? token : null);
      await onRefresh();
    });
  }
  drawer.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !drawer.contains(button)) return;
    if (button.hasAttribute('data-dismiss-feedback')) { dismissFeedback(); return; }
    if (button.hasAttribute('data-save-name')) { void saveName(); return; }
    if (button.hasAttribute('data-cancel-name')) { if (!state.working) { state.form = null; render(); } return; }
    if (button.id === 'close-history' || button.id === 'open-settings') return;
    if (button.hasAttribute('data-retry-history')) { void run(onRefresh, { allowUninitialized: true }); return; }
    if (blocked() || state.form) return;
    if (button === selectView) { if (state.menu?.kind === 'view') closeMenu(true); else showMenu('view', null, button); return; }
    if (button.hasAttribute('data-set-view')) { state.view = button.dataset.setView; closeMenu(true); render(); remember(); return; }
    if (button.id === 'history-manage') { showMenu('global', null, button); return; }
    if (button.id === 'history-new-chat') { void run(() => onNew(null)); return; }
    if (button.id === 'history-selection-done') { exitSelection(); return; }
    if (button.id === 'history-select-visible') { state.selected = toggleHistorySelection(state.selected, projection().visible.map(entry => entry.id)); render(); return; }
    if (button.hasAttribute('data-menu-kind')) { showMenu(button.dataset.menuKind, button.dataset.menuId, button); return; }
    if (button.hasAttribute('data-action')) {
      const menu = state.menu; if (!menu) return;
      const action = button.dataset.action;
      if (action === 'back-menu' || action === 'move-menu') { menu.page = action === 'move-menu' ? 'move' : 'main'; renderOverlay(); overlay.querySelector('button')?.focus(); }
      if (action === 'rename') beginName(menu.kind, menu.id);
      if (action === 'new-group') beginName('group');
      if (action === 'new-in-group') void run(() => onNew(menu.id === 'none' ? null : menu.id));
      if (action === 'select-many') selectMany(menu.kind === 'chat' ? [menu.id] : []);
      if (action === 'undo-last-delete') void restoreDeleted();
      if (action === 'select-group') { clearQuery(); state.view = 'groups'; state.collapsed.delete(menu.id); selectMany(projection().all.filter(entry => entry.group === menu.id).map(entry => entry.id)); }
      if (action === 'delete-group') requestDelete('group', menu.id);
      if (action === 'delete-chats') requestDelete('chats', menu.kind === 'chat' ? [menu.id] : [...state.selected]);
      return;
    }
    if (button.hasAttribute('data-move-to')) { const menu = state.menu; void move(menu.kind === 'chat' ? [menu.id] : [...state.selected], button.dataset.moveTo); return; }
    if (state.menu) { closeMenu(); return; }
    if (button.hasAttribute('data-new-in-group')) { void run(() => onNew(button.dataset.newInGroup === 'none' ? null : button.dataset.newInGroup)); return; }
    if (button.hasAttribute('data-collapse')) { const id = button.dataset.collapse; state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id); render(); remember(); return; }
    if (button.hasAttribute('data-open-chat')) { const id = button.dataset.openChat; if (state.multi) { state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); render(); } else void run(() => onOpen(id)); return; }
    if (button.hasAttribute('data-batch-move')) { showMenu('selection', null, button); state.menu.page = 'move'; renderOverlay(); overlay.querySelector('button')?.focus(); return; }
    if (button.hasAttribute('data-batch-delete')) { requestDelete('chats', [...state.selected]); return; }
    if (button.hasAttribute('data-undo')) void restoreDeleted();
  }, { signal });
  feedback.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') feedbackState.pause('hover'); }, { signal });
  feedback.addEventListener('pointerleave', () => feedbackState.pause('hover', false), { signal });
  feedback.addEventListener('focusin', () => feedbackState.pause('focus'), { signal });
  feedback.addEventListener('focusout', () => { queueMicrotask(() => {
    if (!disposed) feedbackState.pause('focus', feedback.contains(doc.activeElement));
  }); }, { signal });
  drawer.addEventListener('contextmenu', event => {
    if (event.target.closest('input,textarea,[contenteditable]')) return;
    const row = event.target.closest('[data-context-kind]'); if (!row) return;
    event.preventDefault(); contextFor(row, { x: event.clientX, y: event.clientY });
  }, { signal });
  drawer.addEventListener('input', event => { if (event.target.matches('[data-name-input]') && state.form) state.form.value = event.target.value; }, { signal });
  drawer.addEventListener('change', event => {
    if (state.working || state.form) return;
    const node = event.target;
    if (node.hasAttribute('data-select-chat')) { node.checked ? state.selected.add(node.dataset.selectChat) : state.selected.delete(node.dataset.selectChat); render(); }
    if (node.hasAttribute('data-select-group')) { const id = node.dataset.selectGroup; projection().filtered.filter(entry => entry.group === id).forEach(entry => node.checked ? state.selected.add(entry.id) : state.selected.delete(entry.id)); state.collapsed.delete(id); render(); }
  }, { signal });
  drawer.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.target === selectView && ['ArrowDown', 'ArrowUp'].includes(event.key) && !state.menu) { event.preventDefault(); showMenu('view', null, selectView); return; }
    if (event.key === 'Escape' && (state.menu || state.form || state.multi || state.working)) {
      event.preventDefault(); event.stopPropagation();
      if (state.working) return;
      if (state.menu) closeMenu(true); else if (state.form) { state.form = null; render(); } else exitSelection(); return;
    }
    if (event.key === 'Enter' && event.target.matches('[data-name-input]')) { event.preventDefault(); void saveName(); return; }
    if (state.menu && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const nodes = [...overlay.querySelectorAll('button:not(:disabled)')], i = nodes.indexOf(doc.activeElement);
      nodes[event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length]?.focus();
    }
    if (state.menu && event.key === 'Tab') closeMenu(true);
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      if (event.target.closest('input,textarea,[contenteditable]')) return;
      const row = event.target.closest('[data-context-kind]'); if (row) { event.preventDefault(); contextFor(row); }
    }
  }, { signal });
  dialog.addEventListener('click', event => {
    if (state.working) return;
    if (event.target.closest('[data-confirm-delete]')) void confirmDelete();
    else if (event.target === dialog || event.target.closest('[data-cancel-delete]')) { pendingDelete = null; dialog.close(); }
  }, { signal });
  dialog.addEventListener('cancel', event => { if (state.working) event.preventDefault(); else pendingDelete = null; }, { signal });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); }, { signal });
  doc.addEventListener('pointerdown', event => { if (state.menu && !event.target.closest('.ho-menu') && !event.target.closest('[data-menu-kind],#history-manage,#history-view')) closeMenu(); }, { signal, capture: true });
  list.addEventListener('scroll', () => { if (state.menu) closeMenu(); }, { signal });
  function updateDrag(point) {
    if (!state.drag || disposed) return;
    dragPoint = point;
    const bounds = drawer.getBoundingClientRect(), ghost = overlay?.querySelector('.ho-ghost');
    const targetNode = doc.elementFromPoint(point.x, point.y)?.closest('[data-drop-group]');
    const target = targetNode && drawer.contains(targetNode) ? targetNode.dataset.dropGroup : null;
    if (state.drag.target !== target) {
      clearTimeout(expandTimer); state.drag.target = target;
      if (target && state.view === 'groups' && state.collapsed.has(target)) expandTimer = setTimeout(() => {
        if (!state.drag || state.drag.target !== target) return;
        state.collapsed.delete(target); render(); updateDrag(dragPoint);
      }, 600);
    }
    drawer.querySelectorAll('[data-drop-group]').forEach(node => node.classList.toggle('is-drop', node.dataset.dropGroup === target));
    if (ghost) { ghost.style.left = Math.max(8, Math.min(point.x - bounds.left + 12, drawer.clientWidth - ghost.offsetWidth - 8)) + 'px'; ghost.style.top = Math.max(8, Math.min(point.y - bounds.top + 17, drawer.clientHeight - ghost.offsetHeight - 8)) + 'px'; ghost.querySelector('small').textContent = target ? `松开移至“${groupName(target)}”` : '拖到分组，Esc 取消'; }
  }
  function autoScroll() {
    if (!state.drag || disposed) return;
    const bounds = list.getBoundingClientRect(), point = dragPoint;
    if (point && state.view === 'groups' && point.x >= bounds.left && point.x <= bounds.right) {
      const delta = point.y < bounds.top + 30 ? -9 : point.y > bounds.bottom - 30 ? 9 : 0;
      if (delta) { list.scrollTop += delta; updateDrag(point); }
    }
    scrollFrame = win.requestAnimationFrame(autoScroll);
  }
  function clearDrag() { clearTimeout(expandTimer); win.cancelAnimationFrame(scrollFrame); scrollFrame = null; state.drag = null; dragPoint = null; }
  const pressDrag = installPressDrag(drawer, {
    canStart: () => !blocked() && !state.form && !state.menu && !dialog.open && drawer.classList.contains('open'),
    start: (id, point) => { state.drag = { ids: state.multi && state.selected.has(id) ? [...state.selected] : [id], target: null }; render(); updateDrag(point); autoScroll(); },
    move: updateDrag,
    finish: point => { updateDrag(point); const drag = state.drag; clearDrag(); if (drag?.target) void move(drag.ids, drag.target); else render(); },
    cancel: () => { clearDrag(); render(); },
  });
  const unsubscribe = organization.subscribe(applyOrganization);
  return Object.freeze({
    update({ entries, activeId, query, snapshot }) { if (disposed) return; state.entries = entries; state.activeId = activeId; state.query = query || ''; if (snapshot) { state.loadError = ''; applyOrganization(snapshot, true); } else render(); },
    setLoadError(error) { if (!disposed) { state.loadError = error.message || '读取历史失败，请重试。'; render(); } },
    setBusy(value) { if (!disposed && state.busy !== Boolean(value)) { state.busy = Boolean(value); if (value) pressDrag.cancel(); render(); } },
    setOpen(open) { if (!open) { pressDrag.cancel(); closeMenu(); feedbackState.dismiss(); feedbackState.pause('hover', false); feedbackState.pause('focus', false); } },
    restoreUndo(deletion) { if (!disposed && deletion?.token && !feedbackState.snapshot().undoToken) feedbackState.rememberUndo(deletion.token); },
    dispose() { if (disposed) return; disposed = true; controller.abort(); feedbackState.dispose(); pressDrag.dispose(); clearDrag(); unsubscribe(); overlay?.remove(); dialog.remove(); },
  });
}
