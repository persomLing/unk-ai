import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const image = () => ({ id: 'reference', type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=', capture: { version: 1, tabId: 1, url: 'https://page.test', documentId: 'fixture-document', capturedAt: '2026-11-02', image: { width: 800, height: 600 } } });

test('Agent submission saves its image and forwards the captured profile and image once', async t => {
  const save = deferred();
  const calls = [];
  const attachment = image();
  const value = createConversationServiceFixture({ state: { attachments: [attachment] }, saveCurrent: () => save.promise,
    profileFor: () => ({ model: 'fixed-vision', supportsVision: true }),
    agentSlot: { isMode: () => true, start: async (goal, options) => { calls.push({ goal, options }); return true; } } });
  t.after(() => { save.resolve(); value.dispose(); });
  const sending = value.sendMessage('读取框选列表');
  await tick();
  assert.equal(value.state.conversation.messages[0].attachments?.[0].dataUrl, attachment.dataUrl);
  value.state.attachments = [structuredClone(attachment)];
  await value.sendMessage('读取框选列表');
  attachment.capture.documentId = 'mutated-after-submit';
  save.resolve();
  await sending;
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.referenceImages[0].capture.documentId, 'fixture-document');
  assert.equal(calls[0].options.profile.model, 'fixed-vision');
  assert.equal(value.modelRequests.length, 0);
  value.dispose();
});

test('cancelled image submission never starts Agent after its required save completes', async t => {
  const save = deferred();
  let starts = 0;
  const value = createConversationServiceFixture({ state: { attachments: [image()] }, saveCurrent: () => save.promise,
    profileFor: () => ({ model: 'vision', supportsVision: true }),
    agentSlot: { isMode: () => true, start: async () => { starts++; return true; } } });
  t.after(() => { save.resolve(); value.dispose(); });
  const sending = value.sendMessage('停止后不发图');
  await tick();
  value.stopActiveReply();
  save.resolve();
  await sending;
  await tick();
  assert.equal(starts, 0);
  assert.equal(value.modelRequests.length, 0);
  value.dispose();
});
