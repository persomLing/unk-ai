import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageReadState } from '../src/sidepanel/features/page-reading/page-read-state.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
test('page read state records actual completion and failure for the captured target', async () => {
  const changes = [];
  const state = createPageReadState({ onChange: value => changes.push(value.status) });
  const target = { id: 7, url: 'https://page.test/a' };
  await state.run(target, null, async () => 'body');
  target.url = 'https://page.test/b';
  assert.equal(state.current().target.url, 'https://page.test/a');
  assert.deepEqual(changes, ['reading', 'read']);
  await assert.rejects(state.run(target, null, async () => { throw new Error('unavailable'); }));
  assert.equal(state.current().status, 'failed');
});

test('stopping releases local read status and late completion cannot clear a new read', async () => {
  const state = createPageReadState();
  const old = deferred(), next = deferred(), controller = new AbortController();
  const first = state.run({ id: 7, url: 'https://page.test/a' }, controller.signal, () => old.promise);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(state.current().status, 'stopped');
  const second = state.run({ id: 8, url: 'https://page.test/b' }, null, () => next.promise);
  old.resolve('late');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.current().target.id, 8);
  assert.equal(state.current().status, 'reading');
  next.resolve('new body');
  await second;
  assert.equal(state.current().status, 'read');
});

test('a timed-out parent signal displays a read failure instead of a user stop', async () => {
  const state = createPageReadState();
  const controller = new AbortController();
  const pending = state.run({ id: 7, url: 'https://page.test/a' }, controller.signal, () => new Promise(() => {}));
  controller.abort(Object.assign(new Error('body timed out'), { name: 'TimeoutError' }));
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.equal(state.current().status, 'failed');
});

test('a same-URL document reload invalidates old read status without touching another tab', async () => {
  const state = createPageReadState();
  const body = deferred();
  const pending = state.run({ id: 7, url: 'https://page.test/a' }, null, () => body.promise);
  state.invalidate(8);
  assert.equal(state.current().status, 'reading');
  state.invalidate(7);
  assert.equal(state.current(), null);
  body.resolve('old document');
  await pending;
  assert.equal(state.current(), null);
});
