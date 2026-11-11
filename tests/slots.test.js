import test from 'node:test';
import assert from 'node:assert/strict';

import { createSlotRegistry, SLOT_CONTRACTS } from '../src/sidepanel/composition/slots.js';
import {
  mergeAttachments,
  removeAttachment,
  attachmentDetail,
} from '../src/sidepanel/features/attachments/attachments-slot.js';

test('duplicate registration cannot silently replace a working implementation', () => {
  const basic = { name: 'basic', read() {} };
  const registry = createSlotRegistry({ reading: basic });
  assert.equal(registry.get('reading').name, 'basic');
  assert.throws(() => registry.register('reading', { read() {} }), /already registered/);
  assert.equal(registry.get('reading'), basic);
  registry.replace('reading', { name: 'cdp', read() {} });
  assert.equal(registry.get('reading').name, 'cdp');
  assert.deepEqual(registry.names(), ['reading']);
  assert.throws(() => registry.get('missing'), /Unknown feature slot/);
  assert.throws(() => registry.replace('visual', { decide() {}, resolve() {} }), /Unknown feature slot/);
});

test('initial, registered and replacement slots must satisfy their declared contract', () => {
  assert.throws(() => createSlotRegistry({ reading: {} }), /reading.*read/);
  const registry = createSlotRegistry();
  assert.throws(() => registry.register('visual', { decide() {} }), /visual.*resolve/);
  assert.throws(() => registry.register('reading', { read: 'not a method' }), /reading.*read/);
  assert.throws(() => registry.register('reading', null), /implementation object/);
  const reading = { read() {} };
  registry.register('reading', reading);
  assert.throws(() => registry.replace('reading', {}), /reading.*read/);
  assert.equal(registry.get('reading'), reading);
});

test('new slot names need an explicit method contract and contract input is copied', () => {
  const registry = createSlotRegistry();
  assert.throws(() => registry.register('readng', { read() {} }), /Unknown feature slot contract/);
  assert.throws(() => registry.register('', {}), /slot name/);
  assert.throws(() => registry.register(' reading ', { read() {} }), /slot name/);
  const contracts = { ...SLOT_CONTRACTS, custom: ['run'] };
  const custom = createSlotRegistry({}, { contracts });
  contracts.custom.length = 0;
  assert.throws(() => custom.register('custom', {}), /custom.*run/);
  custom.register('custom', { run() {} });
  assert.equal(custom.has('custom'), true);
  assert.throws(() => createSlotRegistry({}, { contracts: { custom: [] } }), /Invalid feature slot contract/);
});

test('sealed consumers retain one implementation and its public methods cannot be swapped', () => {
  const implementation = { read() { return 'original'; } };
  const registry = createSlotRegistry({ reading: implementation }).seal();
  const publishedReading = registry.get('reading');
  assert.equal(registry.isSealed(), true);
  assert.equal(registry.seal(), registry);
  assert.throws(() => registry.replace('reading', { read() { return 'replacement'; } }), /sealed/);
  assert.throws(() => registry.register('visual', { decide() {}, resolve() {} }), /sealed/);
  assert.throws(() => { implementation.read = () => 'replacement'; }, TypeError);
  assert.throws(() => { registry.get = () => null; }, TypeError);
  assert.equal(publishedReading, registry.get('reading'));
  assert.equal(publishedReading.read(), 'original');
  registry.names().push('visual');
  assert.deepEqual(registry.names(), ['reading']);
});

test('sealing revalidates a factory interface that was changed during composition', () => {
  const implementation = { read() {} };
  const registry = createSlotRegistry({ reading: implementation });
  delete implementation.read;
  assert.throws(() => registry.seal(), /reading.*read/);
  assert.equal(registry.isSealed(), false);
  registry.replace('reading', { read() {} });
  registry.seal();
  assert.equal(registry.isSealed(), true);
});

test('attachment collection helpers use lodash-backed deterministic merging', () => {
  const first = { id: '1', type: 'document', name: 'a.md', size: 2 };
  const duplicate = { id: '2', type: 'document', name: 'a.md', size: 2 };
  const second = { id: '3', type: 'image', name: 'chart.jpg', size: 10, width: 100, height: 80 };
  assert.equal(mergeAttachments([first], [duplicate]).length, 1);
  assert.equal(mergeAttachments([first], [second]).length, 2);
  assert.equal(removeAttachment([first, second], '1').length, 1);
  assert.equal(attachmentDetail(second), '100 × 80');
});
