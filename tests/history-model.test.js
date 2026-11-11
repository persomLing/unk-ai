import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historySelection,
  projectHistory,
  toggleHistorySelection,
} from '../src/sidepanel/features/history/history-model.js';

const entries = [
  { id: 'newest', title: '当前网页价格', updatedAt: '2026-11-05T10:00:00Z', messageCount: 4, pageTitle: 'Cloud docs', pageUrl: 'https://cloud.test/pricing' },
  { id: 'middle', title: '知识库与 RAG', updatedAt: '2026-11-04T10:00:00Z', messageCount: 8, syncStatus: 'pending' },
  { id: 'oldest', title: '设备配置', updatedAt: '2026-11-03T10:00:00Z', messageCount: 2 },
  { id: 'untitled', title: '', updatedAt: '2026-11-02T10:00:00Z', messageCount: 0 },
];

function organization() {
  return {
    version: 1, revision: 2,
    groups: [{ id: 'cloud', name: '云服务' }, { id: 'learning', name: 'AI 学习' }],
    assignments: { newest: 'cloud', middle: 'learning' },
    titles: {},
    preferences: { view: 'groups', collapsed: [] },
  };
}

const ids = list => list.map(entry => entry.id);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test('old conversations without an organization index appear ungrouped and keep input order', () => {
  const source = freeze(structuredClone(entries));
  const result = projectHistory(source, undefined);
  assert.deepEqual(result.groups, [{ id: 'none', name: '未分组' }]);
  assert.deepEqual(ids(result.all), ids(source));
  assert.deepEqual(ids(result.visible), ids(source));
  assert.ok(result.all.every(entry => entry.group === 'none'));
  assert.equal(result.all[3].title, '未命名会话');
  assert.equal(source[3].title, '');
  assert.equal(result.searching, false);
});

test('custom conversation names override stale titles without changing timestamps, ordering or message metadata', () => {
  const source = freeze(structuredClone(entries));
  const index = organization();
  index.titles = { newest: '用户指定的云服务名称', oldest: '设备配置说明' };
  freeze(index);
  const result = projectHistory(source, index);
  assert.deepEqual(ids(result.all), ids(source));
  assert.deepEqual(result.all.map(entry => entry.updatedAt), source.map(entry => entry.updatedAt));
  assert.deepEqual(result.all.map(entry => entry.messageCount), source.map(entry => entry.messageCount));
  assert.equal(result.all[1].syncStatus, 'pending');
  assert.equal(result.all[0].title, '用户指定的云服务名称');
  assert.equal(result.all[2].title, '设备配置说明');
  assert.equal(source[0].title, '当前网页价格');
  assert.notEqual(result.all[0], source[0], 'navigation projection must not mutate shared history entries');
});

test('an assignment to a removed or unknown group safely falls back to ungrouped', () => {
  const index = organization();
  index.assignments.oldest = 'removed-group';
  const result = projectHistory(entries, index);
  assert.deepEqual(result.all.map(entry => entry.group), ['cloud', 'learning', 'none', 'none']);
  assert.deepEqual(result.groups.map(group => group.id), ['cloud', 'learning', 'none']);
});

test('all view is a flat sequence of conversations regardless of collapsed groups', () => {
  const index = organization();
  const result = projectHistory(entries, index, { view: 'all', collapsed: ['cloud', 'learning', 'none'] });
  assert.deepEqual(ids(result.visible), ids(entries));
  assert.deepEqual(ids(result.filtered), ids(entries));
  assert.equal(result.visible.length, entries.length);
  assert.ok(result.visible.every(entry => entries.some(source => source.id === entry.id)), 'group headers are not mixed into the flat entries');
  assert.deepEqual(result.groups.map(group => group.id), ['cloud', 'learning', 'none'], 'move menus retain group destinations in all view');
});

test('group view hides collapsed members while retaining all conversations for selections and counts', () => {
  const result = projectHistory(entries, organization(), { collapsed: new Set(['cloud', 'none']) });
  assert.deepEqual(ids(result.all), ids(entries));
  assert.deepEqual(ids(result.filtered), ids(entries));
  assert.deepEqual(ids(result.visible), ['middle']);
  const selected = historySelection(result, new Set(['newest', 'middle', 'oldest']));
  assert.deepEqual(selected, { ids: ['newest', 'middle', 'oldest'], hidden: 2, allVisible: true });
});

test('search temporarily exposes matching collapsed groups and includes page identity', () => {
  const collapsed = new Set(['cloud', 'learning', 'none']);
  const cloud = projectHistory(entries, organization(), { query: '  CLOUD  ', collapsed });
  assert.equal(cloud.searching, true);
  assert.deepEqual(ids(cloud.filtered), ['newest']);
  assert.deepEqual(ids(cloud.visible), ['newest']);
  const url = projectHistory(entries, organization(), { query: '/PRICING', collapsed });
  assert.deepEqual(ids(url.visible), ['newest']);
  const title = projectHistory(entries, organization(), { query: 'rag', collapsed });
  assert.deepEqual(ids(title.visible), ['middle']);
  assert.deepEqual([...collapsed], ['cloud', 'learning', 'none'], 'search must not rewrite the collapsed preference');
});

test('search uses the renamed title and does not match the obsolete title', () => {
  const index = organization();
  index.titles.oldest = '我的硬件';
  assert.deepEqual(ids(projectHistory(entries, index, { query: '硬件' }).visible), ['oldest']);
  assert.deepEqual(ids(projectHistory(entries, index, { query: '设备配置' }).visible), []);
});

test('search selection summaries retain hidden checked records and discard deleted or duplicate ids', () => {
  const projected = projectHistory(entries, organization(), { query: '设备' });
  const selected = new Set(['newest', 'oldest', 'deleted']);
  const result = historySelection(projected, [...selected, 'newest']);
  assert.deepEqual(result, { ids: ['newest', 'oldest'], hidden: 1, allVisible: true });
  assert.deepEqual([...selected], ['newest', 'oldest', 'deleted'], 'summary does not mutate its input selection');
});

test('switching to all view updates the hidden count without dropping prior selections', () => {
  const selected = new Set(['newest', 'oldest']);
  const grouped = projectHistory(entries, organization(), { view: 'groups', collapsed: ['cloud', 'none'] });
  const flat = projectHistory(entries, organization(), { view: 'all', collapsed: ['cloud', 'none'] });
  assert.equal(historySelection(grouped, selected).hidden, 2);
  assert.deepEqual(historySelection(flat, selected), { ids: ['newest', 'oldest'], hidden: 0, allVisible: false });
});

test('select all current toggles only visible records and preserves checked hidden records', () => {
  const projected = projectHistory(entries, organization(), { view: 'groups', collapsed: ['learning', 'none'] });
  const original = new Set(['middle']);
  const selected = toggleHistorySelection(original, ids(projected.visible));
  assert.deepEqual([...selected], ['middle', 'newest']);
  assert.deepEqual(historySelection(projected, selected), { ids: ['middle', 'newest'], hidden: 1, allVisible: true });
  const cleared = toggleHistorySelection(selected, ids(projected.visible));
  assert.deepEqual([...cleared], ['middle']);
  assert.deepEqual([...original], ['middle']);
  assert.notEqual(selected, original);
});

test('select all completes a partial selection, then deselects the same scope reversibly', () => {
  const scope = ['newest', 'middle', 'oldest'];
  const original = new Set(['middle', 'untitled']);
  const all = toggleHistorySelection(original, scope);
  assert.deepEqual(new Set(all), new Set(['newest', 'middle', 'oldest', 'untitled']));
  const restoredScope = toggleHistorySelection(all, scope);
  assert.deepEqual([...restoredScope], ['untitled']);
  assert.deepEqual([...original], ['middle', 'untitled']);
});

test('empty results do not falsely claim all selected and toggling an empty scope is a no-op', () => {
  const projected = projectHistory(entries, organization(), { query: 'no-such-conversation' });
  const selected = new Set(['newest', 'middle']);
  assert.deepEqual(historySelection(projected, selected), { ids: ['newest', 'middle'], hidden: 2, allVisible: false });
  assert.deepEqual(toggleHistorySelection(selected, []), selected);
});

test('deletion refresh removes only disappeared selected ids while moves preserve selection identity', () => {
  const index = organization();
  const selected = new Set(['newest', 'middle', 'oldest']);
  index.assignments.oldest = 'cloud';
  const moved = projectHistory(entries, index, { collapsed: ['cloud'] });
  assert.deepEqual(historySelection(moved, selected), { ids: ['newest', 'middle', 'oldest'], hidden: 2, allVisible: false });
  const afterDelete = projectHistory(entries.filter(entry => entry.id !== 'middle'), index, { collapsed: ['cloud'] });
  assert.deepEqual(historySelection(afterDelete, selected), { ids: ['newest', 'oldest'], hidden: 2, allVisible: false });
});
