import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';

export const VIDEO_READING_PORT = 'unk-ai-video-notes';
export const VIDEO_PROVIDER_ID = 'video-transcript';
export const VIDEO_ILLUSTRATION_MODES = Object.freeze(['off', 'frame', 'generate']);
// Working context only. Longer transcripts are summarized in full before collection.
export const VIDEO_CONTEXT_MAX_CHARS = 100000;
// Bound network stalls, not the video length. Metadata and subtitles are fetched sequentially.
export const VIDEO_LIMITS = Object.freeze({ timeoutMs: 90000, requestMs: 30000,
  maxBytes: 2 * 1024 * 1024 }); // Metadata responses; subtitle bodies have no size gate.
export const videoError = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => videoError('VIDEO_DATA_INVALID', '视频字幕资料不完整或版本不支持，请回到原视频重新整理。');
const integer = value => Number.isSafeInteger(value) && value > 0;
const field = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';

/** URL recognition is metadata only. It never implies the presence of subtitles. */
export function parseVideoUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10}|av[1-9]\d*)\/?$/);
    const part = url.searchParams.get('p') ?? '1';
    if (!match || url.searchParams.getAll('p').length > 1 || !/^[1-9]\d{0,4}$/.test(part)) return null;
    const bvid = match[1].startsWith('BV') ? match[1] : '';
    const aid = bvid ? null : Number(match[1].slice(2));
    if (aid !== null && !integer(aid)) return null;
    return { platform: 'bilibili', bvid, aid, part: Number(part) };
  } catch { return null; }
}

export function videoTarget(value, { documentRequired = false } = {}) {
  const fields = pageTargetFields(value);
  if (!Number.isInteger(fields.tabId) || fields.tabId < 0 || !parseVideoUrl(fields.expectedUrl)
    || (documentRequired && !fields.documentId) || (fields.documentId && fields.documentId.length > 160)) {
    throw videoError('VIDEO_TARGET_INVALID', '请选中 B 站普通视频页面后，再使用视频笔记。');
  }
  return { tabId: fields.tabId, url: fields.expectedUrl,
    ...(fields.documentId ? { documentId: fields.documentId } : {}) };
}

export function captureVideoRequest(value) {
  if (!value || value.kind !== 'video-notes' || value.version !== 1) throw invalid();
  const illustration = VIDEO_ILLUSTRATION_MODES.includes(value.illustration) ? value.illustration : 'off';
  const target = videoTarget(value.target);
  if (value.frameFallback === true) {
    const frameOffer = validateVideoResult(value.frameOffer, target);
    if (frameOffer.kind !== 'unavailable' || !['no-subtitles', 'empty-subtitles'].includes(frameOffer.reason)) throw invalid();
    return { kind: 'video-notes', version: 1, target: frameOffer.target, illustration, frameFallback: true, frameOffer };
  }
  return { kind: 'video-notes', version: 1, target, illustration };
}

export function normalizeVideoCues(values, duration) {
  if (!Array.isArray(values)) throw invalid();
  const cues = [];
  let previousStart = -1;
  for (const value of values) {
    if (!value || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
      || !Number.isSafeInteger(Math.round(value.startMs)) || !Number.isSafeInteger(Math.round(value.endMs))
      || value.startMs < 0 || value.endMs <= value.startMs || value.endMs > (duration + 10) * 1000
      || value.startMs < previousStart || typeof value.text !== 'string') throw invalid();
    previousStart = value.startMs;
    const text = value.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (text) cues.push({ id: 'c' + (cues.length + 1), startMs: Math.round(value.startMs),
      endMs: Math.round(value.endMs), text });
  }
  return cues;
}

export function validateVideoResult(value, expectedTarget) {
  if (!value || value.version !== 1 || !['ready', 'unavailable'].includes(value.kind)) throw invalid();
  const target = videoTarget(value.target, { documentRequired: true });
  if (expectedTarget) assertPageTarget(expectedTarget, target);
  const parsed = parseVideoUrl(target.url), video = value.video;
  if (!video || video.platform !== 'bilibili' || !/^BV[a-zA-Z0-9]{10}$/.test(video.bvid || '')
    || !integer(video.aid) || !integer(video.cid) || video.part !== parsed.part
    || (video.partCount !== undefined && (!integer(video.partCount) || video.partCount < video.part || video.partCount > 99999))
    || (parsed.bvid && parsed.bvid !== video.bvid) || (parsed.aid && parsed.aid !== video.aid)
    || !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isSafeInteger(Math.round(video.duration * 1000))
    || !field(video.title, 512) || !Number.isFinite(Date.parse(value.capturedAt))) throw invalid();
  const result = { version: 1, kind: value.kind, target,
    video: { platform: 'bilibili', bvid: video.bvid, aid: video.aid, cid: video.cid,
      part: video.part, title: field(video.title, 512), duration: video.duration,
      ...(video.partCount !== undefined ? { partCount: video.partCount } : {}),
      ...(field(video.partTitle, 256) ? { partTitle: field(video.partTitle, 256) } : {}) },
    capturedAt: value.capturedAt };
  if (value.kind === 'unavailable') {
    if (!['no-subtitles', 'empty-subtitles', 'non-speech'].includes(value.reason)) throw invalid();
    return { ...result, reason: value.reason };
  }
  const track = value.track;
  if (!track || !field(track.id, 120) || !/^(?:[a-z]{2,3})(?:-[a-z0-9]{2,8})*$/i.test(track.language || '')
    || !['manual', 'auto', 'visual'].includes(track.kind)) throw invalid();
  if (track.kind === 'visual' && (!Array.isArray(value.cues) || value.cues.length > 240
    || value.cues.some(cue => typeof cue?.text !== 'string' || cue.text.length > 680))) throw invalid();
  const cues = normalizeVideoCues(value.cues, video.duration);
  if (!cues.length) throw invalid();
  const normalizedTrack = { id: field(track.id, 120), language: track.language,
    label: field(track.label, 64) || track.language, kind: track.kind };
  if (track.kind !== 'visual') return { ...result, track: normalizedTrack, cues };
  const coverage = value.visualCoverage, durationMs = Math.round(video.duration * 1000);
  const count = (number, max) => Number.isSafeInteger(number) && number >= 0 && number <= max;
  if (track.id !== 'visual' || track.language !== 'und' || !['subtitles', 'timeline'].includes(coverage?.mode)
    || coverage.version !== 1 || coverage.stepMs !== 1000 || !count(coverage.scannedMs, durationMs)
    || !count(coverage.retainedFrames, 240) || !coverage.retainedFrames || !count(coverage.failedFrames, coverage.retainedFrames)
    || !count(coverage.omittedFrames, 7200) || !/^\d{2,4}×\d{2,4}$/.test(coverage.resolution || '')) throw invalid();
  let cursor = 0, coveredMs = 0;
  const gaps = [];
  for (const cue of cues) {
    if (cue.startMs < cursor || cue.endMs > coverage.scannedMs || cue.endMs <= cue.startMs) throw invalid();
    if (cursor < cue.startMs) gaps.push([cursor, cue.startMs]);
    coveredMs += cue.endMs - cue.startMs;
    cursor = cue.endMs;
  }
  if (cursor < durationMs) gaps.push([cursor, durationMs]);
  return { ...result, track: { ...normalizedTrack, label: '画面识别' }, cues,
    visualCoverage: { version: 1, mode: coverage.mode, stepMs: 1000, scannedMs: coverage.scannedMs,
      retainedFrames: coverage.retainedFrames, failedFrames: coverage.failedFrames, omittedFrames: coverage.omittedFrames,
      resolution: coverage.resolution, coveredMs, gaps: gaps.slice(0, 8), gapCount: gaps.length } };
}

export function hasVideoTranscript(attachments) {
  return Array.isArray(attachments) && attachments.some(item => item?.type === 'video-transcript');
}

export function selectedVideoTranscript(attachments, { agentTask = false } = {}) {
  const values = (Array.isArray(attachments) ? attachments : []).filter(item => item?.type === 'video-transcript');
  if (!values.length) return null;
  if (agentTask) throw videoError('VIDEO_AGENT_UNSUPPORTED', '视频字幕当前仅支持普通问答，请退出页面操作模式，或移除字幕附件。');
  if (values.length !== 1) throw invalid();
  const value = validateVideoResult(values[0].videoTranscript);
  if (value.kind !== 'ready') throw invalid();
  return value;
}

export function createVideoAttachment(value) {
  const transcript = validateVideoResult(value);
  if (transcript.kind !== 'ready') throw invalid();
  return { type: 'video-transcript',
    id: 'video:' + transcript.video.bvid + ':' + transcript.video.cid + ':' + transcript.track.id + ':' + transcript.capturedAt,
    name: videoCaptionTitle(transcript.video, transcript.track.kind),
    size: new TextEncoder().encode(JSON.stringify(transcript)).byteLength, videoTranscript: transcript };
}

export function videoDisplayTitle(video) {
  return field(video.partTitle, 256) || field(video.title, 512);
}

export function videoCaptionTitle(video, kind) {
  return videoDisplayTitle(video) + ' · P' + video.part
    + (video.partCount ? '/' + video.partCount : '') + (kind === 'visual' ? ' 画面识别' : ' 字幕');
}

/** Shareable fallback; only the original video/P and subtitle time are encoded. */
export function videoPageUrl(video) {
  return 'https://www.bilibili.com/video/' + video.bvid + '/?p=' + video.part;
}

export function videoTimestampUrl(video, startMs) {
  return videoPageUrl(video) + '&t=' + Math.floor(startMs / 1000);
}

export function videoTimestamp(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60);
  return (minutes >= 60 ? String(Math.floor(minutes / 60)).padStart(2, '0') + ':' : '')
    + String(minutes % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
