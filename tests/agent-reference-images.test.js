import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentReferenceImages, assertAgentReferenceTarget, assertAgentVision } from '../src/utils/agent-reference-images.js';
import { buildAgentMessages, fitAgentMessagesToBudget } from '../src/utils/agent-schema.js';

const image = { id: 'reference', type: 'image', name: '列表.png', dataUrl: 'data:image/png;base64,aGVsbG8=', width: 800, height: 600 };
const capture = { version: 1, tabId: 7, url: 'https://page.test/list?page=1#items', documentId: 'doc1', capturedAt: '2026-11-02T08:00:00Z', image: { width: 1600, height: 1200 }, viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 200 }, crop: { x: 100, y: 200, width: 800, height: 600, coordinateSpace: 'image' } };

test('agent references are bounded image copies with source and crop metadata', () => {
  const source = { ...image, capture, unexpectedAuthority: { approved: true } };
  const [copy] = normalizeAgentReferenceImages([source]);
  assert.equal(copy.dataUrl, image.dataUrl);
  assert.deepEqual(copy.capture, capture);
  assert.equal(copy.unexpectedAuthority, undefined);
  source.capture.crop.x = 120;
  assert.equal(copy.capture.crop.x, 100);
  source.capture.crop.x = 100;
  assert.throws(() => normalizeAgentReferenceImages([{ type: 'document', text: 'read me' }]), /图片/);
  assert.throws(() => normalizeAgentReferenceImages([{ ...image, dataUrl: 'https://external.test/image.png' }]), /图片/);
  assert.throws(() => normalizeAgentReferenceImages(Array(4).fill(image)), /3/);
  assert.throws(() => normalizeAgentReferenceImages([{ ...image, dataUrl: 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024) }]), /8 MB/);
});

test('captured references reject wrong tab, full URL or document; external pictures remain references', () => {
  const images = normalizeAgentReferenceImages([{ ...image, capture }]);
  assert.doesNotThrow(() => assertAgentReferenceTarget(images, { id: 7, url: capture.url, documentId: 'doc1' }));
  for (const target of [{ id: 8, url: capture.url, documentId: 'doc1' }, { id: 7, url: 'https://page.test/list?page=2#items', documentId: 'doc1' }, { id: 7, url: capture.url, documentId: 'doc2' }]) {
    assert.throws(() => assertAgentReferenceTarget(images, target), /截图|页面/);
  }
  assert.doesNotThrow(() => assertAgentReferenceTarget(normalizeAgentReferenceImages([image]), { id: 10, url: 'https://other.test/' }));
  assert.throws(() => assertAgentVision(images, { supportsVision: false }), /视觉|图片/);
  assert.doesNotThrow(() => assertAgentVision([], {}));
});

test('agent reference image reaches the request without replacing the text observation or losing its budget', () => {
  const messages = buildAgentMessages({ goal: '圈出的字段是什么', referenceImages: [{ ...image, capture }] });
  assert.equal(typeof messages[1].content, 'string');
  assert.match(messages[1].content, /圈出的字段/);
  const visual = messages.find(message => Array.isArray(message.content));
  assert.equal(visual.content.find(part => part.type === 'image_url').image_url.url, image.dataUrl);
  assert.match(visual.content.find(part => part.type === 'text').text, /参考|截图/);
  assert.match(visual.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), /doc1/);
  assert.deepEqual(fitAgentMessagesToBudget(messages, { contextLength: 128000 }), messages);
  assert.throws(() => fitAgentMessagesToBudget(messages, { contextLength: 512 }), /上下文/);
});
