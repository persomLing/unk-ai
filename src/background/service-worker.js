import {
  captureFailure,
  captureResultForUi,
  capturedOutputHeight,
  computeRegionCrop,
  createPageCapturePlan,
  createRegionCapturePlan,
  jpegDataUrlBytes,
  limitCapturesByBytes,
  normalizePageCaptureOptions,
  normalizePageMetrics,
  normalizePageRegion,
  regionCaptureTail,
} from '../utils/page-capture.js';
import { mergeFramePages } from '../utils/page-merge.js';
import { handleAgentMessage, pauseAgentTask } from './agent-service.js';
import { createNetworkReadingService, withPageDebugger } from './network-reading-service.js';
import { captureSiteResearchDiscovery } from '../utils/site-research.js';
import { assertPageTarget, pageTargetFields } from '../utils/page-target.js';
import {
  mergeDeepReading,
  summarizeAccessibilityTree,
  summarizeDomSnapshot,
} from '../utils/deep-reading.js';

const PICKER_FILE = 'content/figure-picker.js';
const CONTENT_FILES = ['content/aria-snapshot-bundle.js', 'content/extractor.js', 'content/content.js', 'content/page-selection.js', PICKER_FILE];
const RESTRICTED_SCHEMES = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source):/i;
const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);
const WEB_RESEARCH_TIMEOUT_MS = 26000;
const WEB_RESEARCH_MAX_BYTES = 128 * 1024;
const activeCaptures = new Map();
let captureSequence = 0;
const agentTakeoverTabs = new Map();
const networkReadingService = chrome.runtime.onConnect ? createNetworkReadingService({ chrome }) : null;

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'AGENT_TAKEOVER' || sender?.id !== chrome.runtime.id || !sender?.tab?.id) return false;
  const tabId = sender.tab.id;
  const current = agentTakeoverTabs.get(tabId) || { count: 0 };
  agentTakeoverTabs.set(tabId, {
    count: current.count + 1,
    taskId: String(message.taskId || current.taskId || ''),
  });
  // The content guard has already invalidated its local snapshot. Persisting
  // the background pause or clearing a slow frame must not delay the UI forever.
  let notified = false;
  const notifyTakeover = () => {
    if (notified) return;
    notified = true;
    void chrome.runtime.sendMessage({
      type: 'AGENT_TAKEOVER',
      tabId,
      taskId: String(message.taskId || ''),
      reason: String(message.reason || 'user-clicked-page').slice(0, 100),
    }).catch(() => {});
  };
  const notificationTimer = setTimeout(notifyTakeover, 1500);
  pauseAgentTask({ tabId, taskId: String(message.taskId || '') })
    .catch(() => {})
    .finally(() => { clearTimeout(notificationTimer); notifyTakeover(); });
  return false;
});

function checkedTab(tab) {
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    throw new Error('当前页面不支持截图。');
  }
  const restrictedReason = pageAccessError(tab.url);
  if (restrictedReason) throw new Error(restrictedReason);
  return tab;
}

async function activeTab(message = {}) {
  const requestedTabId = Number.isInteger(message.tabId) ? message.tabId : null;
  const [tab] = requestedTabId
    ? [await chrome.tabs.get(requestedTabId).catch(() => null)]
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  checkedTab(tab);
  assertPageTarget(message, { ...tab, tabId: tab.id, documentId: message.documentId });
  return tab;
}

async function documentIdentity(tab, expected = {}) {
  let entry;
  try {
    [entry] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, ...(expected.documentId ? { documentIds: [expected.documentId] } : { frameIds: [0] }) },
      func: () => ({ url: location.href }),
    });
  } catch (error) {
    if (expected.documentId) error.code = 'PAGE_CHANGED';
    throw error;
  }
  if (!entry?.result?.url || !entry.documentId) throw new Error('无法确认当前网页文档，请重新读取。');
  const identity = { tabId: tab.id, documentId: entry.documentId, url: entry.result.url };
  assertPageTarget({ expectedUrl: tab.url, ...pageTargetFields(expected) }, identity);
  return identity;
}

async function assertCurrentDocument(identity, { visible = false } = {}) {
  const tab = await chrome.tabs.get(identity.tabId);
  assertPageTarget(identity, { ...tab, tabId: tab.id, documentId: identity.documentId });
  await documentIdentity(tab, identity);
  if (visible) {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id) {
      const error = new Error('截图目标已不是当前可见标签页，请返回原页面后重试。');
      error.code = 'PAGE_CHANGED';
      throw error;
    }
  }
  return tab;
}

async function captureBoundVisible(identity, quality) {
  const tab = await assertCurrentDocument(identity, { visible: true });
  const dataUrl = await captureVisible(tab.windowId, quality);
  await assertCurrentDocument(identity, { visible: true });
  return dataUrl;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function captureVisible(windowId, quality) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality })
    .catch((error) => {
      throw captureFailure(
        'CAPTURE_API_FAILED',
        error?.message || '浏览器未能截取当前标签页。',
      );
    });
}

function readPageCaptureMetrics() {
  function geometry(element) {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    const position = getComputedStyle(element).position;
    return {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      position,
    };
  }
  const headerCandidates = Array.from(document.querySelectorAll(
    'header, [role="banner"], nav, [data-fixed], [class*="header"], [class*="topbar"]',
  )).slice(0, 24);
  const fixedHeaders = headerCandidates
    .map(geometry)
    .filter((value) => value
      && (value.position === 'fixed' || value.position === 'sticky')
      && value.width >= innerWidth * 0.72
      && value.height >= 20
      && value.height <= innerHeight * 0.35
      && value.y <= 8);
  let scrollContainer = '';
  let container = document.scrollingElement || document.documentElement;
  const scrollingElement = document.scrollingElement;
  const rootScrolls = (scrollingElement?.scrollHeight || 0) > (scrollingElement?.clientHeight || 0) + 1;
  if (!rootScrolls) {
    const candidates = Array.from(document.querySelectorAll('main, [role="main"], article, section, div'))
      .slice(0, 250);
    container = candidates.find((element) => {
      const style = getComputedStyle(element);
      const overflow = `${style.overflowY} ${style.overflow}`;
      return element.scrollHeight > element.clientHeight + 20
        && element.clientHeight >= innerHeight * 0.45
        && element.getBoundingClientRect().height >= innerHeight * 0.45
        && /(auto|scroll|overlay)/.test(overflow);
    }) || document.documentElement;
  }
  const viewportHeight = container === document.documentElement
    ? innerHeight
    : Math.min(innerHeight, container.clientHeight || innerHeight);
  const viewportWidth = container === document.documentElement
    ? innerWidth
    : Math.min(innerWidth, container.clientWidth || innerWidth);
  let contentTop = 0;
  let contentLeft = 0;
  if (container !== document.documentElement) {
    const bounds = container.getBoundingClientRect();
    contentTop = Math.max(0, Math.round(bounds.top));
    contentLeft = Math.max(0, Math.round(bounds.left));
  }
  if (container !== document.documentElement) {
    const tokens = Array.from(container.classList || []).slice(0, 4)
      .filter((token) => /^[a-zA-Z_][\w-]*$/.test(token));
    if (container.id && /^[a-zA-Z_][\w-]*$/.test(container.id)) {
      scrollContainer = `#${container.id}`;
    } else if (tokens.length) {
      scrollContainer = `${container.tagName.toLowerCase()}.${tokens.join('.')}`;
    }
  }
  return {
    viewportWidth,
    viewportHeight,
    pageWidth: container === document.documentElement
      ? Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0)
      : container.scrollWidth || viewportWidth,
    pageHeight: container === document.documentElement
      ? Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0)
      : container.scrollHeight || viewportHeight,
    scrollX: container === document.documentElement ? window.scrollX : container.scrollLeft,
    scrollY: container === document.documentElement ? window.scrollY : container.scrollTop,
    scrollContainer,
    devicePixelRatio: window.devicePixelRatio || 1,
    captureWidth: innerWidth,
    captureHeight: innerHeight,
    contentLeft,
    contentTop,
    fixedHeaderHeight: fixedHeaders.reduce((maximum, value) => Math.max(maximum, value.y + value.height), 0),
    title: document.title,
    url: location.href,
    captureType: container === document.documentElement ? 'document' : 'element',
  };
}

async function readMetrics(tabId, documentId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) },
    func: readPageCaptureMetrics,
  });
  if (!result || result.error) throw new Error(result?.error || '无法读取页面尺寸。');
  const metrics = normalizePageMetrics(result);
  metrics.scrollContainer = result.scrollContainer || null;
  metrics.captureType = result.captureType || 'document';
  return metrics;
}

async function scrollPage(tabId, x, y, selector, documentId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, ...(documentId ? { documentIds: [documentId] } : {}) },
    func: (scrollX, scrollY, containerSelector) => {
      let container = null;
      try {
        container = containerSelector ? document.querySelector(containerSelector) : null;
      } catch {
        container = null;
      }
      if (container) {
        container.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      } else {
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      }
      return {
        x: container ? container.scrollLeft : window.scrollX,
        y: container ? container.scrollTop : window.scrollY,
        container: Boolean(container),
      };
    },
    args: [x, y, selector || null],
  });
  if (selector && !result?.container) {
    throw captureFailure('SCROLL_CONTAINER_LOST', '页面滚动区域在截图过程中发生了变化。');
  }
  return result;
}

function guarded(entry, operation) {
  if (entry.cancelled) {
    return Promise.reject(captureFailure('CAPTURE_CANCELLED', '截图已取消。'));
  }
  const remaining = Math.max(0, entry.deadline - Date.now());
  if (!remaining) {
    return Promise.reject(captureFailure('CAPTURE_TIMEOUT', '页面截图超时。'));
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(captureFailure('CAPTURE_TIMEOUT', '页面截图超时。'));
    }, remaining);
  });
  return Promise.race([Promise.resolve(operation), timeout, entry.cancelPromise])
    .finally(() => clearTimeout(timer));
}

function pause(entry, milliseconds) {
  return guarded(entry, delay(milliseconds));
}

function emitProgress(entry, patch) {
  chrome.runtime.sendMessage({
    type: 'CAPTURE_PAGE_PROGRESS',
    token: entry.token,
    ...patch,
  }).catch(() => {});
}

async function beginCapture(tab, options, identity) {
  cancelCapturesForTab(tab.id);
  const token = `page-capture-${Date.now()}-${captureSequence += 1}`;
  const original = await readMetrics(tab.id, identity.documentId).catch(() => {
    throw captureFailure('PAGE_NOT_READABLE', '无法读取页面尺寸，请刷新页面后重试。');
  });
  let rejectCancelled;
  const cancelPromise = new Promise((_, reject) => {
    rejectCancelled = reject;
  });
  cancelPromise.catch(() => {});
  const entry = {
    token,
    tabId: tab.id,
    windowId: tab.windowId,
    identity,
    original,
    options,
    cancelled: false,
    restoreAttempted: false,
    deadline: Date.now() + options.timeoutMs,
    cancelPromise,
    rejectCancelled,
  };
  activeCaptures.set(token, entry);
  return entry;
}

function cancelCapture(token) {
  const entry = activeCaptures.get(token);
  if (!entry || entry.cancelled) return false;
  entry.cancelled = true;
  entry.rejectCancelled(captureFailure('CAPTURE_CANCELLED', '截图已取消。'));
  return true;
}

function cancelCapturesForTab(tabId, excludedToken = '') {
  for (const [token, entry] of activeCaptures) {
    if (entry.tabId === tabId && token !== excludedToken) cancelCapture(token);
  }
}

async function endCapture(entry, restore = true) {
  if (!entry) return false;
  activeCaptures.delete(entry.token);
  let restored = false;
  if (restore) {
    try {
      await assertCurrentDocument(entry.identity);
      await scrollPage(
        entry.tabId,
        entry.original.scrollX,
        entry.original.scrollY,
        entry.original.scrollContainer,
        entry.identity.documentId,
      );
      restored = true;
    } catch {
      // The tab may have navigated or closed; the capture result is still usable.
    }
  }
  return restored;
}

async function captureFullPage(message, knownTab) {
  const tab = knownTab || await activeTab(message);
  const identity = await documentIdentity(tab, message);
  const options = normalizePageCaptureOptions(message?.options);
  const entry = await beginCapture(tab, options, identity);
  try {
    const metrics = entry.original;
    const startScrollY = metrics.scrollY;
    const plan = createPageCapturePlan({ ...metrics, scrollY: 0 }, options);
    const captures = [];
    let currentScrollY = startScrollY;
    for (const chunk of plan.chunks) {
      if (!activeCaptures.has(entry.token)) throw captureFailure('CAPTURE_CANCELLED', '截图已取消。');
      if (chunk.scrollY !== currentScrollY || chunk.index === 0) {
        await guarded(entry, scrollPage(
          tab.id,
          metrics.scrollX,
          chunk.scrollY,
          metrics.scrollContainer,
          identity.documentId,
        ));
        await pause(entry, options.settleMs);
        currentScrollY = chunk.scrollY;
      }
      const dataUrl = await guarded(entry, captureBoundVisible(
        identity,
        options.captureQuality,
      ));
      const bytes = jpegDataUrlBytes(dataUrl);
      if (!bytes) throw captureFailure('CAPTURE_FAILED', '没有获取到页面截图。');
      const currentMetrics = await guarded(entry, readMetrics(tab.id, identity.documentId));
      captures.push({
        index: chunk.index,
        scrollX: currentMetrics.scrollX,
        scrollY: currentMetrics.scrollY,
        sourceCrop: chunk.sourceCrop,
        destination: chunk.destination,
        dataUrl,
        bytes,
      });
      emitProgress(entry, {
        mode: 'full-page',
        completed: captures.length,
        total: plan.chunks.length,
      });
      await pause(entry, options.throttleMs);
    }
    const finalMetrics = await guarded(entry, readMetrics(tab.id, identity.documentId));
    if (finalMetrics.url !== metrics.url) {
      throw captureFailure('PAGE_NAVIGATED', '页面在截图过程中发生变化。');
    }
    const limited = limitCapturesByBytes(captures, options.maxBytes);
    captures.splice(limited.captures.length);
    const totalBytes = limited.bytes;
    const availableHeight = capturedOutputHeight(plan, captures);
    const tail = regionCaptureTail(plan, captures);
    const restored = await endCapture(entry);
    entry.restoreAttempted = true;
    return captureResultForUi({
      ...identity,
      token: entry.token,
      mode: 'full-page',
      plan: {
        width: plan.width,
        height: availableHeight,
        scale: plan.scale,
        viewport: plan.viewport,
        captureViewport: plan.captureViewport,
        page: plan.page,
        fixedHeaderHeight: plan.fixedHeaderHeight,
        chunks: plan.chunks.slice(0, captures.length),
        truncated: plan.truncated || limited.truncated || limited.overLimit,
        capturedPageHeight: plan.capturedPageHeight,
      },
      chunks: captures,
      bytes: totalBytes,
      maxBytes: options.maxBytes,
      quality: options.captureQuality,
      title: metrics.title,
      url: metrics.url,
      originalScroll: { x: metrics.scrollX, y: metrics.scrollY },
      restored,
    });
  } finally {
    if (!entry.restoreAttempted) await endCapture(entry);
  }
}

async function captureRegion(message) {
  const tab = await activeTab(message);
  const identity = await documentIdentity(tab, message);
  const options = normalizePageCaptureOptions(message?.options);
  const entry = await beginCapture(tab, options, identity);
  try {
    const metrics = entry.original;
    const region = normalizePageRegion(message?.region || message, metrics, {
      coordinateSpace: message?.coordinateSpace,
    });
    if (!region) throw captureFailure('INVALID_REGION', '截图区域无效。');
    const plan = createRegionCapturePlan(region, metrics, options);
    if (!plan?.chunks.length) throw captureFailure('REGION_NOT_CAPTURABLE', '无法定位截图区域。');
    const captures = [];
    let currentScrollY = metrics.scrollY;
    let currentScrollX = metrics.scrollX;
    for (const chunk of plan.chunks) {
      if (!activeCaptures.has(entry.token)) throw captureFailure('CAPTURE_CANCELLED', '截图已取消。');
      if (chunk.scrollY !== currentScrollY || chunk.scrollX !== currentScrollX || chunk.index === 0) {
        await guarded(entry, scrollPage(
          tab.id,
          chunk.scrollX,
          chunk.scrollY,
          metrics.scrollContainer,
          identity.documentId,
        ));
        await pause(entry, options.settleMs);
        currentScrollY = chunk.scrollY;
        currentScrollX = chunk.scrollX;
      }
      const dataUrl = await guarded(entry, captureBoundVisible(
        identity,
        options.captureQuality,
      ));
      const bytes = jpegDataUrlBytes(dataUrl);
      if (!bytes) throw captureFailure('CAPTURE_FAILED', '没有获取到页面截图。');
      const currentMetrics = await guarded(entry, readMetrics(tab.id, identity.documentId));
      const crop = computeRegionCrop({
        x: region.pageRect.x - currentMetrics.scrollX,
        y: region.pageRect.y - currentMetrics.scrollY + chunk.outputY,
        width: region.pageRect.width,
        height: chunk.outputHeight,
      }, currentMetrics);
      if (!crop) throw captureFailure('REGION_NOT_CAPTURABLE', '截图过程中无法定位目标区域。');
      captures.push({
        index: chunk.index,
        scrollX: currentMetrics.scrollX,
        scrollY: currentMetrics.scrollY,
        offsetY: chunk.outputY,
        height: chunk.outputHeight,
        sourceCrop: crop.cropRect,
        destination: chunk.destination,
        dataUrl,
        bytes,
      });
      emitProgress(entry, {
        mode: 'region',
        completed: captures.length,
        total: plan.chunks.length,
      });
      await pause(entry, options.throttleMs);
    }
    const finalMetrics = await guarded(entry, readMetrics(tab.id, identity.documentId));
    if (finalMetrics.url !== metrics.url) {
      throw captureFailure('PAGE_NAVIGATED', '页面在截图过程中发生变化。');
    }
    const limited = limitCapturesByBytes(captures, options.maxBytes);
    captures.splice(limited.captures.length);
    const totalBytes = limited.bytes;
    const availableHeight = capturedOutputHeight(plan, captures);
    const tail = regionCaptureTail(plan, captures);
    const restored = await endCapture(entry);
    entry.restoreAttempted = true;
    return {
      token: entry.token,
      ...identity,
      mode: 'region',
      plan: {
        width: plan.width,
        height: availableHeight,
        scale: plan.scale,
        viewport: plan.viewport,
        captureViewport: plan.captureViewport,
        pageRect: plan.pageRect,
        fixedHeaderHeight: plan.fixedHeaderHeight,
        chunks: plan.chunks.slice(0, captures.length),
        truncated: plan.truncated || limited.truncated || limited.overLimit,
        capturedHeight: plan.capturedHeight,
      },
      chunks: captures,
      bytes: totalBytes,
      maxBytes: options.maxBytes,
      quality: options.captureQuality,
      title: metrics.title,
      url: metrics.url,
      pageRect: region.pageRect,
      tail,
      originalScroll: { x: metrics.scrollX, y: metrics.scrollY },
      restored,
    };
  } finally {
    if (!entry.restoreAttempted) await endCapture(entry);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  installSelectionMenu();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'unk-ai-ask-selection' || !tab?.id) return;
  let text = String(info.selectionText || '').trim();
  let context = '';
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: info.frameId === undefined ? undefined : [info.frameId] },
      func: () => {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return { text: '', context: '' };
        let node = selection.getRangeAt(0).startContainer;
        if (node?.nodeType === 3) node = node.parentElement;
        let container = node;
        for (let depth = 0; container && depth < 5; depth += 1) {
          if (/^(P|LI|BLOCKQUOTE|TD|TH|PRE|H1|H2|H3|H4|SECTION|ARTICLE)$/.test(container.tagName || '')) break;
          container = container.parentElement;
        }
        return {
          text: String(selection.toString() || '').trim(),
          context: String(container?.innerText || container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1600),
        };
      },
    });
    if (result?.result?.text) {
      text = result.result.text;
      context = result.result.context;
    }
  } catch {
    // The context menu still works when the page blocks script injection.
  }
  if (!text) return;
  await chrome.storage.session.set({
    pageSelection: {
      text,
      context,
      title: String(tab.title || ''),
      url: String(tab.url || ''),
      selectedAt: new Date().toISOString(),
    },
  });
  if (Number.isInteger(tab.windowId)) await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  installSelectionMenu();
});

// Installed extensions register their page observer as soon as possible. This
// keeps the first selection working even before the side panel is opened.

function installSelectionMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'unk-ai-ask-selection',
      title: '用 UNK AI 解释选中内容',
      contexts: ['selection'],
    });
  });
}

installSelectionMenu();

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === '_execute_action' && tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

function pageAccessError(url = '') {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return '无法识别当前页面地址，请刷新页面后重试。';
  }
  if (RESTRICTED_SCHEMES.test(url) || RESTRICTED_HOSTS.has(hostname)) {
    return '浏览器不允许读取此页面。你仍可在下方进行普通对话。';
  }
  return '';
}

function publicResearchUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local')
      || /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1|\[?f[cd])/i.test(host)) return null;
    return url;
  } catch { return null; }
}

async function readPublicWebResponse(value) {
  const target = publicResearchUrl(value);
  if (!target) throw Object.assign(new Error('联网检索只允许公开 HTTP/HTTPS 地址。'), { code: 'WEB_RESEARCH_URL' });
  let response;
  try {
    response = await fetch(target.href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'user-agent': 'Mozilla/5.0 (compatible; UNK-AI-Web-Research/1.0)',
      },
    });
  } catch (error) {
    throw Object.assign(new Error(`公开网页请求失败：${error?.message || '网络不可达'}`), { code: 'WEB_RESEARCH_NETWORK' });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`公开网页返回 ${response.status}。`), { code: 'WEB_RESEARCH_HTTP' });
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/.test(contentType)) {
    throw Object.assign(new Error('来源不是可读取的网页正文。'), { code: 'WEB_RESEARCH_CONTENT' });
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { text: text.slice(0, WEB_RESEARCH_MAX_BYTES), contentType,
      truncated: text.length > WEB_RESEARCH_MAX_BYTES };
  }
  const chunks = [];
  let size = 0;
  while (size < WEB_RESEARCH_MAX_BYTES) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  reader.cancel?.().catch?.(() => {});
  reader.releaseLock?.();
  const merged = new Uint8Array(Math.min(size, WEB_RESEARCH_MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const keep = Math.min(chunk.byteLength, merged.length - offset);
    merged.set(chunk.subarray(0, keep), offset);
    offset += keep;
    if (offset >= merged.length) break;
  }
  return { text: new TextDecoder().decode(merged), contentType, truncated: size > WEB_RESEARCH_MAX_BYTES };
}

function pdfDescriptor(tab) {
  return { pdf: { url: String(tab.url || ''), title: String(tab.title || '') } };
}

async function probePdfUrl(url) {
  if (!/^https?:/i.test(url || '')) return false;
  try {
    const head = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
    if (head.ok && /application\/pdf/i.test(head.headers.get('content-type') || '')) return true;
  } catch {
    // HEAD is not supported everywhere; fall through to a short range request.
  }
  try {
    const response = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      headers: { Range: 'bytes=0-2047' },
    });
    if (!response.ok && response.status !== 206) return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    if (!value?.length) return false;
    return new TextDecoder('latin1').decode(value.subarray(0, 2048)).includes('%PDF-');
  } catch {
    return false;
  }
}

async function pdfFallbackOrThrow(tab, message) {
  if (await probePdfUrl(tab.url)) return pdfDescriptor(tab);
  throw new Error(message);
}

async function extractActivePage(options = {}) {
  const [tab] = Number.isInteger(options.tabId)
    ? [await chrome.tabs.get(options.tabId)]
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url) throw new Error('没有找到可读取的当前标签页。');
  assertPageTarget(options, { ...tab, tabId: tab.id, documentId: options.documentId });

  const restrictedReason = pageAccessError(tab.url);
  if (restrictedReason) throw new Error(restrictedReason);

  if (/\.pdf(?=[?#]|$)/i.test(new URL(tab.url).pathname)) {
    return { ...pdfDescriptor(tab), tabId: tab.id, url: tab.url };
  }

  let identity;
  try {
    identity = await documentIdentity(tab, options);
  } catch (error) {
    if (error.code === 'PAGE_CHANGED') throw error;
    return pdfFallbackOrThrow(tab, error.message);
  }
  const finish = async (page) => {
    await assertCurrentDocument(identity);
    assertPageTarget({ expectedUrl: identity.url }, page);
    return { ...page, ...identity };
  };

  try {
    // Read the known main document before asking any embedded frame to run.
    // A lazy cross-origin iframe can remain at document_idle indefinitely;
    // optional frame collection must not hold an already visible article.
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [identity.documentId] },
      files: ['content/extractor.js'],
      injectImmediately: true,
    }), 5000, '主页面正文提取器加载超时。');
    const extractFrame = async (extractOptions) => {
      if (extractOptions.skipTop && window === window.top) return null;
      if (extractOptions.deadlineAt && Date.now() >= extractOptions.deadlineAt) return null;
      const extractor = globalThis.__unkAiExtractor;
      if (!extractor?.extractPageContent) return null;
      let lazyMaterialization = null;
      if (extractOptions.materializeLazy) {
        try {
          lazyMaterialization = await extractor.materializeLazyContent({
            ...(extractOptions.lazyOptions || {}),
            maxSteps: 8,
            stepDelayMs: 80,
            timeoutMs: 5000,
          });
        } catch (error) {
          lazyMaterialization = { error: error?.message || String(error) };
        }
      }
      try {
        const page = extractor.extractPageContent(extractOptions);
        return { ...page, lazyMaterialization, hasFrames: Boolean(document.querySelector('iframe,frame')) };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    };
    const extractOptions = {
      ...(options.options || {}),
      maxBudget: options.maxBudget,
      includeStructure: options.includeStructure ?? options.options?.includeStructure,
      includeLinks: options.includeLinks ?? options.options?.includeLinks,
      materializeLazy: options.lazyLoad,
      lazyOptions: options.lazyOptions,
    };
    const mainResults = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [identity.documentId] },
      func: extractFrame,
      args: [extractOptions],
      injectImmediately: true,
    }), 10000, '主页面正文读取超时。');
    const topFrame = mainResults.find((entry) => entry.frameId === 0);
    if (!topFrame) throw new Error('未读取到主页面文档。');
    if (topFrame.result?.error) throw new Error(topFrame.result.error);
    assertPageTarget(identity, { tabId: tab.id, documentId: topFrame.documentId, url: topFrame.result?.url });
    const { hasFrames, ...mainPage } = topFrame.result;
    const frameResults = [{ ...topFrame, result: mainPage }];
    if (hasFrames !== false) {
      const frameDeadlineAt = Date.now() + 1500;
      try {
        const extraFrames = await withTimeout((async () => {
          await assertCurrentDocument(identity);
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true }, files: ['content/extractor.js'], injectImmediately: true,
          });
          // An injection may finish after the optional wait has ended. Do not
          // schedule more work then, and never scroll optional embedded frames.
          if (Date.now() >= frameDeadlineAt) return [];
          await assertCurrentDocument(identity);
          if (Date.now() >= frameDeadlineAt) return [];
          return chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true }, func: extractFrame,
            args: [{ ...extractOptions, skipTop: true, materializeLazy: false, deadlineAt: frameDeadlineAt }],
            injectImmediately: true,
          });
        })(), 1500, '附加框架读取超时。');
        frameResults.push(...extraFrames.filter(entry => entry.frameId !== 0));
      } catch {
        // The validated main body remains usable when an optional frame fails.
      }
    }
    const merged = mergeFramePages(frameResults, options.maxBudget);
    if (merged?.text?.trim()) return await finish(merged);
    // A successful but not-yet-rendered Docsify extraction is authoritative.
    // Let the caller retry readiness instead of treating its shell as content.
    return await finish(mainPage);
  } catch (firstError) {
    if (firstError.code === 'PAGE_CHANGED') throw firstError;
    // Frame extraction is best effort; fall back to the top content bridge.
  }

  try {
    return await finish(await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE', ...options }, { documentId: identity.documentId }));
  } catch (firstError) {
    if (firstError.code === 'PAGE_CHANGED') throw firstError;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [identity.documentId] }, files: CONTENT_FILES });
    } catch {
      return pdfFallbackOrThrow(tab, firstError?.message || '无法访问当前页面，请刷新后重试。');
    }
  }

  try {
    return await finish(await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE', ...options }, { documentId: identity.documentId }));
  } catch (error) {
    if (error.code === 'PAGE_CHANGED') throw error;
    return pdfFallbackOrThrow(tab, '页面尚未准备好，请刷新页面后再试。');
  }
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => clearTimeout(timer));
}

/**
 * Read AX Tree and DOMSnapshot through a short-lived debugger session. The
 * caller must explicitly opt in; this function never clicks, types, focuses or
 * mutates page content. Detach runs even when a CDP command fails.
 */
async function captureDeepReading(tab, page) {
  const target = { tabId: tab.id };
  try {
    await assertCurrentDocument(page);
    return await withPageDebugger(target, async (_target, sendCommand) => {
    const [ax, dom] = await Promise.all([
      withTimeout(
        sendCommand('Accessibility.getFullAXTree'),
        12000,
        '读取可访问性树超时。',
      ),
      withTimeout(
        sendCommand('DOMSnapshot.captureSnapshot', {
          computedStyles: [],
          includePaintOrder: false,
          includeDOMRects: false,
        }),
        12000,
        '读取页面结构超时。',
      ),
    ]);
    await assertCurrentDocument(page);
    const axSummary = summarizeAccessibilityTree(ax?.nodes);
    const domSummary = summarizeDomSnapshot(dom);
    return mergeDeepReading(page, {
      semanticTree: axSummary.nodes,
      ax: axSummary,
      dom: domSummary,
      frameCount: Number(page?.frameCount) || 0,
      truncated: axSummary.truncated || domSummary.truncated,
    });
    }, { chrome, timeoutMs: 20000 });
  } catch (error) {
    if (error.code === 'PAGE_CHANGED') throw error;
    return mergeDeepReading(page, {
      available: false,
      error: error?.message || '深度读取不可用，已回退到普通读取。',
    });
  }
}

async function captureDeepReadingScreenshot(tab, scope = 'page') {
  const target = { tabId: tab.id };
  return withPageDebugger(target, async (_target, sendCommand) => {
    const options = { format: 'jpeg', fromSurface: true, quality: 78 };
    if (scope === 'page') {
      const metrics = await withTimeout(
        sendCommand('Page.getLayoutMetrics'),
        8000,
        '读取页面尺寸超时。',
      );
      const content = metrics?.cssContentSize || metrics?.contentSize || {};
      const width = Math.max(320, Math.ceil(Number(content.width) || 1280));
      const height = Math.max(480, Math.ceil(Number(content.height) || 800));
      const aligned = alignCaptureSize(width, height, 1600, 12000);
      options.captureBeyondViewport = true;
      options.clip = { x: 0, y: 0, width: aligned.width, height: aligned.height, scale: 1 };
    }
    const shot = await withTimeout(
      sendCommand('Page.captureScreenshot', options),
      12000,
      '页面截图超时。',
    );
    const dataUrl = `data:image/jpeg;base64,${shot?.data || ''}`;
    if (!/^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(dataUrl)) {
      throw new Error('没有获取到页面截图。');
    }
    return dataUrl;
  }, { chrome, timeoutMs: 30000 });
}

function screenshotScale(width, height, maxEdge, maxHeight) {
  return Math.min(
    1,
    Math.max(320, Number(maxEdge) || 1600) / Math.max(1, width),
    Math.max(480, Number(maxHeight) || 12000) / Math.max(1, height),
  );
}

function alignCaptureSize(width, height, maxEdge, maxHeight) {
  const maximumWidth = Math.max(320, Number(maxEdge) || 1600);
  const maximumHeight = Math.max(480, Number(maxHeight) || 12000);
  const scale = Math.min(1, maximumWidth / width, maximumHeight / height);
  return {
    width: Math.ceil(width * scale),
    height: Math.ceil(height * scale),
    scale,
  };
}

function normalizedScreenshotClip(content, {
  maxEdge = 1600,
  maxHeight = 12000,
} = {}) {
  const width = Math.max(1, Math.ceil(Number(content?.width) || 1280));
  const height = Math.max(1, Math.ceil(Number(content?.height) || 800));
  const boundedWidth = Math.min(width, Math.max(320, Number(maxEdge) || 1600));
  const boundedHeight = Math.min(height, Math.max(480, Number(maxHeight) || 12000));
  return {
    x: 0,
    y: 0,
    width: boundedWidth,
    height: boundedHeight,
    scale: 1,
  };
}

function screenshotCaptureOptions(scope, content, {
  maxEdge = 1600,
  maxHeight = 12000,
  quality = 78,
} = {}) {
  const options = { format: 'jpeg', fromSurface: true, quality };
  if (scope === 'page') {
    options.captureBeyondViewport = true;
    options.clip = normalizedScreenshotClip(content, { maxEdge, maxHeight });
  }
  return options;
}

/**
 * Capture the active page through CDP when possible. This avoids the
 * captureVisibleTab focus/rate-limit failures and is the same short-lived
 * debugger session used for deep structure reading.
 */
async function captureVisualContext(message = {}) {
  const tab = await activeTab(message);
  let identity;
  try {
    identity = await documentIdentity(tab, message);
  } catch (error) {
    // Chrome's PDF viewer blocks content scripts. CDP can still bind its
    // top-level frame/loader before and after a screenshot.
    if (message.documentId || error.code === 'PAGE_CHANGED') throw error;
    identity = { tabId: tab.id, url: tab.url };
  }
  const target = { tabId: tab.id };
  let cdpDocument = null;
  const checkIdentity = async sendCommand => {
    if (identity.documentId) return assertCurrentDocument(identity);
    await activeTab({ tabId: identity.tabId, expectedUrl: identity.url });
    const tree = await withTimeout(sendCommand('Page.getFrameTree'), 8000, '无法确认截图文档。');
    const frame = tree?.frameTree?.frame;
    if (!frame?.id || !frame.loaderId) throw new Error('无法确认截图文档。');
    assertPageTarget({ expectedUrl: identity.url }, { url: frame.url });
    const key = `${frame.id}:${frame.loaderId}`;
    if (cdpDocument && key !== cdpDocument) {
      const error = new Error('页面在截图过程中发生了变化，请重试。');
      error.code = 'PAGE_CHANGED';
      throw error;
    }
    cdpDocument = key;
  };
  return withPageDebugger(target, async (_target, sendCommand) => {
    await checkIdentity(sendCommand);
    const scope = message.scope === 'page' ? 'page' : 'viewport';
    let truncated = false;
    let options = screenshotCaptureOptions(scope, null, {});
    if (scope === 'page') {
      const metrics = await withTimeout(
        sendCommand('Page.getLayoutMetrics'),
        8000,
        '读取页面尺寸超时。',
      );
      const content = metrics?.cssContentSize || metrics?.contentSize || {};
      options = screenshotCaptureOptions(scope, content, {
        maxEdge: message.maxEdge,
        maxHeight: message.maxHeight,
      });
      truncated = Number(content.width) > options.clip.width || Number(content.height) > options.clip.height;
    }
    await checkIdentity(sendCommand);
    const result = await withTimeout(
      sendCommand('Page.captureScreenshot', options),
      12000,
      '页面截图超时。',
    );
    await checkIdentity(sendCommand);
    const dataUrl = `data:image/jpeg;base64,${result?.data || ''}`;
    if (!/^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(dataUrl)) {
      throw new Error('没有获取到页面截图。');
    }
    return {
      images: [{
        ...identity,
        dataUrl,
        pageTitle: String(tab.title || ''),
        pageUrl: String(tab.url || ''),
        scope,
        fullPage: scope === 'page' && !truncated,
        truncated,
      }],
      title: String(tab.title || ''),
      url: String(tab.url || ''),
      scope,
      ...identity,
      truncated,
    };
  }, { chrome, timeoutMs: 35000 });
}

async function captureSiteResearch(message) {
  const tab = await activeTab(message);
  const identity = await documentIdentity(tab, message);
  const [entry] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, documentIds: [identity.documentId] },
    world: 'MAIN',
    func: captureSiteResearchDiscovery,
  });
  assertPageTarget(identity, { tabId: tab.id, documentId: entry?.documentId, url: entry?.result?.url });
  await assertCurrentDocument(identity);
  return { ...entry.result, ...identity };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const networkMethod = message?.type === 'NETWORK_READING_START' ? 'start'
    : message?.type === 'NETWORK_READING_READ' ? 'read' : message?.type === 'NETWORK_READING_STOP' ? 'stop'
    : message?.type === 'NETWORK_READING_VALIDATE' ? 'validateGrant' : null;
  if (networkMethod && networkReadingService) {
    networkReadingService[networkMethod](message, sender).then(sendResponse)
      .catch(error => sendResponse({ error: error.code || 'NETWORK_READING_FAILED', message: error.message }));
    return true;
  }
  if (message?.type === 'CAPTURE_PAGE_TARGET') {
    if (sender?.id !== chrome.runtime.id || sender?.tab
      || !String(sender?.url || '').startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ error: 'ERR_PAGE_TARGET_SENDER', message: '页面来源只能由扩展界面确认。' });
      return false;
    }
    withTimeout(activeTab(message).then(tab => documentIdentity(tab, message)), 4000, '确认页面来源超时。')
      .then(sendResponse).catch(error => sendResponse({ error: error.code || 'PAGE_TARGET_FAILED', message: error.message }));
    return true;
  }
  if (message?.type === 'CAPTURE_SITE_RESEARCH') {
    if (sender?.id !== chrome.runtime.id || sender?.tab
      || !String(sender?.url || '').startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ error: 'ERR_RESEARCH_SENDER', message: '站内研究只能由扩展界面发起。' });
      return false;
    }
    withTimeout(captureSiteResearch(message), 7000, '读取站点目录超时，请重试。')
      .then(sendResponse).catch(error => sendResponse({ error: error.code || 'RESEARCH_DISCOVERY_FAILED', message: error.message }));
    return true;
  }
  if (message?.type === 'WEB_RESEARCH_FETCH') {
    if (sender?.id !== chrome.runtime.id || sender?.tab
      || !String(sender?.url || '').startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ error: 'ERR_WEB_RESEARCH_SENDER', message: '联网检索只能由扩展界面发起。' });
      return false;
    }
    withTimeout(readPublicWebResponse(message.url), WEB_RESEARCH_TIMEOUT_MS, '公开网页请求超时。')
      .then(sendResponse)
      .catch(error => sendResponse({
        error: error?.code || 'WEB_RESEARCH_FAILED',
        message: error?.message || '公开网页请求失败。',
      }));
    return true;
  }
  if (typeof message?.type === 'string'
    && message.type.startsWith('AGENT_')
    && message.type !== 'AGENT_TAKEOVER') {
    if (sender?.id !== chrome.runtime.id || sender?.tab
      || !String(sender?.url || '').startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ error: 'ERR_AGENT_SENDER', message: '页面操作只能由扩展界面发起。' });
      return false;
    }
    handleAgentMessage(message, sendResponse).then((handled) => {
      if (!handled) sendResponse({ error: 'ERR_AGENT_UNKNOWN', message: '未知的浏览器 Agent 消息。' });
    });
    return true;
  }
  if (message?.type === 'CAPTURE_PAGE_VISUAL_CONTEXT') {
    captureVisualContext(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ...captureFailure('VISUAL_CAPTURE_FAILED', error?.message || '页面截图失败。'),
      }));
    return true;
  }
  if (message?.type === 'CAPTURE_ACTIVE_TAB') {
    activeTab(message).then(async (tab) => {
      const identity = await documentIdentity(tab, message);
      if (message.fullPage !== true && message.mode !== 'full-page') {
        const quality = message.options?.captureQuality === undefined
          ? 82
          : normalizePageCaptureOptions(message.options).captureQuality;
        const dataUrl = await captureBoundVisible(identity, quality);
        if (!/^data:image\/jpeg;base64,/.test(dataUrl || '')) {
          throw new Error('没有获取到页面截图。');
        }
        return { dataUrl, ...identity, title: tab.title };
      }
      return captureFullPage(message, tab);
    }).then(sendResponse).catch((error) => sendResponse({
      ...captureFailure(error?.code, error?.message || '页面截图失败。'),
    }));
    return true;
  }
  if (message?.type === 'CAPTURE_FULL_PAGE'
    || message?.type === 'CAPTURE_PAGE_REGION'
    || message?.type === 'CAPTURE_PAGE_RECT') {
    if (message.type === 'CAPTURE_FULL_PAGE') {
      captureFullPage(message)
        .then(sendResponse)
        .catch((error) => sendResponse(
          captureFailure(error?.code, error?.message || '页面截图失败。'),
        ));
      return true;
    }
    captureRegion(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ...captureFailure(error?.code, error?.message || '页面截图失败。'),
        error: error?.message || '页面截图失败。',
      }));
    return true;
  }
  if (message?.type === 'CANCEL_PAGE_CAPTURE') {
    const cancelled = cancelCapture(String(message.token || ''));
    sendResponse({ ok: cancelled });
    return false;
  }
  if (message?.type === 'START_FIGURE_PICKER') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async ([tab]) => {
      if (!tab?.id || !/^https?:/i.test(tab.url || '')) throw new Error('当前页面不支持区域选择。');
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'START_FIGURE_PICKER' });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [PICKER_FILE] });
        await chrome.tabs.sendMessage(tab.id, { type: 'START_FIGURE_PICKER' });
      }
      return { ok: true };
    }).then(sendResponse).catch((error) => sendResponse({ error: error?.message || '无法开始选择图表。' }));
    return true;
  }
  if (message?.type === 'GET_PAGE_SELECTION') {
    const tabId = message.tabId;
    if (!Number.isInteger(tabId)) {
      sendResponse({ selection: null });
      return false;
    }
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_SELECTION' }).then((selection) => {
      sendResponse({ selection: selection || null });
    }).catch(() => chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return { text: '', context: '' };
        const text = String(selection.toString() || '').trim();
        if (!text) return { text: '', context: '' };
        let node = selection.getRangeAt(0).startContainer;
        if (node?.nodeType === 3) node = node.parentElement;
        let container = node;
        for (let depth = 0; container && depth < 5; depth += 1) {
          if (/^(P|LI|BLOCKQUOTE|TD|TH|PRE|H1|H2|H3|H4|SECTION|ARTICLE)$/.test(container.tagName || '')) break;
          container = container.parentElement;
        }
        return {
          text: text.slice(0, 12000),
          context: String(container?.innerText || container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1600),
          title: document.title,
          url: location.href,
        };
      },
    }).then(([result]) => {
      const selection = result?.result?.text ? {
        ...result.result,
        selectedAt: new Date().toISOString(),
      } : null;
      if (selection) chrome.storage.session.set({ pageSelection: selection }).catch(() => {});
      sendResponse({ selection });
    }).catch(() => sendResponse({ selection: null })));
    return true;
  }
  if (message?.type === 'PAGE_SELECTION_CHANGED') {
    chrome.storage.session.set({ pageSelection: message.payload || null }).catch(() => {});
    return false;
  }
  if (message?.type === 'PAGE_FIGURE_PICKED') {
    chrome.storage.session.set({ pageFigurePick: message.payload ? {
      ...message.payload,
      ...(Number.isInteger(sender?.tab?.id) ? { tabId: sender.tab.id } : {}),
      ...(sender?.documentId ? { documentId: sender.documentId } : {}),
    } : null }).catch(() => {});
    return false;
  }
  if (message?.type === 'CLEAR_PAGE_SELECTION') {
    chrome.storage.session.remove('pageSelection').catch(() => {});
    return false;
  }
  if (message?.type !== 'EXTRACT_PAGE' && message?.type !== 'EXTRACT_DEEP_PAGE') return false;

  const deep = message.type === 'EXTRACT_DEEP_PAGE' || message.deepReading === true;
  const extraction = extractActivePage({
    ...pageTargetFields(message),
    maxBudget: message.maxBudget,
    options: message.options,
    includeStructure: message.includeStructure,
    includeLinks: message.includeLinks,
    lazyLoad: message.lazyLoad,
    lazyOptions: message.lazyOptions,
  }).then(async (page) => {
    if (!deep || !page || page.error || page.pdf) return page;
    const tab = await chrome.tabs.get(page.tabId);
    checkedTab(tab);
    return captureDeepReading(tab, page);
  });

  extraction
    .then((page) => {
      if (page?.pdf) {
        sendResponse({ pdf: page.pdf });
        return;
      }
      if (!page || typeof page.text !== 'string') throw new Error('没有提取到可用的网页正文。');
      if (page.error) throw new Error(String(page.error));
      sendResponse({
        ...pageTargetFields(page),
        capturedAt: new Date().toISOString(),
        title: String(page.title || '未命名网页'),
        url: String(page.url || ''),
        text: page.text,
        truncated: Boolean(page.truncated),
        sections: Array.isArray(page.sections) ? page.sections : [],
        figures: Array.isArray(page.figures) ? page.figures : [],
        links: Array.isArray(page.links) ? page.links : [],
        tables: Array.isArray(page.structure?.tables) ? page.structure.tables : [],
        structure: page.structure && typeof page.structure === 'object' ? page.structure : null,
        lazyMaterialization: page.lazyMaterialization || null,
        deepReading: page.deepReading || null,
      });
    })
    .catch((error) => sendResponse({ error: error?.message || '网页正文读取失败。', code: error?.code || '' }));

  return true;
});
