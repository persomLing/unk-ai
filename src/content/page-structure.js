(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && !root.__unkAiPageStructure) root.__unkAiPageStructure = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /**
   * Compatibility bridge for callers that load the optional structure file.
   * The implementation lives in extractor.js so the injected script order
   * cannot create a second, drifting lazy-load implementation.
   */
  function materializeLazyContent(input) {
    const implementation = root?.__unkAiExtractor?.materializeLazyContent;
    if (typeof implementation !== "function") {
      return Promise.reject(new Error("正文提取器未加载。"));
    }
    return implementation(input);
  }

  return { materializeLazyContent };
});
