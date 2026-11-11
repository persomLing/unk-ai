import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionChatSessions } from '../src/sidepanel/features/messages/selection-chat-sessions.js';

const selection = (overrides = {}) => ({ source: 'conversation', sourceVersion: 1, conversationId: 'main-a',
  messageId: 'answer-1', role: 'assistant', text: 'metadata 是附带的键值对', context: 'metadata 用于筛选和引用来源。',
  question: 'metadata 是什么？', title: 'RAG 说明', selectedAt: '2026-11-11T02:00:00Z', ...overrides });
const anchor = { left: 20, top: 100, width: 90, height: 20 };

function fixture(t, options = {}) {
  let currentId = 'main-a';
  const created = [];
  const manager = createSelectionChatSessions({
    getConversationId: () => options.getConversationId ? options.getConversationId() : currentId,
    createChat: (quote, rect) => {
      if (options.createChat) return options.createChat(quote, rect);
      const chat = {
        selection: quote, rect, accepts: [], trackingUpdates: [], closeCalls: 0,
        acceptSelection(next, nextRect) {
          this.accepts.push({ selection: next, rect: nextRect });
          if (this.acceptError) throw this.acceptError;
          if (this.acceptResult != null) return this.acceptResult;
          this.selection = next;
          return { accepted: true };
        },
        setTracking(value, notice) {
          this.trackingUpdates.push({ value, notice });
          this.onTrackingUpdate?.(value, notice);
        },
        close() { this.closeCalls += 1; manager.forget(this); },
      };
      created.push(chat);
      return chat;
    },
  });
  t.after(() => manager.dispose());
  return { manager, created, setCurrent: id => { currentId = id; },
    open: overrides => manager.open(selection(overrides), anchor) };
}

test('later selections in the same main conversation reuse its first follow-up and preserve quote context', t => {
  const fx = fixture(t);
  const original = selection();
  const first = fx.manager.open(original, anchor);
  assert.deepEqual(first, { chat: fx.created[0], reused: false, accepted: true });
  assert.equal(first.chat.rect, anchor);
  original.text = '后来改变的外部输入';
  assert.equal(first.chat.selection.text, 'metadata 是附带的键值对', 'the window receives an independent bounded source');
  const later = fx.open({ messageId: 'answer-2', text: 'embedding 是向量表示', context: '向量用于语义检索。' });
  assert.deepEqual(later, { chat: first.chat, reused: true, accepted: true });
  assert.equal(fx.created.length, 1);
  assert.equal(first.chat.accepts.length, 1);
  assert.equal(first.chat.accepts[0].selection.messageId, 'answer-2');
  assert.equal(first.chat.accepts[0].selection.context, '向量用于语义检索。');
  assert.equal(first.chat.accepts[0].rect, anchor);
  fx.manager.syncConversation('main-a');
  assert.deepEqual(first.chat.trackingUpdates, []);
});

test('switching or creating a main conversation detaches the old window and the next selection starts a new one', t => {
  for (const currentId of ['main-b', 'new-empty-main', null]) {
    const fx = fixture(t);
    const previous = fx.open().chat;
    fx.setCurrent(currentId);
    assert.deepEqual(fx.manager.syncConversation(currentId), { released: true, chat: previous });
    assert.deepEqual(previous.trackingUpdates, [{ value: false, notice: '已切换主对话；新的选区将另开追问。' }]);
    assert.equal(previous.closeCalls, 0, 'detaching preserves the independent follow-up window');
    fx.manager.syncConversation(currentId);
    assert.equal(previous.trackingUpdates.length, 1, 'the detach notice is issued once');
    fx.setCurrent('main-b');
    const next = fx.open({ conversationId: 'main-b' });
    assert.equal(next.accepted, true);
    assert.equal(next.reused, false);
    assert.notEqual(next.chat, previous);
    assert.equal(fx.created.length, 2);
  }
});

test('returning to a previous main conversation never revives its detached tracking window', t => {
  const fx = fixture(t);
  const first = fx.open().chat;
  fx.setCurrent('main-b');
  fx.manager.syncConversation('main-b');
  fx.setCurrent('main-a');
  fx.manager.syncConversation('main-a');
  const returned = fx.open();
  assert.equal(returned.reused, false);
  assert.notEqual(returned.chat, first);
  assert.equal(first.accepts.length, 0);
  assert.equal(first.closeCalls, 0);
});

test('open notices a changed main conversation even when the caller has not synchronized yet', t => {
  const fx = fixture(t);
  const previous = fx.open().chat;
  fx.setCurrent('main-b');
  const next = fx.open({ conversationId: 'main-b' });
  assert.equal(next.reused, false);
  assert.notEqual(next.chat, previous);
  assert.equal(previous.trackingUpdates.length, 1);
});

test('closing the tracked follow-up permits a new one while late closes from old windows cannot clear it', t => {
  const fx = fixture(t);
  const first = fx.open().chat;
  assert.equal(fx.manager.forget(first), true);
  const second = fx.open().chat;
  assert.notEqual(second, first);
  assert.equal(fx.manager.forget(first), false);
  first.close();
  assert.equal(fx.open().chat, second);
  assert.equal(fx.created.length, 2);
  fx.setCurrent('main-b');
  fx.manager.syncConversation('main-b');
  const third = fx.open({ conversationId: 'main-b' }).chat;
  second.close();
  assert.equal(fx.open({ conversationId: 'main-b' }).chat, third);
  assert.equal(fx.created.length, 3);
});

test('a rejecting or failing tracked window never creates a competing follow-up', t => {
  const fx = fixture(t);
  const chat = fx.open().chat;
  for (const acceptResult of [false, { accepted: false }, { accepted: false, reason: 'transferring' }]) {
    chat.acceptResult = acceptResult;
    assert.deepEqual(fx.open(), { chat, reused: true, accepted: false,
      reason: acceptResult.reason || 'selection-rejected' });
    assert.equal(fx.created.length, 1);
  }
  chat.acceptError = new Error('view failed');
  assert.deepEqual(fx.open(), { chat, reused: true, accepted: false, reason: 'accept-failed' });
  assert.equal(fx.created.length, 1);
  chat.acceptError = null;
  chat.acceptResult = true;
  assert.deepEqual(fx.open(), { chat, reused: true, accepted: true });
});

test('invalid, future or foreign selections are refused without touching the tracked quote', t => {
  const fx = fixture(t);
  const chat = fx.open().chat;
  for (const quote of [null, {}, selection({ text: '' }), selection({ source: 'page' }),
    selection({ sourceVersion: 2 }), selection({ role: 'user' }),
    new Proxy({}, { get() { throw new Error('invalid imported selection'); } })]) {
    assert.deepEqual(fx.manager.open(quote, anchor), { chat: null, reused: false, accepted: false, reason: 'invalid-selection' });
  }
  assert.deepEqual(fx.open({ conversationId: 'main-b' }), {
    chat: null, reused: false, accepted: false, reason: 'source-mismatch' });
  assert.equal(fx.created.length, 1);
  assert.equal(chat.accepts.length, 0);
  assert.equal(fx.open().chat, chat);
});

test('missing source, getter errors and window factory failures return structured refusal and allow a later retry', t => {
  for (const current of [null, '', 3]) {
    const fx = fixture(t, { getConversationId: () => current });
    assert.deepEqual(fx.open(), { chat: null, reused: false, accepted: false, reason: 'conversation-unavailable' });
    assert.equal(fx.created.length, 0);
  }
  const unavailable = fixture(t, { getConversationId: () => { throw new Error('no current conversation'); } });
  assert.equal(unavailable.open().reason, 'conversation-unavailable');
  let factoryResult = new Error('mount failed');
  const failing = fixture(t, { createChat: () => {
    if (factoryResult instanceof Error) throw factoryResult;
    return factoryResult;
  } });
  assert.equal(failing.open().reason, 'create-failed');
  for (const value of [null, {}, { acceptSelection() {} }, { setTracking() {} }]) {
    factoryResult = value;
    assert.equal(failing.open().reason, 'invalid-chat');
  }
  factoryResult = { acceptSelection: () => true, setTracking() {} };
  assert.deepEqual(failing.open(), { chat: factoryResult, reused: false, accepted: true });
});

test('detachment relinquishes ownership before view callbacks and remains final if a notice fails', t => {
  const fx = fixture(t);
  const first = fx.open().chat;
  let next;
  first.onTrackingUpdate = () => {
    next = fx.open({ conversationId: 'main-b' }).chat;
    first.close();
    throw new Error('notice rendering failed');
  };
  fx.setCurrent('main-b');
  assert.deepEqual(fx.manager.syncConversation('main-b'), { released: true, chat: first, reason: 'tracking-update-failed' });
  assert.ok(next);
  assert.equal(fx.open({ conversationId: 'main-b' }).chat, next);
  assert.equal(fx.created.length, 2);
});

test('disposal only releases manager state and refuses subsequent commands without closing independent windows', t => {
  const fx = fixture(t);
  const chat = fx.open().chat;
  fx.manager.dispose();
  fx.manager.dispose();
  assert.equal(chat.closeCalls, 0);
  assert.deepEqual(chat.trackingUpdates, []);
  assert.deepEqual(fx.open(), { chat: null, reused: false, accepted: false, reason: 'disposed' });
  assert.deepEqual(fx.manager.syncConversation('main-b'), { released: false, chat: null, reason: 'disposed' });
  assert.equal(fx.manager.forget(chat), false);
  assert.equal(fx.created.length, 1);
});
