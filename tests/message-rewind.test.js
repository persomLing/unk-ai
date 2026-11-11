import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageRewind } from '../src/sidepanel/features/messages/message-rewind.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const image = { id: 'reference', type: 'image', name: 'reference.png', mime: 'image/png',
  dataUrl: 'data:image/png;base64,aW1hZ2U=', width: 80, height: 100,
  capture: { version: 1, tabId: 7, url: 'https://site.test/a?full=1', documentId: 'doc-original', viewport: { width: 900, height: 600 } } };
const document = { id: 'notes', type: 'document', name: 'notes.txt', text: 'Document body', chars: 13 };
function fixture({ block = '', save, timeoutMs } = {}) {
  const question = { id: 'question', role: 'user', content: 'Question plus model-only context', displayContent: 'Original question',
    attachments: [structuredClone(image), structuredClone(document)], selection: { text: 'Original selected text', url: 'https://site.test/a?full=1', selectedAt: 'original' },
    requestSource: { scope: 'independent', topicId: 'ai', label: 'untrusted label', ignored: 'untrusted field' } };
  const previous = { id: 'previous', role: 'user', content: 'Previous prompt' };
  const state = { conversation: { id: 'original', storage: 'local', messages: [previous, { id: 'previous-answer', role: 'assistant' }, question,
    { id: 'answer', role: 'assistant' }, { id: 'later', role: 'user', content: 'Later prompt' }] },
    attachments: [{ id: 'unrelated-draft', type: 'image' }], pageSelection: { text: 'New unrelated selection' }, draft: 'Unrelated draft' };
  const saves = [], renders = [];
  const rewind = createMessageRewind({ getConversation: () => state.conversation, getBlockReason: () => block, timeoutMs,
    applyDraft: draft => { state.draft = draft.text; state.draftSource = draft.requestSource;
      if (Object.hasOwn(draft, 'attachments')) state.attachments = draft.attachments;
      if (Object.hasOwn(draft, 'selection')) state.pageSelection = draft.selection; },
    saveConversation: async conversation => { saves.push(structuredClone(conversation)); return save?.(conversation); },
    onChanged: conversation => renders.push(conversation.id),
  });
  return { state, question, saves, renders, rewind, block: reason => { block = reason; } };
}

test('rewinding restores the original images, documents and selection with complete capture identity', async () => {
  const value = fixture();
  assert.deepEqual(await value.rewind.rewind('question'), { ok: true, current: true });
  assert.equal(value.state.draft, 'Original question');
  assert.deepEqual(value.state.attachments, [image, document]);
  assert.deepEqual(value.state.pageSelection, value.question.selection);
  assert.deepEqual(value.state.draftSource, { scope: 'independent', topicId: 'ai', label: 'AI圈动态' });
  assert.deepEqual(value.saves[0].messages.map(message => message.id), ['previous', 'previous-answer']);
  value.state.attachments[0].capture.viewport.width = 1;
  value.state.attachments[1].text = 'Edited document draft';
  value.state.pageSelection.text = 'Edited selection';
  assert.equal(value.question.attachments[0].capture.viewport.width, 900);
  assert.equal(value.question.attachments[1].text, 'Document body');
  assert.equal(value.question.selection.text, 'Original selected text');
});

test('legacy text-only questions clear unrelated attachments and selection rather than combining drafts', async () => {
  const value = fixture();
  delete value.question.attachments;
  delete value.question.selection;
  delete value.question.displayContent;
  delete value.question.requestSource;
  assert.equal((await value.rewind.rewind('question')).ok, true);
  assert.equal(value.state.draft, 'Question plus model-only context');
  assert.deepEqual(value.state.attachments, []);
  assert.equal(value.state.pageSelection, null);
  assert.equal(value.state.draftSource, null);
});

test('busy generation, submission, compression, attachment preparation and Agent tasks block rewinding before mutation', async () => {
  for (const reason of ['正在生成中', '正在提交中', '正在压缩中', '正在准备附件', '浏览器任务仍在运行']) {
    const value = fixture({ block: reason });
    const before = structuredClone(value.state);
    assert.deepEqual(await value.rewind.rewind('question'), { ok: false, message: reason });
    assert.deepEqual(value.state, before);
    assert.equal(value.saves.length, 0);
    assert.equal(value.renders.length, 0);
  }
});

test('a save finishing after a conversation switch cannot replace new draft attachments or render the new conversation', async () => {
  const gate = deferred(), value = fixture({ save: () => gate.promise });
  const original = value.state.conversation;
  const pending = value.rewind.rewind('question');
  await Promise.resolve();
  assert.equal(value.saves[0].id, original.id);
  value.state.conversation = { id: 'new', messages: [{ id: 'new-question', role: 'user' }] };
  value.state.draft = 'New draft';
  value.state.attachments = [{ id: 'new-draft-image', type: 'image', dataUrl: 'data:image/png;base64,bmV3' }];
  const snapshot = structuredClone(value.state);
  gate.resolve();
  assert.deepEqual(await pending, { ok: true, current: false });
  assert.deepEqual(value.state, snapshot);
  assert.deepEqual(value.renders, ['original']);
  assert.deepEqual(original.messages.map(message => message.id), ['previous', 'previous-answer']);
});

test('a second rewind while the first save is pending cannot truncate again or change the restored draft', async () => {
  const gate = deferred(), value = fixture({ save: () => gate.promise });
  const pending = value.rewind.rewind('question');
  const snapshot = structuredClone(value.state);
  assert.deepEqual(await value.rewind.rewind('previous'), { ok: false, message: '正在保存回退，请稍后编辑。' });
  assert.deepEqual(value.state, snapshot);
  gate.resolve(); await pending;
  assert.equal(value.saves.length, 1);
});

test('a save failure keeps restored draft pixels available and reports failure without recreating removed messages', async () => {
  const value = fixture({ save: () => { throw new Error('Directory denied'); } });
  await assert.rejects(value.rewind.rewind('question'), /Directory denied/);
  assert.equal(value.state.attachments[0].dataUrl, image.dataUrl);
  assert.equal(value.state.draft, 'Original question');
  assert.deepEqual(value.state.conversation.messages.map(message => message.id), ['previous', 'previous-answer']);
  assert.deepEqual(value.renders, ['original']);
});

test('a hanging save is bounded and its late completion cannot mutate another conversation', async () => {
  const gate = deferred(), value = fixture({ save: () => gate.promise, timeoutMs: 10 });
  const pending = value.rewind.rewind('question');
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.equal(value.state.attachments[0].dataUrl, image.dataUrl);
  value.state.conversation = { id: 'new', messages: [] };
  value.state.attachments = [{ id: 'new-image' }];
  const snapshot = structuredClone(value.state);
  gate.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(value.state, snapshot);
  assert.deepEqual(value.renders, ['original']);
});

test('missing and assistant message IDs cannot rewind the timeline', async () => {
  for (const id of ['missing', 'answer']) {
    const value = fixture(), snapshot = structuredClone(value.state);
    assert.deepEqual(await value.rewind.rewind(id), { ok: false });
    assert.deepEqual(value.state, snapshot);
    assert.equal(value.saves.length, 0);
  }
});
