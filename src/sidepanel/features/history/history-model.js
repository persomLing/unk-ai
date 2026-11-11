/** Organizing history changes its navigation only, never the message snapshots. */
export function projectHistory(entries, organization, { query = '', view = 'groups', collapsed = [] } = {}) {
  const groups = [...(organization?.groups || []), { id: 'none', name: '未分组' }];
  const known = new Set(groups.map(group => group.id));
  const folded = new Set(collapsed);
  const needle = query.trim().toLocaleLowerCase();
  const all = entries.map(entry => {
    const assigned = organization?.assignments?.[entry.id];
    return { ...entry, title: organization?.titles?.[entry.id] || entry.title || '未命名会话',
      group: known.has(assigned) ? assigned : 'none' };
  });
  const filtered = all.filter(entry => !needle || [entry.title, entry.pageTitle, entry.pageUrl]
    .some(value => String(value || '').toLocaleLowerCase().includes(needle)));
  const visible = filtered.filter(entry => view === 'all' || needle || !folded.has(entry.group));
  return { all, filtered, visible, groups, searching: Boolean(needle) };
}

export function historySelection(projected, selected) {
  const existing = new Set(projected.all.map(entry => entry.id));
  const visible = new Set(projected.visible.map(entry => entry.id));
  const ids = [...new Set(selected)].filter(id => existing.has(id));
  return { ids, hidden: ids.filter(id => !visible.has(id)).length,
    allVisible: visible.size > 0 && [...visible].every(id => ids.includes(id)) };
}

export function toggleHistorySelection(selected, ids) {
  const next = new Set(selected);
  const remove = ids.length > 0 && ids.every(id => next.has(id));
  ids.forEach(id => remove ? next.delete(id) : next.add(id));
  return next;
}
