import MarkdownIt from 'markdown-it';

function isCjkWordChar(code) {
  return (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0x3040 && code <= 0x30FF)
    || (code >= 0x31F0 && code <= 0x31FF)
    || (code >= 0xAC00 && code <= 0xD7AF)
    || (code >= 0x1100 && code <= 0x11FF)
    || (code >= 0x3130 && code <= 0x318F)
    || (code >= 0x20000 && code <= 0x2CEAF)
    || (code >= 0x30000 && code <= 0x323AF);
}

function isCjkPunctChar(code) {
  return (code >= 0x3001 && code <= 0x303F)
    || (code >= 0xFF01 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFEE)
    || (code >= 0x2018 && code <= 0x201F)
    || code === 0x00B7
    || code === 0x2014
    || code === 0x2026;
}

function charBefore(src, start) {
  if (start <= 0) return 0x20;
  const code = src.charCodeAt(start - 1);
  if ((code & 0xFC00) === 0xDC00 && start >= 2) {
    const high = src.charCodeAt(start - 2);
    if ((high & 0xFC00) === 0xD800) return src.codePointAt(start - 2);
    return 0xFFFD;
  }
  if ((code & 0xFC00) === 0xD800) return 0xFFFD;
  return code;
}

function charAt(src, pos, posMax) {
  if (pos >= posMax) return 0x20;
  const code = src.charCodeAt(pos);
  if ((code & 0xFC00) === 0xD800 && pos + 1 < posMax) {
    const low = src.charCodeAt(pos + 1);
    if ((low & 0xFC00) === 0xDC00) return src.codePointAt(pos);
    return 0xFFFD;
  }
  if ((code & 0xFC00) === 0xDC00) return 0xFFFD;
  return code;
}

/**
 * Relax CommonMark punctuation flanking for `*` / `~` adjacent to CJK text or
 * CJK punctuation (e.g. `都是**“模型...”**的工具`) without altering `_` or English math.
 */
export function cjkFriendlyEmphasis(md) {
  const BaseState = md.inline.State;
  const { isMdAsciiPunct, isPunctCharCode, isWhiteSpace } = md.utils;

  function CjkStateInline(src, parser, env, outTokens) {
    BaseState.call(this, src, parser, env, outTokens);
  }
  CjkStateInline.prototype = Object.create(BaseState.prototype);
  CjkStateInline.prototype.constructor = CjkStateInline;
  CjkStateInline.Token = BaseState.Token;

  CjkStateInline.prototype.scanDelims = function scanDelims(start, canSplitWord) {
    const base = BaseState.prototype.scanDelims.call(this, start, canSplitWord);
    const marker = this.src.charCodeAt(start);
    if ((marker !== 0x2A && marker !== 0x7E) || (base.can_open && base.can_close)) return base;

    const lastChar = charBefore(this.src, start);
    const nextChar = charAt(this.src, start + base.length, this.posMax);
    const isLastWs = isWhiteSpace(lastChar);
    const isNextWs = isWhiteSpace(nextChar);
    const isLastPunct = isMdAsciiPunct(lastChar) || isPunctCharCode(lastChar);
    const isNextPunct = isMdAsciiPunct(nextChar) || isPunctCharCode(nextChar);

    let canOpen = base.can_open;
    let canClose = base.can_close;

    if (!canOpen && !isNextWs) {
      if ((isCjkWordChar(lastChar) && isNextPunct) || (!isLastWs && isCjkPunctChar(nextChar))) {
        canOpen = true;
      }
    }
    if (!canClose && !isLastWs) {
      if ((isLastPunct && isCjkWordChar(nextChar)) || (isCjkPunctChar(lastChar) && !isNextWs)) {
        canClose = true;
      }
    }
    return { can_open: canOpen, can_close: canClose, length: base.length };
  };

  md.inline.State = CjkStateInline;
}

const DETAILS_OPEN_RE = /^<details(\s+open(?:\s*=\s*(?:""|''|"open"|'open'|true))?)?\s*>([\s\S]*)$/i;
const DETAILS_TAG_OPEN_RE = /<details(?:\s+open(?:\s*=\s*(?:""|''|"open"|'open'|true))?)?\s*>/gi;
const SUMMARY_INLINE_RE = /^\s*<summary>([\s\S]*?)<\/summary>([\s\S]*)$/i;

function emitInlineParagraph(state, text, line) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const open = state.push('paragraph_open', 'p', 1);
  open.map = [line, line + 1];
  const inline = state.push('inline', '', 0);
  inline.content = trimmed;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push('paragraph_close', 'p', -1);
}

/**
 * Safely parse standard Markdown `<details><summary>...</summary>...</details>` blocks
 * while keeping `html: false` across the parser (rejecting arbitrary attributes/tags).
 */
export function safeDetailsBlock(md) {
  md.block.ruler.after('fence', 'safe_details', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const startMax = state.eMarks[startLine];
    const firstLine = state.src.slice(startPos, startMax);
    const openMatch = firstLine.match(DETAILS_OPEN_RE);
    if (!openMatch) return false;

    const isOpen = Boolean(openMatch[1]);
    const remainder = openMatch[2] || '';

    let closingLine = -1;
    let inlineContent = '';
    const sameLineClose = remainder.match(/^([\s\S]*?)<\/details>\s*$/i);
    if (sameLineClose && !/<details\b/i.test(sameLineClose[1])) {
      closingLine = startLine;
      inlineContent = sameLineClose[1];
    } else {
      let depth = 1;
      for (let line = startLine + 1; line < endLine; line++) {
        const lPos = state.bMarks[line] + state.tShift[line];
        const lMax = state.eMarks[line];
        const lineText = state.src.slice(lPos, lMax);
        const opens = (lineText.match(DETAILS_TAG_OPEN_RE) || []).length;
        const closes = (lineText.match(/<\/details>/gi) || []).length;
        depth += opens - closes;
        if (depth <= 0) {
          closingLine = line;
          break;
        }
      }
    }

    if (silent) return true;

    let summaryText = '';
    let afterSummary = '';
    let bodyStartLine = startLine + 1;

    if (closingLine === startLine) {
      const sumMatch = inlineContent.match(SUMMARY_INLINE_RE);
      if (sumMatch) {
        summaryText = sumMatch[1].trim();
        afterSummary = sumMatch[2];
      } else {
        afterSummary = inlineContent;
      }
    } else {
      const remSummary = remainder.match(SUMMARY_INLINE_RE);
      if (remSummary) {
        summaryText = remSummary[1].trim();
        afterSummary = remSummary[2];
      } else if (remainder.trim()) {
        afterSummary = remainder;
      } else {
        let scanLine = startLine + 1;
        const scanLimit = closingLine >= 0 ? closingLine : endLine;
        while (scanLine < scanLimit && state.isEmpty(scanLine)) scanLine++;
        if (scanLine < scanLimit) {
          const sPos = state.bMarks[scanLine] + state.tShift[scanLine];
          const sMax = state.eMarks[scanLine];
          const sLine = state.src.slice(sPos, sMax);
          const nextSummary = sLine.match(SUMMARY_INLINE_RE);
          if (nextSummary) {
            summaryText = nextSummary[1].trim();
            afterSummary = nextSummary[2];
            bodyStartLine = scanLine + 1;
          } else if (/^\s*<summary>/i.test(sLine)) {
            const parts = [sLine.replace(/^\s*<summary>/i, '')];
            let foundEnd = false;
            let k = scanLine + 1;
            for (; k < Math.min(scanLimit, scanLine + 6); k++) {
              const kText = state.src.slice(state.bMarks[k] + state.tShift[k], state.eMarks[k]);
              const endIdx = kText.search(/<\/summary>/i);
              if (endIdx >= 0) {
                parts.push(kText.slice(0, endIdx));
                afterSummary = kText.slice(endIdx + 10);
                foundEnd = true;
                k++;
                break;
              }
              parts.push(kText);
            }
            if (foundEnd) {
              summaryText = parts.join(' ').replace(/\s+/g, ' ').trim();
              bodyStartLine = k;
            }
          }
        }
      }
    }

    const effectiveEnd = closingLine >= 0 ? closingLine : endLine;
    const nextLineAfter = closingLine >= 0 ? closingLine + 1 : endLine;
    let closingLineBody = '';
    if (closingLine > startLine) {
      const cPos = state.bMarks[closingLine] + state.tShift[closingLine];
      const cMax = state.eMarks[closingLine];
      closingLineBody = state.src.slice(cPos, cMax).replace(/<\/details>[\s\S]*$/i, '').trim();
    }

    const oldParent = state.parentType;
    const oldLineMax = state.lineMax;
    state.parentType = 'details';
    state.lineMax = effectiveEnd;

    const detailsOpen = state.push('details_open', 'details', 1);
    detailsOpen.block = true;
    detailsOpen.markup = '<details>';
    detailsOpen.map = [startLine, nextLineAfter];
    detailsOpen.attrSet('class', 'md-details');
    if (isOpen) detailsOpen.attrSet('open', '');

    const summaryOpen = state.push('summary_open', 'summary', 1);
    summaryOpen.block = true;
    const summaryInline = state.push('inline', '', 0);
    summaryInline.content = summaryText || '展开详情';
    summaryInline.children = [];
    state.push('summary_close', 'summary', -1);

    const bodyOpen = state.push('details_body_open', 'div', 1);
    bodyOpen.block = true;
    bodyOpen.attrSet('class', 'md-details-body');

    emitInlineParagraph(state, afterSummary, startLine);
    if (closingLine !== startLine && bodyStartLine < effectiveEnd) {
      state.md.block.tokenize(state, bodyStartLine, effectiveEnd);
    }
    emitInlineParagraph(state, closingLineBody, effectiveEnd);

    state.push('details_body_close', 'div', -1);
    state.push('details_close', 'details', -1);

    state.parentType = oldParent;
    state.lineMax = oldLineMax;
    state.line = nextLineAfter;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
}).enable(['table', 'strikethrough']).use(cjkFriendlyEmphasis).use(safeDetailsBlock);

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
