import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeHtml } from '../src/sidepanel/core/dom.js';
import { icon } from '../src/sidepanel/icons.js';
import { parseSuggestionResponse } from '../src/sidepanel/features/messages/model-suggestions.js';

// Execute the real HTML adapter without message-view's browser CSS imports.
const source = readFileSync(new URL('../src/sidepanel/features/messages/message-view.js', import.meta.url), 'utf8');
const adapter = source.slice(source.indexOf('function tryNextMarkup('), source.indexOf('function assistantMessageMarkup('));
const renderSuggestions = new Function('escapeHtml', 'icon', 'parseSuggestionResponse', `${adapter}\nreturn tryNextMarkup;`)(
  escapeHtml, icon, parseSuggestionResponse,
);
const chipCount = html => (html.match(/class="try-next-chip"/g) || []).length;
const savedMessage = suggestions => ({ id: 'answer-1', role: 'assistant', status: 'complete',
  content: 'OpenAI 融资尚未官宣，国产模型发布仍需核对官方来源，现有聚合报道不足以确认。', suggestions });

test('stored answer prose and vague fragments no longer render as exploration questions', () => {
  const message = savedMessage([
    '因此，本轮**没有新增任何可核实信息**。上一版回答中的 5 项，其可信度、时间标注和缺口**全部维持原状，没有一项可以升级**',
    '对上一版的具体影响',
  ]);
  const snapshot = structuredClone(message);
  assert.equal(renderSuggestions(message, { showSuggestions: true }), '');
  assert.deepEqual(message, snapshot, 'display filtering must not rewrite stored conversation content');
});

test('valid concrete saved questions remain visible while malformed and vague suggestions are filtered', () => {
  const message = savedMessage([
    '对上一版的具体影响',
    '哪些官方文件能核实 OpenAI 融资？',
    '因此全部维持原状，没有一项可以升级**',
    '国产模型发布需要核对哪些一手来源？',
  ]);
  const html = renderSuggestions(message, { showSuggestions: true });
  assert.equal(chipCount(html), 2);
  assert.match(html, /哪些官方文件能核实 OpenAI 融资？/);
  assert.match(html, /国产模型发布需要核对哪些一手来源？/);
  assert.doesNotMatch(html, /上一版|可以升级|全部维持原状/);
  assert.match(html, /data-for-message="answer-1"/);
});

test('saved complete answer sentences are not recycled as next-step suggestions', () => {
  const excerpt = 'OpenAI 的融资为什么尚未官宣？';
  const message = savedMessage([excerpt, '哪些官方文件能核实 OpenAI 融资？']);
  message.content = `## 待核实事项\n${excerpt}\n现有聚合报道不足以确认。`;
  const html = renderSuggestions(message, { showSuggestions: true });
  assert.equal(chipCount(html), 1);
  assert.doesNotMatch(html, /OpenAI 的融资为什么尚未官宣/);
  assert.match(html, /哪些官方文件能核实 OpenAI 融资？/);
});

test('display filtering preserves latest-turn visibility and streaming suppression', () => {
  const message = savedMessage(['哪些官方文件能核实 OpenAI 融资？']);
  assert.equal(renderSuggestions(message), '');
  assert.equal(renderSuggestions(message, { showSuggestions: false }), '');
  assert.equal(renderSuggestions({ ...message, status: 'streaming' }, { showSuggestions: true }), '');
  assert.equal(renderSuggestions({ ...message, suggestions: null }, { showSuggestions: true }), '');
  assert.equal(chipCount(renderSuggestions(message, { showSuggestions: true })), 1);
});

test('valid question text remains escaped and bound to its saved suggestion value', () => {
  const question = '为什么 OpenAI “未官宣” 还会影响估值？';
  const html = renderSuggestions(savedMessage([question]), { showSuggestions: true });
  assert.equal(chipCount(html), 1);
  assert.match(html, new RegExp(`data-suggestion="${escapeHtml(question)}"`));
  assert.match(html, /type="button"/);
});
