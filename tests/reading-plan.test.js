import test from 'node:test';
import assert from 'node:assert/strict';
import { readingPolicyForTurn, readingPolicyForRetry, scoreReadingCandidate } from '../src/utils/reading-plan.js';

test('ordinary MCP requests select auto reading without a separate research switch', () => {
  assert.deepEqual(readingPolicyForTurn({ question: '找到 MCP 章节并总结' }), { version: 1, scope: 'auto', intent: 'read', reason: 'explicit-site-question', requireCurrentPage: true });
  assert.equal(readingPolicyForTurn({ question: '本站哪里讲 MCP' }).intent, 'locate');
  assert.equal(readingPolicyForTurn({ question: '解释 MCP 是什么', pageTitle: '第 20 章 MCP 模型上下文协议' }).scope, 'auto');
});

test('page mode includes the current body without inventing a related-site request', () => {
  const pageTitle = '第 1-3 章 RAG、微调、续训与智能体选型';
  for (const question of ['现在社区解决codex生图接入外部模型了嘛', '不能用api的方法嘛']) {
    assert.deepEqual(readingPolicyForTurn({ question, pageTitle }), {
      version: 1, scope: 'page', intent: 'read', reason: 'page-mode-enabled', requireCurrentPage: true,
    });
  }
});

test('page off, direct and operation requests do not use ordinary webpage reading', () => {
  for (const input of [
    { question: '找 MCP 章节', pageContextEnabled: false },
    { question: '找 MCP 章节', directModelRequest: true },
    { question: '找 MCP 章节', mode: 'page-operation' },
  ]) assert.equal(readingPolicyForTurn(input).scope, 'none');
});

test('small talk and attachments cannot silently disable a selected page mode', () => {
  for (const input of [{ question: '你好' }, { question: '总结附件里的 MCP', attachments: [{ type: 'document' }] }]) {
    const policy = readingPolicyForTurn(input);
    assert.equal(policy.scope, 'page');
    assert.equal(policy.requireCurrentPage, true);
  }
});

test('local and selected-passage requests keep their local scope', () => {
  assert.equal(readingPolicyForTurn({ question: '总结这页' }).scope, 'page');
  assert.equal(readingPolicyForTurn({ question: '只解释选中段落', selection: { text: 'MCP content' } }).scope, 'page');
  assert.equal(readingPolicyForTurn({ question: '只看当前页的 MCP 内容' }).scope, 'page');
  assert.equal(readingPolicyForTurn({ question: '这份文档有哪些容易忽略的使用前提？' }).scope, 'page');
  assert.equal(readingPolicyForTurn({ question: '解释当前网页的主要观点' }).scope, 'page');
  assert.equal(readingPolicyForTurn({ question: '找 MCP 章节并总结', selection: { text: 'MCP' } }).scope, 'auto');
});

test('retry retains recorded sources and never upgrades a legacy ordinary message to auto reading', () => {
  const policy = { version: 1, scope: 'auto', intent: 'read', reason: 'test', baseUrl: 'https://docs.example.com/#/intro', planned: true, selectedUrls: ['https://docs.example.com/#/20-mcp'] };
  assert.deepEqual(readingPolicyForRetry({ readingPolicy: policy, pageContextEnabled: true }), policy);
  assert.equal(readingPolicyForRetry({ pageContextEnabled: true, researchEnabled: false }).scope, 'page');
  assert.equal(readingPolicyForRetry({ pageContextEnabled: true, researchEnabled: true }).scope, 'site');
  assert.equal(readingPolicyForRetry({ pageContextEnabled: false, researchEnabled: true }).scope, 'none');
  assert.equal(readingPolicyForRetry({ content: 'Old general question' }).scope, 'none');
});

test('selection requires actual complete topic terms or an explicit chapter number', () => {
  assert.ok(scoreReadingCandidate('找到 MCP 章节并总结', { title: '第 20 章 MCP 模型上下文协议' }) > 100);
  assert.equal(scoreReadingCandidate('找到 MCP 章节并总结', { title: '第 1 章 大模型概述' }), 0);
  assert.equal(scoreReadingCandidate('总结网站相关内容', { title: '第 8 章 网络内容介绍' }), 0);
  assert.ok(scoreReadingCandidate('阅读第 20 章', { title: '第 20 章 MCP 模型上下文协议' }) >= 300);
});

test('explicit chapter numbers constrain matching instead of merely boosting weak topical links', () => {
  const query = '找到第20章MCP模型上下文协议并总结';
  assert.ok(scoreReadingCandidate(query, { title: '第 20 章 MCP 模型上下文协议' }) > 0);
  for (const title of ['第 1 章 大模型认知与工程概览', '12-召回信息合并与上下文构建', '第 21 章 MCP 和 Agent']) {
    assert.equal(scoreReadingCandidate(query, { title }), 0);
  }
  assert.ok(scoreReadingCandidate('对比第20章和第21章', { title: '第 21 章 Agent' }) > 0);
});

test('complete MCP names do not match generic model or context titles', () => {
  for (const query of ['找到模型上下文协议章节并总结', 'Explain the Model Context Protocol']) {
    assert.ok(scoreReadingCandidate(query, { title: '第 20 章 MCP 模型上下文协议' }) > 0);
    assert.ok(scoreReadingCandidate(query, { title: 'Model Context Protocol' }) > 0);
    for (const title of ['第 1 章 大模型认知与工程概览', '12-召回信息合并与上下文构建', 'Model engineering', 'Context construction']) {
      assert.equal(scoreReadingCandidate(query, { title }), 0);
    }
  }
});
