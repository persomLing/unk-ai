import { awaitWithTimeout } from '../../../utils/abortable.js';
import { parseSkillMarkdown, SKILL_LIMITS } from './skill-format.js';

export function skillCompatibilityLabel(status) {
  return status === 'compatible' ? '未发现已知依赖' : status === 'unsupported' ? '当前无法运行' : '需要检查';
}

export async function readSkillFile(file, { signal, timeoutMs = 5000 } = {}) {
  if (!file || typeof file.text !== 'function' || typeof file.name !== 'string' || !/\.md$/i.test(file.name)) {
    throw new Error('请选择单个 Markdown 技能文件（.md）。');
  }
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > SKILL_LIMITS.maxBytes) {
    throw new Error('技能文件必须非空且不超过 64 KiB。');
  }
  signal?.throwIfAborted();
  const raw = await awaitWithTimeout(Promise.resolve().then(() => {
    signal?.throwIfAborted();
    return file.text();
  }), { signal, timeoutMs, message: '读取技能文件超时，请重新选择文件。' });
  signal?.throwIfAborted();
  // Recheck the actual UTF-8 payload; declared file.size is not a trust boundary.
  return parseSkillMarkdown(raw, { fileName: file.name });
}

/** The apply callback must synchronously copy the record into the current draft. */
export function createSkillLibraryView({ root, store, onApply,
  getApplyBlockReason = () => '', getContextKey = () => '', onNotice = () => {} } = {}) {
  if (!root || !store || typeof onApply !== 'function') throw new TypeError('技能库界面需要容器、存储和草稿回调。');
  const document = root.ownerDocument;
  const titleId = `${root.id || 'skills-dialog'}-title`;
  const applyReasonId = `${root.id || 'skills-dialog'}-apply-reason`;
  root.classList.add('skills-dialog');
  root.setAttribute('aria-labelledby', titleId);
  root.innerHTML = `
    <header class="skills-header"><h2 id="${titleId}">技能库</h2><button type="button" class="skills-close" data-skill-action="close" aria-label="关闭技能库">×</button></header>
    <div class="skills-intro">导入 SKILL.md，将文字指南用于本次提问。当前支持写作、分析和整理已有资料；脚本、外部工具及附带文件依赖需另行适配。</div>
    <div class="skills-toolbar"><button type="button" class="button" data-skill-action="import">导入 SKILL.md</button><span class="skills-count"></span><input type="file" class="skills-file-input" accept=".md,text/markdown" hidden aria-label="选择技能文件"></div>
    <p class="skills-feedback" role="status" aria-live="polite"></p>
    <div class="skills-content"><div class="skills-list" aria-label="已导入技能"></div><section class="skills-detail" aria-label="技能详情" hidden>
      <h3 class="skills-name"></h3><p class="skills-description"></p><p class="skills-status"></p><ul class="skills-issues"></ul>
      <p class="skills-check-note">检查只识别已知依赖，不能保证完整兼容。请核对原文；技能不会新增工具或权限。</p>
      <details class="skills-source"><summary>查看完整原文</summary><pre></pre></details>
    </section></div>
    <footer class="skills-footer"><p id="${applyReasonId}" class="skills-apply-reason" role="status" hidden></p><button type="button" class="button" data-skill-action="delete" disabled>从技能库删除</button><button type="button" class="button button-primary" data-skill-action="apply" aria-describedby="${applyReasonId}" disabled>用于本次提问</button></footer>`;
  const node = selector => root.querySelector(selector);
  const list = node('.skills-list'), detail = node('.skills-detail'), feedback = node('.skills-feedback');
  const fileInput = node('.skills-file-input'), applyButton = node('[data-skill-action="apply"]');
  const applyReason = node('.skills-apply-reason');
  const deleteButton = node('[data-skill-action="delete"]'), importButton = node('[data-skill-action="import"]');
  let disposed = false, epoch = 0, session = null, fileChoiceSession = null, snapshot = null, selectedId = null, busy = false;
  function selected() { return snapshot?.records.find(record => record.id === selectedId) || null; }
  function current(operation) {
    return !disposed && root.open && session === operation && !operation.signal.aborted
      && operation.epoch === epoch && Object.is(operation.contextKey, getContextKey());
  }
  function assertCurrent(operation) {
    if (!current(operation)) throw new DOMException('技能选择已取消或对话已切换。', 'AbortError');
  }
  function notice(message, kind = 'error') {
    feedback.textContent = message;
    feedback.classList.toggle('is-error', kind === 'error');
    try { onNotice(message, kind); } catch { /* Notice observers do not own the draft. */ }
  }
  function stateControls() {
    const record = selected();
    const compatible = record && parseSkillMarkdown(record.raw, { fileName: record.sourceFileName }).compatibility.status === 'compatible';
    const blocked = getApplyBlockReason() || '';
    importButton.disabled = busy;
    deleteButton.disabled = busy || !record;
    applyButton.disabled = busy || !compatible || Boolean(blocked);
    applyReason.textContent = blocked;
    applyReason.hidden = !blocked;
    for (const row of list.querySelectorAll('button')) row.disabled = busy;
    root.setAttribute('aria-busy', String(busy));
  }
  function renderDetail() {
    const record = selected();
    detail.hidden = !record;
    if (!record) { stateControls(); return; }
    const parsed = parseSkillMarkdown(record.raw, { fileName: record.sourceFileName });
    node('.skills-name').textContent = parsed.name;
    node('.skills-description').textContent = parsed.description || '这个技能没有填写说明。';
    node('.skills-status').textContent = `${skillCompatibilityLabel(parsed.compatibility.status)} · ${record.sourceFileName}`;
    node('.skills-status').dataset.status = parsed.compatibility.status;
    const issues = node('.skills-issues');
    issues.replaceChildren();
    for (const issue of parsed.compatibility.issues) {
      const item = document.createElement('li');
      item.textContent = issue.message + (issue.evidence ? `（${String(issue.evidence).slice(0, 180)}）` : '');
      issues.append(item);
    }
    issues.hidden = !parsed.compatibility.issues.length;
    node('.skills-source pre').textContent = record.raw;
    stateControls();
  }
  function render(next) {
    snapshot = next;
    if (!snapshot.records.some(record => record.id === selectedId)) selectedId = snapshot.records[0]?.id || null;
    node('.skills-count').textContent = `${snapshot.records.length} / 20`;
    list.replaceChildren();
    if (!snapshot.records.length) {
      const empty = document.createElement('p'); empty.className = 'skills-empty';
      empty.textContent = '还没有技能。选择一个 SKILL.md 文件，先查看它在浏览器里的可用范围。'; list.append(empty);
    }
    for (const record of snapshot.records) {
      const parsed = parseSkillMarkdown(record.raw, { fileName: record.sourceFileName });
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'skills-item'; button.dataset.skillId = record.id;
      button.setAttribute('aria-pressed', String(record.id === selectedId));
      const name = document.createElement('span'); name.className = 'skills-item-name'; name.textContent = record.name;
      const status = document.createElement('span'); status.className = 'skills-item-status'; status.textContent = skillCompatibilityLabel(parsed.compatibility.status);
      button.append(name, status); list.append(button);
    }
    renderDetail();
  }
  async function run(operation, action) {
    if (!current(operation) || busy) return;
    busy = true; feedback.textContent = ''; feedback.classList.remove('is-error'); stateControls();
    try { await action(); }
    catch (error) {
      if (current(operation) && error.name !== 'AbortError') notice(error.message || '技能库操作失败。');
    } finally {
      if (current(operation)) { busy = false; stateControls(); }
    }
  }
  async function refresh() {
    const operation = session;
    if (!operation) return;
    return run(operation, async () => {
      const next = await store.list({ signal: operation.signal });
      assertCurrent(operation); render(next);
    });
  }
  function invalidate() {
    epoch += 1;
    session?.controller.abort(new DOMException('技能库已关闭。', 'AbortError'));
    session = null; fileChoiceSession = null; busy = false;
  }
  function close() {
    invalidate();
    if (root.open) root.close();
  }
  async function open() {
    if (disposed) return;
    invalidate();
    const controller = new AbortController();
    session = { epoch, controller, signal: controller.signal, contextKey: getContextKey() };
    selectedId = null; snapshot = null; list.replaceChildren(); detail.hidden = true;
    feedback.textContent = ''; node('.skills-count').textContent = '';
    if (!root.open) root.showModal();
    await refresh();
  }
  const click = event => {
    const operation = session;
    if (!operation || !current(operation)) { if (root.open) close(); return; }
    const action = event.target.closest('[data-skill-action]')?.dataset.skillAction;
    if (action === 'close') { close(); return; }
    if (busy) return;
    const id = event.target.closest('[data-skill-id]')?.dataset.skillId;
    if (id) { selectedId = id; render(snapshot); return; }
    if (action === 'import') { fileChoiceSession = operation; fileInput.value = ''; fileInput.click(); return; }
    const record = selected();
    if (!record) return;
    if (action === 'delete') {
      void run(operation, async () => {
        const next = await store.remove(record.id, { signal: operation.signal });
        assertCurrent(operation); render(next);
        notice('已从技能库删除；已发送消息中的技能副本仍保留。', 'info');
      });
    }
    if (action === 'apply') {
      try {
        assertCurrent(operation);
        const blocked = getApplyBlockReason();
        if (blocked) { notice(blocked); return; }
        const parsed = parseSkillMarkdown(record.raw, { fileName: record.sourceFileName });
        if (parsed.compatibility.status !== 'compatible') { notice('这个技能有未满足或待核对的依赖，当前只能查看。'); return; }
        onApply(structuredClone(record));
        close();
      } catch (error) { if (current(operation)) notice(error.message || '无法选择这个技能。'); }
    }
  };
  const change = () => {
    const operation = fileChoiceSession, file = fileInput.files?.[0];
    fileChoiceSession = null;
    fileInput.value = '';
    if (!operation || !file) return;
    void run(operation, async () => {
      const parsed = await readSkillFile(file, { signal: operation.signal });
      assertCurrent(operation);
      const record = await store.importMarkdown(parsed.raw, { fileName: file.name, signal: operation.signal });
      assertCurrent(operation);
      selectedId = record.id;
      const next = await store.list({ signal: operation.signal });
      assertCurrent(operation); render(next);
      notice(parsed.compatibility.status === 'compatible' ? '已导入。核对原文后可用于本次提问。' : '已导入供查看；请先解决列出的依赖。', 'info');
    });
  };
  const cancel = event => { event.preventDefault(); close(); };
  // Native close events are queued. An old event must not cancel a reopened modal.
  const closed = () => { if (!root.open && session) invalidate(); };
  root.addEventListener('click', click);
  root.addEventListener('cancel', cancel);
  root.addEventListener('close', closed);
  fileInput.addEventListener('change', change);
  return Object.freeze({ open, close, refresh,
    dispose() {
      if (disposed) return;
      close(); disposed = true;
      root.removeEventListener('click', click); root.removeEventListener('cancel', cancel); root.removeEventListener('close', closed);
      fileInput.removeEventListener('change', change);
    },
  });
}
