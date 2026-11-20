import { videoError } from './video-request.js';
import { captureVideoNavigation } from './video-navigation-request.js';

export const VIDEO_SCAN_PORT = 'unk-ai-video-scan';
export const VIDEO_DECODER_PORT = 'unk-ai-video-decoder';
export const VIDEO_STILL_TIMEOUT_MS = 25000;
export const FRAME_TIME_TOLERANCE_MS = 350;
export const FRAME_SCAN = Object.freeze({ stepMs: 1000, maxFrames: 240, maxEdge: 1280, maxImageChars: 224 * 1024,
  maxSegmentBytes: 8 * 1024 * 1024, maxIndexBytes: 256 * 1024, maxDownloadBytes: 192 * 1024 * 1024,
  maxSegmentMs: 30000, maxDurationMs: 2 * 60 * 60 * 1000, scanMs: 600000, blockMs: 30000,
  batchSize: 8, batchMs: 45000, transcriptMs: 480000, maxBatches: 60 });

export const isScanToken = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value);
export const canScanFrames = reason => ['no-subtitles', 'empty-subtitles'].includes(reason);
export const isScanCursor = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value <= limit;

export function captureVideoStillRequest(input) {
  const { target, video, startMs, conversationId, turnId, messageId } = captureVideoNavigation({ ...input, action: 'capture' });
  if (!target.documentId || !isScanToken(input.runId)) throw videoError('VIDEO_SCAN_INVALID', '视频截帧的来源无效。');
  return { version: 1, target, video, startMs, conversationId, turnId, messageId, runId: input.runId };
}

const isFrameJpeg = value => typeof value === 'string' && value.length <= FRAME_SCAN.maxImageChars
  && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value);

export function validateVideoStill(value, startMs) {
  if (!value || value.startMs !== startMs) return null;
  const { outcome, frameMs, width, height, dataUrl } = value;
  if (outcome === 'no-frame') return { outcome, startMs };
  if (!Number.isSafeInteger(frameMs) || frameMs < 0 || Math.abs(frameMs - startMs) > FRAME_TIME_TOLERANCE_MS) return null;
  if (outcome === 'black-frame') return { outcome, startMs, frameMs };
  if (outcome !== 'captured' || !Number.isInteger(width) || !Number.isInteger(height)
    || Math.min(width, height) < 1 || Math.max(width, height) > FRAME_SCAN.maxEdge || !isFrameJpeg(dataUrl)) return null;
  return { outcome, startMs, frameMs, width, height, dataUrl };
}

export function bilibiliHostOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return url.origin;
  } catch {}
  return '';
}

function mediaError() {
  return videoError('VIDEO_STREAM_UNAVAILABLE', 'B 站未提供可读取的普通 AVC 视频流，未扫描画面。');
}

function mediaUrl(value, cid) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return '';
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^[a-z0-9-]+\.bilivideo\.(?:com|cn)$/.test(url.hostname)
      || !new RegExp('^/upgcxcode/\\d+/\\d+/' + cid + '/[\\w.-]+\\.m4s$').test(url.pathname)) return '';
    return url.href;
  } catch { return ''; }
}

function byteRange(value) {
  if (typeof value !== 'string' || !/^\d{1,12}-\d{1,12}$/.test(value)) return null;
  const [start, end] = value.split('-').map(Number);
  return end >= start ? { start, end } : null;
}

export function selectBilibiliDash(response, video, quality) {
  const data = response?.data;
  if ([-101, -102, -403, 62002, 62004].includes(response?.code) || data?.is_preview || data?.drm_tech_type || data?.dash?.drm_tech_type) {
    throw videoError('VIDEO_SCAN_ACCESS_DENIED', '当前视频仅提供预览、需要访问权限或使用加密流，未扫描画面。');
  }
  if ([-352, -412, -509].includes(response?.code) || data?.v_voucher) {
    throw videoError('VIDEO_SCAN_RATE_LIMITED', 'B 站暂时限制了视频取流，请稍后重试。');
  }
  if (response?.code !== 0 || !Array.isArray(data?.dash?.video) || data.dash.video.length > 64
    || !Number.isFinite(data.dash.duration) || Math.abs(data.dash.duration - video.duration) > 3) throw mediaError();
  const tracks = [];
  for (const row of data.dash.video) {
    if (!/^avc1\.[a-f\d]{6}$/i.test(row?.codecs || '') || row.drm_tech_type || row.encryption
      || !Number.isSafeInteger(row.id) || row.id <= 0 || (quality !== undefined && row.id !== quality)
      || !Number.isSafeInteger(row.width) || !Number.isSafeInteger(row.height)
      || Math.min(row.width, row.height) < 16 || Math.max(row.width, row.height) > 4096) continue;
    const init = byteRange(row.SegmentBase?.Initialization ?? row.segment_base?.initialization);
    const index = byteRange(row.SegmentBase?.indexRange ?? row.segment_base?.index_range);
    if (!init || !index || init.start !== 0 || index.start !== init.end + 1 || index.end >= FRAME_SCAN.maxIndexBytes) continue;
    const backups = row.backupUrl ?? row.backup_url;
    const urls = [...new Set([row.baseUrl ?? row.base_url, ...(Array.isArray(backups) ? backups.slice(0, 4) : [])]
      .map(url => mediaUrl(url, video.cid)).filter(Boolean))].slice(0, 3);
    if (urls.length) tracks.push({ urls, codec: row.codecs, init, index, quality: row.id, width: row.width, height: row.height });
  }
  const best = tracks.find(track => track.quality === 64) ?? tracks.sort((left, right) => right.quality - left.quality)[0];
  if (!best) throw mediaError();
  return best;
}

export function frameBucket(atMs, durationMs, maxFrames = FRAME_SCAN.maxFrames) {
  return Math.min(maxFrames - 1, Math.floor(atMs * maxFrames / durationMs));
}

export function validateScanBlock(value, scannedMs, durationMs) {
  if (!isScanCursor(value?.scannedMs, durationMs) || value.scannedMs <= scannedMs
    || value.scannedMs - scannedMs > FRAME_SCAN.maxSegmentMs + FRAME_SCAN.stepMs
    || !Array.isArray(value.samples) || value.samples.length > 1 + FRAME_SCAN.maxSegmentMs / FRAME_SCAN.stepMs) return null;
  let last = scannedMs - 1;
  const samples = [];
  for (const sample of value.samples) {
    const atMs = sample?.atMs;
    if (!isScanCursor(atMs, value.scannedMs - 1) || atMs <= last || atMs % FRAME_SCAN.stepMs !== 0) return null;
    last = atMs;
    if (sample.dataUrl !== undefined && !isFrameJpeg(sample.dataUrl)) return null;
    samples.push({ atMs, ...(sample.dataUrl ? { dataUrl: sample.dataUrl } : {}),
      ...(sample.repeat === true ? { repeat: true } : {}), ...(sample.changed === true ? { changed: true } : {}) });
  }
  return { scannedMs: value.scannedMs, samples };
}
