import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from '../src/utils/markdown.js';

test('renders GFM tables with a horizontal-scroll wrapper', () => {
  const html = renderMarkdown([
    '| 根因 | 典型现象 | 优先方案 |',
    '| --- | --- | --- |',
    '| RAG | 模型没看到资料 | Prompt 优化 |',
    '| 微调 | 行为不稳定 | 微调 |',
  ].join('\n'));
  assert.match(html, /<div class="md-table-scroll"/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>根因<\/th>/);
  assert.match(html, /<td>微调<\/td>/);
});

test('renders common markdown features and escapes raw html', () => {
  const html = renderMarkdown('## Title\n\n- one\n- two\n\n**bold** ~~old~~\n\n`code`\n\n<script>alert(1)</script>');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<s>old<\/s>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
