import { createFile, DataStream } from 'mp4box';
import { FRAME_SCAN, frameBucket } from '../sidepanel/features/video-notes/video-scan-protocol.js';
import { frameSignature, sameFrame } from '../sidepanel/features/video-notes/frame-dedup.js';
import { videoError } from '../sidepanel/features/video-notes/video-request.js';
import { awaitWithAbort } from '../utils/abortable.js';

const unsupported = () => videoError('VIDEO_DECODE_UNSUPPORTED', '无法解码这个 B 站视频流；加密流、不兼容的编码和分片格式不受支持。');
const inaccessible = () => videoError('VIDEO_MEDIA_INACCESSIBLE', 'B 站视频分片未能读取（可能受跨域、地区或访问限制），未生成完整笔记。');

async function fetchBytes(url, { start, end }, signal, fetcher) {
  const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` }, signal,
    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'strict-origin-when-cross-origin' });
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (response.status !== 206 || Number(range?.[1]) !== start || Number(range?.[2]) !== end
    || !Number.isSafeInteger(Number(range?.[3])) || Number(range?.[3]) <= end || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw inaccessible();
  }
  const bytes = new Uint8Array(end - start + 1), reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      if (offset + value.byteLength > bytes.length) throw inaccessible();
      bytes.set(value, offset); offset += value.byteLength;
    }
    if (offset !== bytes.length) throw inaccessible();
    return { buffer: bytes.buffer, total: Number(range[3]) };
  } finally { void reader.cancel().catch(() => {}); }
}

const parseBuffer = (file, buffer, offset = 0) => file.appendBuffer(Object.assign(buffer, { fileStart: offset }), true);

export function readSegmentIndex(buffer, track, total, durationMs) {
  const file = createFile();
  parseBuffer(file, buffer);
  const index = file.getBox('sidx');
  if (!index?.timescale || !Array.isArray(index.references) || !index.references.length
    || index.start !== track.index.start || index.start + index.size !== track.index.end + 1
    || index.earliest_presentation_time < 0 || index.earliest_presentation_time * 1000 / index.timescale > 500) throw unsupported();
  let start = index.start + index.size + index.first_offset, time = 0;
  const segments = index.references.map(reference => {
    const end = start + reference.referenced_size - 1, fromMs = Math.round(time * 1000 / index.timescale);
    time += reference.subsegment_duration;
    const toMs = Math.min(durationMs, Math.round(time * 1000 / index.timescale));
    if (reference.reference_type || !Number.isSafeInteger(start) || start <= track.index.end || !Number.isSafeInteger(end)
      || end >= total || reference.referenced_size <= 0 || reference.referenced_size > FRAME_SCAN.maxSegmentBytes
      || toMs <= fromMs || toMs - fromMs > FRAME_SCAN.maxSegmentMs) throw unsupported();
    const segment = { start, end, fromMs, toMs };
    start = end + 1;
    return segment;
  });
  if (Math.abs(time * 1000 / index.timescale - durationMs) > 3000) throw unsupported();
  return segments;
}

export function readAvcSegment(init, media, codec) {
  const file = createFile(true);
  parseBuffer(file, init.slice(0));
  if (!file.moov || file.getBox('pssh')) throw unsupported();
  const tracks = file.getInfo().videoTracks;
  if (tracks?.length !== 1 || tracks[0].codec.toLowerCase() !== codec.toLowerCase()) throw unsupported();
  const info = tracks[0], track = file.getTrackById(info.id), entries = track.mdia.minf.stbl.stsd.entries;
  if (entries.length !== 1 || entries[0].type !== 'avc1' || !entries[0].avcC || entries[0].sinf
    || Math.min(info.video.width, info.video.height) < 16 || Math.max(info.video.width, info.video.height) > 4096) throw unsupported();
  const edits = track.edts?.elst?.entries || [];
  if (edits.length > 1 || (edits.length && (edits[0].media_time < 0 || edits[0].media_rate_integer !== 1
    || edits[0].media_rate_fraction !== 0))) throw unsupported();
  const timestamp = sample => Math.round((sample.cts - (edits[0]?.media_time || 0)) * 1e6 / sample.timescale);
  const avcConfig = new DataStream();
  entries[0].avcC.write(avcConfig);
  const description = new Uint8Array(avcConfig.buffer, 8);
  parseBuffer(file, media, init.byteLength);
  if (file.getBox('pssh') || file.getBox('senc') || file.getBox('saiz') || file.getBox('saio')
    || file.moofs?.some(fragment => fragment.trafs.some(part => part.tfhd?.flags & 1))) throw unsupported();
  const samples = file.getTrackSamplesInfo(info.id);
  if (!samples?.length || !samples[0].is_sync || samples.length > 4000) throw unsupported();
  return { config: { codec, codedWidth: info.video.width, codedHeight: info.video.height, description,
    hardwareAcceleration: 'no-preference' }, samples, timestamp, readSample: index => file.getTrackSample(info.id, index) };
}

async function decodeSegment(init, buffer, media, segment, { signal, cursor, sampleFrame }) {
  const { config, samples, timestamp, readSample } = readAvcSegment(init, buffer, media.codec);
  if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') throw unsupported();
  const support = await awaitWithAbort(VideoDecoder.isConfigSupported(config), signal);
  signal.throwIfAborted();
  if (!support.supported) throw unsupported();
  let next = Math.ceil(Math.max(cursor, segment.fromMs) / FRAME_SCAN.stepMs) * FRAME_SCAN.stepMs;
  const output = [];
  let failure, previous = null, notifyQueue;
  const collect = (frame, until) => {
    const frameMs = frame.timestamp / 1000;
    while (next < segment.toMs && next < until) {
      output.push(Math.abs(frameMs - next) <= 350 ? sampleFrame(frame, next) : { atMs: next });
      next += FRAME_SCAN.stepMs;
    }
  };
  const decoder = new VideoDecoder({
    output(frame) {
      if (signal.aborted || failure) { frame.close(); return; }
      try {
        if (previous) collect(previous, frame.timestamp / 1000);
      } catch { failure = unsupported(); }
      finally { previous?.close(); previous = frame; }
    },
    error() { failure = unsupported(); notifyQueue?.(); },
  });
  try {
    decoder.configure(config);
    for (const [index, sample] of samples.entries()) {
      signal.throwIfAborted();
      if (failure) throw failure;
      while (decoder.decodeQueueSize >= 16) {
        const dequeued = new Promise(resolve => { notifyQueue = resolve; });
        decoder.addEventListener('dequeue', notifyQueue, { once: true });
        try { await awaitWithAbort(dequeued, signal); }
        finally { decoder.removeEventListener('dequeue', notifyQueue); notifyQueue = null; }
        if (failure) throw failure;
      }
      const decoded = readSample(index);
      if (!decoded?.data || !Number.isSafeInteger(timestamp(sample)) || !sample.timescale) throw unsupported();
      decoder.decode(new EncodedVideoChunk({ type: sample.is_sync ? 'key' : 'delta', timestamp: timestamp(sample),
        duration: Math.round(sample.duration * 1e6 / sample.timescale), data: decoded.data }));
    }
    await awaitWithAbort(decoder.flush(), signal);
    signal.throwIfAborted();
    if (failure || !previous) throw unsupported();
    collect(previous, (previous.timestamp + (previous.duration ?? 0)) / 1000 + 2);
    while (next < segment.toMs) { output.push({ atMs: next }); next += FRAME_SCAN.stepMs; }
    return output;
  } finally { previous?.close(); if (decoder.state !== 'closed') decoder.close(); }
}

function createFrameSampler(durationMs) {
  const canvas = document.createElement('canvas'), hashCanvas = document.createElement('canvas');
  hashCanvas.width = 132; hashCanvas.height = 96;
  const pixels = hashCanvas.getContext('2d', { willReadFrequently: true });
  const picture = canvas.getContext('2d', { alpha: false });
  if (!pixels || !picture) throw unsupported();
  let signature = null, keptBucket = -1;
  return (frame, atMs) => {
    pixels.drawImage(frame, 0, 0, hashCanvas.width, hashCanvas.height);
    const current = frameSignature(pixels.getImageData(0, 0, hashCanvas.width, hashCanvas.height).data, hashCanvas.width, hashCanvas.height);
    if (!current) { signature = null; return { atMs }; }
    if (sameFrame(signature, current)) return { atMs, repeat: true };
    signature = current;
    const bucket = frameBucket(atMs, durationMs);
    if (bucket === keptBucket) return { atMs, changed: true };
    const scale = Math.min(1, FRAME_SCAN.maxEdge / Math.max(frame.displayWidth, frame.displayHeight));
    canvas.width = Math.max(1, Math.round(frame.displayWidth * scale));
    canvas.height = Math.max(1, Math.round(frame.displayHeight * scale));
    picture.drawImage(frame, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.72, 0.55, 0.38]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= FRAME_SCAN.maxImageChars) { keptBucket = bucket; return { atMs, dataUrl }; }
    }
    return { atMs, changed: true };
  };
}

export async function scanVideoFrames({ media, durationMs, startMs, signal, onBlock, fetcher = fetch }) {
  let source, init, index;
  for (const url of media.urls) {
    signal.throwIfAborted();
    try {
      const initial = await fetchBytes(url, media.init, signal, fetcher);
      const segmentIndex = await fetchBytes(url, media.index, signal, fetcher);
      if (initial.total !== segmentIndex.total) throw inaccessible();
      init = initial.buffer; index = segmentIndex; source = url;
      break;
    }
    catch { signal.throwIfAborted(); }
  }
  if (!source) throw inaccessible();
  const header = new Uint8Array(init.byteLength + index.buffer.byteLength);
  header.set(new Uint8Array(init)); header.set(new Uint8Array(index.buffer), init.byteLength);
  const segments = readSegmentIndex(header.buffer, media, index.total, durationMs);
  const sampleFrame = createFrameSampler(durationMs);
  let downloaded = header.byteLength, scannedMs = startMs;
  for (const segment of segments) {
    if (segment.toMs <= startMs) continue;
    signal.throwIfAborted();
    if (downloaded + segment.end - segment.start + 1 > FRAME_SCAN.maxDownloadBytes) return { scannedMs, status: 'limited' };
    let response;
    try { response = await fetchBytes(source, segment, signal, fetcher); }
    catch { signal.throwIfAborted(); throw inaccessible(); }
    if (response.total !== index.total) throw inaccessible();
    downloaded += response.buffer.byteLength;
    const samples = await decodeSegment(init, response.buffer, media, segment, { signal, cursor: startMs, sampleFrame });
    signal.throwIfAborted();
    await onBlock({ scannedMs: segment.toMs, samples });
    scannedMs = segment.toMs;
  }
  return { scannedMs, status: 'complete' };
}
