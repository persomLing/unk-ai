import { assertImageAttachmentsAvailable, safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { presentVideoNotesMessage, videoAttachmentName } from '../video-notes/video-notes-presentation.js';
import { copyIllustrationPlacement } from '../illustration/illustration-placement.js';
import { copyIllustrationLayout, illustrationDimensions } from '../illustration/illustration-layout.js';

const MAX_TURNS = 50;
const MAX_TEXT = 120_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const text = value => typeof value === 'string' ? value : '';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function sourceFor(value) {
  try {
    const url = new URL(text(value?.url));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { title: text(value.title) || url.hostname, url: url.href };
  } catch { return null; }
}

function attachmentFor(file) {
  const image = file?.type === 'image' && safeAttachmentDataUrl(file.dataUrl);
  return { name: text(videoAttachmentName(file)) || '附件', type: file?.type === 'image' ? 'image' : 'document',
    ...(image ? { dataUrl: image } : file?.type === 'image' ? {
      ...(text(file.imagePath) ? { imagePath: file.imagePath } : {}),
      ...(text(file.loadError) ? { loadError: file.loadError } : {}),
    } : {}) };
}

function illustrationFor(file) {
  const dataUrl = safeAttachmentDataUrl(file.dataUrl);
  const placement = copyIllustrationPlacement(file.placement);
  const layout = copyIllustrationLayout(file.illustrationLayout);
  return { name: text(file.name) || '生成图片', generated: file.generated === true,
    ...(placement ? { placement } : {}),
    ...(layout ? { illustrationLayout: layout } : {}), ...illustrationDimensions(file),
    ...(file.videoGenerated ? { videoGenerated: true } : {}),
    ...(file.videoFrame ? { frameTime: Number(file.videoFrame.time) || 0 } : {}),
    ...(typeof file.videoFrame?.verified === 'boolean' ? { frameVerified: file.videoFrame.verified } : {}),
    ...(dataUrl ? { dataUrl } : {
      ...(text(file.imagePath) ? { imagePath: file.imagePath } : {}),
      ...(text(file.loadError) ? { loadError: file.loadError } : {}),
    }) };
}

/** Freeze visible content only; never clone provider config or hidden model context. */
export function createExportSnapshot(conversation) {
  if (!conversation?.id) throw new Error('当前没有可导出的对话。');
  const turns = [];
  let turn;
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (const storedMessage of messages) {
    const message = presentVideoNotesMessage(storedMessage, messages, { includeScope: true });
    if (message?.role === 'user') {
      const index = turns.length + 1;
      turn = { id: `turn-${index}`, index,
        user: { id: text(message.id), content: text(message.displayContent ?? message.content),
          attachments: (Array.isArray(message.attachments) ? message.attachments : []).map(attachmentFor) },
        assistant: null };
      turns.push(turn);
    } else if (message?.role === 'assistant' && turn && !turn.assistant) {
      turn.assistant = { id: text(message.id), content: text(message.content),
        status: ['complete', 'streaming', 'stopped', 'error'].includes(message.status) ? message.status : 'complete',
        errorMessage: text(message.errorMessage),
        ...(message.fundMode ? { fundMode: true } : {}),
        sources: (Array.isArray(message.sources) ? message.sources : []).map(sourceFor).filter(Boolean),
        illustrations: (Array.isArray(message.attachments) ? message.attachments : [])
          .filter(file => file?.type === 'image' && (file.generated || file.videoFrame)).map(illustrationFor) };
    }
  }
  return freeze({ id: text(conversation.id), title: text(conversation.title) || '未命名对话',
    createdAt: text(conversation.createdAt), turns });
}

export function selectExportSnapshot(snapshot, selectedIds) {
  const ids = new Set(selectedIds || []);
  if (!ids.size) throw new Error('请至少选择一轮对话。');
  if (!snapshot?.turns?.length) throw new Error('当前没有可导出的对话。');
  const turns = snapshot.turns.filter(turn => ids.has(turn.id));
  if (turns.length !== ids.size) throw new Error('所选回合已失效，请重新打开导出。');
  return freeze({ ...snapshot, turns });
}

export function exportSelectionIssue(snapshot, selectedIds, { includeQuestions = true } = {}) {
  try {
    const { turns } = selectExportSnapshot(snapshot, selectedIds);
    if (turns.length > MAX_TURNS) return '一次最多导出 50 轮，请减少选择。';
    const chars = turns.reduce((sum, turn) => sum + (includeQuestions ? turn.user.content.length : 0) + (turn.assistant?.content.length || 0), 0);
    if (chars > MAX_TEXT) return '所选内容超过 12 万字符，请分批导出。';
    if (includeQuestions) for (const turn of turns) assertImageAttachmentsAvailable(turn.user.attachments);
    for (const turn of turns) assertImageAttachmentsAvailable((turn.assistant?.illustrations || []).map(file => ({ ...file, type: 'image' })));
    const dataBytes = file => file.dataUrl ? Math.ceil(file.dataUrl.split(',')[1].length * 3 / 4) : 0;
    const bytes = turns.reduce((sum, turn) => sum
      + (includeQuestions ? turn.user.attachments.reduce((size, file) => size + dataBytes(file), 0) : 0)
      + (turn.assistant?.illustrations || []).reduce((size, file) => size + dataBytes(file), 0), 0);
    if (bytes > MAX_IMAGE_BYTES) return '所选图片超过 8 MB，请分批导出。';
    return '';
  } catch (error) { return error.message; }
}

export function exportFilename(snapshot, extension) {
  if (!['png', 'pdf', 'html'].includes(extension)) throw new Error('不支持的导出格式。');
  let title = text(snapshot?.title).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ').trim().slice(0, 64).replace(/[. ]+$/g, '') || '对话';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `对话-${title}`;
  const id = text(snapshot?.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'export';
  return `${title}-${id}.${extension}`;
}

const CHART_FENCE_LANGS = new Set(['chart', 'fund-chart', 'fund-kpi', 'fund-steps', 'mermaid']);
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/;

function pipeColumnCount(line) {
  const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed ? trimmed.split('|').length : 0;
}

function scanMarkdownStructure(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  let tableCount = 0;
  let maxTableCols = 0;
  let chartCount = 0;
  let codeBlockCount = 0;
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const closeMatch = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fence.char && closeMatch[1].length >= fence.len) {
        fence = null;
      }
      continue;
    }
    const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const lang = openMatch[2].trim().split(/\s+/)[0]?.toLowerCase() || '';
      fence = { char: openMatch[1][0], len: openMatch[1].length };
      if (CHART_FENCE_LANGS.has(lang)) chartCount++;
      else codeBlockCount++;
      continue;
    }
    if (i + 1 < lines.length && line.includes('|') && TABLE_SEP_RE.test(lines[i + 1])) {
      const cols = Math.max(pipeColumnCount(line), pipeColumnCount(lines[i + 1]));
      if (cols >= 2) {
        tableCount++;
        if (cols > maxTableCols) maxTableCols = cols;
        i += 1;
        while (i + 1 < lines.length && lines[i + 1].includes('|')) i++;
      }
    }
  }
  return { tableCount, maxTableCols, chartCount, codeBlockCount };
}

/** Analyze selected turns without DOM access to signal layout suitability for PNG, PDF, or HTML. */
export function analyzeExportContent(turns, { includeQuestions = true } = {}) {
  let totalChars = 0;
  let tableCount = 0;
  let maxTableCols = 0;
  let chartCount = 0;
  let codeBlockCount = 0;
  let imageCount = 0;
  let hasFundMode = false;

  for (const turn of turns) {
    if (includeQuestions && turn.user) {
      totalChars += text(turn.user.content).length;
      imageCount += (turn.user.attachments || []).filter(item => item.type === 'image').length;
    }
    const answer = turn.assistant;
    if (!answer) continue;
    if (answer.fundMode) hasFundMode = true;
    const body = text(answer.content);
    totalChars += body.length;
    imageCount += (answer.illustrations || []).length;
    const stats = scanMarkdownStructure(body);
    tableCount += stats.tableCount;
    if (stats.maxTableCols > maxTableCols) maxTableCols = stats.maxTableCols;
    chartCount += stats.chartCount;
    codeBlockCount += stats.codeBlockCount;
  }

  const turnCount = turns.length;
  const estimatedHeightPx = 220 + turnCount * 170 + Math.round(totalChars * 0.55)
    + tableCount * 240 + chartCount * 320 + imageCount * 340;
  const exceedsPngLimit = estimatedHeightPx > 14_000;

  return Object.freeze({
    turnCount,
    totalChars,
    tableCount,
    maxTableCols,
    chartCount,
    codeBlockCount,
    imageCount,
    hasFundMode,
    estimatedHeightPx,
    exceedsPngLimit,
  });
}

/** Recommend PNG, PDF, or HTML based on the currently selected turns and question inclusion. */
export function recommendExportFormat(snapshot, selectedIds, { includeQuestions = true } = {}) {
  let turns;
  try {
    ({ turns } = selectExportSnapshot(snapshot, selectedIds));
  } catch {
    return null;
  }
  const signals = analyzeExportContent(turns, { includeQuestions });

  if (signals.maxTableCols >= 5) {
    return Object.freeze({
      format: 'html',
      reason: `含多列宽表（最多 ${signals.maxTableCols} 列），HTML 可完整展示并支持复制`,
      signals,
    });
  }
  if (signals.exceedsPngLimit) {
    return Object.freeze({
      format: 'html',
      reason: '内容较长（可能超过 PNG 高度上限），HTML 无裁切且可选字',
      signals,
    });
  }
  if (signals.hasFundMode && (signals.chartCount >= 1 || signals.tableCount >= 2)) {
    return Object.freeze({
      format: 'html',
      reason: '含研报图表与数据表，HTML 保留矢量清晰度且可复制文字',
      signals,
    });
  }
  if (signals.chartCount >= 2) {
    return Object.freeze({
      format: 'html',
      reason: '含多张可视化图表，HTML 保留矢量清晰度且排版更完整',
      signals,
    });
  }
  if (signals.codeBlockCount >= 3 && signals.totalChars >= 2200) {
    return Object.freeze({
      format: 'html',
      reason: '含多段代码，HTML 便于阅读与直接复制',
      signals,
    });
  }
  if (signals.tableCount >= 3 && signals.totalChars >= 2200) {
    return Object.freeze({
      format: 'html',
      reason: '含多张数据表，HTML 排版完整且支持复制',
      signals,
    });
  }
  if (signals.turnCount >= 4) {
    return Object.freeze({
      format: 'pdf',
      reason: `多轮长对话（${signals.turnCount} 轮），PDF 自动分页更利于归档和打印`,
      signals,
    });
  }
  if (signals.totalChars >= 2800 || signals.tableCount >= 2 || signals.imageCount >= 3) {
    return Object.freeze({
      format: 'pdf',
      reason: '内容篇幅较长，PDF 自动分页更适合阅读与留存',
      signals,
    });
  }
  return Object.freeze({
    format: 'png',
    reason: '篇幅精炼，长图 PNG 适合直接发微信或快速分享',
    signals,
  });
}
