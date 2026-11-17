import { captureVideoRequest, parseVideoUrl } from '../video-notes/video-request.js';
import { normalizeDraftSource } from '../welcome/draft-source.js';

function capturePageCommand(request) {
  if (request?.kind !== 'video-notes') throw new Error('这条提问的页面入口暂不支持恢复，请重新选择对应功能。');
  return captureVideoRequest(request);
}

/** An editable draft keeps its original command, not a global video mode. */
export function captureRewoundCommand(message, conversationId) {
  if (!message?.pageCommand) return null;
  return { version: 1, conversationId, pageCommand: capturePageCommand(message.pageCommand) };
}

export function rewoundCommandForDraft(state, text = state.draft, options = {}) {
  const record = state.rewoundCommand;
  if (!record || record.conversationId !== state.conversation?.id || options.fromQueue
    || Object.hasOwn(options, 'pageCommand') || Object.hasOwn(options, 'requestSource')
    || options.agentTask === true || options.directModelRequest === true || options.requirePage === true
    || normalizeDraftSource(state.draftSource) || !String(text ?? '').trim()
    || String(text).trim() !== String(state.draft ?? '').trim()) return null;
  if (record.version !== 1) throw new Error('这条提问的页面入口记录版本不支持，请重新选择对应功能。');
  return { version: 1, conversationId: record.conversationId, pageCommand: capturePageCommand(record.pageCommand) };
}

export function rewoundCommandHint(record, hasTranscript) {
  if (!record) return '';
  const request = record.pageCommand;
  const mode = { off: '', frame: ' · 截帧', generate: ' · 生图' }[request.illustration];
  return `视频笔记 · P${parseVideoUrl(request.target.url).part}${mode || ''} · ${hasTranscript ? '使用原视频字幕' : '读取原视频字幕'}`;
}
