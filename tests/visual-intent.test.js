import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVisualDecisionPrompt,
  localVisualDecision,
  needsVisualPreflight,
  parseVisualDecision,
} from '../src/utils/visual-intent.js';

const page = {
  title: 'RAG 指南',
  figures: [
    { type: 'canvas', caption: '检索流程' },
    { type: 'img', alt: '指标曲线' },
  ],
  tables: [],
};

test('preflights explicit visual questions only', () => {
  assert.equal(needsVisualPreflight('这个流程图说明了什么？', { figures: [] }), true);
  assert.equal(needsVisualPreflight('请翻译这段正文', page), false);
  assert.equal(needsVisualPreflight('总结核心观点', page), false);
  assert.equal(needsVisualPreflight('总结核心观点', { figures: [], tables: [] }), false);
  assert.equal(
    needsVisualPreflight('请总结这个网页的主要内容、核心观点和关键结论。', page),
    false,
  );
});

test('parses strict visual decisions and rejects malformed output', () => {
  assert.deepEqual(parseVisualDecision('{"screenshot":true,"scope":"viewport","reason":"看布局"}'), {
    screenshot: true,
    scope: 'viewport',
    reason: '看布局',
  });
  assert.equal(parseVisualDecision('{"screenshot":false,"scope":"none"}').screenshot, false);
  assert.equal(parseVisualDecision('无法判断'), null);
  assert.equal(parseVisualDecision('{"scope":"page"}'), null);
});

test('decides a safe local fallback when the routing model is unavailable', () => {
  assert.deepEqual(localVisualDecision('看一下这个图表', page), {
    screenshot: true,
    scope: 'page',
    reason: '问题涉及页面视觉内容',
  });
  assert.equal(localVisualDecision('当前画面里的按钮是什么颜色？', page).scope, 'viewport');
  assert.equal(localVisualDecision('翻译正文', page).screenshot, false);
  assert.equal(localVisualDecision('总结这个网页的主要内容', page).screenshot, false);
});

test('builds a bounded prompt with figure metadata instead of the whole page', () => {
  const prompt = buildVisualDecisionPrompt('分析这两张图', page);
  assert.match(prompt, /RAG 指南/);
  assert.match(prompt, /检索流程/);
  assert.match(prompt, /指标曲线/);
  assert.match(prompt, /"scope":"page"\|"viewport"/);
});
