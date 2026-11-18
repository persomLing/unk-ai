import { escapeHtml } from '../../core/dom.js';
import { imageAttachmentLoadError, safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { copyIllustrationPlacement, placeIllustrationNodes } from './illustration-placement.js';
import { illustrationLayoutStyle } from './illustration-layout.js';

const ownedIllustrations = new WeakMap();

const REASONS = Object.freeze({
  blocked: '画面受保护或跨域', unverified: '画面与要点不符', 'no-vision': '当前模型不支持视觉核对',
  'not-ready': '播放器未就绪', uncertain: '播放器状态或画面结果未确认', 'page-changed': '原视频页面已变化',
  'page-required': '请回到原视频标签页', 'no-image-model': '未配置生图模型', 'generate-failed': '图片生成失败',
  'no-frame': '无可用画面', failed: '截取失败', 'verify-failed': '画面核对失败', 'plan-failed': '配图规划失败', 'plan-invalid': '配图规划返回了无效结果',
  'prompt-invalid': '请填写有效的画面描述，最多 4000 字',
  timeout: '配图规划或画面读取超时', 'rate-limit': '模型额度不足或请求过于频繁', 'access-denied': '模型服务拒绝访问，请检查模型和 API Key',
  'save-failed': '配图保存失败，请保留当前会话并检查本地文件夹', cancelled: '已取消配图', interrupted: '配图已中断，请重新提交提问',
});

function timestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function badge(item) {
  return item.videoFrame ? `视频画面 · ${timestamp(item.videoFrame.time)}${item.videoFrame.verified === false ? ' · 未做内容核对' : ''}`
    : item.videoGenerated ? 'AI 生成示意图 · 非视频真实画面' : 'AI 生成';
}

function locationAttributes(item, index, total) {
  const placement = copyIllustrationPlacement(item.placement) || { version: 1 };
  const time = placement.time ?? item.videoFrame?.time ?? item.time;
  const location = copyIllustrationPlacement({ ...placement, time });
  return `data-illustration-id="${escapeHtml(item.id || '')}" data-illustration-name="${escapeHtml(String(item.name || '').slice(0, 500))}" data-illustration-placement="${escapeHtml(JSON.stringify(location))}" data-illustration-index="${index}" data-illustration-total="${total}"`;
}

function readyFigure(item, index, total) {
  const src = safeAttachmentDataUrl(item.dataUrl), caption = escapeHtml(item.name || '生成图片');
  const attributes = `${locationAttributes(item, index, total)} style="${illustrationLayoutStyle(item.illustrationLayout, item)}"`;
  if (!src) {
    const error = imageAttachmentLoadError(item) || '图片暂不可用。';
    return `<figure class="generated-image is-unavailable" ${attributes}><figcaption>${caption}</figcaption><small class="message-file-error">${escapeHtml(error)}</small></figure>`;
  }
  return `<figure class="generated-image${item.videoFrame ? ' is-frame' : ''}" ${attributes}>
    <img class="message-image" data-image-preview tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看图片 ${caption}" title="点击放大" src="${src}" alt="${caption}" />
    <figcaption><span class="generated-image-badge">${escapeHtml(badge(item))}</span><span class="generated-image-caption">${caption}</span></figcaption>
  </figure>`;
}

function pendingFigure(item, index, total) {
  const caption = escapeHtml(item.name || '配图');
  const label = item.phase === 'planning' ? '正在判断图片布局…' : item.kind === 'frame' ? '正在截取视频画面…' : '正在生成图片…';
  const notice = item.kind === 'frame' ? '<small class="illustration-frame-notice">请不要离开视频页面</small>' : '';
  const style = illustrationLayoutStyle(item.layout, { videoFrame: item.kind === 'frame' ? {} : null });
  return `<figure class="generated-image is-loading" ${locationAttributes(item, index, total)} style="${style}" aria-busy="true">
    <div class="generated-image-placeholder" role="status"><div class="generated-image-progress"><span class="illustration-progress-label"><span class="illustration-spinner" aria-hidden="true"></span><span>${label}</span></span><button class="illustration-cancel" data-action="cancel-illustration" type="button" title="取消本轮剩余配图">取消配图</button></div></div>${notice}
    <figcaption><span class="generated-image-badge">${escapeHtml(item.kind === 'frame' ? `视频配图 · ${timestamp(item.time)}` : badge(item))}</span><span class="generated-image-caption">${caption}</span></figcaption>
  </figure>`;
}

/** Planned slots keep their IDs and order as each image arrives. Pending slots
 * are metadata, never empty image attachments passed to disk image storage. */
export function generatedImagesMarkup(message) {
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
      illustrationLayout: file.illustrationLayout || item.layout }, index, total);
    return info.status === 'generating' && item.status === 'loading' ? pendingFigure(item, index, total) : '';
  }).concat(extra.filter(file => !seen.has(file.id)).map((file, index) => readyFigure(file, items.length + index, total))).join('');
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

export function videoIllustrationNote(message) {
  const info = message.videoIllustration;
  if (!info || typeof info !== 'object') return '';
  if (info.status === 'generating' && (info.mode === 'frame' || info.items?.some(item => item.kind === 'frame' && item.status === 'loading'))) {
    return '<p class="video-illustration-note is-capturing" role="status">正在准备视频截帧，请不要离开当前视频页面，也不要切换分 P；完成后会在对应位置显示画面。</p>';
  }
  const warning = info.warnings?.length ? '<p class="video-illustration-note">播放器状态或页面未确认，已停止后续自动截帧，请先核对原视频。</p>' : '';
  if (info.reason === 'save-failed') return `${warning}<p class="video-illustration-note">${REASONS['save-failed']}。</p>`;
  if (info.reason === 'no-image-model' || info.items?.some(item => item.reason === 'no-image-model')) return `${warning}<p class="video-illustration-note">${REASONS['no-image-model']}。</p>`;
  if (info.status === 'unavailable' && !info.items?.length) {
    const reason = ['plan-failed', 'plan-invalid'].includes(info.reason) ? REASONS[info.reason] : '';
    return `${warning}${reason ? `<p class="video-illustration-note">${reason}。</p>` : ''}`;
  }
  return warning;
}

export function illustrationNote(message) {
  const info = message.illustration;
  if (!info || typeof info !== 'object' || info.status !== 'unavailable') return '';
  if (info.items?.length && !['save-failed', 'no-image-model'].includes(info.reason)) return '';
  const reason = REASONS[info.reason] || '配图失败';
  return `<p class="video-illustration-note">${escapeHtml(reason)}。</p>`;
}
