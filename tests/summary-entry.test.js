import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/sidepanel/index.html', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');

test('page summary is rendered only for readable pages and uses delegated clicks', () => {
  assert.doesNotMatch(html, /id="summarize-page"/);
  assert.doesNotMatch(html, /id="welcome-summary"/);
  assert.equal((entry.match(/\.addEventListener\('click', summarizePage\)/g) || []).length, 0);
  assert.match(entry, /primary\.action === 'summarize-page' \? 'summarize-page' : 'welcome-primary'/);
  assert.match(entry, /chip\.dataset\.action === 'summarize-page'/);
});

test('the welcome primary action follows the page-aware prompt action', () => {
  assert.doesNotMatch(entry, /action = 'summarize-page'/);
  assert.match(entry, /data-action="\$\{escapeHtml\(primary\.action\)\}"/);
});

test('extension HTML never contains CSP-blocked inline scripts', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(html, /src="\/src\/sidepanel\/theme-boot\.js"/);
});

test('model readiness does not require or request folder permission during a send', () => {
  const configured = entry.slice(entry.indexOf('async function ensureConfigured('), entry.indexOf('async function readPage('));
  assert.doesNotMatch(configured, /requestDirectoryPermission|restoreConversationDirectory/);
  assert.doesNotMatch(configured, /if\s*\([^)]*storageInfo\.granted/);
  assert.match(configured, /normalized\?\.endpointUrl/);
});

test('folder failures use durable pending saves and do not discard the previous temporary chat', () => {
  const create = entry.slice(entry.indexOf('async function newConversation('), entry.indexOf('async function ensureConversation('));
  assert.match(create, /if \(currentTemporary\?\.messages\.length\)\s*\{/);
  assert.match(create, /await operation\.persist\(\(\) => promoteTemporaryConversation\(currentTemporary\)\)/);
  assert.match(create, /syncStatus === 'pending'/);
  assert.ok(create.indexOf('promoteTemporaryConversation(') < create.indexOf('createTemporaryConversation('));
  // Startup ordering, hanging storage and cancellation are exercised with
  // real bounded waits in sidepanel-boot.test.js.
});

test('welcome topics refresh their prompt at click time and fill an editable draft', () => {
  const handler = entry.slice(entry.indexOf("$('#welcome')?.addEventListener"), entry.indexOf("$('#queue-recall')"));
  assert.match(handler, /welcomePromptsFor\(state\.activePageSignal \|\| \{\}\)\.topics\.find/);
  assert.match(handler, /pastedText\.setValue\(prompt\);/);
  assert.match(handler, /state\.draft = prompt;/);
  assert.doesNotMatch(handler, /await sendMessage\(|directModelRequest = chip/);
});

