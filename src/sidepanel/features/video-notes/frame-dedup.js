import { FRAME_SCAN, frameBucket } from './video-scan-protocol.js';

function dHash(pixels, width, height, top, bottom, columns, rows) {
  const hash = new Uint8Array(columns * rows);
  const sample = (col, row) => {
    const x = Math.min(width - 1, Math.floor((col + 0.5) * width / (columns + 1)));
    const y = Math.min(height - 1, Math.floor((top + (bottom - top) * (row + 0.5) / rows) * height));
    const index = (y * width + x) * 4;
    return (pixels[index] * 77 + pixels[index + 1] * 150 + pixels[index + 2] * 29) >> 8;
  };
  for (let row = 0; row < rows; row++) {
    let previous = sample(0, row);
    for (let col = 0; col < columns; col++) {
      const next = sample(col + 1, row);
      hash[row * columns + col] = previous > next ? 1 : 0;
      previous = next;
    }
  }
  return hash;
}

export function frameSignature(pixels, width, height) {
  let sum = 0, squares = 0;
  const count = width * height;
  for (let index = 0; index < pixels.length; index += 4) {
    const luma = (pixels[index] * 77 + pixels[index + 1] * 150 + pixels[index + 2] * 29) >> 8;
    sum += luma;
    squares += luma ** 2;
  }
  if (sum / count < 12 && squares / count - (sum / count) ** 2 < 44) return null;
  return [dHash(pixels, width, height, 0, 1, 32, 32), dHash(pixels, width, height, 0.7, 1, 32, 8),
    dHash(pixels, width, height, 0, 0.2, 32, 8)];
}

export function sameFrame(left, right) {
  if (!left || !right) return false;
  return left.every((hash, band) => {
    let distance = 0;
    const limit = band === 0 ? 12 : 10;
    for (let index = 0; index < hash.length; index++) {
      if (hash[index] !== right[band][index] && ++distance > limit) return false;
    }
    return true;
  });
}

export function createFrameSelection(durationMs, { maxFrames = FRAME_SCAN.maxFrames, previous } = {}) {
  const frames = (previous?.frames || []).map(frame => ({ ...frame }));
  const buckets = new Set(frames.map(frame => frameBucket(frame.atMs, durationMs, maxFrames)));
  let last = frames.at(-1), candidates = previous?.candidates || 0;
  return {
    add(sample) {
      const { atMs } = sample, endMs = Math.min(durationMs, atMs + FRAME_SCAN.stepMs);
      if (sample.repeat && last?.endMs === atMs) { last.endMs = endMs; return; }
      last = null;
      if (!sample.dataUrl && !sample.changed) return;
      candidates++;
      const bucket = frameBucket(atMs, durationMs, maxFrames);
      if (!sample.dataUrl || buckets.has(bucket)) return;
      buckets.add(bucket);
      last = { id: 'f' + atMs, atMs, endMs, dataUrl: sample.dataUrl };
      frames.push(last);
    },
    snapshot: () => ({ frames, candidates }),
  };
}
