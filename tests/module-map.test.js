import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const map = readFileSync(new URL('../docs/MODULE-MAP.md', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');

test('module map documents all implemented feature slots', () => {
  assert.match(map, /features\/attachments\/attachments-slot\.js/);
  assert.match(map, /features\/page-reading\/page-reader-slot\.js/);
  assert.match(map, /features\/visual-context\/auto-visual-slot\.js/);
  assert.match(map, /features\/visual-context\/visual-capture-service\.js/);
  assert.match(map, /features\/context\/context-slot\.js/);
  assert.match(map, /features\/messages\/message-view\.js/);
  assert.match(map, /features\/models\/model-switcher\.js/);
  assert.match(map, /features\/welcome\/welcome-prompts\.js/);
});

test('entry keeps an explicit module navigation header', () => {
  assert.match(entry, /MODULE NAVIGATION/);
  assert.match(entry, /composition\/composition-root\.js/);
  assert.match(entry, /features\/page-reading\/page-reader-slot\.js/);
  assert.match(entry, /features\/visual-context\/auto-visual-slot\.js/);
});
