import { renderMessageContent } from '../messages/message-view.js';
import { awaitWithTimeout } from '../../../utils/abortable.js';
import { EXPORT_LIMITS, assertExportActive, exportCanvasSize, paginateHeight } from './pagination.js';
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
    answer.append(textElement(doc, 'p', 'export-role', 'UNK AI'));
    const status = statusText(turn.assistant);
    if (status) answer.append(textElement(doc, 'p', 'export-status', status));
    if (turn.assistant?.content) {
      const content = textElement(doc, 'div', 'export-markdown', '');
      renderMessageContent(content, String(turn.assistant.content));
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
  for (const block of paper.querySelectorAll('tr, img, .katex-display, .export-heading, h1, h2, h3, h4, h5, h6, .export-role')) {
    const rect = block.getBoundingClientRect();
    let bottom = rect.bottom;
    if (block.matches('h1, h2, h3, h4, h5, h6, .export-role') && block.nextElementSibling) {
      bottom = Math.min(block.nextElementSibling.getBoundingClientRect().bottom, bottom + 45);
    }
    blocks.push({ top: rect.top - origin, bottom: bottom - origin });
  }
  return { lines, blocks };
}

/** Call after appending the paper and awaiting its document fonts, for preview parity. */
export function fitExportDocument(paper) {
  for (const formula of paper.querySelectorAll('.katex-display > .katex')) {
    const available = formula.parentElement.clientWidth;
    const width = formula.scrollWidth;
    if (width > available && available > 0) {
      const size = Number.parseFloat(paper.ownerDocument.defaultView.getComputedStyle(formula).fontSize);
      formula.style.fontSize = `${size * available / width}px`;
    }
  }
  return paper;
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
  if (!['png', 'pdf'].includes(format)) throw new TypeError('不支持的导出格式。');
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
    fitExportDocument(paper);
    const height = Math.ceil(paper.getBoundingClientRect().height);
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
        x: 0, y: slice.top, scale: size.scale, windowWidth: EXPORT_LIMITS.width, windowHeight: 1200,
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
