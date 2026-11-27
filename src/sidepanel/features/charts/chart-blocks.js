/**
 * Global Paper & Ink Chart Block decorator, lazy ECharts lifecycle manager,
 * theme observer, and card action / lightbox dialog controller.
 *
 * Keeps ZERO top-level static imports from `echarts-runtime.js` (and `echarts/*`)
 * so Vite places Apache ECharts in an isolated async chunk loaded only when a
 * conversation message actually renders a chart.
 */

import { awaitWithTimeout } from '../../../utils/abortable.js';
import { icon } from '../../icons.js';
import { showCopied } from '../messages/copy-feedback.js';
import { chartKindLabel, gaugeGridColumns, parseChartSpec, recommendedChartHeight } from './chart-spec.js';
import { resolveChartPalette } from './chart-option.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const defaultLoadRuntime = () => import('./echarts-runtime.js');

/**
 * Mounted live ECharts instances keyed by stage element.
 * Iterated on detach/theme changes; WeakRef/Set isn't needed because entries
 * are pruned whenever `el.isConnected` becomes false.
 */
const mountedCharts = new Map();
const observedDocuments = new WeakSet();
const boundEllipsisContainers = new WeakSet();
const boundEllipsisDocs = new WeakSet();
let sharedChartTip = null;
let sharedChartTipTarget = null;
let sharedChartTipTimer = null;
let activeChartDialog = null;

function hashString(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function createSvgNode(doc, tag) {
  return typeof doc.createElementNS === 'function'
    ? doc.createElementNS(SVG_NS, tag)
    : doc.createElement(tag);
}

function buildSvgElementFallback(doc, svgMarkup) {
  const cleanMarkup = String(svgMarkup || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z_][\w:-]*)\s*>|<([a-zA-Z_][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root = doc.createDocumentFragment();
  const stack = [root];
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = tokenRe.exec(cleanMarkup)) !== null) {
    if (match[1]) {
      if (stack.length > 1) stack.pop();
    } else if (match[2]) {
      const el = createSvgNode(doc, match[2]);
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
      if (parent && parent !== root && typeof doc.createTextNode === 'function') {
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

function makeActionButton(doc, { action, iconName, label, title }) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'unk-chart-btn';
  btn.dataset.action = action;
  btn.title = title || label;
  btn.setAttribute('aria-label', title || label);
  btn.innerHTML = icon(iconName);
  const span = doc.createElement('span');
  span.textContent = label;
  btn.append(span);
  return btn;
}

function buildStreamingChartSkeleton(doc) {
  const box = doc.createElement('div');
  box.className = 'unk-chart-skeleton';
  box.dataset.chartDecoration = 'true';
  box.setAttribute('aria-label', '正在绘制数据图表');
  const label = doc.createElement('span');
  label.className = 'unk-chart-skeleton-label';
  label.textContent = '正在绘制数据图表…';
  const bars = doc.createElement('div');
  bars.className = 'unk-chart-skeleton-bars';
  for (let i = 0; i < 5; i++) bars.append(doc.createElement('i'));
  box.append(label, bars);
  return box;
}

function readStageSpec(stage) {
  const raw = stage?.dataset?.chartSpec || stage?.getAttribute?.('data-chart-spec') || '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return parseChartSpec(raw);
  }
}

/**
 * Build a complete `<figure class="unk-chart-card">` element for a normalized chart spec.
 * Shared cleanly by live message decoration, Fund Mode table synthesis, and static export.
 */
export function buildChartCardElement(doc, spec, {
  rawSource = '',
  sourceNode = null,
  exportMode = false,
  renderStaticSvg = null,
} = {}) {
  const specJson = JSON.stringify(spec);
  const chartHash = hashString(`${spec.type}:${specJson}`);
  const height = recommendedChartHeight(spec);
  const kind = chartKindLabel(spec);

  const figure = doc.createElement('figure');
  figure.className = `unk-chart-card is-${spec.type}`;
  figure.dataset.chartDecoration = 'true';
  figure.dataset.chartType = spec.type;
  figure.dataset.chartHash = chartHash;

  const header = doc.createElement('div');
  header.className = 'unk-chart-header';

  const headerTop = doc.createElement('div');
  headerTop.className = 'unk-chart-header-top';

  const titleRow = doc.createElement('div');
  titleRow.className = 'unk-chart-title-row';

  const badge = doc.createElement('span');
  badge.className = 'unk-chart-badge';
  badge.textContent = kind;
  titleRow.append(badge);

  if (spec.title) {
    const titleEl = doc.createElement('div');
    titleEl.className = 'unk-chart-title';
    titleEl.textContent = spec.title;
    titleEl.title = spec.title;
    titleEl.dataset.chartEllipsis = 'true';
    titleRow.append(titleEl);
  }
  headerTop.append(titleRow);

  const rawText = rawSource || JSON.stringify(spec, null, 2);

  if (!exportMode) {
    const actions = doc.createElement('div');
    actions.className = 'unk-chart-actions';

    const toggleBtn = makeActionButton(doc, {
      action: 'toggle-chart-source',
      iconName: 'article',
      label: '源码',
      title: '切换图表配置与视图',
    });
    toggleBtn.setAttribute('aria-pressed', 'false');

    const copyBtn = makeActionButton(doc, {
      action: 'copy-chart-source',
      iconName: 'copy',
      label: '复制',
      title: '复制图表 JSON 配置',
    });

    const expandBtn = makeActionButton(doc, {
      action: 'expand-chart',
      iconName: 'maximize',
      label: '放大',
      title: '放大交互查看图表',
    });

    actions.append(toggleBtn, copyBtn, expandBtn);
    headerTop.append(actions);
  }

  header.append(headerTop);

  if (spec.subtitle) {
    const subEl = doc.createElement('div');
    subEl.className = 'unk-chart-subtitle';
    subEl.textContent = spec.subtitle;
    subEl.title = spec.subtitle;
    subEl.dataset.chartEllipsis = 'true';
    header.append(subEl);
  }

  const stage = doc.createElement('div');
  stage.className = 'unk-chart-stage';
  stage.dataset.chartStage = 'true';
  stage.dataset.chartHash = chartHash;
  stage.dataset.chartSpec = specJson;
  if (!exportMode) {
    stage.style.height = `${height}px`;
  }

  if (exportMode && typeof renderStaticSvg === 'function') {
    const palette = resolveChartPalette(doc, { exportMode: true });
    let svgString = '';
    try {
      svgString = renderStaticSvg(spec, { width: 660, height, palette }) || '';
    } catch {
      svgString = '';
    }
    const svgNode = svgString ? parseSvgToNode(doc, svgString) : null;
    if (svgNode) {
      svgNode.classList?.add('unk-chart-svg');
      svgNode.removeAttribute('width');
      svgNode.removeAttribute('height');
      stage.append(svgNode);
    } else {
      const note = doc.createElement('p');
      note.className = 'unk-chart-fallback';
      note.textContent = '图表导出渲染不可用';
      stage.append(note);
    }
  }

  figure.append(header, stage);

  if (spec.source || (!exportMode && spec.type === 'scatter' && spec.totalPoints > 24)) {
    const footer = doc.createElement('div');
    footer.className = 'unk-chart-footer';
    footer.textContent = spec.source || '部分密集点可悬停查看详情';
    figure.append(footer);
  }

  if (!exportMode) {
    const sourceBox = doc.createElement('div');
    sourceBox.className = 'unk-chart-source';
    sourceBox.hidden = true;
    if (sourceNode) {
      sourceBox.append(sourceNode);
    } else {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.className = 'language-chart';
      code.textContent = rawText;
      pre.append(code);
      sourceBox.append(pre);
    }
    figure.append(sourceBox);
  }

  return figure;
}

/**
 * Transform `<pre><code class="language-chart">` and `<pre><code class="language-fund-chart">`
 * fences inside a rendered Markdown fragment into ECharts cards (or streaming placeholders).
 */
export function decorateChartBlocks(fragment, {
  streaming = false,
  exportMode = false,
  renderStaticSvg = null,
} = {}) {
  if (!fragment?.querySelectorAll) return;
  const doc = fragment.ownerDocument || globalThis.document;
  for (const code of [...fragment.querySelectorAll('pre > code')]) {
    const cls = code.className || '';
    if (!/\blanguage-(?:chart|fund-chart)\b/i.test(cls)) continue;
    const pre = code.parentElement;
    if (!pre || pre.parentNode === null || pre.closest?.('.unk-chart-source')) continue;
    const raw = code.textContent || '';
    if (!raw.trim()) continue;

    const spec = parseChartSpec(raw);
    if (!spec) {
      if (streaming) pre.replaceWith(buildStreamingChartSkeleton(doc));
      continue;
    }

    const placeholder = doc.createElement('div');
    pre.replaceWith(placeholder);
    const card = buildChartCardElement(doc, spec, {
      rawSource: raw,
      sourceNode: exportMode ? null : pre,
      exportMode,
      renderStaticSvg,
    });
    placeholder.replaceWith(card);
  }
}

/**
 * Preserve live mounted ECharts SVG subtrees across streaming `syncChildren` DOM reconciliation
 * so completed charts above an actively streaming paragraph never flicker or tear down.
 */
export function preserveMountedCharts(container, nextFragment) {
  if (!container?.querySelectorAll || !nextFragment?.querySelectorAll) return;
  const prevStages = [...container.querySelectorAll('[data-chart-stage="true"]')];
  const nextStages = [...nextFragment.querySelectorAll('[data-chart-stage="true"]')];
  if (!prevStages.length || !nextStages.length) return;

  const used = new Set();
  for (const nextStage of nextStages) {
    const nextHash = nextStage.dataset?.chartHash;
    if (!nextHash) continue;
    const match = prevStages.find((prev) => {
      if (used.has(prev)) return false;
      const entry = mountedCharts.get(prev);
      if (!entry) return false;
      return prev.dataset?.chartHash === nextHash
        && Boolean(prev.getAttribute?.('_echarts_instance_'))
        && Boolean(prev.firstElementChild);
    });
    if (!match) continue;
    used.add(match);
    nextStage.setAttribute('_echarts_instance_', match.getAttribute('_echarts_instance_'));
    const prevStyle = match.getAttribute?.('style');
    if (prevStyle) nextStage.setAttribute('style', prevStyle);
    while (match.firstChild) {
      nextStage.append(match.firstChild);
    }
  }
}

function disposeEntry(stageEl, entry) {
  try {
    entry?.observer?.disconnect?.();
  } catch {}
  try {
    if (entry?.rafId != null) cancelAnimationFrame(entry.rafId);
  } catch {}
  try {
    entry?.instance?.dispose?.();
  } catch {}
  mountedCharts.delete(stageEl);
}

/** Dispose all chart instances whose stage elements are no longer in the document. */
export function disposeDetachedCharts() {
  for (const [stageEl, entry] of [...mountedCharts.entries()]) {
    if (!stageEl.isConnected) {
      disposeEntry(stageEl, entry);
    }
  }
}

/** Dispose all mounted chart instances under `container`. */
export function disposeChartsIn(container) {
  if (!container?.querySelectorAll) return;
  for (const stageEl of container.querySelectorAll('[data-chart-stage="true"]')) {
    const entry = mountedCharts.get(stageEl);
    if (entry) disposeEntry(stageEl, entry);
  }
}

function measureStageSize(stage, spec) {
  const rect = stage.getBoundingClientRect?.();
  const cs = stage.ownerDocument?.defaultView?.getComputedStyle?.(stage);
  const padX = cs ? (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0) : 0;
  const rawWidth = stage.clientWidth || rect?.width || 420;
  const width = Math.max(220, Math.floor(rawWidth - padX));
  const height = recommendedChartHeight(spec, width);
  stage.style.height = `${height}px`;
  return { width, height };
}

function hideChartEllipsisTip() {
  if (sharedChartTipTimer !== null) {
    clearTimeout(sharedChartTipTimer);
    sharedChartTipTimer = null;
  }
  sharedChartTipTarget = null;
  if (sharedChartTip) sharedChartTip.hidden = true;
}

function showChartEllipsisTip(target) {
  if (!target?.isConnected) return;
  if (!((target.scrollWidth || 0) > (target.clientWidth || 0) + 1)) {
    hideChartEllipsisTip();
    return;
  }
  const text = String(target.textContent || '').trim();
  if (!text) {
    hideChartEllipsisTip();
    return;
  }
  const doc = target.ownerDocument || globalThis.document;
  if (!sharedChartTip || sharedChartTip.ownerDocument !== doc) {
    sharedChartTip?.remove?.();
    sharedChartTip = doc.createElement('div');
    sharedChartTip.className = 'unk-chart-ellipsis-tip';
    sharedChartTip.setAttribute('role', 'tooltip');
    sharedChartTip.hidden = true;
    doc.body?.append(sharedChartTip);
  }
  sharedChartTip.textContent = text;
  sharedChartTip.hidden = false;

  const win = doc.defaultView;
  const vw = win?.innerWidth || 440;
  const vh = win?.innerHeight || 720;
  const rect = target.getBoundingClientRect?.();
  const tipRect = sharedChartTip.getBoundingClientRect?.();
  if (!rect || !tipRect) return;

  const pad = 10;
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(pad, Math.min(vw - tipRect.width - pad, left));
  let top = rect.top - tipRect.height - 6;
  if (top < pad) top = rect.bottom + 6;
  if (top + tipRect.height > vh - pad) top = Math.max(pad, vh - tipRect.height - pad);
  sharedChartTip.style.left = `${Math.round(left)}px`;
  sharedChartTip.style.top = `${Math.round(top)}px`;
}

function bindChartEllipsisTooltips(container) {
  if (!container || boundEllipsisContainers.has(container) || typeof container.addEventListener !== 'function') {
    return;
  }
  boundEllipsisContainers.add(container);

  const scheduleTip = (target) => {
    const el = target?.closest?.('[data-chart-ellipsis="true"]');
    if (!el) {
      if (sharedChartTipTarget) hideChartEllipsisTip();
      return;
    }
    if (el === sharedChartTipTarget && sharedChartTip && !sharedChartTip.hidden) return;
    if (sharedChartTipTimer !== null) clearTimeout(sharedChartTipTimer);
    sharedChartTipTarget = el;
    sharedChartTipTimer = setTimeout(() => {
      sharedChartTipTimer = null;
      if (sharedChartTipTarget === el && el.isConnected) showChartEllipsisTip(el);
    }, 120);
  };

  container.addEventListener('pointerover', (event) => scheduleTip(event.target));
  container.addEventListener('focusin', (event) => scheduleTip(event.target));
  container.addEventListener('pointerout', (event) => {
    if (!sharedChartTipTarget) return;
    const next = event.relatedTarget?.closest?.('[data-chart-ellipsis="true"]');
    if (next !== sharedChartTipTarget) hideChartEllipsisTip();
  });
  container.addEventListener('focusout', hideChartEllipsisTip);
  container.addEventListener('scroll', hideChartEllipsisTip, { capture: true, passive: true });
  container.addEventListener('pointerdown', hideChartEllipsisTip, { capture: true });

  const doc = container.ownerDocument;
  if (doc && !boundEllipsisDocs.has(doc) && typeof doc.addEventListener === 'function') {
    boundEllipsisDocs.add(doc);
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideChartEllipsisTip();
    });
  }
}

function ensureThemeObserver(doc, loadRuntime) {
  if (!doc?.documentElement || observedDocuments.has(doc)) return;
  const MutationObs = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  if (typeof MutationObs !== 'function') return;
  observedDocuments.add(doc);

  let pending = false;
  const observer = new MutationObs(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(async () => {
      pending = false;
      disposeDetachedCharts();
      if (!mountedCharts.size) return;
      const palette = resolveChartPalette(doc, { exportMode: false });
      try {
        await loadRuntime();
      } catch {
        return;
      }
      for (const [stageEl, entry] of [...mountedCharts.entries()]) {
        if (!stageEl.isConnected || stageEl.ownerDocument !== doc) continue;
        if (entry.themeKey === palette.themeKey) continue;
        const dims = measureStageSize(stageEl, entry.spec);
        entry.instance.update(entry.spec, palette, dims);
        entry.themeKey = palette.themeKey;
      }
    });
  });

  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-accent'],
  });
}

function renderStageError(doc, stage, message) {
  stage.replaceChildren();
  const note = doc.createElement('p');
  note.className = 'unk-chart-fallback';
  note.textContent = message;
  stage.append(note);
}

/**
 * Lazily load Apache ECharts (only when at least one `[data-chart-stage="true"]` exists
 * inside `container`) and mount/update responsive SVG charts with theme reactivity.
 */
export async function mountChartBlocks(container, { loadRuntime = defaultLoadRuntime } = {}) {
  disposeDetachedCharts();
  if (!container?.querySelectorAll) return;

  const stages = [...container.querySelectorAll('[data-chart-stage="true"]')];
  if (!stages.length) return;
  bindChartEllipsisTooltips(container);

  let runtime;
  try {
    runtime = await loadRuntime();
  } catch {
    const doc = container.ownerDocument || globalThis.document;
    for (const stage of stages) {
      if (stage.isConnected) {
        renderStageError(doc, stage, '图表组件加载失败，可点击右上角「源码」查看原始数据。');
      }
    }
    return;
  }

  disposeDetachedCharts();
  const doc = container.ownerDocument || globalThis.document;
  ensureThemeObserver(doc, loadRuntime);
  const palette = resolveChartPalette(doc, { exportMode: false });

  for (const stage of stages) {
    if (!stage.isConnected) continue;
    const spec = readStageSpec(stage);
    if (!spec) continue;
    const hash = stage.dataset?.chartHash || '';
    const existing = mountedCharts.get(stage);
    const hasIntactDom = Boolean(stage.getAttribute?.('_echarts_instance_') && stage.firstElementChild);

    if (existing && hasIntactDom) {
      if (existing.hash === hash && existing.themeKey === palette.themeKey) {
        continue;
      }
      const dims = measureStageSize(stage, spec);
      existing.instance.update(spec, palette, dims);
      existing.spec = spec;
      existing.hash = hash;
      existing.themeKey = palette.themeKey;
      continue;
    }

    if (existing) {
      disposeEntry(stage, existing);
    }

    stage.replaceChildren();
    stage.removeAttribute?.('_echarts_instance_');
    const dims = measureStageSize(stage, spec);

    let instance;
    try {
      instance = runtime.mountEChartInstance(stage, spec, palette, dims);
    } catch {
      renderStageError(doc, stage, '当前图表渲染异常，可点击右上角「源码」查看数据。');
      continue;
    }

    const entry = {
      instance,
      spec,
      hash,
      themeKey: palette.themeKey,
      observer: null,
      rafId: null,
    };

    const ResizeObs = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
    if (typeof ResizeObs === 'function') {
      const resizeObserver = new ResizeObs(() => {
        if (!stage.isConnected) {
          disposeEntry(stage, entry);
          return;
        }
        if (entry.rafId != null) return;
        const scheduleFrame = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb) => setTimeout(cb, 16);
        entry.rafId = scheduleFrame(() => {
          entry.rafId = null;
          if (!stage.isConnected || stage.closest?.('[hidden]')) return;
          const nextDims = measureStageSize(stage, entry.spec);
          entry.instance.resize(nextDims);
        });
      });
      resizeObserver.observe(stage);
      entry.observer = resizeObserver;
    }

    mountedCharts.set(stage, entry);
  }
}

async function openChartPreview(triggerButton, { writeText, notify, loadRuntime = defaultLoadRuntime } = {}) {
  const card = triggerButton?.closest?.('.unk-chart-card');
  const stage = card?.querySelector('[data-chart-stage="true"]');
  const spec = readStageSpec(stage);
  if (!card || !stage || !spec) return null;

  const doc = triggerButton.ownerDocument || globalThis.document;
  if (activeChartDialog?.isConnected) {
    activeChartDialog.close?.();
    activeChartDialog.remove();
    activeChartDialog = null;
  }

  const titleText = spec.title || chartKindLabel(spec);
  const sourceText = card.querySelector('.unk-chart-source code')?.textContent || JSON.stringify(spec, null, 2);

  const dialog = doc.createElement('dialog');
  dialog.className = 'unk-chart-preview-dialog';
  dialog.setAttribute('aria-label', `${titleText}放大视图`);

  const shell = doc.createElement('div');
  shell.className = 'unk-chart-preview-shell';

  const header = doc.createElement('header');
  header.className = 'unk-chart-preview-header';

  const titleGroup = doc.createElement('div');
  titleGroup.className = 'unk-chart-preview-title';
  const badge = doc.createElement('span');
  badge.className = 'unk-chart-badge';
  badge.textContent = chartKindLabel(spec);
  const strong = doc.createElement('strong');
  strong.textContent = titleText;
  titleGroup.append(badge, strong);

  const actions = doc.createElement('div');
  actions.className = 'unk-chart-preview-actions';

  if (typeof writeText === 'function' && sourceText) {
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'unk-chart-btn';
    copyBtn.innerHTML = `${icon('copy')}<span>复制配置</span>`;
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
  closeBtn.className = 'icon-button';
  closeBtn.title = '关闭 (Esc)';
  closeBtn.setAttribute('aria-label', '关闭图表放大视图');
  closeBtn.innerHTML = icon('close');
  actions.append(closeBtn);

  header.append(titleGroup, actions);

  const viewport = doc.createElement('div');
  viewport.className = 'unk-chart-preview-viewport';
  const previewStage = doc.createElement('div');
  previewStage.className = 'unk-chart-preview-stage';
  viewport.append(previewStage);

  shell.append(header, viewport);
  dialog.append(shell);
  doc.body.append(dialog);
  activeChartDialog = dialog;

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  closeBtn.focus?.();

  let previewInstance = null;
  let previewObserver = null;
  let closed = false;

  const cleanup = () => {
    closed = true;
    try { previewObserver?.disconnect?.(); } catch {}
    try { previewInstance?.dispose?.(); } catch {}
    previewObserver = null;
    previewInstance = null;
    if (activeChartDialog === dialog) activeChartDialog = null;
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

  try {
    const runtime = await loadRuntime();
    if (closed || !dialog.isConnected) return dialog;
    const rect = previewStage.getBoundingClientRect?.();
    const width = Math.max(360, Math.round(previewStage.clientWidth || rect?.width || 720));
    const height = Math.max(320, Math.round(previewStage.clientHeight || rect?.height || 460));
    const palette = resolveChartPalette(doc, { exportMode: false });
    previewInstance = runtime.mountEChartInstance(previewStage, spec, palette, { width, height });

    const ResizeObs = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
    if (typeof ResizeObs === 'function') {
      previewObserver = new ResizeObs(() => {
        if (closed || !previewStage.isConnected) return;
        const r = previewStage.getBoundingClientRect?.();
        const w = Math.round(previewStage.clientWidth || r?.width || 0);
        const h = Math.round(previewStage.clientHeight || r?.height || 0);
        if (w > 0 && h > 0) previewInstance.resize({ width: w, height: h });
      });
      previewObserver.observe(previewStage);
    }
  } catch {
    if (!closed && previewStage.isConnected) {
      renderStageError(doc, previewStage, '放大图表加载失败，请重试。');
    }
  }

  return dialog;
}

/** Handle delegated toolbar button clicks on `.unk-chart-card` (toggle source, copy, expand). */
export async function handleChartAction(button, { writeText, notify, loadRuntime = defaultLoadRuntime } = {}) {
  const action = button?.dataset?.action;
  if (!action) return false;
  const card = button.closest?.('.unk-chart-card');
  if (!card) return false;

  if (action === 'toggle-chart-source') {
    const stage = card.querySelector('[data-chart-stage="true"]');
    const sourceBox = card.querySelector('.unk-chart-source');
    if (!stage || !sourceBox) return false;
    const showingSource = sourceBox.hidden;
    sourceBox.hidden = !showingSource;
    stage.hidden = showingSource;
    button.setAttribute('aria-pressed', showingSource ? 'true' : 'false');
    const label = button.querySelector('span');
    if (label) label.textContent = showingSource ? '图表' : '源码';
    if (!showingSource) {
      const entry = mountedCharts.get(stage);
      if (entry) {
        const dims = measureStageSize(stage, entry.spec);
        entry.instance.resize(dims);
      } else {
        void mountChartBlocks(card, { loadRuntime });
      }
    }
    return true;
  }

  if (action === 'copy-chart-source') {
    const code = card.querySelector('.unk-chart-source code');
    const text = code?.textContent;
    if (!text || button.disabled || button.dataset?.copied === 'true') return true;
    try {
      await awaitWithTimeout(writeText(text), { timeoutMs: 3000, message: '复制等待超时，请检查剪贴板。' });
      if (button.isConnected && !button.closest?.('[inert]')) showCopied(button, { lock: true });
    } catch (error) {
      if (button.isConnected && !button.closest?.('[inert]')) {
        notify?.(error?.name === 'TimeoutError' ? error.message : '复制失败，请手动复制配置。', 'error');
      }
    }
    return true;
  }

  if (action === 'expand-chart') {
    await openChartPreview(button, { writeText, notify, loadRuntime });
    return true;
  }

  return false;
}
