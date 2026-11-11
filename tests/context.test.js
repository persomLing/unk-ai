import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compressionThreshold,
  contextUsageFor,
  estimateTextTokens,
  localDateContext,
  requestMessagesFor,
  splitMessagesForCompression,
  summarizeOlderHistory,
} from '../src/utils/context.js';
import {
  findFigureForPick,
  normalizePageContext,
  pageContextForModel,
  pageContextStats,
} from '../src/utils/reading-context.js';

test('uses a 90 percent compression threshold', () => {
  assert.equal(compressionThreshold(128000), 115200);
  assert.equal(compressionThreshold(1000), 900);
});

test('estimates Chinese text more densely than ASCII punctuation', () => {
  assert.ok(estimateTextTokens('这是一段中文内容') >= 8);
  assert.ok(estimateTextTokens('this is english text') < 12);
});

test('context usage exposes used, remaining and a 90% trigger', () => {
  const conversation = {
    messages: [
      { id: 'u1', role: 'user', content: '中文内容'.repeat(6000), status: 'complete' },
    ],
  };
  const usage = contextUsageFor(conversation, undefined, null, 20000);
  assert.equal(usage.total, 20000);
  assert.equal(usage.threshold, 18000);
  assert.ok(usage.percent > 90);
  assert.ok(usage.remainingPercent < 10);
  assert.equal(usage.shouldCompress, true);
  assert.equal(usage.messages.length, 2);
});

test('local date questions receive computed Beijing time instead of triggering web search', () => {
  const messages = requestMessagesFor({ messages: [
    { id: 'u', role: 'user', content: '现在是几月几号', status: 'complete' },
  ] });
  assert.match(messages.find(message => message.content.includes('当前本地时间')).content, /北京时间/);
  assert.match(localDateContext(new Date('2026-11-03T02:58:00Z')), /2026年11月3日 星期二 10:58/);
});

test('empty conversations never trigger compression', () => {
  const usage = contextUsageFor({ messages: [] }, undefined, null, 1000);
  assert.equal(usage.shouldCompress, false);
});

test('compression keeps recent messages and moves older content aside', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index} ${'content '.repeat(100)}`,
    status: 'complete',
  }));
  const { older, recent } = splitMessagesForCompression({ messages }, undefined, 4000);
  assert.ok(older.length > 0);
  assert.ok(recent.length > 0);
  assert.equal(older.length + recent.length, messages.length);
  assert.equal(recent.at(-1).id, messages.at(-1).id);
});

test('only older history is summarized once recent messages fill the budget', () => {
  const messages = [
    { id: 'old', role: 'user', content: 'old '.repeat(3000), status: 'complete' },
    { id: 'recent', role: 'assistant', content: 'recent reply', status: 'complete' },
    { id: 'new', role: 'user', content: 'latest question', status: 'complete' },
  ];
  const older = summarizeOlderHistory({ messages }, undefined, 8000);
  assert.deepEqual(older.map((message) => message.id), ['old']);
});

test('page context gives the model an outline and an explicit figure index', () => {
  const messages = requestMessagesFor({ messages: [] }, undefined, {
    title: 'AI Agent 指南',
    url: 'https://example.test/guide',
    text: '正文',
    sections: [{ level: 1, text: '问题诊断' }, { level: 2, text: 'RAG' }],
    figures: [{
      type: 'canvas',
      section: ['问题诊断'],
      caption: '从提示词、RAG、微调到智能体的方案诊断关系图',
      nearby: '不同方案对应的落地路径',
    }],
  });
  const content = messages[1].content;
  assert.match(content, /<page_outline>/);
  assert.match(content, /问题诊断/);
  assert.match(content, /<figure_index>/);
  assert.match(content, /方案诊断关系图/);
  assert.match(content, /不包含图片像素/);
});

test('page context omits the figure index when a page has no figures', () => {
  const messages = requestMessagesFor({ messages: [] }, undefined, {
    title: 'Plain page',
    url: 'https://example.test/plain',
    text: 'Only text',
    sections: [],
    figures: [],
  });
  assert.doesNotMatch(messages[1].content, /<figure_index>/);
  assert.match(messages[1].content, /Only text/);
});

test('page outline preserves heading hierarchy for chapter-level questions', () => {
  const messages = requestMessagesFor({ messages: [] }, undefined, {
    title: 'Guide',
    url: 'https://example.test/guide',
    text: 'Body',
    sections: [
      { level: 1, text: 'AI Agent' },
      { level: 2, text: '问题诊断' },
      { level: 3, text: 'RAG' },
      { level: 2, text: '落地' },
    ],
    figures: [],
  });
  const content = messages[1].content;
  assert.match(content, /1\. AI Agent/);
  assert.match(content, / {2}2\. 问题诊断/);
  assert.match(content, / {4}3\. RAG/);
});

test('richer reading context is serialized without requiring optional fields', () => {
  const page = normalizePageContext({
    title: 'Reading context',
    url: 'https://example.test/reading',
    text: 'Body',
    semanticTree: [{ type: 'heading', level: 1, text: 'Overview' }],
    sections: [{ level: 1, text: 'Overview' }],
    tables: [{
      caption: 'Results',
      section: ['Overview'],
      headers: ['Model', 'Score'],
      rows: [['A', '0.9']],
    }],
    links: [{ text: 'Paper', href: 'https://example.test/paper', section: ['Overview'] }],
    structure: {
      forms: [{ label: 'Search', fields: [{ name: 'query', label: 'Keyword' }] }],
    },
    figures: [{
      type: 'image',
      caption: 'Architecture',
      section: ['Overview'],
      alt: 'Pipeline diagram',
    }],
  });
  const content = pageContextForModel(page);
  assert.match(content, /<page_outline>/);
  assert.match(content, /<semantic_tree>/);
  assert.match(content, /<table_index>/);
  assert.match(content, /Model \| Score/);
  assert.match(content, /<links_index>/);
  assert.match(content, /<form_index>/);
  assert.match(content, /Search：Keyword/);
  assert.match(content, /figure-1：Architecture/);
  assert.deepEqual(pageContextStats(page), {
    chars: 4,
    outline: 1,
    semanticNodes: 1,
    tables: 1,
    links: 1,
    figures: 1,
    forms: 1,
    pdfPages: 0,
    pdfPagesRead: 0,
    truncated: false,
  });
});

test('optional visual metadata associates a captured figure with its caption and section', () => {
  const page = normalizePageContext({
    title: 'Guide',
    url: 'https://example.test/guide',
    text: 'Body',
    figures: [{ id: 'chart-a', caption: 'Latency chart', section: ['Results'] }],
  });
  const figure = findFigureForPick(page, { figureId: 'chart-a', label: 'Latency chart' });
  assert.equal(figure.id, 'chart-a');
  assert.deepEqual(figure.section, ['Results']);
});

test('page context without richer fields still uses the existing extractor shape', () => {
  const page = normalizePageContext({
    title: 'Legacy',
    url: 'https://example.test/legacy',
    text: 'Legacy body',
    sections: [{ level: 1, text: 'Only heading' }],
    figures: [],
  });
  assert.equal(page.semanticTreeSource, 'outline');
  assert.deepEqual(page.tables, []);
  assert.deepEqual(page.links, []);
  assert.match(pageContextForModel(page), /Legacy body/);
});

test('PDF attachment text is inlined as a document instead of a base64 file part', () => {
  const conversation = {
    messages: [{
      id: 'u1',
      role: 'user',
      content: '总结这个 PDF',
      status: 'complete',
      attachments: [{
        id: 'a1',
        type: 'document',
        name: 'report.pdf',
        size: 1024,
        text: '[第 1 页]\nPDF body',
        chars: 18,
        pages: 1,
      }],
    }],
  };
  const messages = requestMessagesFor(conversation, undefined, null);
  const user = messages.at(-1);
  assert.equal(typeof user.content, 'string');
  assert.match(user.content, /<attachment name="report.pdf">/);
  assert.match(user.content, /PDF body/);
  assert.doesNotMatch(user.content, /file_data/);
});

test('legacy file attachments are serialized without crashing on ordering', () => {
  const conversation = {
    messages: [{
      id: 'u1',
      role: 'user',
      content: '旧附件',
      status: 'complete',
      attachments: [{
        id: 'a1',
        type: 'file',
        name: 'legacy.pdf',
        dataUrl: 'data:application/pdf;base64,AAAA',
      }],
    }],
  };
  const messages = requestMessagesFor(conversation, undefined, null);
  const user = messages.at(-1);
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[1].type, 'file');
  assert.equal(user.content[1].file.filename, 'legacy.pdf');
});
