import { escapeHtml } from '../../core/dom.js';
import { imageAttachmentLoadError, safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { copyIllustrationPlacement, placeIllustrationNodes } from './illustration-placement.js';
import { illustrationDimensions, illustrationLayoutStyle } from './illustration-layout.js';
import { icon } from '../../icons.js';

const ownedIllustrations = new WeakMap();
const GENERATION_FAILURES = new Set(['generate-failed', 'generate-timeout', 'rate-limit', 'access-denied']);

const REASONS = Object.freeze({
  blocked: '画面受保护或跨域', unverified: '画面与要点不符', 'no-vision': '当前服务未配置支持图片输入的模型',
  'not-ready': '播放器未就绪', uncertain: '播放器状态或画面结果未确认', 'page-changed': '原视频页面已变化',
  'page-required': '请回到原视频标签页', 'no-image-model': '未配置生图模型', 'generate-failed': '图片生成失败',
  'generate-timeout': '生图等待超时',
  'no-frame': '该时间点无可用画面', 'black-frame': '所选时间点的画面为黑屏',
  'stream-unavailable': '原视频流无法读取或解码',
  failed: '截取失败', 'verify-failed': '视觉模型未能完成审阅', 'plan-failed': '配图规划失败', 'plan-invalid': '配图规划返回了无效结果',
  'prompt-invalid': '请填写有效的画面描述，最多 4000 字',
  timeout: '配图规划或画面读取超时', 'rate-limit': '模型额度不足或请求过于频繁', 'access-denied': '模型服务拒绝访问，请检查模型和 API Key',
  'save-failed': '配图保存失败，请保留当前会话并检查本地文件夹', cancelled: '已取消配图', interrupted: '配图已中断，请重新提交提问',
});

function timestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function badge(item) {
  if (!item.videoFrame) return item.videoGenerated ? 'AI 生成示意图 · 非视频真实画面' : 'AI 生成';
  const review = item.videoFrame.verified;
  const status = review === true ? ' · 模型已审阅' : review === false ? ' · 未做内容核对' : '';
  return `视频画面 · ${timestamp(item.videoFrame.time)}${status}`;
}

function locationAttributes(item, index, total) {
  const placement = copyIllustrationPlacement(item.placement) || { version: 1 };
  const time = placement.time ?? item.videoFrame?.time ?? item.time;
  const location = copyIllustrationPlacement({ ...placement, time });
  return `data-illustration-id="${escapeHtml(item.id || '')}" data-illustration-name="${escapeHtml(String(item.name || '').slice(0, 500))}" data-illustration-placement="${escapeHtml(JSON.stringify(location))}" data-illustration-index="${index}" data-illustration-total="${total}"`;
}

function readyFigure(item, index, total, allowImageReference) {
  const src = safeAttachmentDataUrl(item.dataUrl), caption = escapeHtml(item.name || '生成图片');
  const dimensions = illustrationDimensions(item);
  const intrinsicSize = dimensions.width ? ` width="${dimensions.width}" height="${dimensions.height}"` : '';
  const attributes = `${locationAttributes(item, index, total)} style="${illustrationLayoutStyle(item.illustrationLayout, item, dimensions)}"`;
  if (!src) {
    const error = imageAttachmentLoadError(item) || '图片暂不可用。';
    return `<figure class="generated-image is-unavailable" ${attributes}><figcaption>${caption}</figcaption><small class="message-file-error">${escapeHtml(error)}</small></figure>`;
  }
  return `<figure class="generated-image${item.videoFrame ? ' is-frame' : ''}" ${attributes}>
    <div class="generated-image-media"><img class="message-image" data-image-preview tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看图片 ${caption}" title="点击放大" src="${src}" alt="${caption}"${intrinsicSize} /></div>
    <figcaption><span class="generated-image-badge">${escapeHtml(badge(item))}</span><span class="generated-image-caption">${caption}</span>${allowImageReference ? `<button class="generated-image-reference" type="button" data-action="reference-image" data-image-id="${escapeHtml(item.id || '')}" title="把这张图片加入输入框作为参考图">${icon('sparkles')}引用生图</button>` : ''}</figcaption>
  </figure>`;
}

export function imageReplyPlaceholder(layout) {
  return `<div class="generated-image-placeholder direct-image-placeholder" data-image-reply-placeholder style="${illustrationLayoutStyle(layout)}" aria-hidden="true"></div>`;
}

function pendingFigure(item, index, total) {
  const caption = escapeHtml(item.name || '配图');
  const label = item.phase === 'planning' ? '正在判断图片布局…' : item.kind === 'frame' ? '正在截取视频画面并审阅…' : '正在生成图片…';
  const style = illustrationLayoutStyle(item.layout, { videoFrame: item.kind === 'frame' ? {} : null });
  return `<figure class="generated-image is-loading" ${locationAttributes(item, index, total)} style="${style}" aria-busy="true">
    <div class="generated-image-placeholder" role="status"><div class="generated-image-progress"><span class="illustration-progress-label"><span class="illustration-spinner" aria-hidden="true"></span><span>${label}</span></span><button class="illustration-cancel" data-action="cancel-illustration" type="button" title="取消本轮剩余配图">取消配图</button></div></div>
    <figcaption><span class="generated-image-badge">${escapeHtml(item.kind === 'frame' ? `视频配图 · ${timestamp(item.time)}` : badge(item))}</span><span class="generated-image-caption">${caption}</span></figcaption>
  </figure>`;
}

/** Planned slots keep their IDs and order as each image arrives. Pending slots
 * are metadata, never empty image attachments passed to disk image storage. */
export function generatedImagesMarkup(message, { allowImageReference = false } = {}) {
  const files = (Array.isArray(message.attachments) ? message.attachments : [])
    .filter(item => item?.type === 'image' && (item.generated || item.videoFrame));
  const info = message.videoIllustration || message.illustration || {};
  const items = (Array.isArray(info.items) ? info.items : []).slice(0, 3).filter(item => typeof item?.id === 'string');
  const byId = new Map(files.map(file => [file.id, file]));
  const seen = new Set();
  const extra = files.filter(file => !items.some(item => item.id === file.id));
  const total = items.length + extra.length;
  const figures = items.map((item, index) => {
    seen.add(item.id);
    const file = byId.get(item.id);
    if (file) return readyFigure({ ...file, placement: file.placement || item.placement,
      illustrationLayout: file.illustrationLayout || item.layout }, index, total, allowImageReference);
    return info.status === 'generating' && item.status === 'loading' ? pendingFigure(item, index, total) : '';
  }).concat(extra.filter(file => !seen.has(file.id)).map((file, index) => readyFigure(file, items.length + index, total, allowImageReference))).join('');
  return figures ? `<div class="message-illustrations">${figures}</div>` : '';
}

/** Only the gallery created as an article's direct child belongs to this renderer.
 * Markdown descendants cannot register arbitrary nodes for sanitizer bypass. */
export function detachMessageIllustrations(container) {
  let owned = ownedIllustrations.get(container);
  if (!owned && container.hasAttribute('data-message-content') && container.parentElement?.classList.contains('assistant-message')) {
    const gallery = [...container.parentElement.children].find(node => node.classList.contains('message-illustrations'));
    if (gallery) {
      const entries = [...gallery.children].filter(node => node.matches('figure.generated-image')).map(node => {
        let placement;
        try { placement = copyIllustrationPlacement(JSON.parse(node.dataset.illustrationPlacement || 'null')); } catch {}
        return { node, item: { name: node.dataset.illustrationName || '', placement },
          index: Number(node.dataset.illustrationIndex) || 0, total: Number(node.dataset.illustrationTotal) || 1 };
      });
      owned = { entries, groups: [gallery] };
      ownedIllustrations.set(container, owned);
    }
  }
  for (const group of owned?.groups || []) group.remove();
}

export function restoreMessageIllustrations(container) {
  const owned = ownedIllustrations.get(container);
  if (owned) owned.groups = placeIllustrationNodes(container, owned.entries);
}

export function replaceMessageIllustrations(container, gallery) {
  detachMessageIllustrations(container);
  ownedIllustrations.delete(container);
  if (gallery) container.parentElement.append(gallery);
}

function generationFailureText(failure) {
  if (!GENERATION_FAILURES.has(failure?.reason)) return '';
  const code = failure.httpStatus;
  const http = Number.isInteger(code) && code >= 400 && code <= 599 ? `（HTTP ${code}）` : '';
  return `${REASONS[failure.reason]}${http}。`;
}

export function videoIllustrationNote(message) {
  const info = message.videoIllustration;
  if (!info || typeof info !== 'object') return '';
  if (info.status === 'generating' && (info.mode === 'frame' || info.items?.some(item => item.kind === 'frame' && item.status === 'loading'))) {
    return '<p class="video-illustration-note is-capturing" role="status">正在独立截帧并审阅画面。你可以继续观看原视频。</p>';
  }
  if (info.mode === 'generate' && info.status === 'generating' && info.phase === 'planning') {
    return '<p class="video-illustration-note" role="status">正在规划视频配图…</p>';
  }
  const warning = info.warnings?.length ? '<p class="video-illustration-note">原视频来源或画面时间无法确认，本轮截帧已停止。</p>' : '';
  if (info.mode === 'frame' && info.status === 'unavailable' && (info.embedded ?? 0) === 0) {
    const reason = info.reason || info.skipped?.find(item => item.reason !== 'not-needed')?.reason
      || info.items?.find(item => item.status === 'unavailable' && item.reason !== 'not-needed')?.reason;
    const explanation = REASONS[reason];
    if (reason === 'no-vision' || reason === 'verify-failed') {
      return `${warning}<p class="video-illustration-note">${escapeHtml(explanation)}，本轮未插入截图。</p>`;
    }
    if (explanation) return `${warning}<p class="video-illustration-note">本轮截帧未完成。${escapeHtml(explanation)}。</p>`;
  }
  if (info.reason === 'save-failed') return `${warning}<p class="video-illustration-note">${REASONS['save-failed']}。</p>`;
  if (info.reason === 'no-image-model' || info.items?.some(item => item.reason === 'no-image-model')) return `${warning}<p class="video-illustration-note">${REASONS['no-image-model']}。</p>`;
  if (info.mode === 'generate' && info.status === 'unavailable' && (info.embedded ?? 0) === 0) {
    const failure = info.skipped?.find(item => GENERATION_FAILURES.has(item.reason)) || info;
    const explanation = generationFailureText(failure);
    if (explanation) return `<p class="video-illustration-note">${escapeHtml(explanation)}</p>`;
  }
  if (info.status === 'unavailable' && !info.items?.length) {
    const reason = ['plan-failed', 'plan-invalid', 'timeout'].includes(info.reason) ? REASONS[info.reason] : '';
    return `${warning}${reason ? `<p class="video-illustration-note">${reason}。</p>` : ''}`;
  }
  return warning;
}

export function illustrationNote(message) {
  const info = message.illustration;
  if (!info || typeof info !== 'object' || info.status !== 'unavailable') return '';
  if (info.phase === 'generate') {
    const explanation = generationFailureText(info);
    if (explanation) return `<p class="video-illustration-note">${escapeHtml(explanation)}</p>`;
  }
  if (info.items?.length && !['save-failed', 'no-image-model'].includes(info.reason)) return '';
  const reason = REASONS[info.reason] || '配图失败';
  return `<p class="video-illustration-note">${escapeHtml(reason)}。</p>`;
}
