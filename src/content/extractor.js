(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  // The worker reinjects this file for a fresh read. Replace an older loaded
  // implementation as well, so retrying after an extension update uses it.
  if (root) root.__unkAiExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_BUDGET = 60000;
  const LAZY_TIMEOUT_MS = 5000;
  const MAX_LAZY_STEPS = 24;
  const MAX_LAZY_STEP_DELAY_MS = 250;
  const TRUNCATION_MARKER = "\n\n[…正文已截断…]\n\n";
  const NOISE_CLASS_PATTERNS = new RegExp(
    "(?:^|[\\s_-])(?:ad|ads|advert|sponsor|promo|banner|cookie|newsletter|popup|modal|social|share|comment|comments|recommend|related|sidebar|widget|breadcrumb|pagination|subscribe|skip-link|visually-hidden|sr-only|toolbar|footer-nav|back-to-top|floating|sticky-bottom)(?:$|[\\s_-])",
    "i",
  );
  const DEFAULT_STRUCTURE_LIMITS = Object.freeze({
    nodes: 6000,
    landmarks: 40,
    headings: 120,
    links: 300,
    tables: 20,
    rowsPerTable: 100,
    cellsPerRow: 30,
    forms: 20,
    fieldsPerForm: 60,
    figures: 80,
  });
  const TEXT_LIMITS = Object.freeze({
    label: 300,
    link: 300,
    cell: 400,
    caption: 500,
    heading: 180,
  });
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIALOG",
    "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
    "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI",
    "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "BUTTON",
    "TFOOT", "TH", "THEAD", "TR", "UL",
  ]);
  const SEPARATED_CELL_TAGS = new Set(["TD", "TH"]);
  const NOISE_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "NAV", "FOOTER",
    "INPUT", "TEXTAREA", "SELECT", "OPTION", "OPTGROUP", "DATALIST",
    "IFRAME", "FRAME", "OBJECT", "EMBED", "SVG", "CANVAS",
  ]);
  const NOISE_ROLES = new Set(["navigation", "contentinfo", "search"]);
  const LANDMARK_ROLES = new Set([
    "article", "banner", "complementary", "contentinfo", "dialog", "form",
    "main", "navigation", "region", "search",
  ]);
  const NATIVE_LANDMARK_ROLES = Object.freeze({
    ARTICLE: "article",
    ASIDE: "complementary",
    FOOTER: "contentinfo",
    FORM: "form",
    HEADER: "banner",
    MAIN: "main",
    NAV: "navigation",
    SECTION: "region",
  });
  const FORM_FIELD_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);
  const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  const SELECTABLE_ROLES = new Set(["option", "tab", "row", "gridcell", "treeitem"]);

  function tagOf(node) {
    return String(node && (node.tagName || node.nodeName) || "").toUpperCase();
  }

  function childrenOf(node) {
    if (!node) return [];
    return Array.from(node.childNodes || node.children || []);
  }

  function getAttribute(node, name) {
    if (typeof node.getAttribute === "function") return node.getAttribute(name);
    return node.attributes && node.attributes[name] != null
      ? String(node.attributes[name])
      : null;
  }

  function inlineStyleHides(node) {
    const style = node.style;
    if (style && (
      style.display === "none" ||
      style.visibility === "hidden" || style.visibility === "collapse" ||
      style.contentVisibility === "hidden"
    )) return true;

    const text = getAttribute(node, "style");
    return typeof text === "string" && (
      /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(text) ||
      /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)(?:\s*!important)?\s*(?:;|$)/i.test(text) ||
      /(?:^|;)\s*content-visibility\s*:\s*hidden(?:\s*!important)?\s*(?:;|$)/i.test(text)
    );
  }

  function isHidden(node, doc) {
    if (node.hidden === true || getAttribute(node, "hidden") != null) return true;
    if (String(getAttribute(node, "aria-hidden") || "").toLowerCase() === "true") return true;
    if (inlineStyleHides(node)) return true;

    const view = doc && doc.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return false;
    try {
      const style = view.getComputedStyle(node);
      return Boolean(style && (
        style.display === "none" ||
        style.visibility === "hidden" || style.visibility === "collapse" ||
        style.contentVisibility === "hidden"
      ));
    } catch (_) {
      return false;
    }
  }

  function isNoise(node) {
    if (NOISE_TAGS.has(tagOf(node))) return true;
    const editable = getAttribute(node, "contenteditable");
    if (editable !== null && editable !== undefined && String(editable).toLowerCase() !== "false") return true;
    if (node.isContentEditable === true) return true;
    const role = String(getAttribute(node, "role") || "").toLowerCase();
    if (["textbox", "searchbox", "combobox"].includes(role)) return true;
    if (NOISE_ROLES.has(role)) return true;
    const className = String(getAttribute(node, "class") || "");
    const id = String(getAttribute(node, "id") || "");
    if (NOISE_CLASS_PATTERNS.test(className) || NOISE_CLASS_PATTERNS.test(id)) return true;
    return false;
  }

  function linkDensity(element, doc) {
    const links = matchingElements(element, "a[href]");
    if (!links.length) return 0;
    const allText = collectText(element, doc).length;
    if (!allText) return 1;
    const linkText = links.reduce((sum, link) => sum + collectText(link, doc).length, 0);
    return linkText / allText;
  }

  function collectAriaAwareText(container, doc) {
    // Generic ARIA snapshots include live input values (including passwords)
    // and editable drafts. Keep reading text on the value-free traversal;
    // collectSemanticStructure below still supplies headings, links and tables.
    return collectText(container, doc);
  }

  function normalizeInlineText(text) {
    return String(text)
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/ *\n */g, " ")
      .trim();
  }

  function normalizeCodeText(text) {
    return String(text)
      .replace(/^\n/, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^[\t ]+|[\t \n]+$/g, "")
      .trim();
  }

  // A read-only recursive walk avoids innerText (and form .value entirely).
  // Each block owns its buffer, so a nested block cannot erase or duplicate
  // text that appeared before it in its parent.
  function collectText(root, doc) {
    const blocks = [];
    if (root && root.nodeType === 1 && (isNoise(root) || isHidden(root, doc))) return "";

    function push(buffer) {
      const text = buffer.code
        ? normalizeCodeText(buffer.text)
        : normalizeInlineText(buffer.text);
      buffer.text = "";
      if (text) blocks.push({ text, code: buffer.code, cell: buffer.cell });
    }

    function walk(node, buffer) {
      const type = node.nodeType == null ? 1 : node.nodeType;
      if (type === 3 || type === 4) {
        buffer.text += node.nodeValue == null ? (node.data || "") : node.nodeValue;
        return;
      }
      if (type !== 1) {
        for (const child of childrenOf(node)) walk(child, buffer);
        return;
      }
      if (isNoise(node) || isHidden(node, doc)) return;

      const tag = tagOf(node);
      if (tag === "BR") {
        buffer.text += " ";
        return;
      }
      if (tag === "PRE") {
        push(buffer);
        const code = { text: collectCodeText(node, doc), code: true, cell: false };
        push(code);
        return;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      const own = isBlock
        ? { text: "", code: false, cell: SEPARATED_CELL_TAGS.has(tag) }
        : buffer;
      if (isBlock) push(buffer);

      // Alt text is useful readable content; aria-label on generic containers
      // often duplicates their descendants and is therefore not substituted.
      if (tag === "IMG") {
        const alt = getAttribute(node, "alt");
        const src = getAttribute(node, "src") || getAttribute(node, "data-src");
        if (alt) own.text += alt;
        if (!alt && src && !src.startsWith("data:")) own.text += `[图片：${src}]`;
      }

      for (const child of childrenOf(node)) walk(child, own);
      if (isBlock) push(own);
    }

    const rootBuffer = { text: "", code: false, cell: false };
    for (const child of childrenOf(root)) walk(child, rootBuffer);
    push(rootBuffer);

    let output = "";
    for (const block of blocks) {
      if (!output) {
        output = block.text;
      } else {
        output += (block.cell ? "\t" : "\n\n") + block.text;
      }
    }

    // Inline text is already single-spaced. This also handles whitespace-only
    // block boundaries without collapsing intentional newlines inside pre.
    return output.replace(/\n{3,}/g, "\n\n").trim();
  }

  function collectCodeText(root, doc) {
    let text = "";
    function walk(node) {
      const type = node.nodeType == null ? 1 : node.nodeType;
      if (type === 3 || type === 4) {
        text += node.nodeValue == null ? (node.data || "") : node.nodeValue;
        return;
      }
      if (type !== 1 || isNoise(node) || isHidden(node, doc)) return;
      if (tagOf(node) === "BR") {
        text += "\n";
        return;
      }
      for (const child of childrenOf(node)) walk(child);
    }
    for (const child of childrenOf(root)) walk(child);
    return text;
  }

  function matchingElements(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function contains(parent, node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === parent) return true;
    }
    return false;
  }

  function commonParent(elements) {
    if (!elements.length) return null;
    const ancestors = [];
    for (let node = elements[0]; node; node = node.parentNode) ancestors.push(node);
    return ancestors.find((ancestor) => elements.every((element) => contains(ancestor, element))) || null;
  }

  function hasReadableText(element, doc) {
    return !isHidden(element, doc) && !isNoise(element) && collectText(element, doc).length > 0;
  }

  function readableLength(element, doc) {
    return collectText(element, doc).replace(/\s+/g, "").length;
  }

  function scoreCandidate(element, doc) {
    const length = readableLength(element, doc);
    if (length < 80) return null;
    const score = length
      + matchingElements(element, "p").length * 45
      + matchingElements(element, "h1,h2,h3,h4").length * 25
      + matchingElements(element, "pre,code,table").length * 30;
    return { element, length, score };
  }

  function chooseContainer(doc) {
    if (!doc) return null;
    // Docsify renders the article asynchronously inside this root. An empty
    // root is still authoritative: falling back to the surrounding shell would
    // turn the site title and chapter navigation into apparent page content.
    const documentationRoots = matchingElements(doc, "article,main,section,div")
      .filter((element) => String(getAttribute(element, "class") || "").split(/\s+/).includes("markdown-section"))
      .filter((element) => !isHidden(element, doc) && !isNoise(element));
    if (documentationRoots.length) {
      return documentationRoots.sort((left, right) => readableLength(right, doc) - readableLength(left, doc))[0];
    }
    const docsifyLoading = matchingElements(doc, "script").some((element) =>
      /(?:^|[/@._-])docsify(?:[/.@_-]|$)/i.test(String(getAttribute(element, "src") || "")));
    if (docsifyLoading) {
      const app = matchingElements(doc, "div,main,section")
        .find((element) => getAttribute(element, "id") === "app");
      if (app) return app;
    }
    for (const tag of ["article", "main"]) {
      const candidates = matchingElements(doc, tag).filter((element) => {
        if (!hasReadableText(element, doc)) return false;
        // A nested landmark does not make an otherwise unique outer article
        // ambiguous; the outer container includes both pieces of content.
        return !matchingElements(doc, tag).some((other) => other !== element && contains(other, element));
      });
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return commonParent(candidates) || doc.body || doc.documentElement;
    }
    // Sites frequently build a lesson reader from generic <div> blocks with a
    // navigation/sidebar nearby. Prefer the densest readable article-like
    // subtree instead of returning the entire document-body shell.
    const candidates = ["section", "div"]
      .flatMap((tag) => matchingElements(doc, tag))
      .filter((element) => !isHidden(element, doc) && !isNoise(element))
      .map((element) => scoreCandidate(element, doc))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);
    if (candidates.length) {
      const best = candidates[0];
      if (best.length >= 500) return best.element;
    }
    return doc.body || doc.documentElement || null;
  }

  function nearestAncestor(node, container, predicate) {
    for (let current = node && node.parentNode; current && current !== container; current = current.parentNode) {
      if (predicate(current)) return current;
    }
    return null;
  }

  function resolvePageUrl(value, doc) {
    const source = String(value || "").trim();
    if (!source || source.startsWith("data:")) return "";
    try {
      return new URL(source, doc?.location?.href || "").href.slice(0, 500);
    } catch {
      return source.slice(0, 500);
    }
  }

  function trimmedText(value, limit = TEXT_LIMITS.label) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function numericAttribute(node, name) {
    const value = Number.parseInt(getAttribute(node, name), 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function textOf(node, doc, limit = TEXT_LIMITS.label) {
    return trimmedText(node ? collectText(node, doc) : "", limit);
  }

  function accessibleName(node, doc, limit = TEXT_LIMITS.label) {
    const labelledBy = String(getAttribute(node, "aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean);
    if (labelledBy.length) {
      const ids = new Set(labelledBy);
      const labels = matchingElements(doc || node.ownerDocument, "[id]")
        .filter((item) => ids.has(getAttribute(item, "id")))
        .map((item) => textOf(item, doc, limit));
      const joined = trimmedText(labels.join(" "), limit);
      if (joined) return joined;
    }

    const ariaLabel = trimmedText(getAttribute(node, "aria-label"), limit);
    if (ariaLabel) return ariaLabel;

    const tag = tagOf(node);
    if (tag === "IMG" || tag === "AREA" || tag === "INPUT") {
      const alt = trimmedText(getAttribute(node, "alt"), limit);
      if (alt) return alt;
    }
    if (tag === "INPUT") {
      const value = getAttribute(node, "type");
      if (String(value || "").toLowerCase() === "submit") {
        const submitted = trimmedText(getAttribute(node, "value"), limit);
        if (submitted) return submitted;
      }
    }
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag)) {
      const id = trimmedText(getAttribute(node, "id"), 120);
      if (id) {
        const label = matchingElements(doc, "label[for]")
          .find((item) => getAttribute(item, "for") === id);
        const labelText = label ? textOf(label, doc, limit) : "";
        if (labelText) return labelText;
      }
      const wrappingLabel = nearestAncestor(node, null, (item) => tagOf(item) === "LABEL");
      if (wrappingLabel) {
        const labelText = textOf(wrappingLabel, doc, limit);
        if (labelText) return labelText;
      }
    }
    const title = trimmedText(getAttribute(node, "title"), limit);
    return title || textOf(node, doc, limit);
  }

  function roleOf(node) {
    const explicit = trimmedText(getAttribute(node, "role"), 80).toLowerCase().split(/\s+/)[0];
    return explicit || NATIVE_LANDMARK_ROLES[tagOf(node)] || "";
  }

  function hasAccessibleName(node) {
    return Boolean(
      trimmedText(getAttribute(node, "aria-label"), 80) ||
      trimmedText(getAttribute(node, "aria-labelledby"), 80) ||
      trimmedText(getAttribute(node, "title"), 80),
    );
  }

  function normalizeLimits(options) {
    const raw = options && typeof options === "object" ? (options.limits || options) : {};
    const limits = {};
    for (const [name, fallback] of Object.entries(DEFAULT_STRUCTURE_LIMITS)) {
      const number = Number(raw[name]);
      limits[name] = Number.isFinite(number)
        ? Math.max(0, Math.floor(number))
        : fallback;
    }
    return limits;
  }

  function normalizeExtractOptions(budgetOrOptions) {
    if (budgetOrOptions && typeof budgetOrOptions === "object") {
      return {
        budget: normalizeBudget(budgetOrOptions.maxBudget ?? budgetOrOptions.budget),
        includeStructure: Boolean(budgetOrOptions.includeStructure || budgetOrOptions.structure),
        includeLinks: budgetOrOptions.includeLinks !== false,
        limits: normalizeLimits(budgetOrOptions.limits ? { limits: budgetOrOptions.limits } : budgetOrOptions),
      };
    }
    return {
      budget: normalizeBudget(budgetOrOptions),
      includeStructure: false,
      includeLinks: true,
      limits: normalizeLimits(),
    };
  }

  function tableRows(table) {
    const rows = [];
    for (const child of childrenOf(table)) {
      if (tagOf(child) === "TR") rows.push(child);
      if (["THEAD", "TBODY", "TFOOT"].includes(tagOf(child))) {
        rows.push(...childrenOf(child).filter((node) => tagOf(node) === "TR"));
      }
    }
    return rows.length ? rows : matchingElements(table, "tr");
  }

  function tableCells(row) {
    const direct = Array.from(row?.children || row?.childNodes || [])
      .filter((node) => ["TD", "TH"].includes(tagOf(node)));
    if (direct.length) return direct;
    return childrenOf(row).filter((node) => ["TD", "TH"].includes(tagOf(node)));
  }

  function collectTable(table, doc, limits) {
    const captionNode = matchingElements(table, "caption")[0];
    const output = {
      caption: captionNode ? textOf(captionNode, doc, TEXT_LIMITS.caption) : "",
      headers: [],
      rows: [],
      rowCount: 0,
      truncated: false,
    };
    const allRows = tableRows(table);
    output.rowCount = allRows.length;
    const headerSet = new Set();

    for (const [rowIndex, row] of allRows.slice(0, limits.rowsPerTable).entries()) {
      const cells = [];
      const sourceCells = tableCells(row);
      for (const [cellIndex, cell] of sourceCells.slice(0, limits.cellsPerRow).entries()) {
        const header = tagOf(cell) === "TH";
        const text = textOf(cell, doc, TEXT_LIMITS.cell);
        const cellOutput = {
          text,
          column: cellIndex,
          row: rowIndex,
          header,
        };
        const colspan = numericAttribute(cell, "colspan");
        const rowspan = numericAttribute(cell, "rowspan");
        if (colspan > 1) cellOutput.colspan = colspan;
        if (rowspan > 1) cellOutput.rowspan = rowspan;
        if (header) {
          cellOutput.scope = trimmedText(getAttribute(cell, "scope"), 20) || "auto";
          if (text) headerSet.add(text);
        }
        cells.push(cellOutput);
      }
      if (sourceCells.length > limits.cellsPerRow) output.truncated = true;
      output.rows.push(cells);
    }
    if (allRows.length > limits.rowsPerTable) output.truncated = true;
    output.headers = Array.from(headerSet).slice(0, limits.cellsPerRow);
    return output;
  }

  function formField(node, doc) {
    const tag = tagOf(node).toLowerCase();
    const field = {
      tag,
      type: trimmedText(getAttribute(node, "type"), 40).toLowerCase() || (tag === "button" ? "button" : ""),
      name: trimmedText(getAttribute(node, "name"), 100),
      label: accessibleName(node, doc),
      required: getAttribute(node, "required") != null || getAttribute(node, "aria-required") === "true",
      disabled: getAttribute(node, "disabled") != null || getAttribute(node, "aria-disabled") === "true",
    };
    const role = roleOf(node);
    if (CHECKABLE_ROLES.has(role) || SELECTABLE_ROLES.has(role)) field.role = role;
    // Live choice properties are public control states, not input values. The
    // checked/selected HTML attributes describe defaults and may now be stale.
    if (tag === "input" && ["checkbox", "radio"].includes(field.type)) {
      if (field.type === "checkbox" && node.indeterminate === true) field.checked = "mixed";
      else if (typeof node.checked === "boolean") field.checked = node.checked;
    } else if (!FORM_FIELD_TAGS.has(tagOf(node)) || tag === "button") {
      const checked = getAttribute(node, "aria-checked");
      const selected = getAttribute(node, "aria-selected");
      if (CHECKABLE_ROLES.has(role) && (["true", "false"].includes(checked)
          || checked === "mixed" && ["checkbox", "menuitemcheckbox"].includes(role))) {
        field.checked = checked === "mixed" ? "mixed" : checked === "true";
      }
      if (SELECTABLE_ROLES.has(role) && ["true", "false"].includes(selected)) field.selected = selected === "true";
    }
    const options = [];
    if (tag === "select") {
      const allOptions = matchingElements(node, "option");
      const selectedOptions = [];
      let selectionKnown = allOptions.length <= 40;
      for (const option of allOptions.slice(0, 40)) {
        if (isEditableNode(option)) { selectionKnown = false; continue; }
        // OPTION is excluded from the article traversal; read its label text
        // explicitly without consulting option.value or select.value.
        const label = trimmedText(getAttribute(option, "label"), 120)
          || trimmedText(collectText({ childNodes: childrenOf(option) }, doc), 120);
        if (label) options.push(label);
        if (typeof option.selected !== "boolean") selectionKnown = false;
        if (option.selected === true && label) selectedOptions.push(label);
        if (option.selected === true && !label) selectionKnown = false;
      }
      field.selectedOptions = selectedOptions;
      field.selectionKnown = selectionKnown;
      if (allOptions.length > 40) field.selectionTruncated = true;
    }
    if (options.length) field.options = options;
    return field;
  }

  function collectForm(form, doc, limits) {
    const fields = [];
    const pending = childrenOf(form).reverse();
    let visited = 0;
    while (pending.length && visited < limits.nodes && fields.length < limits.fieldsPerForm) {
      const node = pending.pop();
      visited += 1;
      if (node.nodeType !== 1 || isHidden(node, doc)) continue;
      const tag = tagOf(node);
      const native = FORM_FIELD_TAGS.has(tag);
      // Skip editable/hidden subtrees even when controls are nested inside them.
      if ((!native && isNoise(node)) || isEditableNode(node)) continue;
      if (native || isChoiceControl(node)) fields.push(formField(node, doc));
      if (native && tag !== "BUTTON") continue;
      pending.push(...childrenOf(node).reverse());
    }
    return {
      label: accessibleName(form, doc),
      action: resolvePageUrl(getAttribute(form, "action"), doc),
      method: trimmedText(getAttribute(form, "method"), 20).toLowerCase() || "get",
      fields,
      ...(pending.length ? { truncated: true } : {}),
    };
  }

  function isEditableNode(node) {
    const editable = getAttribute(node, "contenteditable");
    return node.isContentEditable === true
      || (editable != null && String(editable).toLowerCase() !== "false")
      || (tagOf(node) !== "SELECT" && ["textbox", "searchbox", "combobox"].includes(roleOf(node)));
  }

  function isChoiceControl(node) {
    const tag = tagOf(node);
    if (tag === "SELECT") return true;
    if (tag === "INPUT") return ["checkbox", "radio"].includes(String(getAttribute(node, "type") || "").toLowerCase());
    return CHECKABLE_ROLES.has(roleOf(node)) || SELECTABLE_ROLES.has(roleOf(node));
  }

  function collectSemanticStructure(container, doc, inputLimits) {
    const limits = normalizeLimits({ limits: inputLimits });
    const output = {
      landmarks: [],
      headings: [],
      links: [],
      tables: [],
      forms: [],
      figures: [],
    };
    if (!container) return output;

    // Document-order DFS. Heading state is intentionally shared across
    // siblings: a heading opens a section for every following node until a
    // heading of the same or a higher level replaces it.
    const headingLevels = [];
    let headingPath = [];
    let ungroupedChoices = null;
    const pending = [container];
    let visited = 0;
    while (pending.length && visited < limits.nodes) {
      const node = pending.pop();
      visited += 1;
      const type = node.nodeType == null ? 1 : node.nodeType;
      if (type !== 1) continue;
      const tag = tagOf(node);
      const hidden = isHidden(node, doc);
      // Configuration UIs often have semantic controls outside a <form>.
      // Reuse the bounded form index so frame merging retains their states.
      if (!hidden && isChoiceControl(node) && !isEditableNode(node)
          && !nearestAncestor(node, container, item => tagOf(item) === "FORM")) {
        if (!ungroupedChoices && output.forms.length < limits.forms) {
          ungroupedChoices = { label: "页面选项（表单外）", fields: [], section: [] };
          output.forms.push(ungroupedChoices);
        }
        if (ungroupedChoices && ungroupedChoices.fields.length < limits.fieldsPerForm) {
          ungroupedChoices.fields.push({ ...formField(node, doc), section: headingPath.slice(-3) });
        } else if (ungroupedChoices) ungroupedChoices.truncated = true;
      }
      if (hidden || (isNoise(node) && !["NAV", "SVG", "CANVAS"].includes(tag))) continue;
      const section = headingPath.slice(-3);

      if (tag === "TABLE" && output.tables.length < limits.tables) {
        output.tables.push({ ...collectTable(node, doc, limits), section });
      }
      if (tag === "FORM" && output.forms.length < limits.forms) {
        output.forms.push({ ...collectForm(node, doc, limits), section });
      }
      const figureHasMedia = tag === "FIGURE" &&
        matchingElements(node, "img,canvas,svg").length > 0;
      if (["IMG", "FIGURE", "CANVAS", "SVG"].includes(tag) &&
          !figureHasMedia &&
          output.figures.length < limits.figures) {
        const owner = tag === "FIGURE"
          ? node
          : nearestAncestor(node, container, (item) => tagOf(item) === "FIGURE");
        output.figures.push({
          index: output.figures.length,
          type: tag.toLowerCase(),
          alt: tag === "IMG" ? trimmedText(getAttribute(node, "alt"), TEXT_LIMITS.label) : "",
          title: trimmedText(
            getAttribute(node, "aria-label") || getAttribute(node, "title") || "",
            TEXT_LIMITS.label,
          ),
          src: resolvePageUrl(
            getAttribute(node, "currentSrc") || getAttribute(node, "src") || getAttribute(node, "data-src"),
            doc,
          ),
          caption: figureCaption(node, container, doc),
          section,
          figureText: owner ? textOf(owner, doc, TEXT_LIMITS.caption) : "",
        });
      }

      const role = roleOf(node);
      if (LANDMARK_ROLES.has(role) && (!["region", "form"].includes(role) || hasAccessibleName(node))) {
        const landmark = {
          role,
          tag: tag.toLowerCase(),
          label: accessibleName(node, doc),
        };
        if (output.landmarks.length < limits.landmarks) output.landmarks.push(landmark);
      }

      if (/^H[1-6]$/.test(tag) && output.headings.length < limits.headings) {
        const heading = {
          level: Number(tag.slice(1)),
          text: textOf(node, doc, TEXT_LIMITS.heading),
        };
        if (heading.text) {
          while (headingLevels.length && headingLevels.at(-1).level >= heading.level) {
            headingLevels.pop();
          }
          headingLevels.push({ level: heading.level, text: heading.text });
          headingPath = headingLevels.map((item) => item.text).slice(-3);
          heading.section = headingPath.slice(0, -1);
          output.headings.push(heading);
        }
      }

      if ((tag === "A" || tag === "AREA") && output.links.length < limits.links) {
        const href = resolvePageUrl(getAttribute(node, "href"), doc);
        if (href) {
          output.links.push({
            text: accessibleName(node, doc, TEXT_LIMITS.link),
            href,
            title: trimmedText(getAttribute(node, "title"), TEXT_LIMITS.label),
            section,
          });
        }
      }

      const children = childrenOf(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childType = children[index].nodeType;
        if (childType == null || childType === 1) pending.push(children[index]);
      }
    }

    output.truncated = {
      visited: visited >= limits.nodes && pending.length > 0,
      landmarks: output.landmarks.length >= limits.landmarks,
      headings: output.headings.length >= limits.headings,
      links: output.links.length >= limits.links,
      tables: output.tables.length >= limits.tables,
      forms: output.forms.length >= limits.forms,
      figures: output.figures.length >= limits.figures,
    };
    return output;
  }

  function figureCaption(node, container, doc) {
    const figure = nearestAncestor(node, container, (element) =>
      tagOf(element) === "FIGURE" || tagOf(element) === "FIELDSET");
    if (!figure) return "";
    const caption = matchingElements(figure, "figcaption")[0];
    const text = caption ? collectText(caption, doc) : collectText(figure, doc);
    return text.replace(/\s+/g, " ").trim().slice(0, 500);
  }

  /**
   * Build a lightweight reading outline and figure index. This deliberately
   * captures metadata, not pixels: the model can locate and reason about a
   * figure, while the UI tells it to request a real screenshot when visual
   * judgement is required.
   */
  function collectStructure(container, doc) {
    if (!container) return { sections: [], figures: [] };
    const sections = [];
    const figures = [];
    const headingStack = [];

    function sectionPath() {
      return headingStack.map((item) => item.text).filter(Boolean).slice(-3);
    }

    function walk(node) {
      const type = node.nodeType == null ? 1 : node.nodeType;
      if (type !== 1 || isHidden(node, doc)) return;
      const tag = tagOf(node);
      if (isNoise(node) && !["SVG", "CANVAS"].includes(tag)) return;

      if (/^H[1-4]$/.test(tag)) {
        const text = collectText(node, doc).replace(/\s+/g, " ").trim().slice(0, 180);
        if (text) {
          const level = Number(tag.slice(1));
          while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
          headingStack.push({ level, text });
          if (sections.length < 120) sections.push({ level, text });
        }
      }

      if (figures.length < 80 && (tag === "IMG" || tag === "CANVAS" || tag === "SVG")) {
        const figure = { type: tag.toLowerCase(), section: sectionPath() };
        if (tag === "IMG") {
          figure.alt = String(getAttribute(node, "alt") || "").replace(/\s+/g, " ").trim().slice(0, 300);
          figure.title = String(getAttribute(node, "title") || "").replace(/\s+/g, " ").trim().slice(0, 300);
          figure.src = resolvePageUrl(
            getAttribute(node, "currentSrc") || getAttribute(node, "src") || getAttribute(node, "data-src"),
            doc,
          );
        } else {
          const label = getAttribute(node, "aria-label") || getAttribute(node, "title") || "";
          figure.title = String(label).replace(/\s+/g, " ").trim().slice(0, 300);
          if (tag === "SVG") {
            const svgTitle = matchingElements(node, "title")[0];
            if (svgTitle) figure.title = collectText(svgTitle, doc).replace(/\s+/g, " ").trim().slice(0, 300) || figure.title;
          }
        }
        figure.caption = figureCaption(node, container, doc);
        const nearby = nearestAncestor(node, container, (element) =>
          ["FIGURE", "P", "LI", "SECTION", "DIV"].includes(tagOf(element)));
        figure.nearby = nearby ? collectText(nearby, doc).replace(/\s+/g, " ").trim().slice(0, 600) : "";
        figures.push(figure);
      }

      for (const child of childrenOf(node)) walk(child);
    }

    walk(container);
    return { sections, figures };
  }

  function normalizeBudget(value) {
    if (value === undefined) return DEFAULT_BUDGET;
    const budget = Number(value);
    return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : DEFAULT_BUDGET;
  }

  function truncateText(text, budget) {
    if (text.length <= budget) return { text, truncated: false };
    if (budget === 0) return { text: "", truncated: true };
    if (budget <= TRUNCATION_MARKER.length) {
      return { text: TRUNCATION_MARKER.trim().slice(0, budget), truncated: true };
    }

    const available = budget - TRUNCATION_MARKER.length;
    const headLength = Math.ceil(available / 2);
    const tailLength = Math.floor(available / 2);
    return {
      text: text.slice(0, headLength) + TRUNCATION_MARKER + text.slice(text.length - tailLength),
      truncated: true,
    };
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function namedError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function delayOrAbort(ms, signal, interrupted) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted || interrupted?.isSet?.()) {
        reject(namedError("AbortError", "懒加载材料化已取消。"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        interrupted?.removeListener?.(onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        interrupted?.removeListener?.(onAbort);
        reject(namedError("AbortError", "懒加载材料化已取消。"));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      interrupted?.addListener?.(onAbort);
    });
  }

  /**
   * Read-only lazy-load materialization. It only scrolls and restores the
   * original position; it never clicks, types, focuses, or mutates content.
   */
  async function materializeLazyContent(input = {}) {
    const view = input.window || (typeof window !== "undefined" ? window : null);
    const doc = input.document || view?.document ||
      (typeof document !== "undefined" ? document : null);
    const externalSignal = input.signal || null;
    const timeoutMs = numberOr(input.timeoutMs, LAZY_TIMEOUT_MS);
    const stepDelayMs = Math.min(
      numberOr(input.stepDelayMs, 80),
      MAX_LAZY_STEP_DELAY_MS,
    );
    const maxSteps = Math.max(1, Math.min(
      MAX_LAZY_STEPS,
      Math.floor(numberOr(input.maxSteps, 8)),
    ));
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    let interruption = null;
    const interruptListeners = new Set();
    const notifyInterruption = () => {
      for (const listener of interruptListeners) listener();
    };
    const interrupted = {
      addListener(listener) { interruptListeners.add(listener); },
      removeListener(listener) { interruptListeners.delete(listener); },
      isSet() { return Boolean(interruption); },
    };
    const onExternalAbort = () => {
      controller?.abort();
      if (interruption) return;
      interruption = namedError("AbortError", "懒加载材料化已取消。");
      notifyInterruption();
    };
    const onControllerAbort = () => {
      if (!interruption) {
        interruption = namedError("AbortError", "懒加载材料化已取消。");
        notifyInterruption();
      }
    };
    externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
    controller?.signal.removeEventListener?.("abort", onControllerAbort);
    controller?.signal.addEventListener?.("abort", onControllerAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();
    if (!externalSignal && controller?.signal.aborted) onControllerAbort();
    timer = setTimeout(() => {
      controller?.abort();
      interruption = namedError("TimeoutError", "懒加载材料化超时。");
      notifyInterruption();
    }, timeoutMs);

    const scrollingElement = doc?.scrollingElement || doc?.documentElement || doc?.body;
    const root = doc?.documentElement;
    const body = doc?.body;
    const original = {
      x: numberOr(view?.scrollX ?? doc?.defaultView?.scrollX, 0),
      y: numberOr(view?.scrollY ?? doc?.defaultView?.scrollY, 0),
    };
    const documentOriginal = {
      x: numberOr(scrollingElement?.scrollLeft, 0),
      y: numberOr(scrollingElement?.scrollTop, 0),
    };
    const viewportHeight = numberOr(
      view?.innerHeight ?? doc?.defaultView?.innerHeight,
      800,
    );
    const totalHeight = Math.max(
      numberOr(root?.scrollHeight, 0),
      numberOr(body?.scrollHeight, 0),
      numberOr(scrollingElement?.scrollHeight, 0),
      viewportHeight,
    );
    const bottom = Math.max(0, totalHeight - viewportHeight);
    const positions = [];
    for (let index = 0; index < maxSteps; index += 1) {
      const y = Math.min(
        bottom,
        Math.round(index * Math.max(1, viewportHeight * 0.85)),
      );
      if (!positions.includes(y)) positions.push(y);
    }
    if (!positions.includes(bottom)) positions.push(bottom);

    function restore() {
      try {
        if (typeof view?.scrollTo === "function") {
          view.scrollTo({ top: original.y, left: original.x, behavior: "auto" });
        } else if (scrollingElement) {
          scrollingElement.scrollTop = documentOriginal.y;
          scrollingElement.scrollLeft = documentOriginal.x;
          if (body && body !== scrollingElement) {
            body.scrollTop = documentOriginal.y;
            body.scrollLeft = documentOriginal.x;
          }
        }
      } catch (_) {
        // Navigation or a detached document can make restoration impossible.
      }
    }

    const run = (async () => {
      try {
        for (const top of positions) {
          if (interruption) throw interruption;
          if (typeof view?.scrollTo === "function") {
            view.scrollTo({ top, left: original.x, behavior: "auto" });
          } else if (scrollingElement) {
            scrollingElement.scrollTop = top;
            scrollingElement.scrollLeft = original.x;
          }
          await delayOrAbort(stepDelayMs, controller?.signal, interrupted);
          if (interruption) throw interruption;
        }
        return { steps: positions.length, positions, restored: true };
      } finally {
        restore();
        clearTimeout(timer);
        externalSignal?.removeEventListener?.("abort", onExternalAbort);
      }
    })();

    try {
      return await run;
    } catch (error) {
      if (interruption) throw interruption;
      throw error;
    }
  }

  function extractPageContent(maxBudgetOrOptions = DEFAULT_BUDGET, maybeOptions) {
    const options = maybeOptions && typeof maybeOptions === "object"
      ? normalizeExtractOptions({ ...maybeOptions, maxBudget: maxBudgetOrOptions })
      : normalizeExtractOptions(maxBudgetOrOptions);
    const doc = (maybeOptions && maybeOptions.document) ||
      (maxBudgetOrOptions && typeof maxBudgetOrOptions === "object" ? maxBudgetOrOptions.document : null) ||
      (typeof document !== "undefined" ? document : null);
    const title = doc && typeof doc.title === "string" ? doc.title : "";
    const url = doc && doc.location && typeof doc.location.href === "string"
      ? doc.location.href
      : "";
    const container = chooseContainer(doc);
    const text = container ? collectAriaAwareText(container, doc) : "";
    const structure = collectStructure(container, doc);
    const result = truncateText(text, options.budget);
    const output = {
      title,
      url,
      text: result.text,
      truncated: result.truncated,
      sections: structure.sections,
      figures: structure.figures,
    };
    if (options.includeStructure) {
      const semantics = collectSemanticStructure(container, doc, options.limits);
      output.structure = semantics;
      if (options.includeLinks) output.links = semantics.links;
    }
    return output;
  }

  return {
    extractPageContent,
    collectSemanticStructure,
    collectAriaAwareText,
    normalizeExtractOptions,
    materializeLazyContent,
  };
});
