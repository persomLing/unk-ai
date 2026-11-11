import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePageTarget } from '../src/sidepanel/features/page-reading/page-target-capture.js';

test('submission identity is captured without requesting page body or directory', async () => {
  const messages = [];
  const target = await capturePageTarget({ queryActiveTab: async () => ({ id: 7, url: 'https://docs.test/#/one' }),
    sendMessage: async message => { messages.push(message); return { tabId: 7, url: message.expectedUrl, documentId: 'at-click' }; } });
  assert.equal(target.documentId, 'at-click');
  assert.deepEqual(messages.map(item => item.type), ['CAPTURE_PAGE_TARGET']);
});

test('page-off submission does not execute any page script', async () => {
  const target = await capturePageTarget({ bindDocument: false,
    queryActiveTab: async () => ({ id: 7, url: 'https://docs.test/' }), sendMessage: () => { throw new Error('must not run'); } });
  assert.equal(target.documentId, undefined);
});

test('navigation during capture fails instead of binding another route', async () => {
  await assert.rejects(capturePageTarget({ queryActiveTab: async () => ({ id: 7, url: 'https://docs.test/#/one' }),
    sendMessage: async () => ({ tabId: 7, url: 'https://docs.test/#/two', documentId: 'new' }) }), { code: 'PAGE_CHANGED' });
});
