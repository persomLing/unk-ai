(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && !root.__unkAiAriaText) root.__unkAiAriaText = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createAriaText(extractor) {
    const { isNoise, isHidden, tagOf, getAttribute, normalizeInlineText, normalizeCodeText } = extractor;

    const ROLE_MAP = {
      ARTICLE: "article", ASIDE: "complementary", BUTTON: "button",
      CAPTION: "caption", CODE: "code", DATALIST: "listbox",
      DD: "definition", DETAILS: "group", DIALOG: "dialog",
      DL: "list", DT: "term", FIELDSET: "group", FIGCAPTION: "caption",
      FIGURE: "figure", FORM: "form",
      H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
      IMG: "img", INPUT: "textbox", LI: "listitem", MAIN: "main",
      MARK: "mark", NAV: "navigation", OL: "list", OPTION: "option",
      P: "paragraph", PRE: "code", PROGRESS: "progressbar",
      SECTION: "region", SELECT: "combobox", SUMMARY: "button",
      TABLE: "table", TBODY: "rowgroup", TD: "cell", TFOOT: "rowgroup",
      TH: "columnheader", THEAD: "rowgroup", TR: "row",
      TEXTAREA: "textbox", UL: "list",
    };

    const SKIP_TAGS = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "FRAME",
      "OBJECT", "EMBED", "CANVAS", "SVG", "BR", "HR",
      "META", "LINK", "TITLE", "HEAD",
    ]);

    const CONTAINER_ROLES = new Set([
      "main", "article", "complementary", "navigation", "region",
      "contentinfo", "form", "group", "list", "rowgroup", "table",
    ]);

    const LEAF_ROLES = new Set([
      "img", "button", "textbox", "option", "cell", "columnheader",
    ]);

    const MAX_LINES = 2000;
    const MAX_CHARS = 120000;
    const CODE_LIMIT = 4000;

    function roleOf(node, explicit) {
      if (explicit) return explicit;
      return ROLE_MAP[tagOf(node)] || "";
    }

    function nodeText(node) {
      return normalizeInlineText(node?.textContent || "");
    }

    function isSemantic(node, doc) {
      const role = roleOf(node, String(getAttribute(node, "role") || "").toLowerCase());
      return role && !CONTAINER_ROLES.has(role);
    }

    function indentOf(depth) {
      return "  ".repeat(Math.max(0, depth));
    }

    function walk(node, doc, lines, depth) {
      if (lines.length >= MAX_LINES || totalChars >= MAX_CHARS) return;
      if (!node) return;
      if (node.nodeType === 3) {
        const text = normalizeInlineText(node.nodeValue || "");
        if (text && !lines.length) lines.push(text);
        return;
      }
      if (node.nodeType !== 1) return;
      if (isNoise(node) || isHidden(node, doc)) return;

      const tag = tagOf(node);
      const role = roleOf(node, String(getAttribute(node, "role") || "").toLowerCase());

      if (role === "code" || tag === "PRE") {
        const text = normalizeCodeText(node.textContent || "").slice(0, CODE_LIMIT);
        if (text) {
          lines.push(`${indentOf(depth)}- code: ${text}`);
          totalChars += text.length;
        }
        return;
      }

      if (role === "img" || tag === "IMG") {
        const alt = getAttribute(node, "alt");
        const src = getAttribute(node, "src") || getAttribute(node, "data-src");
        const label = alt || (src && !src.startsWith("data:") ? `[图片:${src}]` : "");
        if (label) {
          lines.push(`${indentOf(depth)}- img "${label}"`);
          totalChars += label.length;
        }
        return;
      }

      if (role === "link" || tag === "A") {
        const href = getAttribute(node, "href");
        const text = nodeText(node);
        if (text && href) {
          lines.push(`${indentOf(depth)}- link "${text}" -> ${href}`);
          totalChars += text.length + href.length;
        } else if (text) {
          lines.push(`${indentOf(depth)}- link "${text}"`);
          totalChars += text.length;
        }
        return;
      }

      if (role === "heading") {
        const level = Math.min(6, Number(tag.replace("H", "")) || 1);
        const text = nodeText(node);
        if (text) {
          lines.push(`${indentOf(depth)}- heading "${text}" [level=${level}]`);
          totalChars += text.length;
        }
        return;
      }

      if (isSemantic(node, doc)) {
        const text = nodeText(node);
        if (text) {
          lines.push(`${indentOf(depth)}- ${role}: ${text}`);
          totalChars += text.length;
        }
        if (LEAF_ROLES.has(role)) return;
      }

      for (const child of node.childNodes || []) {
        walk(child, doc, lines, depth + 1);
      }
    }

    let totalChars = 0;

    function extract(root, doc) {
      if (!root) return "";
      totalChars = 0;
      const lines = [];
      walk(root, doc, lines, 0);
      return lines.join("\n").trim();
    }

    return { extract };
  }

  return { createAriaText };
});
