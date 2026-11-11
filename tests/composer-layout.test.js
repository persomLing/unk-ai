import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/sidepanel/style.css', import.meta.url), 'utf8');

test('composer toolbar lays out leading and trailing controls as separate flex groups', () => {
  const rule = css.match(/\.composer-toolbar\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /display:\s*flex;/);
  assert.match(rule, /justify-content:\s*space-between;/);
  assert.doesNotMatch(rule, /padding-right:\s*38px;/);
});

test('send and stop participate in layout so they cannot overlap', () => {
  const rules = [...css.matchAll(/[^{}]*\.send-button[^{}]*\{([^}]+)\}/g)].map(match => match[1]).join('\n');
  assert.doesNotMatch(rules, /position:\s*absolute;/);
  assert.match(rules, /flex:\s*0 0 (?:auto|32px);/);
});

test('header model can shrink and narrow composer moves page capabilities to their own row', () => {
  assert.match(css, /\.composer-trailing\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.header-leading\s*\{[^}]*min-width:\s*0;/);
  assert.match(css, /\.model-switcher\s*\{[^}]*min-width:\s*0;/);
  assert.match(css, /@media \(max-width: 410px\)\s*\{\s*\.composer-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.composer-modes\s*\{[^}]*order:\s*-1;[^}]*flex-basis:\s*100%;/);
});
