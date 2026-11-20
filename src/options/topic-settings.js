import { icon } from '../sidepanel/icons.js';
import { decodeWelcomeTopics, loadWelcomeTopics, saveWelcomeTopic, TOPIC_LIMITS, WELCOME_TOPICS_KEY } from '../sidepanel/features/welcome/topic-preferences.js';

export function installTopicSettings({ root, storage, storageChanges }) {
  const doc = root.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  const list = root.querySelector('#topics-list');
  const add = root.querySelector('#topics-add');
  const editor = root.querySelector('#topics-editor');
  const fields = editor.querySelector('fieldset');
  const remove = root.querySelector('#topics-remove');
  const status = root.querySelector('#topics-status');
  const { title, subtitle, prompt } = editor.elements;
  for (const key of ['title', 'subtitle', 'prompt']) editor.elements[key].maxLength = TOPIC_LIMITS[key];
  let topics = null;
  let previous = null;
  let editorId;
  let saving = false;
  let storageRevision = 0;

  function announce(message, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }

  function render() {
    const editing = !editor.hidden;
    fields.disabled = saving;
    add.disabled = !topics || editing || topics.length >= TOPIC_LIMITS.count;
    const focusId = doc.activeElement?.dataset.editTopic;
    list.replaceChildren();
    if (!topics) return;
    for (const topic of topics) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'topic-settings-row';
      button.dataset.editTopic = topic.id;
      button.disabled = editing;
      const copy = doc.createElement('span');
      const heading = doc.createElement('strong');
      heading.textContent = topic.title;
      copy.append(heading);
      if (topic.subtitle) {
        const detail = doc.createElement('small');
        detail.textContent = topic.subtitle;
        copy.append(detail);
      }
      const edit = doc.createElement('span');
      edit.innerHTML = icon('pencil');
      button.append(copy, edit);
      list.append(button);
      if (topic.id === focusId && !editing) button.focus({ preventScroll: true });
    }
    if (!topics.length && !editing) list.textContent = '还没有话题。';
  }

  function openEditor(topic = null) {
    previous = topic;
    editorId = topic?.id || `topic-${crypto.randomUUID()}`;
    title.value = topic?.title || '';
    subtitle.value = topic?.subtitle || '';
    prompt.value = topic?.prompt || '';
    remove.hidden = !topic;
    editor.hidden = false;
    announce('');
    render();
    title.focus();
  }

  function closeEditor(id) {
    editor.hidden = true;
    previous = null;
    render();
    ([...list.children].find(button => button.dataset.editTopic === id) || add).focus({ preventScroll: true });
  }

  async function save(deleting = false) {
    if (saving || !topics || editor.hidden) return;
    const next = deleting ? null : { id: editorId, title: title.value, subtitle: subtitle.value, prompt: prompt.value };
    saving = true;
    fields.disabled = true;
    announce('正在保存话题…');
    const revision = storageRevision;
    try {
      const saved = await saveWelcomeTopic({ storage, previous, next, signal });
      if (signal.aborted) return;
      if (revision === storageRevision) topics = saved;
      saving = false;
      closeEditor(next?.id);
      announce(deleting ? '话题已删除。' : '话题已保存。');
    } catch (error) {
      if (signal.aborted) return;
      announce(error.name === 'TimeoutError' ? '话题保存尚未确认，请检查列表后再试。' : error.message || '话题保存失败。', true);
    } finally {
      saving = false;
      if (!signal.aborted) fields.disabled = false;
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !Object.hasOwn(changes, WELCOME_TOPICS_KEY) || signal.aborted) return;
    storageRevision += 1;
    try { topics = decodeWelcomeTopics(changes[WELCOME_TOPICS_KEY].newValue); }
    catch (error) { topics = null; announce(error.message, true); }
    render();
  }

  add.addEventListener('click', () => openEditor(), { signal });
  list.addEventListener('click', event => {
    const id = event.target.closest('[data-edit-topic]')?.dataset.editTopic;
    const topic = topics?.find(item => item.id === id);
    if (topic && editor.hidden) openEditor(topic);
  }, { signal });
  editor.addEventListener('submit', event => { event.preventDefault(); void save(); }, { signal });
  root.querySelector('#topics-cancel').addEventListener('click', () => { closeEditor(previous?.id); announce(''); }, { signal });
  remove.addEventListener('click', () => { if (previous) void save(true); }, { signal });
  storageChanges.addListener(onStorageChanged);
  void loadWelcomeTopics(storage, signal).then(value => {
    if (signal.aborted || storageRevision) return;
    topics = value;
    render();
  }).catch(error => {
    if (!signal.aborted && !storageRevision) announce(error.message || '无法读取话题灵感。', true);
  });

  return { dispose() { controller.abort(); storageChanges.removeListener(onStorageChanged); } };
}
