import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
}).enable(['table', 'strikethrough']);

markdown.renderer.rules.table_open = () => '<div class="md-table-scroll" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

/**
 * Render CommonMark plus GFM tables and strikethrough. Raw HTML stays disabled;
 * DOMPurify sanitizes the result again before it reaches the side panel.
 */
export function renderMarkdown(source) {
  if (source === null || source === undefined) return '';
  return markdown.render(String(source));
}