(function (root) {
  "use strict";

  const runtime = root && root.chrome && root.chrome.runtime;
  if (!runtime?.onMessage || typeof runtime.onMessage.addListener !== "function") return;

  function normalizedOptions(message) {
    const options = message.options && typeof message.options === "object" ? { ...message.options } : {};
    const budget = message.maxBudget === undefined
      ? (options.maxBudget ?? options.budget)
      : message.maxBudget;
    return {
      ...options,
      maxBudget: budget === undefined ? 60000 : budget,
      includeStructure: Boolean(message.includeStructure ?? options.includeStructure),
      includeLinks: message.includeLinks ?? options.includeLinks,
    };
  }

  async function lazyLoad(message, extractor, signal) {
    const pageStructure = root.__unkAiPageStructure || extractor;
    if (!pageStructure || typeof pageStructure.materializeLazyContent !== "function") {
      return { available: false, reason: "page-structure.js 未加载。" };
    }
    return {
      available: true,
      ...await pageStructure.materializeLazyContent({
        ...(message.lazyLoad === true ? {} : message.lazyLoad || message.lazyOptions || {}),
        signal,
        window: root,
        document: root.document,
      }),
    };
  }

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "EXTRACT_PAGE") return undefined;

    const options = normalizedOptions(message);
    const wantsLazyLoad = Boolean(message.materializeLazy ?? message.lazyLoad);
    if (!wantsLazyLoad) {
      try {
        const extractor = root.__unkAiExtractor;
        if (!extractor || typeof extractor.extractPageContent !== "function") {
          throw new Error("正文提取器未加载。");
        }
        sendResponse(extractor.extractPageContent(options));
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
      return false;
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (message.signal?.addEventListener && controller) {
      message.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const extractor = root.__unkAiExtractor;
    if (!extractor || typeof extractor.extractPageContent !== "function") {
      sendResponse({ error: "正文提取器未加载。" });
      return false;
    }
    Promise.resolve()
      .then(() => lazyLoad(message, extractor, controller?.signal).catch((error) => ({
        available: false,
        error: error instanceof Error ? error.message : String(error),
      })))
      .then((lazy) => {
        const result = extractor.extractPageContent({
          ...options,
          includeStructure: Boolean(message.includeStructure ?? options.includeStructure ?? true),
        });
        sendResponse({
          ...result,
          lazyMaterialization: lazy?.available === false
            ? lazy
            : { available: true, steps: lazy?.steps || 0, restored: lazy?.restored !== false },
        });
      })
      .catch((error) => {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
