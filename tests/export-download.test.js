import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportDownloader } from '../src/sidepanel/features/export/download-export.js';

test('downloads use their supplied snapshot filename and keep the URL alive for the browser', async () => {
  const issued = [], revoked = [], timers = [];
  const save = createExportDownloader({
    download: async options => { issued.push(options); return 42; },
    urls: { createObjectURL: () => 'blob:export', revokeObjectURL: url => revoked.push(url) },
    delay: (callback, ms) => timers.push({ callback, ms }),
  });
  assert.equal(await save({ blob: new Blob(['image']), filename: '原会话.png' }), 42);
  assert.deepEqual(issued, [{ url: 'blob:export', filename: '原会话.png', saveAs: true }]);
  assert.deepEqual(revoked, []);
  assert.equal(timers[0].ms, 120000);
  timers[0].callback();
  assert.deepEqual(revoked, ['blob:export']);
});

test('cancelled exports do not issue a download and issued saves release local waiting', async () => {
  let calls = 0;
  const controller = new AbortController();
  const save = createExportDownloader({ download: () => { calls++; return new Promise(() => {}); },
    urls: { createObjectURL: () => 'blob:pending', revokeObjectURL() {} }, delay() {} });
  const pending = save({ blob: new Blob(['data']), filename: 'file.pdf', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(save({ blob: new Blob(), filename: 'file.pdf', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
