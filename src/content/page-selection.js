(function (root) {
  "use strict";
  const runtime = root && root.chrome && root.chrome.runtime;
  if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== "function") return;
  if (root.__unkAiSelectionBridge) return;
  root.__unkAiSelectionBridge = true;

  const MAX_SELECTION = 12000;
  const MIN_SELECTION = 2;
  let timer = null;
  let lastText = "";
  let lastUrl = "";
  let lastVisuals = "";
  let iframeListening = false;
  const visualIds = new WeakMap();
  const selectedElements = new Map();
  const selectionStyles = new Map();
  let visualSequence = 0;
  let styleSequence = 0;

  function bounded(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function selectedVisuals() {
    selectedElements.clear();
    const selection = root.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return { visuals: [], visualCount: 0 };
    const seen = new Set();
    const visuals = [];
    let scanned = 0;
    let omitted = false;
    for (let index = 0; index < Math.min(selection.rangeCount, 16); index += 1) {
      const range = selection.getRangeAt(index);
      let container = range.commonAncestorContainer || range.startContainer;
      if (container?.nodeType === 3) container = container.parentElement;
      const candidates = /^(IMG|CANVAS|SVG)$/i.test(container?.tagName || "")
        ? [container] : container?.querySelectorAll?.("img,canvas,svg") || [];
      for (const element of candidates) {
        if (scanned++ >= 5000) { omitted = true; break; }
        if (seen.has(element) || (element.closest?.("svg") && !/^SVG$/i.test(element.tagName || ""))) continue;
        try {
          if (!range.intersectsNode?.(element)) continue;
          const bounds = element.getBoundingClientRect();
          const style = root.getComputedStyle?.(element);
          if (bounds.width < 1 || bounds.height < 1 || element.isConnected === false
            || style?.display === "none" || style?.visibility === "hidden") continue;
          seen.add(element);
          if (visuals.length >= 3) continue;
          if (!visualIds.has(element)) visualIds.set(element, `selection-visual-${++visualSequence}`);
          const id = visualIds.get(element);
          const type = String(element.tagName || "").toLowerCase();
          visuals.push({ id, type,
            src: type === "img" ? bounded(element.currentSrc || element.getAttribute?.("src"), 2000) : "",
            alt: bounded(element.getAttribute?.("alt"), 300), title: bounded(element.getAttribute?.("title") || element.getAttribute?.("aria-label"), 300) });
          selectedElements.set(id, element);
        } catch { /* Detached or inaccessible elements are not selected evidence. */ }
      }
      if (omitted) break;
    }
    return { visuals, visualCount: seen.size, visualsTruncated: omitted || seen.size > visuals.length };
  }

  function readSelection() {
    const text = selectionText();
    const images = selectedVisuals();
    if (!text && !images.visuals.length) return null;
    return { text: text || "[选中的图片]", url: String(root.location?.href || ""),
      title: String(root.document?.title || ""), context: text.length >= MIN_SELECTION ? contextAroundSelection() : "",
      selectedAt: new Date().toISOString(),
      ...(images.visuals.length ? { ...images, imageOnly: !text } : {}) };
  }

  function selectionKey(value) {
    // Chrome serializes message and injected-script object fields in a
    // different order. Compare declared fields, never raw object key order.
    const visuals = (value?.visuals || []).map(visual => ({ id: visual.id, type: visual.type,
      src: visual.src, alt: visual.alt, title: visual.title }));
    return JSON.stringify({ text: value?.text || "", url: value?.url || "", visuals,
      visualCount: value?.visualCount || 0, visualsTruncated: value?.visualsTruncated === true, imageOnly: value?.imageOnly === true });
  }

  function captureSelection(expected, pixels = true) {
    const selection = readSelection();
    if (!selection || selectionKey(selection) !== selectionKey(expected)) throw new Error("网页选区或选中图片已变化，请重新选择后发送。");
    const images = (selection.visuals || []).map(visual => {
      const element = selectedElements.get(visual.id);
      const bounds = element?.getBoundingClientRect();
      if (!bounds || element.isConnected === false || bounds.width < 1 || bounds.height < 1) throw new Error("选中图片已不可见，请重新选择。");
      if (visual.type === "img" && (element.complete !== true || !(element.naturalWidth > 0) || !(element.naturalHeight > 0))) {
        throw new Error("所选图片尚未加载完成或加载失败，请待图片正常显示后重新发送。");
      }
      const image = { ...visual, figureId: visual.id, caption: visual.alt || visual.title || "选中图片",
        pixelRatio: Number(root.devicePixelRatio) || 1,
        rect: { x: bounds.left + Number(root.scrollX || 0), y: bounds.top + Number(root.scrollY || 0), width: bounds.width, height: bounds.height } };
      if (pixels && (visual.type === "img" || visual.type === "canvas")) {
        const width = Number(visual.type === "img" ? element.naturalWidth : element.width);
        const height = Number(visual.type === "img" ? element.naturalHeight : element.height);
        if (width > 0 && height > 0) {
          try {
            const scale = Math.min(1, 1600 / Math.max(width, height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
            const context = canvas.getContext("2d");
            if (!context) throw new Error("无法读取图片像素。");
            context.drawImage(element, 0, 0, canvas.width, canvas.height);
            // Keep transparency; JPEG's implicit black background can erase
            // black text/lines in transparent diagrams and canvas charts.
            const dataUrl = canvas.toDataURL("image/png");
            if (/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(dataUrl)) Object.assign(image, { dataUrl, width: canvas.width, height: canvas.height });
          } catch { /* Cross-origin pixels remain screenshot candidates; never fetch image URLs. */ }
        }
      }
      return image;
    });
    return { selection, images };
  }

  root.__unkAiSelectionVisuals = Object.freeze({
    read: readSelection, capture: captureSelection,
    suppressSelection() {
      const token = `selection-style-${++styleSequence}`;
      const style = document.createElement("style");
      style.textContent = "::selection{background:transparent!important;color:inherit!important;}";
      (document.head || document.documentElement).appendChild(style);
      const timer = setTimeout(() => { style.remove(); selectionStyles.delete(token); }, 10000);
      selectionStyles.set(token, { style, timer });
      return token;
    },
    restoreSelection(token) {
      const entry = selectionStyles.get(token);
      if (entry) { clearTimeout(entry.timer); entry.style.remove(); selectionStyles.delete(token); }
    },
  });

  function selectionText() {
    const selection = root.getSelection ? root.getSelection() : null;
    const text = selection ? String(selection.toString() || "").replace(/\r\n?/g, "\n").trim() : "";
    return text.length > MAX_SELECTION ? text.slice(0, MAX_SELECTION) : text;
  }

  function contextAroundSelection() {
    try {
      const selection = root.getSelection ? root.getSelection() : null;
      if (!selection || !selection.rangeCount) return "";
      let node = selection.getRangeAt(0).startContainer;
      if (node && node.nodeType === 3) node = node.parentElement;
      let container = node;
      for (let depth = 0; container && depth < 5; depth += 1) {
        if (/^(P|LI|BLOCKQUOTE|TD|TH|PRE|H1|H2|H3|H4|SECTION|ARTICLE)$/.test(container.tagName || "")) break;
        container = container.parentElement;
      }
      if (!container) return "";
      const text = String(container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
      const selected = selectionText().replace(/\s+/g, " ").trim();
      const at = selected ? text.indexOf(selected) : -1;
      if (at < 0) return text.slice(0, 700);
      return text.slice(Math.max(0, at - 260), Math.min(text.length, at + selected.length + 260));
    } catch {
      return "";
    }
  }

  function send() {
    timer = null;
    const payload = readSelection();
    // Empty selections are cleared from the panel itself. Never let a delayed
    // empty event overwrite a newer selection.
    if (!payload) return;
    const key = selectionKey(payload);
    if (key === lastVisuals) return;
    lastVisuals = key;
    lastText = payload.text;
    lastUrl = payload.url;
    try {
      Promise.resolve(chrome.runtime.sendMessage({
        type: "PAGE_SELECTION_CHANGED",
        payload,
      })).catch(() => {});
    } catch {
      // The extension may be reloading; the next selection event retries.
    }
  }

  function schedule() {
    clearTimeout(timer);
    // Wait for the pointer gesture to settle; selectionchange fires many times.
    timer = setTimeout(send, 90);
  }

  function clearSelection() {
    clearTimeout(timer);
    timer = null;
    const selection = root.getSelection ? root.getSelection() : null;
    selection?.removeAllRanges();
    lastText = "";
    lastVisuals = "";
    lastUrl = String(root.location && root.location.href || "");
  }

  function listenInIframe() {
    if (iframeListening) return;
    iframeListening = true;
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          if (frame.contentDocument) {
            frame.contentDocument.addEventListener("selectionchange", () => {
              if (frame.contentWindow?.getSelection()?.toString().trim()) schedule();
            }, true);
          }
        } catch {
          // Cross-origin iframe: content scripts run separately when permitted.
        }
      }
    } catch {
      // Not every page exposes its iframe collection.
    }
  }

  document.addEventListener("selectionchange", schedule, true);
  document.addEventListener("mouseup", schedule, true);
  document.addEventListener("keyup", schedule, true);
  document.addEventListener("focusout", schedule, true);
  window.addEventListener("blur", schedule, true);
  document.addEventListener("load", listenInIframe, true);
  listenInIframe();
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CLEAR_PAGE_SELECTION") {
      clearSelection();
      return false;
    }
    if (message?.type !== "GET_PAGE_SELECTION") return undefined;
    if (message.type === "GET_PAGE_SELECTION") {
      sendResponse(readSelection());
    }
    return false;
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
