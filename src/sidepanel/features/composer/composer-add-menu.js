import { parseSkillMarkdown } from '../skills/skill-format.js';
import { icon } from '../../icons.js';

/** A composer menu owns selection only; file, Agent and send actions keep their existing owners. */
export function createComposerAddMenu({ root, trigger, store, getContextKey = () => '',
  getSkillBlockReason = () => '', getSelectedSkillId = () => '', onApplySkill, onOpenSkills,
  onNotice = () => {} }) {
  const document = root.ownerDocument;
  const list = root.querySelector('[data-menu-skills]');
  let disposed = false, session = null, records = [], loaded = false, presentationKey = '';
  const presentation = () => JSON.stringify([getSkillBlockReason(), getSelectedSkillId()]);
  const current = token => !disposed && token === session && !token.signal.aborted
    && !root.hidden && Object.is(token.contextKey, getContextKey());
  const items = () => [...root.querySelectorAll('button')].filter(button => !button.disabled
    && button.getAttribute('aria-disabled') !== 'true' && !button.closest('[hidden]'));
  function close({ restoreFocus = false } = {}) {
    session?.controller.abort(); session = null;
    root.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.disabled && !disposed) trigger.focus();
  }
  function renderSkills(next) {
    records = structuredClone(next);
    loaded = true; presentationKey = presentation();
    const focusedId = document.activeElement?.dataset?.skillId;
    const focusedImport = list.contains(document.activeElement) && document.activeElement?.dataset?.menuAction === 'skills';
    list.replaceChildren();
    if (!records.length) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.menuAction = 'skills'; button.setAttribute('role', 'menuitem');
      button.innerHTML = `${icon('plus')}<span class="add-menu-name">导入 Skill</span><span class="add-menu-description">添加常用工作指南</span>`;
      list.append(button);
      if (focusedImport) button.focus();
      return;
    }
    for (const record of records) {
      const parsed = parseSkillMarkdown(record.raw, { fileName: record.sourceFileName });
      const supported = parsed.compatibility.status === 'compatible';
      const blocked = supported ? getSkillBlockReason() : '';
      const selected = getSelectedSkillId() === record.id;
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.skillId = record.id; button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-disabled', String(Boolean(blocked)));
      button.title = blocked || (supported ? parsed.description : '查看未满足的依赖');
      const glyph = document.createElement('span'); glyph.className = 'add-menu-skill-icon'; glyph.innerHTML = icon('sparkles');
      const name = document.createElement('span'); name.className = 'add-menu-name'; name.textContent = parsed.name;
      const description = document.createElement('span'); description.className = 'add-menu-description';
      description.textContent = supported ? parsed.description : '需适配 · 查看原因';
      button.append(glyph, name, description);
      if (selected) { const mark = document.createElement('span'); mark.className = 'add-menu-selected'; mark.textContent = '已选'; button.append(mark); }
      list.append(button);
      if (focusedId === record.id) button.focus();
    }
  }
  async function open({ last = false } = {}) {
    if (disposed || trigger.disabled) return;
    close();
    const controller = new AbortController();
    const token = session = { controller, signal: controller.signal, contextKey: getContextKey() };
    records = []; loaded = false;
    root.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    list.textContent = '读取技能…';
    const initialFocus = last ? items().at(-1) : items()[0];
    initialFocus?.focus();
    try {
      const snapshot = await store.list({ signal: token.signal });
      if (current(token)) {
        const keepLast = last && document.activeElement === initialFocus;
        renderSkills(snapshot.records);
        if (keepLast) items().at(-1)?.focus();
      }
    } catch (error) {
      if (current(token)) list.textContent = '暂时无法读取技能，请打开技能库重试。';
    }
  }
  function sync() {
    if (!session) return;
    if (!current(session) || trigger.disabled) { close(); return; }
    if (loaded && presentationKey !== presentation()) renderSkills(records);
  }
  const toggle = () => { if (root.hidden) void open(); else close({ restoreFocus: true }); };
  const beforeAction = event => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button)) return;
    if (!session || !current(session)) {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    }
  };
  const click = event => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button) || button.disabled) return;
    if (!session || !current(session)) { close(); return; }
    const record = records.find(item => item.id === button.dataset.skillId);
    if (record) {
      const parsed = parseSkillMarkdown(record.raw, { fileName: record.sourceFileName });
      if (parsed.compatibility.status !== 'compatible') { close(); onOpenSkills({ recordId: record.id }); return; }
      const blocked = getSkillBlockReason();
      if (blocked) { onNotice(blocked, 'info'); return; }
      try { onApplySkill(structuredClone(record)); close(); }
      catch (error) { onNotice(error.message || '无法选用此技能。', 'error'); }
      return;
    }
    if (button.dataset.menuAction === 'skills') { close(); onOpenSkills(); return; }
    // Existing input and Agent listeners execute the selected action.
    close();
  };
  const keydown = event => {
    if (root.hidden) {
      if (event.target === trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); void open({ last: event.key === 'ArrowUp' }); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ restoreFocus: true }); return; }
    if (event.key === 'Tab') { close({ restoreFocus: true }); return; }
    if (!root.contains(event.target) && event.target !== trigger) return;
    const choices = items(), index = choices.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % choices.length;
    if (event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = choices.length - 1;
    if (next !== undefined) { event.preventDefault(); choices[next]?.focus(); }
  };
  const outside = event => { if (!root.contains(event.target) && !trigger.contains(event.target)) close(); };
  trigger.addEventListener('click', toggle);
  root.addEventListener('click', beforeAction, true);
  root.addEventListener('click', click);
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', outside);
  const unsubscribe = store.subscribe?.(snapshot => { if (session && current(session)) renderSkills(snapshot.records); });
  return Object.freeze({ open, close, sync,
    dispose() {
      if (disposed) return;
      close(); disposed = true; unsubscribe?.();
      trigger.removeEventListener('click', toggle); root.removeEventListener('click', beforeAction, true); root.removeEventListener('click', click);
      document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', outside);
    },
  });
}
