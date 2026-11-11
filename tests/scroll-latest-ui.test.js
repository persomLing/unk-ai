import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/sidepanel/style.css', import.meta.url), 'utf8');

test('scroll-to-latest button contains both arrow and animated dots', () => {
  const match = html.match(/<div id="scroll-latest"[\s\S]*?<\/div>/);
  assert.ok(match, 'scroll-latest container should exist');
  assert.match(match[0], /scroll-latest-arrow/);
  assert.match(match[0], /scroll-latest-dots/);
  assert.equal((match[0].match(/<i><\/i>/g) || []).length, 3);
});

test('streaming state swaps the arrow for animated dots', () => {
  assert.match(css, /\.scroll-latest\.is-streaming \.scroll-latest-arrow\s*\{\s*display:\s*none;/);
  assert.match(css, /\.scroll-latest\.is-streaming \.scroll-latest-dots\s*\{\s*display:\s*inline-flex;/);
  assert.match(css, /\.scroll-latest-dots i\s*\{[\s\S]*?animation:\s*thinking/);
});

test('scroll button keeps a compact circular hit target', () => {
  assert.match(css, /\.scroll-latest-button\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;[\s\S]*?border-radius:\s*50%;/);
});
