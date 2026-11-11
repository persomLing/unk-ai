import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false })
  .enable(['table', 'strikethrough']);

// Keep TeX as readable source instead of letting Markdown consume its escapes
// and underscores. Code spans/fences are already separate parser tokens.
markdown.inline.ruler.before('escape', 'copy_math', (state, silent) => {
  const start = state.pos;
  const source = state.src;
  const opening = source.startsWith('$$', start) ? '$$'
    : source.startsWith('\\(', start) ? '\\('
      : source.startsWith('\\[', start) ? '\\['
        : source[start] === '$' ? '$' : '';
  if (!opening) return false;
  const closing = opening === '\\(' ? '\\)' : opening === '\\[' ? '\\]' : opening;
  const from = start + opening.length;
  let end = source.indexOf(closing, from);
  while (end !== -1 && source[end - 1] === '\\') end = source.indexOf(closing, end + closing.length);
  if (end === -1 || end + closing.length > state.posMax) return false;
  const content = source.slice(from, end);
  if (!content.trim()) return false;
  if (opening === '$' && (/^\s|\s$|\n/.test(content) || /\d/.test(source[end + 1] || ''))) return false;
  if (!silent) state.push('copy_math', '', 0).content = content.trim();
  state.pos = end + closing.length;
  return true;
});

function inlineText(tokens = []) {
  let text = '';
  const links = [];
  for (const token of tokens) {
    if (token.type === 'link_open') {
      links.push({ start: text.length, url: token.attrGet('href') || '' });
    } else if (token.type === 'link_close') {
      const link = links.pop();
      if (link?.url && text.slice(link.start) !== link.url) text += ` (${link.url})`;
    } else if (token.type === 'image') {
      const label = inlineText(token.children) || token.content || '';
      const url = token.attrGet('src') || '';
      text += label + (url && label !== url ? `${label ? ' ' : ''}(${url})` : '');
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      text += '\n';
    } else if (token.children) {
      text += inlineText(token.children);
    } else if (token.nesting === 0) {
      text += token.content || '';
    }
  }
  return text;
}

function blockTree(tokens) {
  const root = { children: [] };
  const stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      stack.pop();
      continue;
    }
    const node = { type: token.type.replace(/_open$/, ''), token, children: [] };
    stack.at(-1).children.push(node);
    if (token.nesting === 1) stack.push(node);
  }
  return root.children;
}

function renderBlocks(nodes, { listItem = false } = {}) {
  let result = '';
  let previous;
  for (const node of nodes) {
    const content = renderBlock(node);
    if (!content) continue;
    const besideNestedList = listItem && (node.type.endsWith('_list') || previous?.type.endsWith('_list'));
    if (result) result += besideNestedList ? '\n' : '\n\n';
    result += content;
    previous = node;
  }
  return result;
}

function renderTable(node) {
  const rows = [];
  function visit(current) {
    if (current.type === 'tr') {
      rows.push(current.children.map(cell => renderBlocks(cell.children)).join('\t'));
    } else current.children.forEach(visit);
  }
  visit(node);
  return rows.join('\n');
}

function renderBlock(node) {
  if (node.type === 'inline') return inlineText(node.token.children);
  if (node.type === 'fence' || node.type === 'code_block') {
    // Markdown-it adds one terminal newline to code blocks. Keep all code
    // characters, indentation and interior blank lines, without a fence.
    return node.token.content.replace(/\n$/, '');
  }
  if (node.type === 'table') return renderTable(node);
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    let number = Number(node.token.attrGet('start')) || 1;
    return node.children.map(item => {
      const prefix = node.type === 'ordered_list' ? `${number++}. ` : '• ';
      const content = renderBlocks(item.children, { listItem: true });
      return content.split('\n').map((line, index) => `${index ? ' '.repeat(prefix.length) : prefix}${line}`).join('\n');
    }).join('\n');
  }
  if (node.children.length) return renderBlocks(node.children);
  return node.token.content || '';
}

/** Plain clipboard text preserves structure and destinations, without HTML or DOM access. */
export function markdownToPlainText(value) {
  return renderBlocks(blockTree(markdown.parse(String(value ?? ''), {})));
}

/** Capture strings once so later streaming updates cannot change a copy choice. */
export function messageCopyContent(message) {
  const body = String(message?.content ?? '');
  const reasoning = String(message?.reasoning ?? '');
  const reasoningOnly = !body.trim() && Boolean(reasoning.trim());
  const source = body.trim() ? body : reasoningOnly ? reasoning : '';
  return { markdown: source, plainText: markdownToPlainText(source), reasoningOnly };
}
