import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentUploadRegistry, acceptsAgentUpload, validateAgentUploadPayload } from '../src/utils/agent-upload.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZgAAAABJRU5ErkJggg==';
const image = overrides => ({ type: 'image', name: 'reference.png', dataUrl: `data:image/png;base64,${png}`, ...overrides });
const identity = overrides => ({ taskId: 'task-1', epoch: 1, tabId: 7, url: 'https://example.test/start', ...overrides });
const target = overrides => ({ ...identity(), url: 'https://example.test/upload', frameUrl: 'https://example.test/upload',
  frameOrigin: 'https://example.test', frameId: 0, documentId: 'doc-1', snapshotId: 'snapshot-1', elementId: 'e1', referenceId: 'reference-1', ...overrides });

test('only current task references enter a private immutable upload registry', () => {
  const registry = createAgentUploadRegistry();
  const referenceImages = [image({ name: 'C:\\private\\reference.png' })];
  const registered = registry.register({ ...identity(), referenceImages });
  assert.deepEqual(registered, [{ referenceId: 'reference-1', name: 'reference.png', mime: 'image/png', size: 67 }]);
  assert.equal(JSON.stringify(registered).includes('data:'), false);
  referenceImages[0].dataUrl = 'https://evil.test/file';
  registered[0].name = 'changed';
  const payload = registry.resolve(target());
  assert.equal(payload.name, 'reference.png');
  assert.equal(payload.base64, png);
  assert.equal(payload.target.url, 'https://example.test/upload');
  assert.equal(payload.target.documentId, 'doc-1');
  assert.equal(payload.target.snapshotId, 'snapshot-1');
  payload.name = 'changed again';
  assert.equal(registry.resolve(target()).name, 'reference.png');
});

test('references cannot be rebound or replaced within an execution epoch', () => {
  const registry = createAgentUploadRegistry();
  registry.register({ ...identity(), referenceImages: [image()] });
  assert.equal(registry.register({ ...identity(), referenceImages: [image()] }).length, 1);
  assert.throws(() => registry.register({ ...identity(), referenceImages: [image({ name: 'different.png' })] }), { code: 'ERR_UPLOAD_SCOPE' });
  for (const change of [{ taskId: 'other' }, { tabId: 8 }, { epoch: 2 }, { url: 'https://other.test/upload' },
    { frameOrigin: 'https://other.test' }, { frameUrl: 'https://other.test/form' }, { referenceId: 'reference-2' },
    { elementId: '' }, { snapshotId: '' }, { frameId: -1 }]) {
    assert.throws(() => registry.resolve(target(change)), { code: 'ERR_UPLOAD_SCOPE' });
  }
});

test('pause aborts registered bytes; an old abort cannot remove a newer epoch', () => {
  const registry = createAgentUploadRegistry();
  const first = new AbortController();
  registry.register({ ...identity(), signal: first.signal, referenceImages: [image()] });
  first.abort();
  assert.throws(() => registry.resolve(target()), { code: 'ERR_UPLOAD_SCOPE' });
  const next = new AbortController();
  registry.register({ ...identity({ epoch: 2 }), signal: next.signal, referenceImages: [image()] });
  first.abort();
  assert.equal(registry.resolve(target({ epoch: 2 })).referenceId, 'reference-1');
  const stoppedAction = new AbortController();
  stoppedAction.abort();
  assert.throws(() => registry.resolve(target({ epoch: 2, signal: stoppedAction.signal })), { code: 'ERR_UPLOAD_SCOPE' });
  registry.clear('task-1');
  assert.throws(() => registry.resolve(target({ epoch: 2 })), { code: 'ERR_UPLOAD_SCOPE' });
});

test('arbitrary paths, remote files, malformed data, unsupported files and budgets are rejected', () => {
  for (const reference of [image({ dataUrl: 'C:\\private\\secret.png' }), image({ dataUrl: 'https://example.test/a.png' }),
    image({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }), image({ dataUrl: 'data:image/png;base64,!' }),
    image({ type: 'document' }), image({ dataUrl: `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}` })]) {
    assert.throws(() => createAgentUploadRegistry().register({ ...identity(), referenceImages: [reference] }));
  }
  assert.throws(() => createAgentUploadRegistry().register({ ...identity(), referenceImages: [image(), image(), image(), image()] }));
  assert.throws(() => createAgentUploadRegistry().register({ ...identity({ url: 'file:///private' }), referenceImages: [image()] }), { code: 'ERR_UPLOAD_SCOPE' });
});

test('MIME signature and size are checked before bytes may be assigned as a file', () => {
  const registry = createAgentUploadRegistry();
  registry.register({ ...identity(), referenceImages: [image()] });
  const payload = registry.resolve(target());
  assert.equal(validateAgentUploadPayload(payload), true);
  for (const change of [{ mime: 'image/jpeg' }, { size: payload.size + 1 }, { base64: 'aGVsbG8=' }, { name: '../secret.png' }, { referenceId: 'reference-99' }]) {
    assert.throws(() => validateAgentUploadPayload({ ...payload, ...change }), { code: 'ERR_UPLOAD_INVALID' });
  }
});

test('input accept filters match only the registered image MIME or canonical extension', () => {
  const reference = { name: 'ref.png', mime: 'image/png' };
  for (const accept of ['', 'image/*', 'image/png', '.png', 'image/jpeg, .PNG']) assert.equal(acceptsAgentUpload(accept, reference), true);
  for (const accept of ['image/jpeg', '.pdf', 'video/*', 'application/octet-stream']) assert.equal(acceptsAgentUpload(accept, reference), false);
});
