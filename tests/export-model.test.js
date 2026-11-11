import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportSnapshot, selectExportSnapshot, exportSelectionIssue, exportFilename } from '../src/sidepanel/features/export/export-model.js';

function conversation(count = 3) {
  return { id: 'c-123', title: '价格对比', config: { apiKey: 'secret' }, pageContext: { content: 'hidden page' },
    messages: Array.from({ length: count }, (_, index) => [
      { id: `u${index}`, role: 'user', displayContent: `问题 ${index}`, content: 'hidden model prompt',
        attachments: [{ name: 'report.txt', type: 'document', content: 'private attachment text' }] },
      { id: `a${index}`, role: 'assistant', content: `## 回答 ${index}`, status: 'complete', reasoning: 'hidden reasoning', suggestions: ['hidden suggestion'], agent: { steps: ['hidden step'] } },
    ]).flat() };
}

test('export snapshot preserves visible content and excludes model-only/private fields', () => {
  const original = conversation();
  const snapshot = createExportSnapshot(original);
  const json = JSON.stringify(snapshot);
  for (const hidden of ['secret', 'hidden page', 'hidden model prompt', 'private attachment text', 'hidden reasoning', 'hidden suggestion', 'hidden step']) assert.ok(!json.includes(hidden), hidden);
  assert.equal(snapshot.turns[0].user.content, '问题 0');
  assert.equal(snapshot.turns[0].user.attachments[0].name, 'report.txt');
  original.messages[0].displayContent = 'changed';
  original.messages[1].content = 'later delta';
  original.messages[0].attachments[0].name = 'changed';
  assert.equal(snapshot.turns[0].user.content, '问题 0');
  assert.equal(snapshot.turns[0].assistant.content, '## 回答 0');
  assert.equal(snapshot.turns[0].user.attachments[0].name, 'report.txt');
  assert.ok(Object.isFrozen(snapshot.turns[0].user.attachments));
});

test('noncontiguous selection stays in original turn order and deduplicates IDs', () => {
  const snapshot = createExportSnapshot(conversation());
  const chosen = selectExportSnapshot(snapshot, ['turn-3', 'turn-1', 'turn-3']);
  assert.deepEqual(chosen.turns.map(turn => turn.index), [1, 3]);
  assert.equal(snapshot.turns.length, 3);
  assert.throws(() => selectExportSnapshot(snapshot, ['missing']), /失效/);
  assert.throws(() => selectExportSnapshot(snapshot, []), /至少选择/);
});

test('unfinished replies retain visible state, and a waiting question is selectable', () => {
  const original = conversation();
  original.messages[1].status = 'error';
  original.messages[1].errorMessage = '连接中断';
  original.messages[3].status = 'streaming';
  original.messages.pop();
  const snapshot = createExportSnapshot(original);
  assert.equal(snapshot.turns[0].assistant.status, 'error');
  assert.equal(snapshot.turns[0].assistant.errorMessage, '连接中断');
  assert.equal(snapshot.turns[1].assistant.status, 'streaming');
  assert.equal(snapshot.turns[2].assistant, null);
});

test('snapshots only keep safe source URLs and local raster attachments', () => {
  const original = conversation(1);
  original.messages[0].attachments = [
    { name: 'image.png', type: 'image', dataUrl: 'data:image/png;base64,YQ==' },
    { name: 'remote.png', type: 'image', dataUrl: 'https://host/track' },
    { name: 'bad.svg', type: 'image', dataUrl: 'data:image/svg+xml;base64,YQ==' },
  ];
  original.messages[1].sources = [{ url: 'https://example.com/page', title: '来源' }, { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.com' }];
  const turn = createExportSnapshot(original).turns[0];
  assert.ok(turn.user.attachments[0].dataUrl);
  assert.equal(turn.user.attachments[1].dataUrl, undefined);
  assert.equal(turn.user.attachments[1].type, 'image', 'unavailable image remains an explicit image placeholder');
  assert.equal(turn.user.attachments[2].dataUrl, undefined);
  assert.deepEqual(turn.assistant.sources, [{ title: '来源', url: 'https://example.com/page' }]);
});

test('size limits reject oversized selections without truncating source content', () => {
  const original = conversation(51);
  const snapshot = createExportSnapshot(original);
  assert.match(exportSelectionIssue(snapshot, snapshot.turns.map(turn => turn.id)), /50 轮/);
  assert.equal(exportSelectionIssue(snapshot, ['turn-1']), '');
  original.messages[1].content = '中'.repeat(120_001);
  const large = createExportSnapshot(original);
  assert.match(exportSelectionIssue(large, ['turn-1']), /12 万/);
  assert.equal(large.turns[0].assistant.content.length, 120_001);
});

test('answer-only export budgets exclude hidden questions and their images', () => {
  const original = conversation(1);
  original.messages[0].displayContent = '问'.repeat(120_001);
  const snapshot = createExportSnapshot(original);
  assert.match(exportSelectionIssue(snapshot, ['turn-1']), /12 万/);
  assert.equal(exportSelectionIssue(snapshot, ['turn-1'], { includeQuestions: false }), '');
});

test('filenames keep Chinese titles and reject unsupported extensions', () => {
  assert.equal(exportFilename({ title: '价格/对比?', id: 'c-123' }, 'png'), '价格-对比--c-123.png');
  assert.match(exportFilename({ title: 'CON', id: 'abc' }, 'pdf'), /^对话-CON/);
  assert.throws(() => exportFilename({ title: 'title' }, 'exe'), /不支持/);
});
