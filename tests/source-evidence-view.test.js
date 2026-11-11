import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeHtml } from '../src/sidepanel/core/dom.js';
import { icon } from '../src/sidepanel/icons.js';

// This UI adapter emits HTML. Execute its real implementation without the
// browser-only stylesheet imports needed by the rest of message-view.js.
const source = readFileSync(new URL('../src/sidepanel/features/messages/message-view.js', import.meta.url), 'utf8');
const adapter = source.slice(source.indexOf('function sourcesMarkup('), source.indexOf('function tryNextMarkup('));
const renderSources = new Function('escapeHtml', 'icon', `${adapter}\nreturn sourcesMarkup;`)(escapeHtml, icon);
const sourceEntry = (readStatus, extra = {}) => ({ title: '来源标题', url: 'https://evidence.example/article',
  ...(readStatus ? { readStatus } : {}), ...extra });
const label = html => html.match(/<span class="sources-count">([^<]*)<\/span>/)?.[1];
const statuses = html => [...html.matchAll(/<small class="source-popover-domain"[^>]*>([^<]*)<\/small>/g)].map(match => match[1]);

test('search summaries are sources without claiming their webpage bodies have been read', () => {
  const html = renderSources({ id: 'answer', sources: [sourceEntry('search-summary')] });
  assert.equal(label(html), '1 个来源');
  assert.ok(statuses(html).some(value => value.includes('搜索摘要')));
  assert.doesNotMatch(html, /已读正文|已读取|查看已读取/);
  assert.match(html, /title="查看来源及读取状态"/);
});

test('only sources known to have body evidence retain the read label', () => {
  const html = renderSources({ id: 'answer', sources: [sourceEntry('body'), sourceEntry('body', { url: 'https://second.example/release' })] });
  assert.equal(label(html), '已读取 2 个来源');
  assert.ok(statuses(html).every(value => value.includes('已读正文')));
});

test('mixed body and summary evidence names both actual statuses with a neutral total', () => {
  const html = renderSources({ id: 'answer', sources: [sourceEntry('body'), sourceEntry('search-summary', { url: 'https://second.example/news' })] });
  assert.equal(label(html), '2 个来源');
  assert.ok(statuses(html)[0].includes('已读正文'));
  assert.ok(statuses(html)[1].includes('搜索摘要'));
});

test('truncated source evidence keeps its type and visibly declares the missing content', () => {
  const html = renderSources({ id: 'answer', sources: [sourceEntry('body', { truncated: true }), sourceEntry('search-summary', { truncated: true })] });
  assert.ok(statuses(html)[0].includes('已读正文 · 内容已截断'));
  assert.ok(statuses(html)[1].includes('搜索摘要 · 内容已截断'));
});

test('legacy snippets remain summaries and missing or unfamiliar read states stay unknown', () => {
  const html = renderSources({ id: 'answer', pageSource: { url: 'https://evidence.example/article' },
    sources: [sourceEntry('snippet'), sourceEntry(null), sourceEntry('future-state')] });
  assert.equal(label(html), '3 个来源');
  assert.ok(statuses(html)[0].includes('搜索摘要'));
  assert.ok(statuses(html)[1].includes('读取状态未知'));
  assert.ok(statuses(html)[2].includes('读取状态未知'));
  assert.doesNotMatch(html, /已读正文|已读取/);
});

test('source evidence markup escapes external titles and preserves accessible source controls', () => {
  const html = renderSources({ id: 'answer', sources: [sourceEntry('search-summary', { title: '<script>source</script>', domain: '<external>' })] });
  assert.match(html, /&lt;script&gt;source&lt;\/script&gt;/);
  assert.match(html, /&lt;external&gt;/);
  assert.doesNotMatch(html, /<script>|<external>/);
  assert.match(html, /data-action="toggle-sources" aria-expanded="false"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.equal(renderSources({ id: 'empty', sources: [] }), '');
});

test('all source icons start with a default globe, including missing and pending favicons', () => {
  const html = renderSources({ id: 'icons', sources: [sourceEntry('snippet'),
    sourceEntry('body', { favicon: '   ' }), sourceEntry('snippet', { favicon: 'https://evidence.example/missing.ico' })] });
  assert.equal((html.match(/data-source-favicon-fallback /g) || []).length, 6);
  assert.equal((html.match(/data-source-favicon src=/g) || []).length, 2);
  assert.equal((html.match(/alt="" hidden/g) || []).length, 2);
  assert.doesNotMatch(html, /onerror=|onload=|data-image-preview/);
  assert.equal(label(html), '3 个来源');
});
