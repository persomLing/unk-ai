import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/sidepanel/style.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/sidepanel/features/messages/turn-navigator.js', import.meta.url), 'utf8');

test('turn navigator and preview live outside the scrollable conversation', () => {
  assert.match(html, /id="conversation-stage"[\s\S]*id="conversation-view"[\s\S]*id="turn-navigator"[\s\S]*id="turn-preview"[\s\S]*<\/div>\s*<footer/);
  assert.match(entry, /createTurnNavigator\(\{/);
  assert.match(entry, /turnNavigator\.sync\(conversation\)/);
  assert.match(entry, /turnNavigator\.scheduleLayout\(\)/);
  assert.match(entry, /turnNavigator\.dispose\(\)/);
});

test('turn cards intentionally omit favorite and copy controls', () => {
  assert.doesNotMatch(source, /favorite|bookmark|copy-original|clipboard|data-action=["']copy/);
  assert.match(source, /turn-preview-title/);
  assert.match(source, /turn-preview-answer/);
  assert.doesNotMatch(css, /turn-preview-copy/);
});

test('turn rail is keyboard accessible without a persistent selection state', () => {
  assert.match(source, /button\.type = 'button'/);
  assert.match(source, /aria-label/);
  assert.match(source, /'ArrowUp', 'ArrowDown', 'Home', 'End'/);
  assert.doesNotMatch(source, /aria-current|is-active/);
  assert.doesNotMatch(css, /turn-navigator-item\.is-active/);
  assert.match(css, /\.turn-preview/);
});

test('all rests are equally thin and only hover grows the plain bar', () => {
  assert.match(css, /\.turn-navigator\s*\{[\s\S]*?right:\s*4px;[\s\S]*?gap:\s*5px;/);
  assert.match(css, /\.turn-navigator-item::before\s*\{[\s\S]*?width:\s*9px;[\s\S]*?height:\s*2px;/);
  assert.doesNotMatch(css, /--turn-width|nth-last-child/);
  assert.doesNotMatch(css, /clip-path:\s*polygon\(/);
  assert.match(css, /\.turn-navigator-item:hover::before,[\s\S]*?width:\s*32px;/);
});

test('streaming and resize updates coalesce to one animation frame', () => {
  assert.match(source, /updateFrame !== null/);
  assert.match(source, /requestFrame\(\(\) => \{/);
  assert.match(source, /new ResizeObserver\(\(\) => \{ if \(!preview\.hidden\) scheduleUpdate\(\); \}\)/);
  assert.match(source, /cancelFrame\(updateFrame\)/);
});
