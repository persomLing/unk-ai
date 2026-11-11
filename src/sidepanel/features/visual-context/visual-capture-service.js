import { compact } from 'lodash-es';
import { prepareImageDataUrl, safeAttachmentDataUrl } from '../../../utils/attachments.js';
import { stitchCapturedPage } from '../../../utils/image-crop.js';
import { stitchPlanForCaptures } from '../../../utils/page-capture.js';
import { normalizePageContext, normalizeVisualCapture } from '../../../utils/reading-context.js';
import { assertPageTarget, pageTargetFields } from '../../../utils/page-target.js';

function preparedCapture(capture, scope, page) {
  const attachment = prepareImageDataUrl(capture.dataUrl, {
    name: `${scope === 'page' ? '页面' : '画面'}-${Date.now()}.jpg`,
    pageTitle: capture.pageTitle || page?.title || '',
    pageUrl: capture.pageUrl || page?.url || '',
    source: 'page-visual-context',
  });
  return {
    ...attachment,
    figureId: capture.figureId || '',
    caption: capture.caption || '',
    section: capture.section || [],
    nearby: capture.nearby || '',
    scope: capture.scope || scope,
    fullPage: Boolean(capture.fullPage),
  };
}

/**
 * Visual capture feature slot. The caller supplies the browser transport and
 * the page context; this module owns fallback order and attachment shaping.
 */
export function createVisualCaptureService({
  sendMessage,
  getCurrentPage,
}) {
  async function capture({ scope = 'viewport' } = {}) {
    const page = normalizePageContext(getCurrentPage());
    const target = pageTargetFields(page || {});
    let captures = [];
    try {
      const response = await sendMessage({
        type: 'CAPTURE_PAGE_VISUAL_CONTEXT',
        ...target,
        scope,
        maxImages: scope === 'page' ? 2 : 1,
        maxEdge: 1600,
      });
      if (response?.error) throw new Error(response.error);
      assertPageTarget(target, response);
      if (response?.chunks?.length || response?.captureChunks?.length) {
        const captureData = response.captureChunks?.length ? response.captureChunks : response.chunks;
        const dataUrls = captureData
          .map((chunk) => safeAttachmentDataUrl(String(chunk?.dataUrl || '')))
          .filter(Boolean);
        const plan = stitchPlanForCaptures(response.plan, response.chunks || captureData);
        if (plan && dataUrls.length) {
          const dataUrl = await stitchCapturedPage(plan, dataUrls, {
            maxBytes: 2 * 1024 * 1024,
            quality: 0.8,
          });
          captures = normalizeVisualCapture({ dataUrl, scope: 'page', fullPage: true }, {
            pageTitle: response.title || page?.title,
            pageUrl: response.url || page?.url,
            scope: 'page',
            fullPage: true,
          });
        }
      } else {
        captures = normalizeVisualCapture(response, {
          pageTitle: page?.title,
          pageUrl: page?.url,
          scope,
          fullPage: scope === 'page',
        });
      }
    } catch {
      captures = [];
    }
    if (!captures.length) {
      try {
        const response = await sendMessage({ type: 'CAPTURE_ACTIVE_TAB', ...target });
        if (response?.error) throw new Error(response.error);
        assertPageTarget(target, response);
        const dataUrl = safeAttachmentDataUrl(String(response?.dataUrl || ''));
        if (dataUrl) captures = [{
          dataUrl,
          pageTitle: page?.title || '',
          pageUrl: page?.url || '',
          scope: 'viewport',
          fullPage: false,
        }];
      } catch {
        captures = [];
      }
    }
    return compact(captures.slice(0, 2).map((capture) => {
      try {
        return preparedCapture(capture, scope, page);
      } catch {
        return null;
      }
    }));
  }

  return Object.freeze({ capture });
}
