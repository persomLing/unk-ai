import DOMPurify from 'dompurify';
import { renderMarkdown } from '../../../utils/markdown.js';

const MAX_SOURCE_CHARS = 12000;
const MAX_VISIBLE_CHARS = 220;
const PREVIEW_MARKDOWN = {
  ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'del',
    'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: [],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

/** Keep Markdown structure intact until it has been parsed; bound hover work. */
export function turnPreviewMarkup(content) {
  return renderMarkdown(String(content ?? '').slice(0, MAX_SOURCE_CHARS));
}

/** A read-only excerpt: link labels remain, without navigation or remote media. */
export function renderTurnPreview(container, content) {
  const source = String(content ?? '');
  const fragment = DOMPurify.sanitize(turnPreviewMarkup(source), PREVIEW_MARKDOWN);
  const document = container.ownerDocument;
  const walker = document.createTreeWalker(fragment, document.defaultView.NodeFilter.SHOW_TEXT);
  let remaining = MAX_VISIBLE_CHARS, clipped = false, node;
  while ((node = walker.nextNode())) {
    const characters = Array.from(node.nodeValue);
    if (characters.length <= remaining) { remaining -= characters.length; continue; }
    node.nodeValue = characters.slice(0, remaining).join('').trimEnd() + '…';
    // Remove later siblings at every level, keeping the parsed ancestor tags.
    // This avoids cutting a link/strong/code delimiter or leaving empty blocks.
    for (let last = node; last !== fragment; last = last.parentNode) {
      while (last.nextSibling) last.nextSibling.remove();
    }
    clipped = true;
    break;
  }
  if (!clipped && source.length > MAX_SOURCE_CHARS) fragment.append(document.createTextNode('…'));
  container.replaceChildren(fragment);
}
