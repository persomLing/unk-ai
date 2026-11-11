import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeDeepReading,
  summarizeAccessibilityTree,
  summarizeDomSnapshot,
} from '../src/utils/deep-reading.js';

const axNodes = [
  {
    nodeId: 'root',
    ignored: false,
    role: { value: 'RootWebArea' },
    name: { value: 'Guide' },
    childIds: ['h1', 'p', 'link', 'figure'],
  },
  { nodeId: 'h1', parentId: 'root', ignored: false, role: { value: 'heading' }, name: { value: 'RAG 指南' }, properties: [{ name: 'level', value: { value: 1 } }] },
  { nodeId: 'p', parentId: 'root', ignored: false, role: { value: 'paragraph' }, name: { value: '正文段落' } },
  { nodeId: 'link', parentId: 'root', ignored: false, role: { value: 'link' }, name: { value: '完整报告' } },
  { nodeId: 'figure', parentId: 'root', ignored: false, role: { value: 'img' }, name: { value: '流程图' } },
  { nodeId: 'hidden', parentId: 'root', ignored: true, role: { value: 'heading' }, name: { value: '不应出现' } },
];

test('summarizes the accessibility tree into a bounded semantic outline', () => {
  const result = summarizeAccessibilityTree(axNodes);
  assert.deepEqual(result.nodes.map((node) => node.type), ['heading', 'paragraph', 'link', 'img']);
  assert.equal(result.nodes[0].level, 1);
  assert.equal(result.nodeCount, 6);
  assert.equal(result.includedNodeCount, 4);
  assert.equal(result.truncated, false);
});

test('caps accessibility nodes and characters', () => {
  const result = summarizeAccessibilityTree(axNodes, { maxNodes: 2, maxChars: 10 });
  assert.ok(result.nodes.length <= 2);
  assert.ok(result.chars <= 10);
  assert.equal(result.truncated, true);
});

test('extracts links and images from a DOM snapshot', () => {
  const snapshot = {
    strings: [
      '#document', 'HTML', 'A', 'href', '/report', 'IMG', 'src', '/chart.png',
      'alt', '图表', 'TABLE', 'IFRAME', 'FORM', 'https://example.test/page',
    ],
    documents: [{
      documentURL: 13,
      nodes: {
        nodeName: [0, 1, 2, 5, 10, 11, 12],
        attributes: [[], [], [3, 4], [6, 7, 8, 9], [], [], []],
      },
    }],
  };
  const result = summarizeDomSnapshot(snapshot);
  assert.equal(result.counts.links, 1);
  assert.equal(result.counts.images, 1);
  assert.equal(result.counts.tables, 1);
  assert.equal(result.counts.iframes, 1);
  assert.equal(result.counts.forms, 1);
  assert.equal(result.links[0].href, 'https://example.test/report');
  assert.equal(result.images[0].src, '/chart.png');
});

test('merges deep reading without dropping existing tables or captions', () => {
  const page = {
    title: 'Guide',
    url: 'https://example.test/page',
    text: '正文',
    structure: {
      tables: [{ caption: '指标', headers: ['名称'], rows: [['值']], section: ['结果'] }],
      links: [],
      figures: [],
    },
    figures: [{ type: 'img', caption: '原图注', section: ['结果'] }],
  };
  const merged = mergeDeepReading(page, {
    semanticTree: [{ type: 'heading', level: 1, text: '结果' }],
    ax: { nodeCount: 20 },
    dom: { counts: { nodes: 40, documents: 1 }, links: [{ text: '报告', href: 'https://example.test/report' }], images: [] },
    frameCount: 2,
  });
  assert.equal(merged.structure.tables[0].caption, '指标');
  assert.equal(merged.figures[0].caption, '原图注');
  assert.equal(merged.semanticTreeSource, 'cdp-ax');
  assert.equal(merged.structure.deepReading.source, 'cdp');
  assert.equal(merged.links[0].href, 'https://example.test/report');
  assert.equal(merged.structure.deepReading.frameCount, 2);
});

test('marks failed deep reading as unavailable without replacing ordinary page text', () => {
  const page = {
    title: 'Guide',
    url: 'https://example.test/page',
    text: '普通正文仍可用',
    structure: { tables: [], links: [], figures: [] },
  };
  const merged = mergeDeepReading(page, {
    available: false,
    error: 'DevTools 正在占用此标签页。',
  });
  assert.equal(merged.text, '普通正文仍可用');
  assert.equal(merged.structure.deepReading.source, 'cdp');
  assert.equal(merged.structure.deepReading.available, false);
  assert.match(merged.structure.deepReading.error, /DevTools/);
});

test('deep reading excludes editable values and their descendant draft text', () => {
  const nodes = [
    { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['input', 'editor', 'public'] },
    { nodeId: 'input', parentId: 'root', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'SECRET' } },
    { nodeId: 'editor', parentId: 'root', role: { value: 'generic' }, properties: [{ name: 'editable', value: { value: 'richtext' } }], childIds: ['draft'] },
    { nodeId: 'draft', parentId: 'editor', role: { value: 'paragraph' }, name: { value: 'PRIVATE DRAFT' } },
    { nodeId: 'public', parentId: 'root', role: { value: 'heading' }, name: { value: 'Public article' } },
  ];
  assert.deepEqual(summarizeAccessibilityTree(nodes).nodes.map((node) => node.text), ['Public article']);
});

test('failed or empty deep outlines preserve the ordinary semantic tree and its source', () => {
  const semanticTree = [{ type: 'paragraph', text: 'The current chapter already has readable body text.' }];
  const page = { text: 'Full current article body.', structure: { semanticTree, semanticTreeSource: 'dom' } };
  for (const deep of [{ available: false, error: 'AX timed out' }, { semanticTree: [] }]) {
    const merged = mergeDeepReading(page, deep);
    assert.deepEqual(merged.semanticTree, semanticTree);
    assert.deepEqual(merged.structure.semanticTree, semanticTree);
    assert.equal(merged.semanticTreeSource, 'dom');
    assert.equal(merged.structure.semanticTreeSource, 'dom');
    assert.equal(merged.deepReading.axIncludedNodeCount, 0);
    assert.equal(merged.text, page.text);
  }
});
