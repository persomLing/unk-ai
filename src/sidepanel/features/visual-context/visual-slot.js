import { compact, uniqBy } from 'lodash-es';
import { prepareImageDataUrl } from '../../../utils/attachments.js';
import { normalizePageContext, normalizeVisualCapture } from '../../../utils/reading-context.js';
import {
  buildVisualDecisionPrompt,
  localVisualDecision,
  needsVisualPreflight,
  parseVisualDecision,
} from '../../../utils/visual-intent.js';

function dataUrlOf(capture) {
  return String(capture?.dataUrl || '');
}

export function visualAttachmentsFromResponse(response, page, scope = 'page') {
  const captures = normalizeVisualCapture(response, {
    pageTitle: page?.title,
    pageUrl: page?.url,
    scope,
    fullPage: scope === 'page',
  });
  return uniqBy(captures.map((capture) => prepareImageDataUrl(dataUrlOf(capture), {
    name: `${scope === 'page' ? '页面' : '画面'}-${Date.now()}.jpg`,
    pageTitle: capture.pageTitle || page?.title,
    pageUrl: capture.pageUrl || page?.url,
    source: 'auto-visual-context',
  })).map((attachment, index) => ({
    ...attachment,
    scope: captures[index]?.scope || scope,
    fullPage: Boolean(captures[index]?.fullPage),
  })), (item) => item.name);
}

export function decideVisualLocally(question, page) {
  return needsVisualPreflight(question, page)
    ? localVisualDecision(question, page)
    : { screenshot: false, scope: 'none', reason: '无需视觉判断' };
}

export function visualDecisionMessages(question, page) {
  return [
    { role: 'system', content: '你只负责判断是否需要查看网页截图。严格输出 JSON。' },
    { role: 'user', content: buildVisualDecisionPrompt(question, page) },
  ];
}

export function parseVisualResponse(payload, fallback) {
  const content = payload?.choices?.[0]?.message?.content;
  const value = Array.isArray(content)
    ? content.map((part) => part?.text || '').join('')
    : content;
  return parseVisualDecision(value, fallback);
}

export function normalizeSelectedPage(value) {
  return normalizePageContext(value);
}

export function compactVisualAttachments(values) {
  return compact(values);
}
