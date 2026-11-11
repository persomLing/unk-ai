import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { createPastedTextDraft } from '../src/sidepanel/features/messages/pasted-text-draft.js';
import { createMessageRewind } from '../src/sidepanel/features/messages/message-rewind.js';
import { requestMessagesFor } from '../src/utils/context.js';
import { awaitWithAbort } from '../src/utils/abortable.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await tick();
  }
}
const sendOptions = () => ({ pageContextEnabled: false, directModelRequest: true, pageTargetPromise: Promise.resolve(null) });
const block = label => `${label}\n${'保留全文和代码缩进 '.repeat(140)}\n\tconst result = '<not-html>';\n${label}-END`;

class Element extends EventTarget {
  constructor(document, tag) { super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map(); this.value = ''; this.selectionStart = this.selectionEnd = 0; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  focus() { this.ownerDocument.activeElement = this; }
}

/** Real service, runner, repository and request projection. Only browser/storage
 * and model completion are controlled ports. The two draft event adapters match
 * the production presenter's public contract, without extracting its source. */
function runtime(t, ports = {}) {
  const starts = [], gates = [], saves = [];
  const state = ports.state || { conversation: { id: 'pasted-lifecycle', title: 'Long text', messages: [] } };
  const fixture = createConversationServiceFixture({ state,
    saveCurrent: async ({ conversation }) => saves.push(structuredClone(conversation)),
    generateReply: async (assistant, run) => {
      const gate = deferred(); gates.push(gate);
      const user = fixture.repository.get(run.ref).user;
      starts.push({ assistantId: assistant.id, userId: user.id, user: structuredClone(user),
        request: requestMessagesFor(state.conversation, assistant.id, null) });
      return awaitWithAbort(gate.promise, run.signal);
    }, ...ports });
  const document = { createElement(tag) { return new Element(document, tag); } };
  const input = document.createElement('textarea'), container = document.createElement('div');
  const composer = createPastedTextDraft({ input, container, getScope: () => state.conversation?.id,
    onChange: value => { state.draft = value; } });
  fixture.subscribe(event => { if (event.type === 'draft') composer.setValue(state.draft || ''); });
  function paste(text) {
    const event = new Event('paste', { cancelable: true });
    Object.assign(event, { clipboardData: { files: [], getData: type => type === 'text/plain' ? text : '' } });
    assert.equal(composer.handlePaste(event), true);
    assert.equal(event.defaultPrevented, true);
  }
  function type(text) {
    const start = input.selectionStart, end = input.selectionEnd;
    const before = new Event('beforeinput');
    Object.assign(before, { inputType: 'insertText' });
    input.dispatchEvent(before);
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.setSelectionRange(start + text.length, start + text.length);
    composer.handleInput();
  }
  const send = () => fixture.sendMessage(composer.getValue(), sendOptions());
  t.after(() => { for (const gate of gates) gate.resolve('Cleanup answer'); fixture.dispose(); composer.dispose(); });
  return { fixture, state, starts, gates, saves, input, container, composer, paste, type, send };
}

test('folded text reaches one ordinary user message and one model request, while the draft event clears its cards', async t => {
  const value = runtime(t), { fixture, state, composer, container, input, starts, gates, saves } = value;
  const first = block('FIRST'), second = block('SECOND');
  value.type('请核对：\n');
  value.paste(first);
  value.type('\n再核对：\n');
  value.paste(second);
  value.type('\n请按以上顺序回答。');
  const canonical = `请核对：\n${first}\n再核对：\n${second}\n请按以上顺序回答。`;
  assert.equal(state.draft, canonical);
  assert.equal(composer.getValue(), canonical);
  assert.equal(input.value.includes(first), false, 'large payload is not duplicated in the visible textarea');
  assert.equal(container.children.length, 2);
  const sending = value.send();
  await fixture.sendMessage(canonical, sendOptions());
  assert.equal(state.draft, '');
  assert.equal(input.value, '');
  assert.equal(container.hidden, true);
  await until(() => starts.length === 1, 'first pasted prompt never reached the model');
  assert.equal(starts[0].user.content, canonical);
  assert.equal(starts[0].user.displayContent, canonical);
  assert.equal(starts[0].user.attachments?.length || 0, 0, 'folding must not turn instructions into a document attachment');
  assert.equal(starts[0].request.at(-1).content, canonical);
  assert.equal(starts[0].request.at(-1).role, 'user');
  assert.equal(state.messageQueue.length, 0, 'the duplicate submit must not create a queued copy');
  assert.equal(saves[0].messages.find(message => message.role === 'user').content, canonical);
  gates[0].resolve('Answer');
  await sending;
  assert.equal(state.conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(state.conversation.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(state.conversation.messages.at(-1).status, 'complete');
});

test('new cards cannot mutate a running prompt or queue snapshot, and queued dispatch preserves the next unsent card', async t => {
  const value = runtime(t), { state, starts, gates, composer, container } = value;
  const original = block('ORIGINAL'), queued = block('QUEUED'), next = block('NEXT-DRAFT');
  value.paste(original);
  const first = value.send();
  await until(() => starts.length === 1, 'first turn did not start');
  value.paste(queued);
  value.type('\n排队补充');
  const queuedCanonical = queued + '\n排队补充';
  await value.send();
  assert.equal(state.messageQueue.length, 1);
  assert.equal(state.messageQueue[0].content, queuedCanonical);
  assert.equal(container.hidden, true);
  value.paste(next);
  const nextCanonical = composer.getValue();
  assert.equal(starts[0].user.content, original);
  assert.equal(state.conversation.messages.find(message => message.id === starts[0].userId).content, original);
  assert.equal(state.messageQueue[0].content, queuedCanonical);
  gates[0].resolve('First answer');
  await first;
  await until(() => starts.length === 2, 'queued folded text did not start automatically');
  assert.equal(starts[1].user.content, queuedCanonical);
  assert.equal(starts[1].request.at(-1).content, queuedCanonical);
  assert.equal(state.draft, nextCanonical);
  assert.equal(composer.getValue(), nextCanonical);
  assert.equal(container.children.length, 1, 'fromQueue draft events must not unfold or drop the next card');
  gates[1].resolve('Second answer');
  await until(() => !state.isSubmitting && !state.generatingId, 'queued reply did not finish');
  assert.deepEqual(state.conversation.messages.filter(message => message.role === 'user').map(message => message.content), [original, queuedCanonical]);
  assert.equal(composer.getValue(), nextCanonical);
});

test('configuration failure restores both complete submitted text and a new draft, without leaving optimistic duplicates', async t => {
  const configuration = deferred();
  let calls = 0;
  const value = runtime(t, { ensureConfigured: () => ++calls === 1 ? configuration.promise : true });
  const { fixture, state, composer, container, input, starts, gates } = value;
  const original = block('FAILED-PREPARATION'), newer = block('NEW-DRAFT');
  value.paste(original);
  const sending = value.send();
  await until(() => state.isSubmitting && state.conversation.messages.length === 2, 'optimistic prompt did not appear');
  value.paste(newer);
  configuration.resolve(false);
  await sending;
  const restored = newer + '\n\n' + original;
  assert.equal(fixture.modelRequests.length, 0);
  assert.equal(state.conversation.messages.length, 0);
  assert.equal(state.draft, restored);
  assert.equal(composer.getValue(), restored);
  assert.equal(input.value, restored, 'external restore keeps the full editable text');
  assert.equal(container.hidden, true);
  const retry = value.send();
  await until(() => starts.length === 1, 'restored draft did not send');
  assert.equal(starts[0].user.content, restored);
  assert.equal(starts[0].request.at(-1).content, restored);
  gates[0].resolve('Restored answer');
  await retry;
  assert.equal(state.conversation.messages.filter(message => message.role === 'user').length, 1);
});

test('creating a first conversation during preparation does not clear a newer hidden card', async t => {
  const creation = deferred();
  const state = { conversation: null };
  const value = runtime(t, { state, ensureConversation: async () => {
    await creation.promise;
    return state.conversation ||= { id: 'created-after-paste', title: 'New', messages: [] };
  } });
  const original = block('FIRST-TURN'), newer = block('DRAFT-DURING-CREATION');
  value.paste(original);
  const sending = value.send();
  value.paste(newer);
  assert.equal(value.composer.getValue(), newer);
  creation.resolve();
  await until(() => value.starts.length === 1, 'first conversation did not finish preparing');
  assert.equal(value.starts[0].user.content, original);
  assert.equal(value.composer.getValue(), newer);
  assert.equal(value.container.children.length, 1);
  value.gates[0].resolve('Created answer');
  await sending;
  assert.equal(value.composer.getValue(), newer);
});

test('regeneration and rewind keep the original complete prompt independent of new cards', async t => {
  const value = runtime(t), { fixture, state, starts, gates, composer, container } = value;
  const original = block('RETRY-ORIGINAL'), newer = block('UNSENT-NEXT');
  value.paste(original);
  const first = value.send();
  await until(() => starts.length === 1, 'first model request missing');
  gates[0].resolve('Initial answer');
  await first;
  const userId = starts[0].userId, oldAssistantId = starts[0].assistantId;
  value.paste(newer);
  const retry = fixture.regenerate(oldAssistantId);
  await until(() => starts.length === 2, 'regeneration did not start');
  assert.equal(starts[1].userId, userId);
  assert.notEqual(starts[1].assistantId, oldAssistantId);
  assert.equal(starts[1].user.content, original);
  assert.equal(starts[1].request.at(-1).content, original);
  assert.equal(composer.getValue(), newer);
  assert.equal(container.children.length, 1);
  gates[1].resolve('Regenerated answer');
  await retry;
  assert.equal(state.conversation.messages.filter(message => message.role === 'user').length, 1);
  const rewind = createMessageRewind({ getConversation: () => state.conversation,
    applyDraft: draft => { composer.setValue(draft.text); state.draft = composer.getValue(); },
    saveConversation: async () => {} });
  assert.deepEqual(await rewind.rewind(userId), { ok: true, current: true });
  assert.equal(state.draft, original);
  assert.equal(composer.getValue(), original);
  assert.equal(container.hidden, true, 'rewind replaces the unsent card with the exact editable original');
  assert.equal(state.conversation.messages.length, 0);
});

test('stopping a gated reply allows a new full card to send and late completion cannot change that turn', async t => {
  const value = runtime(t), { fixture, state, starts, gates } = value;
  const original = block('STOPPED'), newer = block('AFTER-STOP');
  value.paste(original);
  const first = value.send();
  await until(() => starts.length === 1, 'first gated request missing');
  fixture.stopActiveReply();
  await first;
  value.paste(newer);
  const second = value.send();
  await until(() => starts.length === 2, 'new card could not send after stopping');
  gates[0].resolve('Late old answer');
  await tick();
  assert.equal(starts[1].user.content, newer);
  assert.equal(state.conversation.messages.find(message => message.id === starts[0].assistantId).status, 'stopped');
  assert.equal(state.conversation.messages.find(message => message.id === starts[1].assistantId).content, '');
  gates[1].resolve('Current answer');
  await second;
  assert.deepEqual(state.conversation.messages.filter(message => message.role === 'user').map(message => message.content), [original, newer]);
  assert.equal(state.conversation.messages.at(-1).content, 'Current answer');
  assert.equal(state.conversation.messages.filter(message => message.content === 'Late old answer').length, 0);
});
