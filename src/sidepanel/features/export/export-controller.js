import { icon } from '../../icons.js';
import { markdownToPlainText } from '../messages/copy-text.js';
import { awaitWithTimeout } from '../../../utils/abortable.js';
import { createExportSnapshot, selectExportSnapshot, exportSelectionIssue, exportFilename } from './export-model.js';

const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const summary = (value, limit) => { const text = compact(value); return text.length > limit ? `${text.slice(0, limit)}…` : text; };

/** UI-owned export sessions are snapshots, never owners of a live chat turn. */
export function createExportController({ document = globalThis.document, download, notify = () => {},
  loadRenderer = () => import('./export-renderer.js') } = {}) {
  if (!document || typeof download !== 'function') throw new TypeError('Export requires a document and download adapter.');
  const dialog = document.createElement('dialog');
  dialog.className = 'export-dialog';
  dialog.id = 'conversation-export-dialog';
  dialog.setAttribute('aria-labelledby', 'export-dialog-title');
  dialog.innerHTML = `<header class="export-dialog-header">
    <div><span class="export-eyebrow">留存 · 分享</span><h2 id="export-dialog-title">导出对话</h2></div>
    <button class="icon-button" type="button" data-export-close aria-label="关闭导出">${icon('close')}</button>
  </header>
  <p class="export-conversation-title"></p>
  <div class="export-tabs" role="tablist" aria-label="导出步骤">
    <button type="button" id="export-select-tab" role="tab" aria-controls="export-select-panel" aria-selected="true" data-export-view="selection">1 选择内容</button>
    <button type="button" id="export-preview-tab" role="tab" aria-controls="export-preview-panel" aria-selected="false" tabindex="-1" data-export-view="preview">2 预览效果</button>
  </div>
  <div class="export-dialog-body">
    <section id="export-select-panel" role="tabpanel" aria-labelledby="export-select-tab">
      <div class="export-selection-toolbar"><label><input type="checkbox" data-export-all>全选回合</label><span data-export-count></span></div>
      <div class="export-turn-list"></div>
      <p class="export-snapshot-note">按当前内容导出；后续生成的文字不会加入本次导出。</p>
    </section>
    <section id="export-preview-panel" role="tabpanel" aria-labelledby="export-preview-tab" hidden>
      <div class="export-preview-viewport"><div class="export-preview-canvas"></div></div>
    </section>
  </div>
  <div class="export-settings">
    <label class="export-include"><input type="checkbox" data-export-questions checked>包含我的提问</label>
    <fieldset class="export-format"><legend class="sr-only">导出格式</legend>
      <label><input type="radio" name="export-format" value="png" checked><span>${icon('image')}<strong>长图 PNG</strong><small>适合分享</small></span></label>
      <label><input type="radio" name="export-format" value="pdf"><span>${icon('file')}<strong>文档 PDF</strong><small>自动分页</small></span></label>
    </fieldset>
    <p class="export-format-note">浅色版式 · 仅包含选中的正文和来源</p>
    <p class="export-feedback" role="status" aria-live="polite" hidden></p>
  </div>
  <footer class="export-dialog-footer"><button type="button" class="button button-secondary" data-export-close>取消</button><button type="button" class="button button-primary" data-export-save>导出 PNG</button></footer>`;
  document.body.append(dialog);
  const find = selector => dialog.querySelector(selector);
  const list = find('.export-turn-list');
  const feedback = find('.export-feedback');
  const canvas = find('.export-preview-canvas');
  const all = find('[data-export-all]');
  const save = find('[data-export-save]');
  let current = null;
  let disposed = false;
  let previewVersion = 0;
  let observer;

  function active(session) {
    return !disposed && current === session && dialog.open && !session.controller.signal.aborted;
  }
  function status(message = '', error = false) {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.classList.toggle('is-error', error);
  }
  function layoutPreview() {
    const paper = canvas.firstElementChild;
    if (!paper || find('#export-preview-panel').hidden) return;
    const width = Math.max(160, find('.export-preview-viewport').clientWidth - 24);
    const scale = Math.min(1, width / 800);
    paper.style.transform = `scale(${scale})`;
    paper.style.transformOrigin = 'top left';
    canvas.style.width = `${800 * scale}px`;
    canvas.style.height = `${paper.scrollHeight * scale}px`;
  }
  if (document.defaultView?.ResizeObserver) {
    observer = new document.defaultView.ResizeObserver(layoutPreview);
    observer.observe(find('.export-preview-viewport'));
  }
  function refresh() {
    const session = current;
    if (!session) return;
    const issue = exportSelectionIssue(session.snapshot, session.selected, session);
    all.checked = session.selected.size === session.snapshot.turns.length && session.selected.size > 0;
    all.indeterminate = session.selected.size > 0 && !all.checked;
    find('[data-export-count]').textContent = `已选 ${session.selected.size} / ${session.snapshot.turns.length} 轮`;
    for (const input of list.querySelectorAll('input')) input.checked = session.selected.has(input.value);
    for (const control of dialog.querySelectorAll('input, [data-export-view]')) control.disabled = session.busy;
    save.disabled = session.busy || Boolean(issue);
    save.textContent = session.busy ? '正在生成…' : `导出 ${session.format.toUpperCase()}`;
    dialog.setAttribute('aria-busy', String(session.busy));
    find('.export-format-note').textContent = session.format === 'pdf'
      ? 'PDF 按图片分页，文字不可选中；需要文本可使用复制功能。'
      : '浅色版式 · 仅包含选中的正文和来源';
    if (!session.busy) status(issue, Boolean(issue));
  }
  function close({ restoreFocus = true } = {}) {
    const session = current;
    if (!session) return;
    current = null;
    previewVersion++;
    session.controller.abort(new DOMException('已取消导出', 'AbortError'));
    if (dialog.open) dialog.close();
    canvas.replaceChildren();
    list.replaceChildren();
    if (restoreFocus && session.trigger?.isConnected) session.trigger.focus({ preventScroll: true });
  }
  function open(conversation, trigger) {
    if (disposed) return;
    close({ restoreFocus: false });
    let snapshot;
    try { snapshot = createExportSnapshot(conversation); }
    catch (error) { notify(error.message, 'error'); return; }
    if (!snapshot.turns.length) { notify('当前没有可导出的问答回合。'); return; }
    current = { snapshot, selected: new Set(snapshot.turns.map(turn => turn.id)), trigger,
      controller: new AbortController(), includeQuestions: true, format: 'png', busy: false, view: 'selection' };
    find('.export-conversation-title').textContent = snapshot.title;
    find('[data-export-questions]').checked = true;
    find('input[value="png"]').checked = true;
    for (const turn of snapshot.turns) {
      const label = document.createElement('label');
      label.className = 'export-turn-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = turn.id;
      checkbox.setAttribute('aria-label', `选择第 ${turn.index} 轮`);
      const copy = document.createElement('span');
      const heading = document.createElement('strong');
      heading.textContent = `${String(turn.index).padStart(2, '0')}  ${summary(turn.user.content, 100) || '附件提问'}`;
      const preview = document.createElement('small');
      preview.textContent = summary(markdownToPlainText(turn.assistant?.content.slice(0, 2000)), 140) || (turn.assistant?.status === 'error' ? '回答未完成' : '暂无回答正文');
      copy.append(heading, preview);
      label.append(checkbox, copy);
      list.append(label);
    }
    showView('selection');
    dialog.showModal();
    refresh();
    all.focus();
  }
  async function preview() {
    const session = current;
    if (!session || session.busy) return;
    const version = ++previewVersion;
    canvas.replaceChildren();
    canvas.style.height = '';
    const issue = exportSelectionIssue(session.snapshot, session.selected, session);
    if (issue) { status(issue, true); return; }
    status('正在准备预览…');
    try {
      const renderer = await awaitWithTimeout(loadRenderer(), { signal: session.controller.signal, timeoutMs: 15000, message: '预览加载超时，请重试。' });
      if (!active(session) || version !== previewVersion) return;
      const paper = renderer.buildExportDocument(selectExportSnapshot(session.snapshot, session.selected), { document, includeQuestions: session.includeQuestions });
      canvas.replaceChildren(paper);
      renderer.fitExportDocument?.(paper);
      layoutPreview();
      status();
      // Images and bundled math fonts can alter line heights after first layout.
      paper.addEventListener('load', layoutPreview, true);
      if (document.fonts) void awaitWithTimeout(document.fonts.ready, { signal: session.controller.signal, timeoutMs: 8000 })
        .then(() => { if (active(session) && version === previewVersion) { renderer.fitExportDocument?.(paper); layoutPreview(); } })
        .catch(() => {});
    } catch (error) {
      if (active(session) && version === previewVersion) status(error.message || '预览失败，请重试。', true);
    }
  }
  function showView(view) {
    if (!current) return;
    current.view = view;
    for (const button of dialog.querySelectorAll('[data-export-view]')) {
      const selected = button.dataset.exportView === view;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    find('#export-select-panel').hidden = view !== 'selection';
    find('#export-preview-panel').hidden = view !== 'preview';
    if (view === 'preview') void preview();
    else { previewVersion++; refresh(); }
  }
  async function saveExport() {
    const session = current;
    if (!session || session.busy || exportSelectionIssue(session.snapshot, session.selected, session)) return;
    const snapshot = selectExportSnapshot(session.snapshot, session.selected);
    const format = session.format;
    const operation = new AbortController();
    session.operation = operation;
    const cancelOperation = () => operation.abort(session.controller.signal.reason);
    session.controller.signal.addEventListener('abort', cancelOperation, { once: true });
    const ownsOperation = () => active(session) && session.operation === operation && !operation.signal.aborted;
    session.busy = true;
    previewVersion++;
    refresh();
    status('正在准备导出…');
    try {
      const renderer = await awaitWithTimeout(loadRenderer(), { signal: operation.signal, timeoutMs: 15000, message: '导出组件加载超时，请重试。' });
      if (!ownsOperation()) return;
      const result = await awaitWithTimeout(renderer.renderConversationExport(snapshot, {
        format, includeQuestions: session.includeQuestions, signal: operation.signal,
        onProgress: value => {
          if (ownsOperation()) status(typeof value === 'string' ? value : value?.phase === 'rendering'
            ? `正在生成第 ${value.page} / ${value.totalPages} 页…` : value?.phase === 'encoding' ? '正在打包文件…' : '正在排版…');
        },
      }), { signal: operation.signal, timeoutMs: 90000, message: '导出超时，请减少所选回合后重试。' });
      if (!ownsOperation()) return;
      status('正在打开保存窗口…');
      await awaitWithTimeout(download({ blob: result.blob, filename: exportFilename(snapshot, result.extension), signal: operation.signal }),
        { signal: operation.signal, timeoutMs: 60000, message: '等待保存窗口超时，请检查浏览器下载列表。' });
      if (!ownsOperation()) return;
      notify(`已交给浏览器保存 ${format.toUpperCase()}。`);
      close();
    } catch (error) {
      operation.abort(error);
      if (active(session)) {
        session.busy = false;
        refresh();
        status(error.message || '导出失败，请重试。', true);
      }
    } finally {
      operation.abort();
      session.controller.signal.removeEventListener('abort', cancelOperation);
    }
  }
  function onClick(event) {
    if (event.target.closest('[data-export-close]')) close();
    else if (event.target.closest('[data-export-save]')) void saveExport();
    else {
      const tab = event.target.closest('[data-export-view]');
      if (tab && !current?.busy) showView(tab.dataset.exportView);
    }
  }
  function onChange(event) {
    if (!current || current.busy) return;
    const input = event.target;
    if (input === all) current.selected = input.checked ? new Set(current.snapshot.turns.map(turn => turn.id)) : new Set();
    else if (input.matches('.export-turn-list input')) {
      if (input.checked) current.selected.add(input.value); else current.selected.delete(input.value);
    } else if (input.matches('[data-export-questions]')) current.includeQuestions = input.checked;
    else if (input.name === 'export-format') current.format = input.value;
    refresh();
    if (current.view === 'preview') void preview();
  }
  function onKey(event) {
    const tab = event.target.closest('[data-export-view]');
    if (!tab || current?.busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'Home' ? 'selection' : event.key === 'End' ? 'preview' : tab.dataset.exportView === 'selection' ? 'preview' : 'selection';
    showView(view);
    find(`[data-export-view="${view}"]`).focus();
  }
  const onCancel = event => { event.preventDefault(); close(); };
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('change', onChange);
  dialog.addEventListener('keydown', onKey);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', () => { if (!dialog.open && current) close(); });
  return { open, close,
    sync(conversationId) { if (current && current.snapshot.id !== conversationId) close({ restoreFocus: false }); },
    dispose() { if (disposed) return; close({ restoreFocus: false }); disposed = true; observer?.disconnect(); dialog.remove(); },
  };
}
