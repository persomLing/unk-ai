const ASPECTS = Object.freeze(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']);
const SIZE_ASPECTS = Object.freeze({ '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' });

export const ILLUSTRATION_LAYOUT_INSTRUCTIONS = '根据画面内容和用户要求判断 aspectRatio（auto、1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9）'
  + '。横向流程、视频演示通常适合横图，人物全身通常适合竖图。用户明确要求的比例优先；显示宽度由应用统一处理。';

/** Only bounded layout choices cross the model/storage → CSS boundary. */
export function createIllustrationLayout(value, { size = 'auto', frame = false } = {}) {
  const aspectRatio = ASPECTS.includes(value?.aspectRatio) ? value.aspectRatio : SIZE_ASPECTS[size] || (frame ? '16:9' : 'auto');
  return { version: 1, aspectRatio };
}

export function copyIllustrationLayout(value) {
  return value?.version === 1 && typeof value === 'object' && !Array.isArray(value) ? createIllustrationLayout(value) : null;
}

export function imageReplyLayout(prompt) {
  const aspectRatio = String(prompt || '').match(/(?<!\d)(16\s*[:：]\s*9|1\s*[:：]\s*1)(?!\d)/u)?.[1]
    .replace(/\s/g, '').replace('：', ':');
  return createIllustrationLayout({ aspectRatio });
}

function dimensions(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= 32768 && height <= 32768 ? { width, height } : {};
}

/** Read local raster headers without a browser, another request or a decode wait.
 * Unknown/legacy images still display at their natural ratio through height:auto. */
export function illustrationDimensions(image) {
  let binary = '';
  try {
    const encoded = String(image?.dataUrl || '').match(/^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/]+={0,2})$/i)?.[1];
    if (encoded) binary = atob(encoded.slice(0, 262144));
  } catch {}
  const byte = at => binary.charCodeAt(at);
  const little = (at, count) => Array.from({ length: count }, (_, index) => byte(at + index) * 2 ** (8 * index)).reduce((a, b) => a + b, 0);
  const big = (at, count) => Array.from({ length: count }, (_, index) => byte(at + index) * 2 ** (8 * (count - index - 1))).reduce((a, b) => a + b, 0);
  if (binary.length >= 24 && binary.startsWith('\x89PNG\r\n\x1a\n') && binary.slice(12, 16) === 'IHDR') return dimensions(big(16, 4), big(20, 4));
  if (binary.length >= 10 && /^GIF8[79]a/.test(binary)) return dimensions(little(6, 2), little(8, 2));
  if (binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP') {
    const format = binary.slice(12, 16);
    if (format === 'VP8X' && binary.length >= 30) return dimensions(1 + little(24, 3), 1 + little(27, 3));
    if (format === 'VP8 ' && binary.length >= 30 && binary.slice(23, 26) === '\x9d\x01\x2a') return dimensions(little(26, 2) & 0x3fff, little(28, 2) & 0x3fff);
    if (format === 'VP8L' && binary.length >= 25 && byte(20) === 0x2f) return dimensions(1 + (little(21, 4) & 0x3fff), 1 + ((little(21, 4) >>> 14) & 0x3fff));
  }
  if (binary.startsWith('\xff\xd8')) {
    for (let offset = 2; offset + 9 <= binary.length;) {
      if (byte(offset) !== 0xff) break;
      while (byte(offset) === 0xff) offset++;
      const marker = byte(offset++);
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = big(offset, 2);
      if (length < 2 || offset + length > binary.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return dimensions(big(offset + 5, 2), big(offset + 3, 2));
      }
      offset += length;
    }
  }
  return dimensions(image?.width, image?.height);
}

export function illustrationLayoutStyle(value, image, actual = illustrationDimensions(image)) {
  const layout = copyIllustrationLayout(value) || createIllustrationLayout(null, { frame: Boolean(image?.videoFrame) });
  const aspect = actual.width ? `${actual.width} / ${actual.height}` : (layout.aspectRatio === 'auto' ? '4:3' : layout.aspectRatio).replace(':', ' / ');
  return `--illustration-aspect:${aspect}`;
}

export function illustrationGenerationSize(size, layout) {
  return SIZE_ASPECTS[size] && layout.aspectRatio !== 'auto' && SIZE_ASPECTS[size] !== layout.aspectRatio ? 'auto' : size;
}

export function illustrationGenerationPrompt(prompt, layout) {
  if (layout.aspectRatio === 'auto') return prompt;
  const hint = `\n\n画面宽高比：${layout.aspectRatio}。请按该比例构图。`;
  // A full direct user prompt must never be silently truncated for a layout hint.
  return prompt.length + hint.length <= 4000 ? prompt + hint : prompt;
}
