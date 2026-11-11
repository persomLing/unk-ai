import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/sidepanel/style.css', import.meta.url), 'utf8');
const view = readFileSync(new URL('../src/sidepanel/features/messages/message-view.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');

test('expanded thinking content has its own scrollbar and allows scrolling into the conversation', () => {
  const block = css.match(/\.thinking-content\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(block, /max-height:/);
  assert.match(block, /overflow-y:\s*auto;/);
  assert.match(block, /overscroll-behavior(?:-y)?:\s*auto;/);
  assert.doesNotMatch(block, /overscroll-behavior(?:-y)?:\s*(?:contain|none);/);
});

test('thinking content is rendered inside its own scroll container', () => {
  assert.match(view, /class="thinking-content"/);
  assert.match(view, /data-thinking-text/);
  assert.match(view, /data-action="toggle-thinking"/);
});

test('opening thinking relinquishes follow-to-latest and stream updates restore reading position', () => {
  const toggle = entry.slice(entry.indexOf("if (button.dataset.action === 'toggle-thinking')"), entry.indexOf("if (button.dataset.action === 'copy-user')"));
  assert.match(toggle, /message\.thinkingExpanded = willOpen/);
  assert.match(toggle, /if \(willOpen\)[\s\S]*?state\.followToPage = false/);
  const update = view.slice(view.indexOf('export function updateStreamingMessage('), view.indexOf('export function messageAttachments('));
  assert.match(update, /captureViewPosition\(conversationView, messagesElement\)/);
  assert.match(update, /restoreViewPosition\(conversationView, messagesElement, position, followToPage\)/);
  assert.match(update, /updateThinkingView\(article, message\)/);
  const streamingBranch = update.slice(update.indexOf("(message.status || 'complete') !== 'streaming'"), update.indexOf('const position = captureViewPosition'));
  assert.doesNotMatch(streamingBranch, /article\.outerHTML/, 'streaming deltas must not replace the message and its toggle');
});

test('a completed thinking block does not keep the live animation class', () => {
  assert.match(view, /class="thinking-block\$\{thinking\.active \? ' is-streaming' : ''\}"/);
  const animatedRule = css.match(/\.thinking-brain-icon\.is-shaking,[\s\S]*?\{([\s\S]*?)\}/)?.[0] || '';
  assert.doesNotMatch(animatedRule, /\.thinking-block\.is-streaming/);
});
