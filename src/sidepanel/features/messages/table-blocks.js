import { awaitWithTimeout } from '../../../utils/abortable.js';
import { icon } from '../../icons.js';
import { showCopied } from './copy-feedback.js';

const TALL_ROW_THRESHOLD = 8;
const WIDE_COL_THRESHOLD = 4;
const CELL_CLAMP_MIN_CHARS = 22;
const BR_TOKEN_RE = /<br\s*\/?>/gi;

function convertLiteralBreaksInNode(doc, root) {
  const NodeFilterApi = doc.defaultView?.NodeFilter || globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const walker = doc.createTreeWalker(root, NodeFilterApi.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('code, pre')) continue;
    if (node.nodeValue && BR_TOKEN_RE.test(node.nodeValue)) {
      BR_TOKEN_RE.lastIndex = 0;
      targets.push(node);
    }
  }
  for (const textNode of targets) {
    const parts = textNode.nodeValue.split(BR_TOKEN_RE);
    if (parts.length <= 1) continue;
    const frag = doc.createDocumentFragment();
    parts.forEach((part, idx) => {
      if (idx > 0) frag.append(doc.createElement('br'));
      if (part) frag.append(doc.createTextNode(part));
    });
    textNode.replaceWith(frag);
  }
}

function enhanceTableCells(doc, table) {
  for (const cell of table.querySelectorAll('tbody td')) {
    convertLiteralBreaksInNode(doc, cell);
    const text = (cell.textContent || '').trim();
    const hasBreak = Boolean(cell.querySelector('br'));
    if (cell.classList.contains('fund-num-col') || cell.querySelector('.fund-code-pill, .fund-badge, .fund-risk-badge')) {
      continue;
    }
    if (text.length >= CELL_CLAMP_MIN_CHARS || hasBreak) {
      if (!cell.firstElementChild?.classList?.contains('md-cell-clip')) {
        const clip = doc.createElement('div');
        clip.className = 'md-cell-clip';
        while (cell.firstChild) clip.append(cell.firstChild);
        cell.append(clip);
      }
    }
  }
}

/**
 * Globally enhance rendered Markdown tables:
 * - Convert literal `<br>` tokens inside cells to real line breaks
 * - Clamp long/multi-line cells cleanly to 2 lines with ellipsis (hover shows full tooltip)
 * - Wrap `.md-table-scroll` in `.message-table-block` with a subtle expand button
 * - Tag tall tables (`> 8` body rows) and wide tables (`>= 4` columns)
 */
export function decorateTableBlocks(fragment) {
  if (!fragment?.querySelectorAll) return;
  for (const scroller of [...fragment.querySelectorAll('.md-table-scroll')]) {
    if (scroller.parentElement?.classList?.contains('message-table-block')) continue;
    const table = scroller.querySelector('table');
    if (!table) continue;

    const doc = scroller.ownerDocument;
    enhanceTableCells(doc, table);

    const bodyRows = table.querySelectorAll('tbody tr').length;
    const colCount = table.querySelectorAll('thead th').length
      || table.querySelector('tr')?.children?.length
      || 0;

    if (bodyRows > TALL_ROW_THRESHOLD) scroller.dataset.tableTall = 'true';
    if (colCount >= WIDE_COL_THRESHOLD) scroller.dataset.tableWide = 'true';

    const wrapper = doc.createElement('div');
    wrapper.className = 'message-table-block';

    const toolbar = doc.createElement('div');
    toolbar.className = 'message-table-toolbar';
    toolbar.dataset.tableDecoration = 'true';

    const expandBtn = doc.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'message-table-action';
    expandBtn.dataset.action = 'expand-table';
    expandBtn.title = '放大查看表格';
    expandBtn.setAttribute('aria-label', '放大查看表格');
    expandBtn.innerHTML = `${icon('maximize')}<span>放大</span>`;

    toolbar.append(expandBtn);
    scroller.replaceWith(wrapper);
    wrapper.append(toolbar, scroller);
  }
}

const boundTooltipContainers = new WeakSet();
let sharedCellTip = null;
let sharedTipTarget = null;
let sharedTipTimer = null;

function cellFullText(clip) {
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) parts.push(node.nodeValue || '');
    else if (node.nodeType === 1) {
      if (node.tagName === 'BR') parts.push('\n');
      else for (const child of node.childNodes) walk(child);
    }
  };
  walk(clip);
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

function hideCellTooltip() {
  if (sharedTipTimer !== null) {
    clearTimeout(sharedTipTimer);
    sharedTipTimer = null;
  }
  sharedTipTarget = null;
  if (sharedCellTip) sharedCellTip.hidden = true;
}

function showCellTooltip(clip) {
  if (!clip?.isConnected) return;
  // Only show tooltip when content is actually clipped (height or width overflow)
  const isOverflowing = (clip.scrollHeight > clip.clientHeight + 2) || (clip.scrollWidth > clip.clientWidth + 2);
  if (!isOverflowing) {
    hideCellTooltip();
    return;
  }
  const full = cellFullText(clip);
  if (!full) return;

  const doc = clip.ownerDocument;
  if (!sharedCellTip || sharedCellTip.ownerDocument !== doc) {
    sharedCellTip?.remove();
    sharedCellTip = doc.createElement('div');
    sharedCellTip.className = 'table-cell-tooltip';
    sharedCellTip.setAttribute('role', 'tooltip');
    sharedCellTip.hidden = true;
    doc.body?.append(sharedCellTip);
  }
  sharedCellTip.textContent = full;
  sharedCellTip.hidden = false;

  const win = doc.defaultView;
  const vw = win?.innerWidth || 440;
  const vh = win?.innerHeight || 720;
  const rect = clip.getBoundingClientRect();
  const tipRect = sharedCellTip.getBoundingClientRect();
  const pad = 10;

  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(pad, Math.min(vw - tipRect.width - pad, left));
  let top = rect.top - tipRect.height - 8;
  if (top < pad) top = rect.bottom + 8;
  if (top + tipRect.height > vh - pad) top = Math.max(pad, vh - tipRect.height - pad);

  sharedCellTip.style.left = `${Math.round(left)}px`;
  sharedCellTip.style.top = `${Math.round(top)}px`;
}

/**
 * Bind delegated hover tooltip for truncated table cells (idempotent via WeakSet).
 * Follows the app's Paper & Ink tooltip rules: delayed reveal, viewport clamping,
 * and instant hide on scroll, pointerdown, or Escape.
 */
export function bindTableCellTooltips(container) {
  if (!container?.addEventListener || boundTooltipContainers.has(container)) return;
  boundTooltipContainers.add(container);

  container.addEventListener('pointerover', (event) => {
    const clip = event.target?.closest?.('.md-cell-clip');
    if (!clip || clip.closest('.md-table-scroll.is-expanded')) {
      if (sharedTipTarget) hideCellTooltip();
      return;
    }
    if (clip === sharedTipTarget) return;
    if (sharedTipTimer !== null) clearTimeout(sharedTipTimer);
    sharedTipTarget = clip;
    sharedTipTimer = setTimeout(() => {
      sharedTipTimer = null;
      if (sharedTipTarget === clip && clip.isConnected) showCellTooltip(clip);
    }, 200);
  });

  container.addEventListener('pointerout', (event) => {
    if (!sharedTipTarget) return;
    const next = event.relatedTarget?.closest?.('.md-cell-clip');
    if (next !== sharedTipTarget) hideCellTooltip();
  });

  container.addEventListener('scroll', hideCellTooltip, { capture: true, passive: true });
  container.addEventListener('pointerdown', hideCellTooltip, { capture: true });
  container.ownerDocument?.addEventListener?.('keydown', (e) => {
    if (e.key === 'Escape') hideCellTooltip();
  });
}

function tableToTsv(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = [...tr.children]
      .filter(el => el.tagName === 'TH' || el.tagName === 'TD')
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim());
    if (cells.length) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

let activeDialog = null;

/**
 * Open a full-viewport, theme-matched lightbox modal for any Markdown table.
 * Preserves Fund Mode styling (`data-fund-mode="true"`) and supports TSV copy + Esc close.
 */
export function openTablePreview(triggerButton, { writeText, notify } = {}) {
  const block = triggerButton?.closest?.('.message-table-block');
  const sourceTable = block?.querySelector('table');
  if (!sourceTable) return null;

  const doc = triggerButton.ownerDocument || globalThis.document;
  if (activeDialog?.isConnected) {
    activeDialog.close?.();
    activeDialog.remove();
    activeDialog = null;
  }

  const isFundMode = Boolean(triggerButton.closest('.assistant-message[data-fund-mode="true"]'));
  const rowCount = sourceTable.querySelectorAll('tbody tr').length;
  const colCount = sourceTable.querySelectorAll('thead th').length
    || sourceTable.querySelector('tr')?.children?.length
    || 0;

  const dialog = doc.createElement('dialog');
  dialog.className = 'table-preview-dialog';
  dialog.setAttribute('aria-label', '表格放大视图');

  const shell = doc.createElement('div');
  shell.className = 'table-preview-shell';

  const header = doc.createElement('header');
  header.className = 'table-preview-header';

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'table-preview-title';
  const strong = doc.createElement('strong');
  strong.textContent = isFundMode ? '研报数据表' : '表格放大查看';
  const meta = doc.createElement('span');
  meta.textContent = `${rowCount} 行 × ${colCount} 列`;
  titleGroup.append(strong, meta);

  const actions = doc.createElement('div');
  actions.className = 'table-preview-actions';

  if (typeof writeText === 'function') {
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'table-preview-btn';
    copyBtn.innerHTML = `${icon('copy')}<span>复制表格</span>`;
    copyBtn.addEventListener('click', async () => {
      try {
        await awaitWithTimeout(writeText(tableToTsv(sourceTable)), {
          timeoutMs: 3000,
          message: '复制超时，请检查剪贴板权限。',
        });
        showCopied(copyBtn, { lock: true });
      } catch (err) {
        notify?.(err?.message || '复制失败，请手动选择表格内容。', 'error');
      }
    });
    actions.append(copyBtn);
  }

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-button table-preview-close';
  closeBtn.title = '关闭 (Esc)';
  closeBtn.setAttribute('aria-label', '关闭表格放大视图');
  closeBtn.innerHTML = icon('close');
  actions.append(closeBtn);

  header.append(titleGroup, actions);

  const viewport = doc.createElement('div');
  viewport.className = 'table-preview-viewport';

  const contentHost = doc.createElement('div');
  contentHost.className = isFundMode ? 'message-content assistant-message' : 'message-content';
  if (isFundMode) contentHost.dataset.fundMode = 'true';

  const scroller = doc.createElement('div');
  scroller.className = 'md-table-scroll is-expanded';
  if (colCount >= WIDE_COL_THRESHOLD) scroller.dataset.tableWide = 'true';
  scroller.append(sourceTable.cloneNode(true));

  contentHost.append(scroller);
  viewport.append(contentHost);
  shell.append(header, viewport);
  dialog.append(shell);

  const cleanup = () => {
    if (activeDialog === dialog) activeDialog = null;
    dialog.remove();
  };

  closeBtn.addEventListener('click', () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else cleanup();
  });
  dialog.addEventListener('close', cleanup);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else cleanup();
    }
  });

  doc.body.append(dialog);
  activeDialog = dialog;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  closeBtn.focus?.();
  return dialog;
}
