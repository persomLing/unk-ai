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
  let iframeListening = false;

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
    const text = selectionText();
    const url = String(root.location && root.location.href || "");
    // Empty selections are cleared from the panel itself. Never let a delayed
    // empty event overwrite a newer selection.
    if (!text) return;
    if (text === lastText && url === lastUrl) return;
    lastText = text;
    lastUrl = url;
    try {
      Promise.resolve(chrome.runtime.sendMessage({
        type: "PAGE_SELECTION_CHANGED",
        payload: {
          text,
          url,
          title: String(root.document && root.document.title || ""),
          context: text.length >= MIN_SELECTION ? contextAroundSelection() : "",
          selectedAt: new Date().toISOString(),
        },
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
      const text = selectionText();
      sendResponse(text ? {
        text,
        url: String(root.location && root.location.href || ""),
        title: String(root.document && root.document.title || ""),
        context: contextAroundSelection(),
        selectedAt: new Date().toISOString(),
      } : null);
    }
    return false;
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
