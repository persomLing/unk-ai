import test from 'node:test';
import assert from 'node:assert/strict';
import * as attachments from '../src/utils/attachments.js';
import { requestMessagesFor, contextUsageFor } from '../src/utils/context.js';
import { renderAttachmentList } from '../src/sidepanel/features/attachments/attachments-slot.js';
import { createConversationServiceFixture } from './helpers/conversation-service-fixture.js';
import { createExportSnapshot, exportSelectionIssue } from '../src/sidepanel/features/export/export-model.js';

const png = 'data:image/png;base64,aGVsbG8=';
const missing = () => ({ id: 'reference', type: 'image', name: 'reference.png', imageStorageVersion: 1,
  imagePath: `images/${'a'.repeat(64)}.png`, loadError: '原图片文件缺失，请重新添加。' });
const question = files => ({ id: 'question', role: 'user', status: 'complete', content: '根据这张原图片回答', attachments: files });

test('image availability keeps legacy and hydrated images usable while reporting missing paths', () => {
  const valid = [{ id: 'legacy', type: 'image', name: 'legacy.png', dataUrl: png }, { ...missing(), dataUrl: png }];
  assert.doesNotThrow(() => attachments.assertImageAttachmentsAvailable(valid));
  assert.equal(attachments.imageAttachmentLoadError(valid[1]), '', 'restored cache bytes take precedence over stale load errors');
  const image = missing();
  assert.throws(() => attachments.assertImageAttachmentsAvailable([image]), error => error.code === 'ERR_IMAGE_ATTACHMENT_UNAVAILABLE'
    && error.message.includes('reference.png') && error.message.includes(image.loadError));
  assert.equal(Object.hasOwn(image, 'dataUrl'), false, 'validation cannot manufacture pixels');
  assert.throws(() => attachments.assertImageAttachmentsAvailable([{ ...missing(), dataUrl: 'images/reference.png' }]),
    /reference\.png.*原图片文件缺失/, 'a relative disk path cannot substitute for hydrated pixels');
  assert.throws(() => attachments.assertImageAttachmentsAvailable([{ type: 'image', name: 'empty.png' }]),
    /empty\.png.*重新添加/, 'old incomplete image records get an actionable fallback');
  assert.doesNotThrow(() => attachments.assertImageAttachmentsAvailable([{ type: 'document', text: 'A local text document' }]));
});

test('actual requests reject the required missing image, while unrelated historical images and estimates remain usable', () => {
  const conversation = { id: 'chat', messages: [question([missing()])] };
  assert.throws(() => requestMessagesFor(conversation), /reference\.png.*原图片文件缺失/);
  assert.doesNotThrow(() => contextUsageFor(conversation, undefined, null, 32000));
  const history = { messages: [question([missing()]), { id: 'old-answer', role: 'assistant', status: 'complete', content: 'Old answer' },
    { id: 'new-question', role: 'user', status: 'complete', content: '现在仅解释文字' }] };
  assert.doesNotThrow(() => requestMessagesFor(history));
  assert.doesNotThrow(() => requestMessagesFor({ messages: [{ ...question([missing()]), includeVisual: false }] }));
  const restored = requestMessagesFor({ messages: [question([{ ...missing(), dataUrl: png }])] });
  const images = restored.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
  assert.equal(images.length, 1);
  assert.equal(images[0].image_url.url, png);
});

test('draft attachment rendering exposes a missing-file explanation and never treats a local path as an image URL', () => {
  const originalDocument = globalThis.document;
  const list = { hidden: true, innerHTML: '' }, button = { disabled: true };
  globalThis.document = { querySelector: selector => selector === '#attachment-list' ? list : selector === '#attach-button' ? button : null };
  try {
    renderAttachmentList([{ ...missing(), loadError: '图片不存在 <img src=x onerror="steal()">' }]);
    assert.equal(list.hidden, false);
    assert.match(list.innerHTML, /图片不存在/);
    assert.match(list.innerHTML, /&lt;img/);
    assert.doesNotMatch(list.innerHTML, /<img\b/);
    assert.doesNotMatch(list.innerHTML, /src="images\//);
    assert.match(list.innerHTML, /移除附件 reference\.png/);
  } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
});

for (const mode of ['draft', 'queue', 'agent']) {
  test(`a missing ${mode} image is rejected before page/model work and leaves submitted inputs intact`, async () => {
    let pageCalls = 0, agentCalls = 0;
    const image = missing(), options = mode === 'queue' ? { fromQueue: true, attachments: [image], selection: null } : mode === 'agent' ? { agentTask: true } : {};
    const fixture = createConversationServiceFixture({ state: { attachments: mode === 'queue' ? [] : [image], draft: '保留这条提问' },
      browser: { queryActiveTab: async () => { pageCalls++; return { id: 7, url: 'https://page.test' }; }, sendMessage: async () => { pageCalls++; return null; } },
      agentSlot: { start: async () => { agentCalls++; return true; } } });
    await fixture.sendMessage('保留这条提问', options);
    assert.equal(pageCalls, 0);
    assert.equal(agentCalls, 0);
    assert.equal(fixture.modelRequests.length, 0);
    assert.equal(fixture.state.conversation.messages.length, 0);
    assert.equal(fixture.input.value, '保留这条提问');
    assert.deepEqual(mode === 'queue' ? options.attachments : fixture.state.attachments, [image]);
    assert.match(fixture.notices.join('\n'), /reference\.png.*原图片文件缺失/);
  });
}

test('only selected missing question images block export, and excluding questions still permits text export', () => {
  const snapshot = createExportSnapshot({ id: 'export', messages: [question([missing()]),
    { id: 'answer', role: 'assistant', status: 'complete', content: '第一轮回答' },
    { id: 'text-question', role: 'user', content: '只解释文字' }, { id: 'text-answer', role: 'assistant', status: 'complete', content: '第二轮回答' }] });
  assert.equal(snapshot.turns[0].user.attachments[0].imagePath, missing().imagePath);
  assert.equal(snapshot.turns[0].user.attachments[0].loadError, missing().loadError);
  assert.match(exportSelectionIssue(snapshot, ['turn-1']), /reference\.png.*原图片文件缺失/);
  assert.equal(exportSelectionIssue(snapshot, ['turn-1'], { includeQuestions: false }), '');
  assert.equal(exportSelectionIssue(snapshot, ['turn-2']), '');
  const hydrated = createExportSnapshot({ id: 'restored-export', messages: [question([{ ...missing(), dataUrl: png }])] });
  assert.equal(exportSelectionIssue(hydrated, ['turn-1']), '', 'restored cache bytes permit exporting the original question');
  assert.equal(hydrated.turns[0].user.attachments[0].dataUrl, png);
});
