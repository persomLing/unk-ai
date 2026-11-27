import { renderMermaidSVG } from 'beautiful-mermaid';
import DOMPurify from 'dompurify';
import { awaitWithTimeout } from '../../../utils/abortable.js';
import { icon } from '../../icons.js';
import { showCopied } from './copy-feedback.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_MERMAID_CHARS = 24_000;
const MERMAID_FONT = '"Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const LIVE_THEME = Object.freeze({
  bg: 'var(--surface)',
  fg: 'var(--ink)',
  line: 'var(--ink-secondary)',
  accent: 'var(--teal)',
  muted: 'var(--muted)',
  surface: 'var(--surface-alt)',
  border: 'var(--line-strong)',
  transparent: true,
  font: MERMAID_FONT,
  padding: 28,
  nodeSpacing: 22,
  layerSpacing: 36,
});

const EXPORT_THEME = Object.freeze({
  bg: '#ffffff',
  fg: '#24332c',
  line: '#4d6155',
  accent: '#20685d',
  muted: '#69766e',
  surface: '#f3f6f3',
  border: '#c7d3ca',
  transparent: false,
  font: MERMAID_FONT,
  padding: 28,
  nodeSpacing: 22,
  layerSpacing: 36,
});

const MERMAID_SANITIZE_CONFIG = Object.freeze({
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
});

let diagramSeq = 0;

/**
 * Infer a human-readable Chinese label from the Mermaid diagram header.
 */
export function inferMermaidKind(source) {
  const lines = String(source || '').split(/\r?\n/);
  let inDirective = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (inDirective) {
      if (line.includes('}%%')) inDirective = false;
      continue;
    }
    if (line.startsWith('%%{')) {
      if (!line.includes('}%%')) inDirective = true;
      continue;
    }
    if (line.startsWith('%%')) continue;
    if (/^(?:flowchart|graph)\b/i.test(line)) return '流程图';
    if (/^sequenceDiagram\b/i.test(line)) return '时序图';
    if (/^stateDiagram(?:-v2)?\b/i.test(line)) return '状态图';
    if (/^classDiagram\b/i.test(line)) return '类图';
    if (/^erDiagram\b/i.test(line)) return 'ER 图';
    if (/^xychart(?:-beta)?\b/i.test(line)) return 'XY 图';
    return 'Mermaid 图表';
  }
  return 'Mermaid 图表';
}

function scopeSvgIds(svgText, prefix) {
  const ids = new Set();
  svgText.replace(/\bid="([a-zA-Z_][\w:-]*)"/g, (_m, id) => {
    ids.add(id);
    return _m;
  });
  if (!ids.size) return svgText;
  let scoped = svgText;
  for (const id of ids) {
    const nextId = `${prefix}-${id}`;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scoped = scoped
      .replace(new RegExp(`\\bid="${escaped}"`, 'g'), `id="${nextId}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${nextId})`)
      .replace(new RegExp(`href="#${escaped}"`, 'g'), `href="#${nextId}"`);
  }
  return scoped;
}

function fallbackSanitizeSvg(raw) {
  return String(raw || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<(?:iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function sanitizeMermaidSvg(rawSvg, { diagramId }) {
  // Strip remote font @import so Chrome MV3 and export CSP (default-src 'none') never trigger network/CSP blocks.
  const withoutImport = String(rawSvg || '').replace(/@import\s+url\([^)]*\)\s*;?/gi, '');
  const scoped = scopeSvgIds(withoutImport, `mmd-${diagramId}`);
  const clean = DOMPurify?.isSupported
    ? DOMPurify.sanitize(scoped, MERMAID_SANITIZE_CONFIG)
    : fallbackSanitizeSvg(scoped);
  if (!/<svg\b/i.test(clean)) return '';
  return clean;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Fallback lightweight XML->SVG DOM parser for non-HTML mock DOMs in Node unit tests.
 */
function buildSvgElementFallback(doc, svgMarkup) {
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z_][\w:-]*)\s*>|<([a-zA-Z_][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root = doc.createDocumentFragment();
  const stack = [root];
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = tokenRe.exec(svgMarkup)) !== null) {
    if (match[1]) {
      if (stack.length > 1) stack.pop();
    } else if (match[2]) {
      const tag = match[2];
      const el = doc.createElementNS(SVG_NS, tag);
      const attrStr = match[3] || '';
      attrRe.lastIndex = 0;
      let am;
      while ((am = attrRe.exec(attrStr)) !== null) {
        el.setAttribute(am[1], decodeXmlEntities(am[2] ?? am[3] ?? ''));
      }
      stack[stack.length - 1].append(el);
      if (!match[4]) stack.push(el);
    } else if (match[5]) {
      const text = decodeXmlEntities(match[5]);
      const parent = stack[stack.length - 1];
      if (parent && parent !== root) {
        parent.append(doc.createTextNode(text));
      }
    }
  }
  return root.firstElementChild || null;
}

function parseSvgToNode(doc, svgMarkup) {
  if (doc.defaultView?.DOMParser) {
    try {
      const parsed = new doc.defaultView.DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
      const svg = parsed?.documentElement;
      if (svg && svg.nodeName.toLowerCase() === 'svg' && !parsed.querySelector('parsererror')) {
        return typeof doc.importNode === 'function' ? doc.importNode(svg, true) : svg;
      }
    } catch {
      // Fall through to template/fallback parser.
    }
  }
  const tpl = doc.createElement('template');
  if (tpl && 'content' in tpl) {
    tpl.innerHTML = svgMarkup;
    const svg = tpl.content?.firstElementChild;
    if (svg && svg.tagName?.toLowerCase() === 'svg') return svg;
  }
  return buildSvgElementFallback(doc, svgMarkup);
}

/**
 * Synchronously render a Mermaid source string into a sanitized SVG string.
 * Returns null if source is empty, oversized, or unsupported/invalid.
 */
export function renderMermaidDiagram(source, { exportMode = false } = {}) {
  const text = String(source || '').trim();
  if (!text || text.length > MAX_MERMAID_CHARS) return null;
  const kind = inferMermaidKind(text);
  const options = exportMode ? EXPORT_THEME : LIVE_THEME;
  let rawSvg;
  try {
    rawSvg = renderMermaidSVG(text, options);
  } catch {
    return null;
  }
  if (!rawSvg || typeof rawSvg !== 'string') return null;
  const diagramId = ++diagramSeq;
  const svg = sanitizeMermaidSvg(rawSvg, { diagramId });
  if (!svg) return null;
  return { kind, svg };
}

function buildStreamingMermaidSkeleton(doc, kind) {
  const box = doc.createElement('div');
  box.className = 'mermaid-vis-skeleton';
  box.dataset.mermaidDecoration = 'true';
  box.setAttribute('aria-label', `正在绘制${kind}`);
  const badge = doc.createElement('span');
  badge.className = 'mermaid-vis-skeleton-label';
  badge.textContent = `正在绘制${kind}…`;
  const nodes = doc.createElement('div');
  nodes.className = 'mermaid-vis-skeleton-nodes';
  for (let i = 0; i < 3; i++) nodes.append(doc.createElement('i'));
  box.append(badge, nodes);
  return box;
}

function makeActionButton(doc, { action, iconName, label, title }) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'mermaid-vis-btn';
  btn.dataset.action = action;
  btn.title = title || label;
  btn.setAttribute('aria-label', title || label);
  btn.innerHTML = icon(iconName);
  const text = doc.createElement('span');
  text.textContent = label;
  btn.append(text);
  return btn;
}

/**
 * Transform `<pre><code class="language-mermaid">` fences in a rendered Markdown fragment
 * into Paper & Ink SVG diagram cards (or streaming placeholders while generating).
 */
export function decorateMermaidBlocks(fragment, { streaming = false, exportMode = false } = {}) {
  if (!fragment?.querySelectorAll) return;
  const doc = fragment.ownerDocument || globalThis.document;
  for (const code of [...fragment.querySelectorAll('pre > code')]) {
    const cls = code.className || '';
    if (!/\blanguage-mermaid\b/i.test(cls)) continue;
    const pre = code.parentElement;
    if (!pre || pre.closest?.('.mermaid-vis-source')) continue;
    const raw = code.textContent || '';
    if (!raw.trim()) continue;

    if (streaming) {
      pre.replaceWith(buildStreamingMermaidSkeleton(doc, inferMermaidKind(raw)));
      continue;
    }

    const rendered = renderMermaidDiagram(raw, { exportMode });
    if (!rendered) continue;

    const svgNode = parseSvgToNode(doc, rendered.svg);
    if (!svgNode) continue;
    svgNode.classList.add('mermaid-vis-svg');
    if (exportMode) {
      svgNode.removeAttribute('width');
      svgNode.removeAttribute('height');
    }

    const figure = doc.createElement('figure');
    figure.className = 'mermaid-vis-card';
    figure.dataset.mermaidDecoration = 'true';
    figure.dataset.mermaidKind = rendered.kind;

    const header = doc.createElement('div');
    header.className = 'mermaid-vis-header';

    const badge = doc.createElement('span');
    badge.className = 'mermaid-vis-badge';
    badge.textContent = rendered.kind;

    const actions = doc.createElement('div');
    actions.className = 'mermaid-vis-actions';

    const toggleBtn = makeActionButton(doc, {
      action: 'toggle-mermaid-source',
      iconName: 'article',
      label: '源码',
      title: '切换源码与图表视图',
    });
    toggleBtn.setAttribute('aria-pressed', 'false');

    const copyBtn = makeActionButton(doc, {
      action: 'copy-mermaid-source',
      iconName: 'copy',
      label: '复制',
      title: '复制 Mermaid 源码',
    });

    const expandBtn = makeActionButton(doc, {
      action: 'expand-mermaid',
      iconName: 'maximize',
      label: '放大',
      title: '放大查看图表',
    });

    actions.append(toggleBtn, copyBtn, expandBtn);
    header.append(badge, actions);

    const stage = doc.createElement('div');
    stage.className = 'mermaid-vis-stage';
    stage.append(svgNode);

    const sourceBox = doc.createElement('div');
    sourceBox.className = 'mermaid-vis-source';
    sourceBox.hidden = true;

    pre.replaceWith(figure);
    sourceBox.append(pre);
    figure.append(header, stage, sourceBox);
  }
}

let activeMermaidDialog = null;

function openMermaidPreview(triggerButton, { writeText, notify } = {}) {
  const card = triggerButton?.closest?.('.mermaid-vis-card');
  const sourceSvg = card?.querySelector('.mermaid-vis-stage svg');
  if (!card || !sourceSvg) return null;

  const doc = triggerButton.ownerDocument || globalThis.document;
  if (activeMermaidDialog?.isConnected) {
    activeMermaidDialog.close?.();
    activeMermaidDialog.remove();
    activeMermaidDialog = null;
  }

  const kind = card.dataset.mermaidKind || 'Mermaid 图表';
  const sourceText = card.querySelector('.mermaid-vis-source code')?.textContent || '';

  const dialog = doc.createElement('dialog');
  dialog.className = 'mermaid-preview-dialog';
  dialog.setAttribute('aria-label', `${kind}放大视图`);

  const shell = doc.createElement('div');
  shell.className = 'mermaid-preview-shell';

  const header = doc.createElement('header');
  header.className = 'mermaid-preview-header';

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'mermaid-preview-title';
  const strong = doc.createElement('strong');
  strong.textContent = kind;
  const zoomLabel = doc.createElement('span');
  zoomLabel.textContent = '100%';
  titleGroup.append(strong, zoomLabel);

  const actions = doc.createElement('div');
  actions.className = 'mermaid-preview-actions';

  let zoom = 1;
  const canvas = doc.createElement('div');
  canvas.className = 'mermaid-preview-canvas';
  const clonedSvg = sourceSvg.cloneNode(true);
  const vb = (clonedSvg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  const naturalWidth = Number.isFinite(vb[2]) && vb[2] > 0 ? vb[2] : 560;
  const applyZoom = (next) => {
    zoom = Math.max(0.5, Math.min(2.5, Number(next.toFixed(2))));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    clonedSvg.style.width = `${Math.round(naturalWidth * zoom)}px`;
    clonedSvg.style.maxWidth = 'none';
  };

  const zoomOutBtn = doc.createElement('button');
  zoomOutBtn.type = 'button';
  zoomOutBtn.className = 'mermaid-preview-btn';
  zoomOutBtn.textContent = '−';
  zoomOutBtn.title = '缩小';
  zoomOutBtn.addEventListener('click', () => applyZoom(zoom - 0.25));

  const zoomResetBtn = doc.createElement('button');
  zoomResetBtn.type = 'button';
  zoomResetBtn.className = 'mermaid-preview-btn';
  zoomResetBtn.textContent = '1:1';
  zoomResetBtn.title = '重置缩放';
  zoomResetBtn.addEventListener('click', () => applyZoom(1));

  const zoomInBtn = doc.createElement('button');
  zoomInBtn.type = 'button';
  zoomInBtn.className = 'mermaid-preview-btn';
  zoomInBtn.textContent = '+';
  zoomInBtn.title = '放大';
  zoomInBtn.addEventListener('click', () => applyZoom(zoom + 0.25));

  actions.append(zoomOutBtn, zoomResetBtn, zoomInBtn);

  if (typeof writeText === 'function' && sourceText) {
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mermaid-preview-btn';
    copyBtn.innerHTML = `${icon('copy')}<span>复制源码</span>`;
    copyBtn.addEventListener('click', async () => {
      try {
        await awaitWithTimeout(writeText(sourceText), { timeoutMs: 3000, message: '复制等待超时，请检查剪贴板。' });
        showCopied(copyBtn, { lock: true });
      } catch (err) {
        notify?.(err?.message || '复制失败，请手动复制。', 'error');
      }
    });
    actions.append(copyBtn);
  }

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-button mermaid-preview-close';
  closeBtn.title = '关闭 (Esc)';
  closeBtn.setAttribute('aria-label', '关闭图表放大视图');
  closeBtn.innerHTML = icon('close');
  actions.append(closeBtn);

  header.append(titleGroup, actions);

  const viewport = doc.createElement('div');
  viewport.className = 'mermaid-preview-viewport';
  canvas.append(clonedSvg);
  viewport.append(canvas);
  applyZoom(1);

  shell.append(header, viewport);
  dialog.append(shell);

  const cleanup = () => {
    if (activeMermaidDialog === dialog) activeMermaidDialog = null;
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
  activeMermaidDialog = dialog;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  closeBtn.focus?.();
  return dialog;
}

/**
 * Handle delegated clicks for Mermaid diagram card toolbar buttons.
 */
export async function handleMermaidAction(button, { writeText, notify } = {}) {
  const action = button?.dataset?.action;
  if (!action) return false;
  const card = button.closest?.('.mermaid-vis-card');
  if (!card) return false;

  if (action === 'toggle-mermaid-source') {
    const stage = card.querySelector('.mermaid-vis-stage');
    const sourceBox = card.querySelector('.mermaid-vis-source');
    if (!stage || !sourceBox) return false;
    const showingSource = sourceBox.hidden;
    sourceBox.hidden = !showingSource;
    stage.hidden = showingSource;
    button.setAttribute('aria-pressed', showingSource ? 'true' : 'false');
    const label = button.querySelector('span');
    if (label) label.textContent = showingSource ? '图表' : '源码';
    return true;
  }

  if (action === 'copy-mermaid-source') {
    const code = card.querySelector('.mermaid-vis-source code');
    const text = code?.textContent;
    if (!text || button.disabled || button.dataset?.copied === 'true') return true;
    try {
      await awaitWithTimeout(writeText(text), { timeoutMs: 3000, message: '复制等待超时，请检查剪贴板。' });
      if (button.isConnected && !button.closest('[inert]')) showCopied(button, { lock: true });
    } catch (error) {
      if (button.isConnected && !button.closest('[inert]')) {
        notify?.(error?.name === 'TimeoutError' ? error.message : '复制失败，请手动复制源码。', 'error');
      }
    }
    return true;
  }

  if (action === 'expand-mermaid') {
    openMermaidPreview(button, { writeText, notify });
    return true;
  }

  return false;
}
