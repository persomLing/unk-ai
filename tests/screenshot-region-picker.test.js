import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScreenshotRegion } from '../src/sidepanel/features/visual-context/screenshot-region-picker.js';
import { createVisualPreparation } from '../src/sidepanel/features/visual-context/manual-visual-capture.js';

const attachment = { dataUrl: 'data:image/jpeg;base64,AAAA', capture: { image: { width: 2000, height: 1200 } } };
class Element extends EventTarget {
  constructor() { super(); this.style = {}; this.complete = true; this.disabled = true; }
  setAttribute() {}
  getBoundingClientRect() { return { left: 10, top: 20, width: 400, height: 240 }; }
  fire(type, fields = {}) { const event = new Event(type, { cancelable: true }); Object.assign(event, fields); this.dispatchEvent(event); }
}
function documentFixture({ failOpen = false } = {}) {
  const selectors = ['img', '.screenshot-region-stage', '.screenshot-region-selection', '.screenshot-region-status', '[data-region-confirm]'];
  const nodes = Object.fromEntries(selectors.map(selector => [selector, new Element()]));
  const cancel = new Element();
  const dialog = new Element();
  dialog.querySelector = selector => nodes[selector];
  dialog.querySelectorAll = () => [cancel];
  dialog.showModal = () => { if (failOpen) throw new Error('Cannot open dialog'); dialog.open = true; };
  dialog.close = () => { if (dialog.open) { dialog.open = false; dialog.fire('close'); } };
  dialog.remove = () => { dialog.removed = true; };
  const document = { body: { append: () => { dialog.appended = true; } }, createElement: () => dialog };
  return { document, dialog, cancel, nodes, stage: nodes['.screenshot-region-stage'], confirm: nodes['[data-region-confirm]'] };
}

test('dragging in the displayed screenshot returns the selected original image pixels', async () => {
  const fx = documentFixture();
  const pending = selectScreenshotRegion(attachment, { document: fx.document });
  fx.stage.fire('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 40 });
  fx.stage.fire('pointermove', { pointerId: 1, clientX: 250, clientY: 160 });
  fx.stage.fire('pointerup', { pointerId: 1, clientX: 250, clientY: 160 });
  assert.equal(fx.confirm.disabled, false);
  fx.confirm.fire('click');
  assert.deepEqual(await pending, { x: 200, y: 100, width: 1000, height: 600, coordinateSpace: 'image' });
  assert.equal(fx.dialog.removed, true);
});

test('Escape and the cancel button close the dialog without creating a selection', async () => {
  for (const action of ['escape', 'button']) {
    const fx = documentFixture();
    const pending = selectScreenshotRegion(attachment, { document: fx.document });
    if (action === 'escape') fx.dialog.fire('cancel'); else fx.cancel.fire('click');
    assert.equal(await pending, null);
    assert.equal(fx.dialog.removed, true);
    assert.equal(fx.dialog.open, false);
  }
});

test('owner cancellation and selection timeout remove the modal and settle its pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['cancel', 'timeout']) {
    const fx = documentFixture();
    const manager = createVisualPreparation({ getOwner: () => ['conversation-a'], onBusy: () => {} });
    const operation = manager.start();
    const pending = operation.wait(selectScreenshotRegion(attachment, { document: fx.document, signal: operation.signal }), 20)
      .finally(() => operation.finish());
    const rejected = assert.rejects(pending, { name: action === 'cancel' ? 'AbortError' : 'TimeoutError' });
    if (action === 'cancel') manager.cancel(); else t.mock.timers.tick(20);
    await rejected;
    assert.equal(fx.dialog.open, false);
    assert.equal(fx.dialog.removed, true);
    assert.equal(operation.signal.aborted, true);
    fx.confirm.fire('click');
  }
});

test('failure to open the dialog does not leave an appended modal behind', () => {
  const fx = documentFixture({ failOpen: true });
  assert.throws(() => selectScreenshotRegion(attachment, { document: fx.document }), /Cannot open dialog/);
  assert.equal(fx.dialog.appended, true);
  assert.equal(fx.dialog.removed, true);
});
