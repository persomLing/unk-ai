import { resizeStitchPlanForPixelLimit } from "./page-capture.js";

export function normalizeCropRect(value, viewport) {
  if (!value || typeof value !== "object") return null;
  const numbers = [value.x, value.y, value.width, value.height].map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const [x, y, width, height] = numbers;
  if (width < 1 || height < 1) return null;
  const vw = Math.max(1, Number(viewport?.width) || width);
  const vh = Math.max(1, Number(viewport?.height) || height);
  const left = Math.max(0, Math.min(x, vw - 1));
  const top = Math.max(0, Math.min(y, vh - 1));
  return {
    x: left,
    y: top,
    width: Math.min(width, vw - left),
    height: Math.min(height, vh - top),
    viewport: { width: vw, height: vh },
  };
}

function canvasFactory(options) {
  if (typeof options.createCanvas === "function") {
    return options.createCanvas;
  }
  if (typeof options.Canvas === "function") {
    return (width, height) => new options.Canvas(width, height);
  }
  if (typeof OffscreenCanvas === "function") {
    return (width, height) => new OffscreenCanvas(width, height);
  }
  return (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

function imageFactory(options) {
  if (typeof options.loadImage === "function") return options.loadImage;
  if (typeof options.Image === "function") {
    return (source) => loadImageWith(() => new options.Image(), source);
  }
  return (source) => loadImageWith(() => new Image(), source);
}

function loadImageWith(create, source) {
  return new Promise((resolve, reject) => {
    const image = create();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("页面截图无法解码。"));
    image.src = source;
  });
}

function encodeCanvas(canvas, mime, quality, options) {
  if (typeof options.encodeCanvas === "function") {
    return options.encodeCanvas(canvas, mime, quality);
  }
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: mime, quality }).then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("浏览器无法编码截图。"));
      reader.readAsDataURL(blob);
    }));
  }
  return Promise.resolve(canvas.toDataURL(mime, quality));
}

export async function cropImageDataUrl(dataUrl, rect, options = {}) {
  const normalized = normalizeCropRect(rect, options.viewport || rect?.viewport);
  if (!normalized) throw new Error("图表区域无效。");
  const image = await imageFactory(options)(dataUrl);
  const scaleX = image.naturalWidth / normalized.viewport.width;
  const scaleY = image.naturalHeight / normalized.viewport.height;
  const sourceX = Math.round(normalized.x * scaleX);
  const sourceY = Math.round(normalized.y * scaleY);
  const sourceWidth = Math.max(1, Math.round(normalized.width * scaleX));
  const sourceHeight = Math.max(1, Math.round(normalized.height * scaleY));
  const maxEdge = Number(options.maxEdge) || 1600;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const canvas = canvasFactory(options)(Math.max(1, Math.round(sourceWidth * scale)), Math.max(1, Math.round(sourceHeight * scale)));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法裁剪截图。");
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return encodeCanvas(canvas, "image/jpeg", 0.86, options);
}

/**
 * Canvas-side stitcher for full-page/region capture data produced by the
 * service worker. It intentionally lives outside the MV3 worker and accepts
 * injectable primitives so the planning path can be tested with Node.
 */
export async function stitchCapturedPage(plan, captures, options = {}) {
  const capturePlan = Array.isArray(plan?.captureChunks) && plan.captureChunks.length
    ? { ...plan, chunks: plan.captureChunks }
    : plan;
  const resizedPlan = resizeStitchPlanForPixelLimit(capturePlan, options.maxPixels);
  if (!resizedPlan?.chunks?.length) {
    throw new Error("没有可拼接的页面截图。");
  }
  if (!Array.isArray(captures) || captures.some((chunk) => typeof chunk !== "string" || !chunk)) {
    throw new Error("页面截图分块不完整。");
  }
  const load = imageFactory(options);
  const makeCanvas = canvasFactory(options);
  const images = await Promise.all(captures.map((source) => load(source)));
  const outputHeight = Math.max(
    1,
    ...resizedPlan.chunks.slice(0, captures.length).map((chunk) => (
      Math.round(Number(chunk.destination?.y) + Number(chunk.destination?.height))
    )),
  );
  const canvas = makeCanvas(
    Math.max(1, resizedPlan.width),
    Number.isFinite(outputHeight) ? outputHeight : resizedPlan.height,
  );
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法拼接截图。");
  const captureViewport = resizedPlan.captureViewport || resizedPlan.viewport;
  if (!captureViewport?.width || !captureViewport?.height) {
    throw new Error("页面截图视图尺寸无效。");
  }
  const scaleX = Number(options.captureWidth || captureViewport.width) / captureViewport.width;
  const scaleY = Number(options.captureHeight || captureViewport.height) / captureViewport.height;
  const quality = Math.max(0.3, Math.min(0.95, Number(options.quality) || 0.8));
  const maxBytes = Number(options.maxBytes) || 4 * 1024 * 1024;
  let currentQuality = quality;
  let dataUrl = "";

  for (let index = 0; index < Math.min(resizedPlan.chunks.length, images.length); index += 1) {
    const chunk = resizedPlan.chunks[index];
    const image = images[index];
    if (!image) throw new Error("页面截图分块不完整。");
    const crop = chunk.sourceCrop;
    const destination = chunk.destination;
    context.drawImage(
      image,
      Math.round(crop.x * scaleX),
      Math.round(crop.y * scaleY),
      Math.max(1, Math.round(crop.width * scaleX)),
      Math.max(1, Math.round(crop.height * scaleY)),
      destination.x,
      destination.y,
      destination.width,
      destination.height,
    );
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    dataUrl = String(await encodeCanvas(canvas, "image/jpeg", currentQuality, options));
    if (jpegBytes(dataUrl) <= maxBytes || currentQuality <= 0.35) break;
    currentQuality = Math.max(0.35, currentQuality - 0.12);
  }
  if (options.maxBytes && jpegBytes(dataUrl) > maxBytes) {
    const downscale = Math.sqrt(maxBytes / jpegBytes(dataUrl));
    if (downscale < 0.98) {
      const resized = makeCanvas(
        Math.max(1, Math.round(canvas.width * downscale)),
        Math.max(1, Math.round(canvas.height * downscale)),
      );
      const resizedContext = resized.getContext("2d");
      if (!resizedContext) throw new Error("浏览器无法压缩截图。");
      resizedContext.drawImage(canvas, 0, 0, resized.width, resized.height);
      dataUrl = String(await encodeCanvas(resized, "image/jpeg", 0.68, options));
    }
  }
  if (!/^data:image\/jpeg;base64,/i.test(dataUrl)) {
    throw new Error("浏览器无法生成 JPEG 截图。");
  }
  return dataUrl;
}

function jpegBytes(value) {
  const dataUrl = String(value || "");
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1).replace(/\s+/g, "") : "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
