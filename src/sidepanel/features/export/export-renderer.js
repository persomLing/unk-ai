import { renderMessageContent } from '../messages/message-view.js';
import { placeIllustrationNodes } from '../illustration/illustration-placement.js';
import { illustrationLayoutStyle } from '../illustration/illustration-layout.js';
import { awaitWithTimeout } from '../../../utils/abortable.js';
import { EXPORT_LIMITS, assertExportActive, exportCanvasSize, paginateHeight } from './pagination.js';
import { STANDALONE_HTML_CSS, assembleStandaloneHtml, tableExportDensity } from './export-html.js';
import { renderEChartSvgString } from '../charts/echarts-runtime.js';
import paperCss from './export-document.css?inline';
import katexCss from 'katex/dist/katex.min.css?inline';
import './export-document.css';

const MAX_TEXT_CHARS = 500_000;
const MAX_IMAGE_DATA = 32 * 1024 * 1024;
const RASTER_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;

function textElement(doc, tag, className, text) {
  const element = doc.createElement(tag);
  element.className = className;
  element.textContent = String(text || '');
  return element;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function validateSnapshot(snapshot, includeQuestions) {
  if (!Array.isArray(snapshot?.turns) || !snapshot.turns.length) throw new Error('请至少选择一个问答回合。');
  let characters = String(snapshot.title || '').length;
  let imageData = 0;
  for (const turn of snapshot.turns) {
    characters += String(turn.assistant?.content || '').length + String(turn.assistant?.errorMessage || '').length;
    for (const source of turn.assistant?.sources || []) characters += String(source.title || '').length + String(source.url || '').length;
    for (const illustration of turn.assistant?.illustrations || []) imageData += String(illustration.dataUrl || '').length;
    if (includeQuestions) {
      characters += String(turn.user?.content || '').length;
      for (const attachment of turn.user?.attachments || []) {
        characters += String(attachment.name || '').length;
        imageData += String(attachment.dataUrl || '').length;
      }
    }
    if (characters > MAX_TEXT_CHARS || imageData > MAX_IMAGE_DATA || snapshot.turns.length > 400) {
      throw new Error('所选内容超过单次导出上限，请减少所选回合后分批导出。');
    }
  }
}

function statusText(answer) {
  if (!answer) return '此回合暂无回答。';
  if (answer.status === 'error') return `回答未完成：${answer.errorMessage || '生成失败。'}`;
  if (answer.status === 'stopped') return '回答已停止，以下保留已生成的内容。';
  if (answer.status === 'streaming') return '导出时回答仍在生成，以下为所选时刻的内容。';
  if (!String(answer.content || '').trim()) return '此回合没有回答正文。';
  return '';
}

/** Preview and export share this inert rendering, so Markdown cannot fetch remote images. */
export function buildExportDocument(snapshot, { document: targetDocument = globalThis.document, includeQuestions = true } = {}) {
  if (!targetDocument?.implementation) throw new Error('当前环境无法生成导出预览。');
  validateSnapshot(snapshot, includeQuestions);
  const doc = targetDocument.implementation.createHTMLDocument('UNK AI Export');
  const paper = doc.createElement('article');
  paper.className = 'export-paper';
  paper.setAttribute('aria-label', '对话导出预览');
  const heading = textElement(doc, 'header', 'export-heading', '');
  heading.append(textElement(doc, 'p', 'export-brand', 'UNK AI · 对话记录'),
    textElement(doc, 'h1', 'export-title', snapshot.title || '对话记录'));
  const date = new Date(snapshot.createdAt);
  const dateText = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  heading.append(textElement(doc, 'p', 'export-meta', `${dateText ? `${dateText} · ` : ''}${snapshot.turns.length} 个问答回合${includeQuestions ? '' : ' · 仅回答'}`));
  paper.append(heading);
  for (const turn of snapshot.turns) {
    const section = textElement(doc, 'section', 'export-turn', '');
    section.append(textElement(doc, 'p', 'export-turn-label', `回合 ${Number.isInteger(turn.index) ? turn.index : snapshot.turns.indexOf(turn) + 1}`));
    if (includeQuestions && turn.user) {
      const question = textElement(doc, 'div', 'export-question', '');
      question.append(textElement(doc, 'p', 'export-role', '提问'), textElement(doc, 'p', 'export-question-text', turn.user.content));
      for (const attachment of turn.user.attachments || []) {
        if (attachment.type === 'image' && RASTER_DATA.test(String(attachment.dataUrl || ''))) {
          const img = doc.createElement('img');
          img.src = attachment.dataUrl;
          img.alt = String(attachment.name || '附件图片');
          question.append(img);
        } else question.append(textElement(doc, 'p', 'export-attachment', `附件：${attachment.name || '未命名文件'}${attachment.type === 'image' ? '（图片未嵌入）' : ''}`));
      }
      section.append(question);
    }
    const answer = textElement(doc, 'div', 'export-answer', '');
    let content;
    answer.append(textElement(doc, 'p', 'export-role', 'UNK AI'));
    const status = statusText(turn.assistant);
    if (status) answer.append(textElement(doc, 'p', 'export-status', status));
    if (turn.assistant?.content) {
      const isFund = Boolean(turn.assistant.fundMode);
      content = textElement(doc, 'div', isFund ? 'export-markdown export-fund-markdown' : 'export-markdown', '');
      renderMessageContent(content, String(turn.assistant.content), false, {
        fundMode: isFund,
        exportMode: true,
        renderStaticChartSvg: renderEChartSvgString,
      });
      for (const img of content.querySelectorAll('img')) {
        // Even data images in Markdown remain text: only explicit local attachments are embedded.
        const url = safeUrl(img.getAttribute('src'));
        img.replaceWith(textElement(doc, 'span', 'export-image-placeholder', `［图片：${img.alt || '未命名图片'}${url ? ` · ${url}` : ''}；导出时未联网加载］`));
      }
      for (const link of content.querySelectorAll('a')) {
        const url = safeUrl(link.getAttribute('href'));
        if (url) link.href = url;
        else link.replaceWith(doc.createTextNode(link.textContent || ''));
      }
      for (const node of content.querySelectorAll('[srcset], [poster], [background]')) {
        node.removeAttribute('srcset'); node.removeAttribute('poster'); node.removeAttribute('background');
      }
      answer.append(content);
    }
    const sources = (turn.assistant?.sources || []).filter(source => safeUrl(source.url));
    if (sources.length) {
      const list = textElement(doc, 'div', 'export-sources', '');
      list.append(textElement(doc, 'p', '', '来源'));
      sources.forEach((source, index) => list.append(textElement(doc, 'p', '', `${index + 1}. ${source.title || '来源'} — ${safeUrl(source.url)}`)));
      answer.append(list);
    }
    const illustrations = (turn.assistant?.illustrations || []).filter(item => RASTER_DATA.test(String(item.dataUrl || '')));
    if (illustrations.length) {
      if (!content) {
        content = textElement(doc, 'div', 'export-markdown', '');
        answer.insertBefore(content, answer.querySelector('.export-sources'));
      }
      const entries = [];
      for (const item of illustrations) {
        const figure = doc.createElement('figure');
        figure.className = 'export-illustration';
        figure.setAttribute('style', illustrationLayoutStyle(item.illustrationLayout, item));
        const img = doc.createElement('img');
        img.src = item.dataUrl;
        img.alt = item.name;
        const seconds = Math.max(0, Math.floor(Number(item.frameTime) || 0));
        const badge = item.frameTime !== undefined
          ? `视频画面 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}${item.frameVerified === false ? ' · 未做内容核对' : ''}`
          : item.videoGenerated ? 'AI 生成示意图 · 非视频真实画面' : 'AI 生成';
        figure.append(img, textElement(doc, 'figcaption', '', `${badge} · ${item.name}`));
        entries.push({ node: figure, item });
      }
      placeIllustrationNodes(content, entries, { className: 'export-illustrations' });
    }
    section.append(answer);
    paper.append(section);
  }
  return targetDocument.adoptNode(paper);
}

function measurePagination(paper, signal) {
  const origin = paper.getBoundingClientRect().top;
  const lines = [];
  const blocks = [];
  const doc = paper.ownerDocument;
  const walker = doc.createTreeWalker(paper, 4);
  let node;
  while ((node = walker.nextNode())) {
    assertExportActive(signal);
    if (!node.textContent?.trim() || node.parentElement?.closest('.katex-mathml')) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.height) lines.push({ top: rect.top - origin - 1, bottom: rect.bottom - origin + 1 });
    }
    if (lines.length > 25_000) throw new Error('内容排版过长，请减少所选回合后导出。');
  }
  for (const block of paper.querySelectorAll('tr, img, .katex-display, .export-heading, .unk-chart-card, .fund-vis-card, .fund-kpi-card, .fund-steps-card, .fund-callout, .mermaid-vis-card, .reading-callout, .reading-steps-card, .reading-interactive-card, .reading-example-card, h1, h2, h3, h4, h5, h6, .export-role')) {
    const rect = block.getBoundingClientRect();
    let bottom = rect.bottom;
    if (block.matches('h1, h2, h3, h4, h5, h6, .export-role') && block.nextElementSibling) {
      bottom = Math.min(block.nextElementSibling.getBoundingClientRect().bottom, bottom + 45);
    }
    blocks.push({ top: rect.top - origin, bottom: bottom - origin });
  }
  return { lines, blocks };
}

function resetTableFit(table) {
  const scroller = table.parentElement;
  table.style.fontSize = '';
  table.style.width = '';
  table.style.transform = '';
  table.style.transformOrigin = '';
  table.style.tableLayout = '';
  delete table.dataset.exportDensity;
  if (scroller) scroller.style.height = '';
}

function fitRasterTable(table, win) {
  const scroller = table.parentElement;
  const cols = Math.max(
    table.querySelectorAll('thead th').length,
    ...[...table.querySelectorAll('tr')].map(row => row.children.length),
    0,
  );
  const density = tableExportDensity(cols);
  if (density) table.dataset.exportDensity = density;

  const available = scroller?.clientWidth || (EXPORT_LIMITS.width - 96);
  if (!(available > 0)) return;
  let actual = table.scrollWidth;
  if (actual <= available + 1) return;

  table.dataset.exportDensity = 'dense';
  const computedSize = Number.parseFloat(win?.getComputedStyle?.(table)?.fontSize || '11');
  if (Number.isFinite(computedSize) && computedSize > 0) {
    table.style.fontSize = `${Math.max(8.5, computedSize * (available / actual)).toFixed(2)}px`;
  }
  actual = table.scrollWidth;
  if (actual > available + 1) {
    // Switching wide overflowing tables to fixed 100% avoids html2canvas CSS transform double-scaling.
    table.style.tableLayout = 'fixed';
    table.style.width = '100%';
    actual = table.scrollWidth;
    if (actual > available + 1) {
      const currentSize = Number.parseFloat(win?.getComputedStyle?.(table)?.fontSize || table.style.fontSize || '9');
      if (Number.isFinite(currentSize) && currentSize > 0) {
        table.style.fontSize = `${Math.max(7.5, currentSize * (available / actual)).toFixed(2)}px`;
      }
    }
  }
}

/** Call after appending the paper and awaiting its document fonts, for preview parity. */
export function fitExportDocument(paper, { format = 'png' } = {}) {
  const isHtml = format === 'html';
  paper.classList?.toggle('export-mode-html', isHtml);
  const win = paper.ownerDocument?.defaultView;

  for (const formula of paper.querySelectorAll('.katex-display > .katex')) {
    formula.style.fontSize = '';
    const available = formula.parentElement.clientWidth;
    const width = formula.scrollWidth;
    if (width > available && available > 0) {
      const size = Number.parseFloat(win?.getComputedStyle?.(formula)?.fontSize || '16');
      if (Number.isFinite(size) && size > 0) {
        formula.style.fontSize = `${size * available / width}px`;
      }
    }
  }

  for (const table of paper.querySelectorAll('.md-table-scroll > table')) {
    resetTableFit(table);
    if (!isHtml) fitRasterTable(table, win);
  }

  for (const code of paper.querySelectorAll('.export-markdown :not(pre) > code')) {
    const wrapped = !isHtml && typeof code.getClientRects === 'function' && code.getClientRects().length > 1;
    code.classList?.toggle('export-multiline-code', wrapped);
  }
  return paper;
}

const SVG_SHAPE_SELECTOR = 'path, line, rect, circle, ellipse, polygon, polyline';
const SVG_TEXT_SELECTOR = 'text, tspan';

/** Inline computed presentation styles into SVGs before html2canvas serializes them standalone. */
export function inlineSvgComputedStyles(paper) {
  const win = paper?.ownerDocument?.defaultView;
  if (!win?.getComputedStyle) return paper;
  for (const svg of paper.querySelectorAll('svg')) {
    const rect = svg.getBoundingClientRect?.();
    if (rect?.width > 0 && rect?.height > 0) {
      if (!svg.getAttribute('width')) svg.setAttribute('width', `${Math.round(rect.width)}`);
      if (!svg.getAttribute('height')) svg.setAttribute('height', `${Math.round(rect.height)}`);
    }
    for (const node of svg.querySelectorAll(SVG_SHAPE_SELECTOR)) {
      const cs = win.getComputedStyle(node);
      if (cs.fill && cs.fill !== 'rgb(0, 0, 0)') node.style.fill = cs.fill;
      else if (node.getAttribute('fill') === 'none') node.style.fill = 'none';
      if (cs.stroke && cs.stroke !== 'none') node.style.stroke = cs.stroke;
      if (cs.strokeWidth) node.style.strokeWidth = cs.strokeWidth;
      if (cs.strokeDasharray && cs.strokeDasharray !== 'none') node.style.strokeDasharray = cs.strokeDasharray;
      if (cs.strokeLinecap) node.style.strokeLinecap = cs.strokeLinecap;
      if (cs.strokeLinejoin) node.style.strokeLinejoin = cs.strokeLinejoin;
      if (cs.opacity && cs.opacity !== '1') node.style.opacity = cs.opacity;
      if (cs.fillOpacity && cs.fillOpacity !== '1') node.style.fillOpacity = cs.fillOpacity;
      if (cs.strokeOpacity && cs.strokeOpacity !== '1') node.style.strokeOpacity = cs.strokeOpacity;
    }
    for (const node of svg.querySelectorAll(SVG_TEXT_SELECTOR)) {
      const cs = win.getComputedStyle(node);
      if (cs.fill) node.style.fill = cs.fill;
      if (cs.fontFamily) node.style.fontFamily = cs.fontFamily;
      if (cs.fontSize) node.style.fontSize = cs.fontSize;
      if (cs.fontWeight) node.style.fontWeight = cs.fontWeight;
      if (cs.textAnchor) node.style.textAnchor = cs.textAnchor;
      if (cs.dominantBaseline) node.style.dominantBaseline = cs.dominantBaseline;
      if (cs.opacity && cs.opacity !== '1') node.style.opacity = cs.opacity;
    }
  }
  return paper;
}

let cachedExportChartsRuntime = null;

async function loadExportChartsRuntimeScript(signal) {
  if (cachedExportChartsRuntime !== null) return cachedExportChartsRuntime;
  if (typeof fetch !== 'function') return '';
  const url = globalThis.chrome?.runtime?.getURL?.('assets/export-charts-runtime.js')
    || (globalThis.location?.href ? new URL('assets/export-charts-runtime.js', globalThis.location.href).href : '');
  if (!url) return '';
  try {
    const response = await awaitWithTimeout(fetch(url), {
      signal,
      timeoutMs: 8000,
      message: '加载图表交互脚本超时。',
    });
    if (!response?.ok) return '';
    const text = await response.text();
    if (text && text.includes('__UNK_EXPORT_CHARTS__')) {
      cachedExportChartsRuntime = text;
      return text;
    }
  } catch {
    // Fall back gracefully to embedded static SVG charts if runtime asset is unavailable.
  }
  return '';
}

/** Build a self-contained offline HTML document string from an export snapshot. */
export function buildStandaloneHtml(snapshot, {
  document: targetDocument = globalThis.document,
  includeQuestions = true,
  signal,
  chartRuntimeScript = '',
  initialTheme = 'light',
} = {}) {
  assertExportActive(signal);
  validateSnapshot(snapshot, includeQuestions);
  const paper = buildExportDocument(snapshot, { document: targetDocument, includeQuestions });
  paper.classList.add('export-mode-html');
  assertExportActive(signal);
  const hasCharts = Boolean(paper.querySelector?.('[data-chart-stage="true"]'));
  return assembleStandaloneHtml({
    title: snapshot.title || '对话记录',
    bodyHtml: paper.outerHTML,
    styles: `${katexCss}\n${paperCss}\n${STANDALONE_HTML_CSS}`,
    chartRuntimeScript: hasCharts ? chartRuntimeScript : '',
    initialTheme,
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片编码失败，请减少所选回合。')), 'image/png'));
}

function releaseCanvas(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

/** No downloads or conversation writes occur here; cancellation discards the pending artifact. */
export async function renderConversationExport(snapshot, { format = 'png', includeQuestions = true, signal, onProgress } = {}) {
  assertExportActive(signal);
  if (!['png', 'pdf', 'html'].includes(format)) throw new TypeError('不支持的导出格式。');
  validateSnapshot(snapshot, includeQuestions);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('导出耗时过长，请减少所选回合。', 'TimeoutError')), 180_000);
  const active = () => assertExportActive(controller.signal);
  const progress = value => { active(); onProgress?.(value); };
  const bounded = (pending, timeoutMs = 30_000) => awaitWithTimeout(pending, { signal: controller.signal,
    timeoutMs, message: '导出处理超时，请减少所选回合后重试。' });
  let frame;
  let canvas;
  try {
    if (format === 'html') {
      progress({ phase: 'preparing', page: 0, totalPages: 1 });
      const initialTheme = document.documentElement?.getAttribute?.('data-theme') === 'dark' ? 'dark' : 'light';
      const hasChartHint = snapshot.turns.some(turn => /```(?:chart|fund-chart)\b/i.test(String(turn.assistant?.content || ''))
        || (turn.assistant?.fundMode && /\|.+\|/.test(String(turn.assistant?.content || ''))));
      const chartRuntimeScript = hasChartHint ? await loadExportChartsRuntimeScript(controller.signal) : '';
      active();
      const html = buildStandaloneHtml(snapshot, {
        document,
        includeQuestions,
        signal: controller.signal,
        chartRuntimeScript,
        initialTheme,
      });
      progress({ phase: 'encoding', page: 1, totalPages: 1 });
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      active();
      return { blob, extension: 'html' };
    }
    progress({ phase: 'preparing', page: 0, totalPages: 0 });
    const [canvasModule, pdfModule] = await bounded(Promise.all([import('html2canvas'), format === 'pdf' ? import('jspdf') : Promise.resolve(null)]));
    active();
    // A dedicated document prevents html2canvas's cloning from loading avatars,
    // page favicons or other unrelated images from the live sidepanel.
    frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1200px;border:0;pointer-events:none;';
    const loaded = new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error('无法创建本地导出画布。')); });
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src \'self\' data:;"></head><body></body></html>';
    document.body.append(frame);
    await bounded(loaded, 8000);
    active();
    const frameDoc = frame.contentDocument;
    if (!frameDoc) throw new Error('无法访问本地导出画布。');
    const style = frameDoc.createElement('style');
    style.textContent = `html,body{margin:0;padding:0;width:800px;background:#fff;overflow:visible;}\n${katexCss}\n${paperCss}`;
    frameDoc.head.append(style);
    const paper = buildExportDocument(snapshot, { document: frameDoc, includeQuestions });
    frameDoc.body.append(paper);
    await bounded(Promise.all([...paper.querySelectorAll('img')].map(async img => {
      try {
        await img.decode();
        active();
        if (img.naturalWidth * img.naturalHeight > 24_000_000) throw new Error('图片尺寸过大');
      } catch (error) {
        active();
        img.replaceWith(textElement(frameDoc, 'p', 'export-image-placeholder', `［图片无法嵌入：${img.alt || '附件图片'}］`));
      }
    })), 10_000);
    active();
    await bounded(frameDoc.fonts.ready, 8000);
    active();
    fitExportDocument(paper, { format });
    inlineSvgComputedStyles(paper);
    const height = Math.max(Math.ceil(paper.getBoundingClientRect().height), Math.ceil(paper.scrollHeight));
    const frameHeight = Math.max(1200, height);
    frame.style.height = `${frameHeight}px`;
    frameDoc.documentElement.style.height = `${height}px`;
    frameDoc.body.style.height = `${height}px`;
    const slices = format === 'pdf' ? paginateHeight(height, { ...measurePagination(paper, controller.signal), signal: controller.signal })
      : [{ top: 0, height: exportCanvasSize(height, { signal: controller.signal }).height }];
    const pdf = pdfModule ? new pdfModule.jsPDF({ unit: 'mm', format: 'a4', compress: true }) : null;
    pdf?.setProperties({ title: String(snapshot.title || '对话记录'), author: 'UNK AI', creator: 'UNK AI' });
    for (let index = 0; index < slices.length; index++) {
      active();
      const slice = slices[index];
      progress({ phase: 'rendering', page: index + 1, totalPages: slices.length });
      const size = exportCanvasSize(slice.height, { format, signal: controller.signal });
      const rendering = canvasModule.default(paper, { backgroundColor: '#fff', width: size.width, height: size.height,
        x: 0, y: slice.top, scale: size.scale, windowWidth: EXPORT_LIMITS.width, windowHeight: frameHeight,
        scrollX: 0, scrollY: 0, useCORS: false, allowTaint: false, foreignObjectRendering: false,
        imageTimeout: 8000, logging: false, removeContainer: true });
      rendering.then(lateCanvas => { if (controller.signal.aborted) releaseCanvas(lateCanvas); }, () => {});
      canvas = await bounded(rendering);
      active();
      if (pdf) {
        if (index) pdf.addPage();
        pdf.addImage(canvas, 'JPEG', 12, 12, 186, slice.height * 186 / EXPORT_LIMITS.width, undefined, 'FAST');
        pdf.setFontSize(8);
        pdf.setTextColor(135);
        pdf.text(`${index + 1} / ${slices.length}`, 198, 291, { align: 'right' });
        releaseCanvas(canvas); canvas = null;
      }
    }
    progress({ phase: 'encoding', page: slices.length, totalPages: slices.length });
    const blob = pdf ? pdf.output('blob') : await bounded(canvasBlob(canvas));
    active();
    return { blob, extension: format };
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    releaseCanvas(canvas);
    frame?.remove();
  }
}
