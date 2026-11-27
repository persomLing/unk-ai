const MAX_TEXT = 2_000_000;
const MAX_NODES = 20_000;

/** Inline attachment, chart, and table-action UI is not part of the answer's quote offsets. */
export function isArticleDecoration(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return Boolean(
    element?.closest?.('.message-illustrations')
    || element?.closest?.('.generated-image')
    || element?.closest?.('[data-fund-decoration="true"]')
    || element?.closest?.('[data-mermaid-decoration="true"]')
    || element?.closest?.('[data-chart-decoration="true"]')
    || element?.closest?.('[data-reading-decoration="true"]')
    || element?.closest?.('[data-table-decoration="true"]'),
  );
}

export function articleTextSnapshot(body) {
  const stack = [body], nodes = [], parts = [];
  let length = 0, visited = 0;
  while (stack.length) {
    const node = stack.pop();
    if (++visited > 100_000) return null;
    if (!node || isArticleDecoration(node)) continue;
    if (node.nodeType === 3) {
      const value = String(node.nodeValue ?? node.textContent ?? '');
      if (nodes.length >= MAX_NODES || length + value.length > MAX_TEXT) return null;
      nodes.push({ node, start: length, end: length + value.length });
      parts.push(value); length += value.length;
    } else {
      const children = node.childNodes || node.children || [];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
  }
  return { nodes, text: parts.join('') };
}

/** Use the same filtered text for capture and highlighting, including ranges
 * spanning several paragraphs and intervening image/loading containers. */
export function articleTextForRange(range, snapshot) {
  const from = snapshot.nodes.find(entry => entry.node === range.startContainer);
  const to = snapshot.nodes.find(entry => entry.node === range.endContainer);
  if (from && to) return snapshot.text.slice(from.start + range.startOffset, to.start + range.endOffset);
  const parts = [];
  for (const entry of snapshot.nodes) {
    const value = snapshot.text.slice(entry.start, entry.end);
    const start = entry.node === range.startContainer ? range.startOffset
      : range.comparePoint(entry.node, 0) < 0 ? value.length : 0;
    const end = entry.node === range.endContainer ? range.endOffset
      : range.comparePoint(entry.node, value.length) > 0 ? 0 : value.length;
    if (end > start) parts.push(value.slice(start, end));
  }
  return parts.join('');
}
