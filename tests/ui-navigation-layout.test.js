import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/sidepanel/style.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../src/sidepanel/icons.js', import.meta.url), 'utf8');

function headerMarkup() {
  return html.match(/<header class="app-header">([\s\S]*?)<\/header>/)?.[1] || '';
}

test('header places selected-turn export immediately after the theme action', () => {
  const header = headerMarkup();
  const actionIds = [...header.matchAll(/<button id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(actionIds, ['open-history', 'model-trigger', 'theme-toggle', 'export-selected', 'new-chat']);
  assert.match(header, /data-icon="sidebar"/);
  assert.doesNotMatch(header, /id="expand-fullscreen"|id="open-settings"/);
  assert.match(header, /id="new-chat"[^>]*title="新对话"/);
  assert.match(entry, /\$\('#new-chat'\)\.addEventListener\('click'/);
  assert.match(icons, /sidebar:\s*'<rect x="3" y="3.5"/);
});

test('header new conversation does not pass its click event as a group and respects history work', async () => {
  const start = entry.indexOf("$('#new-chat').addEventListener('click'");
  const end = entry.indexOf('\n});', start) + 4;
  let listener;
  const calls = [];
  const context = vm.createContext({
    historyMutationBusy: false,
    $: () => ({ addEventListener: (_type, handler) => { listener = handler; } }),
    newConversation: async (...args) => { calls.push(args); },
    toast: () => {},
  });
  vm.runInContext(entry.slice(start, end), context);
  listener({ type: 'click' });
  assert.deepEqual(calls, [[]]);
  context.historyMutationBusy = true;
  listener({ type: 'click' });
  assert.equal(calls.length, 1);
});

test('drawer orders brand, search, history, and fixed settings navigation', () => {
  const drawer = html.match(/<aside id="history-drawer"[\s\S]*?<\/aside>/)?.[0] || '';
  const brand = drawer.indexOf('class="drawer-brand"');
  const search = drawer.indexOf('class="history-search-bar"');
  const history = drawer.indexOf('id="history-list"');
  const settings = drawer.indexOf('id="open-settings"');
  assert.ok(brand >= 0 && brand < search && search < history && history < settings);
  assert.match(drawer, /src="\/icons\/icon-32\.png"/);
  assert.match(drawer, /<strong>UNK AI<\/strong>/);
  assert.match(drawer, /id="history-new-chat"/);
  assert.match(entry, /\$\('#open-history'\)\.addEventListener\('click'/);
  assert.match(entry, /\$\('#open-settings'\)\.addEventListener\('click'/);
});

test('header icon buttons share one optical and hit-area grid', () => {
  assert.match(css, /\.header-leading \.icon-button,[\s\S]*?\.header-trailing \.icon-button\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?flex:\s*0 0 36px;/);
  assert.match(css, /\.header-leading \.icon-button \.icon,[\s\S]*?\.header-trailing \.icon-button \.icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;[\s\S]*?stroke-width:\s*1\.65;/);
  assert.match(icons, /sidebar:\s*'<rect x="3" y="3.5"/);
  assert.doesNotMatch(icons, /<circle[^>]*cx="19"[^>]*cy="17"/);
  assert.doesNotMatch(css, /\.more-button\s*\{/);
});
test('search and settings stay fixed while only the history list scrolls', () => {
  assert.match(css, /\.history-search-bar\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /\.history-list\s*\{[\s\S]*?flex:\s*1;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.history-drawer > footer\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /\.drawer-brand-icon\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;/);
});

test('drawer search keeps its mobile width without horizontal overflow', () => {
  assert.match(css, /\.history-drawer\s*\{[\s\S]*?width:\s*min\(92%, 360px\);/);
  assert.match(css, /\.drawer-brand-lockup\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.drawer-brand-lockup > div\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.history-search-input\s*\{[\s\S]*?min-width:\s*0;/);
});
