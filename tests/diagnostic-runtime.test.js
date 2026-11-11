import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCodeLocation, installRuntimeDiagnostics } from '../src/utils/diagnostic-observer.js';

test('runtime location retains own published module/line/column and rejects private URLs and foreign extensions', () => {
  const location = 'chrome-extension://own-id/src/sidepanel/index.html';
  assert.deepEqual(diagnosticCodeLocation({ filename: 'chrome-extension://own-id/assets/sidepanel-build123.js', lineno: 7, colno: 850 }, location),
    { module: 'assets/sidepanel-build123.js', line: 7, column: 850 });
  assert.deepEqual(diagnosticCodeLocation({ filename: 'chrome-extension://other-id/assets/sidepanel-build123.js' }, location), {});
  assert.deepEqual(diagnosticCodeLocation({ filename: 'https://private.test/user/secret.js' }, location), {});
  assert.deepEqual(diagnosticCodeLocation({ filename: 'chrome-extension://own-id/assets/sidepanel-build123.js?token=secret' }, location), {});
  assert.deepEqual(diagnosticCodeLocation({ reason: { stack: 'Error: PRIVATE\n at go (chrome-extension://own-id/assets/sidepanel-build123.js:4:567)' } }, location),
    { module: 'assets/sidepanel-build123.js', line: 4, column: 567 });
});

test('runtime diagnostics do not store stack/messages and remove their listeners on disposal', () => {
  const target = new EventTarget(); target.location = { href: 'chrome-extension://own-id/src/options/index.html' };
  const events = [];
  const dispose = installRuntimeDiagnostics(target, event => { events.push(event); return Promise.reject(new Error('logging failed')); });
  const event = new Event('error');
  Object.assign(event, { filename: 'chrome-extension://own-id/assets/options-build.js', lineno: 2, colno: 21,
    error: new TypeError('SECRET error'), message: 'SECRET', });
  target.dispatchEvent(event);
  assert.equal(events[1].data.module, 'assets/options-build.js');
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
  dispose(); target.dispatchEvent(event);
  assert.equal(events.length, 2);
});
