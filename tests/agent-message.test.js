import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentTurnForMessage,
  appendAgentStep,
  createAgentTurn,
  finishAgentTurn,
} from '../src/utils/agent-conversation.js';
import { agentPanelMarkup } from '../src/sidepanel/features/messages/agent-message-view.js';
import { exportConversationMarkdown } from '../src/utils/exporter.js';

test('agent messages render progress and final summary in the normal assistant bubble', () => {
  const turn = createAgentTurn({
    goal: '查看控制台余额',
    taskId: 'task-1',
    startedAt: '2026-10-29T00:00:00.000Z',
  });
  appendAgentStep(turn, {
    kind: 'action',
    title: '点击「总览看板」',
    detail: '页面已进入总览',
    at: '2026-10-29T00:00:01.000Z',
  });
  finishAgentTurn(turn, {
    status: 'finished',
    summary: '已完成查看并找到总余额。',
    finishedAt: '2026-10-29T00:00:02.000Z',
  });
  const message = {
    id: 'assistant-1',
    role: 'assistant',
    content: turn.result,
    status: 'complete',
    createdAt: '2026-10-29T00:00:02.000Z',
    agent: agentTurnForMessage(turn),
  };
  const html = agentPanelMarkup(message.agent);
  assert.match(html, /浏览器任务/);
  assert.match(html, /查看控制台余额/);
  assert.match(html, /点击「总览看板」/);
  assert.match(html, /已完成查看并找到总余额/);
  assert.doesNotMatch(html, /agent-card-actions/);
});

test('agent message remains renderable before completion', () => {
  const turn = createAgentTurn({ goal: '打开页面', taskId: 'task-live' });
  appendAgentStep(turn, { kind: 'observe', title: '读取页面中' });
  const html = agentPanelMarkup(agentTurnForMessage(turn));
  assert.match(html, /正在执行/);
  assert.match(html, /读取页面中/);
});

test('agent progress and summary are included in Markdown export', () => {
  const turn = createAgentTurn({ goal: '检查控制台' });
  appendAgentStep(turn, { kind: 'action', title: '打开控制台', detail: '成功' });
  finishAgentTurn(turn, { status: 'finished', summary: '控制台已检查完成。' });
  const { content } = exportConversationMarkdown({
    id: 'conversation-1',
    title: '检查控制台',
    createdAt: '2026-10-29T00:00:00.000Z',
    messages: [{
      id: 'assistant-1',
      role: 'assistant',
      content: turn.result,
      status: 'complete',
      agent: agentTurnForMessage(turn),
    }],
  });
  assert.match(content, /Browser task: 检查控制台/);
  assert.match(content, /打开控制台/);
  assert.match(content, /控制台已检查完成/);
});

test('paused takeover renders continue and stop inside the conversation', () => {
  const html = agentPanelMarkup({
    taskId: 'task-paused',
    goal: '查看控制台',
    status: 'paused',
    steps: [{
      kind: 'warning',
      title: '需要你接管',
      detail: '你点击了页面，已暂停自动操作。',
    }],
  });
  assert.match(html, /已暂停/);
  assert.match(html, /data-agent-action="resume"/);
  assert.match(html, /继续任务/);
  assert.match(html, /data-agent-action="stop"/);
  assert.match(html, /结束任务/);
});

test('running agent is open and fixed-height while finished agent collapses', () => {
  const running = agentPanelMarkup({
    taskId: 'task-running',
    goal: '查看余额',
    status: 'running',
    steps: [{ kind: 'observe', title: '读取页面' }],
  });
  assert.match(running, /message-agent is-running/);
  assert.match(running, /<details class="message-agent-details" open>/);

  const finished = agentPanelMarkup({
    taskId: 'task-finished',
    goal: '查看余额',
    status: 'finished',
    steps: [{ kind: 'result', title: '任务完成' }],
    result: '页面显示余额为 30,192。',
  });
  assert.match(finished, /message-agent is-collapsed/);
  assert.doesNotMatch(finished, /<details class="message-agent-details" open>/);
  assert.match(finished, /页面显示余额为 30,192/);
});
