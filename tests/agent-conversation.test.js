import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentTurnForMessage,
  appendAgentStep,
  buildAgentSummaryInput,
  factsCoverBalanceAndModel,
  createAgentTurn,
  fallbackAgentSummary,
  finishAgentTurn,
} from '../src/utils/agent-conversation.js';

test('agent turns keep a bounded ordered timeline', () => {
  const turn = createAgentTurn({ goal: '打开概览页', taskId: 't1', startedAt: '2026-10-29T00:00:00.000Z' });
  for (let index = 0; index < 70; index += 1) {
    appendAgentStep(turn, { kind: 'action', title: `步骤 ${index}`, at: '2026-10-29T00:00:01.000Z' });
  }
  assert.equal(turn.steps.length, 60);
  assert.equal(turn.steps[0].title, '步骤 10');
  assert.equal(turn.steps.at(-1).title, '步骤 69');
});

test('finishing an agent turn persists status and result without accepting unknown states', () => {
  const turn = createAgentTurn({ goal: '检查页面' });
  finishAgentTurn(turn, { status: 'finished', summary: '已经找到总余额。', finishedAt: '2026-10-29T00:00:02.000Z' });
  assert.equal(turn.status, 'finished');
  assert.equal(turn.result, '已经找到总余额。');
  finishAgentTurn(turn, { status: 'unknown', summary: '' });
  assert.equal(turn.status, 'failed');
});

test('message snapshot contains only serializable bounded agent data', () => {
  const turn = createAgentTurn({ goal: '发布内容' });
  appendAgentStep(turn, { kind: 'result', title: '操作完成', detail: 'ok', at: '2026-10-29T00:00:01.000Z' });
  finishAgentTurn(turn, { status: 'finished', summary: '完成' });
  const snapshot = agentTurnForMessage(turn);
  assert.deepEqual(Object.keys(snapshot), [
    'goal', 'status', 'startedAt', 'finishedAt', 'steps', 'result',
  ]);
  assert.equal(snapshot.steps[0].title, '操作完成');
  assert.equal(snapshot.goal, '发布内容');
});

test('fallback summary is factual and does not claim unobserved page state', () => {
  const turn = createAgentTurn({ goal: '找到数据' });
  appendAgentStep(turn, { kind: 'result', title: '已读取页面', detail: '共 14 个交互元素' });
  finishAgentTurn(turn, { status: 'finished', summary: '页面显示总额为 30,192。' });
  const summary = fallbackAgentSummary(turn);
  assert.match(summary, /浏览器任务已完成/);
  assert.match(summary, /页面显示总额为 30,192/);
  assert.match(summary, /执行记录/);
});

test('summary input puts page evidence before the action trace', () => {
  const input = buildAgentSummaryInput({
    goal: '总结 DeepSeek 页面内容',
    evidence: {
      title: 'DeepSeek 网传消息整理',
      url: 'https://chat.deepseek.com/a/chat/123',
      text: '今日网传消息包括 V5 占位符、GPT-6 Astra 等。',
    },
    steps: [
      { title: '观察页面', detail: '发现 46 个交互元素' },
      { title: '完成任务', detail: '摘要完成' },
    ],
    toolSummary: '已提交问题并查看结果',
  });
  assert.ok(input.indexOf('<page_content>') < input.indexOf('执行记录'));
  assert.match(input, /V5 占位符/);
  assert.match(input, /DeepSeek 网传消息整理/);
});

test('balance and model-price facts are recognized as a complete task basis', () => {
  assert.equal(factsCoverBalanceAndModel([
    { text: '当前余额 ¥20.6', source: 'https://ruoli.dev/wallet' },
    { text: 'GPT 模型 输入 ¥0.6 / 1M 输出 ¥3 / 1M', source: 'https://ruoli.dev/pricing' },
  ]), true);
  assert.equal(factsCoverBalanceAndModel([
    { text: '当前余额 ¥20.6', source: 'https://ruoli.dev/wallet' },
  ]), false);
  assert.equal(factsCoverBalanceAndModel([]), false);
});
