(function (root) {
  "use strict";

  if (root.__unkAiAgentScanner?.version === 12) return;
  root.__unkAiAgentScanner?.removeOverlay?.();
  root.__unkAiAgentSnapshots?.clear();

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='combobox']",
    "[role='textbox']",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const MAX_SNAPSHOTS = 3;
  const MAX_ELEMENTS = 80;
  const MAX_SCROLL_CONTAINERS = 8;
  const MAX_READABLE_REGIONS = 6;
  const MAX_CANDIDATES = 6000;
  const readableNodes = new WeakMap();
  let observationCache = null;
  const nodeKeys = new WeakMap();
  const documentKey = Math.random().toString(36).slice(2, 10);
  let nodeSequence = 0;
  const MAX_SUMMARY = 1600;
  const MAX_NAME = 180;
  const MAX_SELECT_OPTIONS = 40;
  const MAX_SELECT_SELECTED = 10;
  const SELECT_SETTLE_MS = 120;
  const ELEMENT_SEMANTIC_FIELDS = 'tag role name text type autocomplete domId fieldName disabled contentEditable inputMode href targetOrigin targetBlank download formRole formAction formOrigin formIsSearch scrollOnly readable readOnly regionKind fileInput uploadOnly'.split(' ');
  const semanticValue = (key, value) => key === 'fileInput' && value
    ? { accept: value.accept || '', multiple: value.multiple === true, directory: value.directory === true,
      viaLabel: value.viaLabel === true, viaOverlay: value.viaOverlay === true } : value;
  const semanticSignature = value => JSON.stringify(Object.fromEntries(ELEMENT_SEMANTIC_FIELDS
    .filter(key => Object.prototype.hasOwnProperty.call(value || {}, key)).map(key => [key, semanticValue(key, value[key])])));
  const changedSemanticFields = (before, after) => ELEMENT_SEMANTIC_FIELDS.filter(key =>
    JSON.stringify(semanticValue(key, before?.[key])) !== JSON.stringify(semanticValue(key, after?.[key])));
  const CAPTCHA_HINT = /captcha|recaptcha|hcaptcha|验证码|人机验证|verify you are human|not a robot|安全验证/i;
  const LOGIN_HINT = /login|signin|sign-in|登录|登陆/i;
  const MONEY_HINT = /(?:[¥￥$€£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:元|美元|USD|CNY|credits?|积分))/i;
  const PERCENT_HINT = /\d+(?:\.\d+)?\s?%/;
  const STATUS_HINT = /(?:已启用|未启用|运行中|正常|异常|已禁用|已过期|过期|有效|无效|未确认|成功|失败)/;
  const OVERLAY_ID = "__unk_ai_agent_overlay";
  const OVERLAY_STYLE_ID = "__unk_ai_agent_overlay_style";
  const OVERLAY_EVENT = "__unk_ai_agent_takeover";
  const TAKEOVER_EVENTS = ["pointerdown", "click", "keydown", "wheel", "beforeinput", "input"];
  const cancelledTasks = new Map();
  const pendingSettlements = new Set();
  const uploadReceiptProbes = new Map();
  const uploadReceiptReads = new Set();
  let takeoverGuard = null;
  let overlayOwner = null;
  let performing = false;
  let releaseTakeoverClick = null;

  function text(value, max = MAX_NAME) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function safeStyle(element) {
    if (observationCache?.styles.has(element)) return observationCache.styles.get(element);
    try {
      const result = root.getComputedStyle ? root.getComputedStyle(element) : null;
      observationCache?.styles.set(element, result);
      return result;
    } catch {
      return null;
    }
  }

  function rectOf(element) {
    if (observationCache?.rects.has(element)) return observationCache.rects.get(element);
    const result = element.getBoundingClientRect();
    observationCache?.rects.set(element, result);
    return result;
  }

  function hiddenByAncestor(element) {
    let node = element;
    while (node && node.nodeType === 1) {
      if (node.getAttribute?.("aria-hidden") === "true") return true;
      node = parentOf(node);
    }
    return false;
  }

  function parentOf(element) {
    return element?.parentElement || element?.getRootNode?.()?.host || null;
  }

  function stableKey(element) {
    if (!nodeKeys.has(element)) nodeKeys.set(element, `${documentKey}:${++nodeSequence}`);
    return nodeKeys.get(element);
  }

  // Document hit tests stop at a shadow host. Descend only through the actual
  // hit host's open roots; never infer an inner hit from its host alone.
  function deepElementFromPoint(x, y) {
    let hit = root.document.elementFromPoint(x, y);
    const visited = new Set();
    while (hit?.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
      const shadow = hit.shadowRoot;
      if (visited.has(shadow) || visited.size >= 32) return null;
      visited.add(shadow);
      const inner = shadow.elementFromPoint(x, y);
      if (!inner) return null;
      if (inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function containsHit(element, hit) {
    for (let depth = 0; hit && depth < 32; depth++, hit = hit.getRootNode?.()?.host) {
      if (element.contains(hit)) return true;
    }
    return false;
  }

  function visibleRect(element) {
    let rect;
    try { rect = rectOf(element); } catch { return null; }
    if (!rect || rect.width < 4 || rect.height < 4) return null;
    if (!inViewport(rect)) return null;
    const clipped = { left: Math.max(0, rect.left), right: Math.min(root.innerWidth, rect.right),
      top: Math.max(0, rect.top), bottom: Math.min(root.innerHeight, rect.bottom) };
    let parent = parentOf(element);
    for (let depth = 0; parent && depth < 40; depth += 1, parent = parentOf(parent)) {
      const style = safeStyle(parent);
      if (!style) continue;
      let bounds;
      try { bounds = parent.getBoundingClientRect ? rectOf(parent) : null; } catch { continue; }
      if (!bounds) continue;
      if (/auto|scroll|hidden|clip|overlay/.test(style.overflowX || style.overflow || '')) {
        clipped.left = Math.max(clipped.left, bounds.left);
        clipped.right = Math.min(clipped.right, bounds.right);
      }
      if (/auto|scroll|hidden|clip|overlay/.test(style.overflowY || style.overflow || '')) {
        clipped.top = Math.max(clipped.top, bounds.top);
        clipped.bottom = Math.min(clipped.bottom, bounds.bottom);
      }
    }
    return clipped.right - clipped.left >= 2 && clipped.bottom - clipped.top >= 2 ? clipped : null;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    if (hiddenByAncestor(element)) return false;
    const style = safeStyle(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) return false;
    if (style && Number(style.opacity) === 0) return false;
    if (typeof element.checkVisibility === "function"
      && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    return Boolean(visibleRect(element));
  }

  function visibleAssociatedLabel(element, types) {
    if (element?.tagName?.toLowerCase() !== 'input' || !types.includes(element.type) || isVisible(element)) return null;
    const labels = element.labels;
    for (let index = 0; index < Math.min(Number(labels?.length) || 0, 8); index++) {
      const label = labels[index];
      if (label?.tagName?.toLowerCase() === 'label' && label.control === element && isVisible(label)
        && safeStyle(label)?.pointerEvents !== 'none') return label;
    }
    return null;
  }

  function visibleUploadLabel(element) { return visibleAssociatedLabel(element, ['file']); }
  function visibleChoiceLabel(element) { return visibleAssociatedLabel(element, ['checkbox', 'radio']); }

  // An opacity-zero native input can be the actual hit-testable upload surface.
  // Require a visible, named upload area and a meaningful hit-testable rectangle;
  // offscreen, display-none, 1px and pointer-events-none inputs stay unsupported.
  function transparentUploadArea(element, { requireUploadMeaning = true } = {}) {
    if (element?.tagName?.toLowerCase() !== 'input' || element.type !== 'file' || isVisible(element)
      || !element.isConnected || hiddenByAncestor(element)) return null;
    const style = safeStyle(element);
    if (!style || Number(style.opacity) !== 0 || style.display === 'none'
      || ['hidden', 'collapse'].includes(style.visibility) || style.pointerEvents === 'none') return null;
    const parent = parentOf(element);
    if (!parent || ['BODY', 'HTML'].includes(parent.tagName) || !isVisible(parent)) return null;
    const bounds = rectOf(element), area = rectOf(parent);
    if (!['left', 'right', 'top', 'bottom'].every(key => Number.isFinite(bounds[key]) && Number.isFinite(area[key]))
      || bounds.left < area.left - 1 || bounds.right > area.right + 1
      || bounds.top < area.top - 1 || bounds.bottom > area.bottom + 1) return null;
    const meaning = accessibleName(element) || accessibleName(parent);
    if (requireUploadMeaning && !/上传|参考图|图片|图像|upload|image|file/i.test(meaning)) return null;
    const clipped = visibleRect(element);
    if (!clipped || clipped.right - clipped.left < 24 || clipped.bottom - clipped.top < 24) return null;
    try {
      const top = deepElementFromPoint((clipped.left + clipped.right) / 2, (clipped.top + clipped.bottom) / 2);
      return top === element ? parent : null;
    } catch { return null; }
  }

  function observableTarget(element) {
    if (isVisible(element) || visibleUploadLabel(element) || visibleChoiceLabel(element) || transparentUploadArea(element)) return true;
    if (element?.tagName?.toLowerCase() === 'input' && element.type === 'file' && observationCache) {
      observationCache.metrics.uploadRequiresHandoff = true;
    }
    return false;
  }

  function scrollState(element = null) {
    const page = !element;
    const node = element || root.document.scrollingElement || root.document.documentElement;
    const style = page ? null : safeStyle(node);
    const clientHeight = Number(page ? root.innerHeight : node?.clientHeight) || 0;
    const clientWidth = Number(page ? root.innerWidth : node?.clientWidth) || 0;
    const vertical = page || /auto|scroll|overlay/.test(style?.overflowY || style?.overflow || '');
    const horizontal = page || /auto|scroll|overlay/.test(style?.overflowX || style?.overflow || '');
    const maxTop = vertical ? Math.max(0, (Number(node?.scrollHeight) || 0) - clientHeight) : 0;
    const maxLeft = horizontal ? Math.max(0, (Number(node?.scrollWidth) || 0) - clientWidth) : 0;
    if (!page && (!(maxTop > 1 || maxLeft > 1) || clientHeight < 4 || clientWidth < 4)) return null;
    const top = Math.round(Number(page ? root.scrollY : node.scrollTop) || 0);
    const left = Math.round(Number(page ? root.scrollX : node.scrollLeft) || 0);
    return { top, left, maxTop: Math.round(maxTop), maxLeft: Math.round(maxLeft),
      clientHeight, clientWidth,
      directions: [top > 1 && 'up', top < maxTop - 1 && 'down', left > 1 && 'left', left < maxLeft - 1 && 'right'].filter(Boolean) };
  }

  function regionFor(element) {
    let node = element;
    for (let depth = 0; node && depth < 40; depth += 1, node = parentOf(node)) {
      const role = node.getAttribute?.('role') || '';
      const tag = String(node.tagName || '').toLowerCase();
      const hint = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`;
      const region = role === 'navigation' || tag === 'nav' || /(?:^|[\s_-])(?:sidebar|toc|navigation)(?:$|[\s_-])/i.test(hint) ? 'navigation'
        : role === 'main' || tag === 'main' || tag === 'article' ? 'main'
          : role === 'toolbar' || tag === 'header' ? 'toolbar'
            : role === 'complementary' || tag === 'aside' ? 'complementary' : '';
      if (region) return { region, name: text(node.getAttribute?.('aria-label') || referencedText(node) || node.getAttribute?.('title'), 80) ||
        ({ navigation: '导航目录', main: '主正文', toolbar: '工具栏', complementary: '侧栏' })[region] };
    }
    return { region: 'content', name: '' };
  }

  function interactive(element) {
    if (typeof element.matches === 'function') return element.matches(INTERACTIVE_SELECTOR);
    return /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(element.tagName || '')
      || Boolean(element.isContentEditable) || Boolean(element.getAttribute?.('role'));
  }

  function navigationKind(href) {
    try {
      const target = new URL(href), current = new URL(root.location.href);
      const documentPart = url => {
        const route = /^#!?\//.test(url.hash) ? url.hash.replace(/^#!/, '#').split('?') : null;
        const params = new URLSearchParams(route?.[1] || '');
        params.delete('id');
        return `${url.origin}${url.pathname}${url.search}${route ? route[0] + (params.size ? '?' + params : '') : ''}`;
      };
      return target.href === current.href ? 'current_document'
        : documentPart(target) === documentPart(current) ? 'section' : 'document';
    } catch { return 'document'; }
  }

  function layoutOf(element, ids, visualTarget = element) {
    const region = regionFor(visualTarget);
    const rect = rectOf(visualTarget);
    const x = (rect.left + rect.width / 2) / Math.max(1, root.innerWidth);
    const y = (rect.top + rect.height / 2) / Math.max(1, root.innerHeight);
    let container = parentOf(visualTarget);
    while (container && (!ids.has(container) || !scrollState(container))) container = parentOf(container);
    const layout = { region: region.region, regionName: region.name,
      position: `${x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'center'}-${y < 0.34 ? 'top' : y > 0.66 ? 'bottom' : 'middle'}`,
      visible: Boolean(visibleRect(visualTarget)) };
    if (container && scrollState(container)) {
      layout.scrollContainerId = ids.get(container);
      layout.scrollContainerKey = stableKey(container);
    }
    const state = {};
    for (const name of ['expanded', 'selected']) {
      const value = element.getAttribute?.(`aria-${name}`);
      if (value === 'true' || value === 'false') state[name] = value === 'true';
    }
    for (const name of ['checked', 'pressed']) {
      const value = element.getAttribute?.(`aria-${name}`);
      if (value === 'true' || value === 'false' || value === 'mixed') state[name] = value === 'mixed' ? 'mixed' : value === 'true';
    }
    if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) {
      state.checked = element.type === 'checkbox' && element.indeterminate ? 'mixed' : Boolean(element.checked);
    }
    const current = element.getAttribute?.('aria-current');
    if (current && current !== 'false') state.current = text(current, 30);
    if (element.tagName === 'SUMMARY' && element.parentElement?.tagName === 'DETAILS') state.expanded = Boolean(element.parentElement.open);
    return { stableKey: stableKey(element), layout, ...(Object.keys(state).length ? { state } : {}),
      ...(scrollState(element) ? { scroll: scrollState(element) } : {}),
      ...(element.tagName === 'SELECT' ? { select: selectState(element) } : {}) };
  }

  function selectState(element) {
    const source = element.options || [];
    const optionCount = source.length;
    let truncated = optionCount > MAX_SELECT_OPTIONS;
    const describe = option => {
      const value = String(option.value ?? '');
      const label = String(option.text ?? option.label ?? '').replace(/\s+/g, ' ').trim();
      truncated ||= value.length > 160 || label.length > 160;
      return { value: value.slice(0, 160), text: label.slice(0, 160) };
    };
    const options = [];
    for (let index = 0; index < Math.min(optionCount, MAX_SELECT_OPTIONS); index++) {
      const option = source[index];
      options.push({ ...describe(option), selected: Boolean(option.selected),
        disabled: Boolean(option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled)) });
    }
    const selected = [];
    const selectedOptions = element.selectedOptions;
    if (selectedOptions) {
      for (let index = 0; index < Math.min(selectedOptions.length, MAX_SELECT_SELECTED); index++) selected.push(describe(selectedOptions[index]));
      truncated ||= selectedOptions.length > MAX_SELECT_SELECTED;
    } else {
      for (let index = 0; index < Math.min(optionCount, MAX_CANDIDATES); index++) {
        if (!source[index].selected) continue;
        if (selected.length < MAX_SELECT_SELECTED) selected.push(describe(source[index]));
        else truncated = true;
      }
      truncated ||= optionCount > MAX_CANDIDATES;
    }
    return { multiple: Boolean(element.multiple), optionCount, options, selected, truncated };
  }

  function labelsFor(element) {
    const values = [];
    if (element.labels && typeof element.labels[Symbol.iterator] === "function") {
      for (const label of element.labels) values.push(text(label.innerText || label.textContent));
    }
    const rootNode = element.getRootNode?.();
    const id = element.getAttribute?.("id");
    if (rootNode?.querySelector && id) {
      try {
        for (const label of rootNode.querySelectorAll(`label[for="${CSS.escape(id)}"]`)) {
          values.push(text(label.innerText || label.textContent));
        }
      } catch {
        // Ignore invalid selectors on unusual pages.
      }
    }
    return values.filter(Boolean);
  }

  function referencedText(element) {
    const ids = text(element.getAttribute?.("aria-labelledby"), 500).split(/\s+/).filter(Boolean);
    if (!ids.length) return "";
    const rootNode = element.getRootNode?.();
    return ids.map((id) => {
      try {
        return text(rootNode?.getElementById?.(id)?.innerText || "");
      } catch {
        return "";
      }
    }).filter(Boolean).join(" ");
  }

  function accessibleName(element) {
    const editable = /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable;
    const candidates = [
      element.getAttribute?.("aria-label"),
      referencedText(element),
      ...labelsFor(element),
      element.getAttribute?.("alt"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("title"),
      editable ? "" : element.innerText,
      editable ? "" : element.textContent,
    ];
    for (const candidate of candidates) {
      const value = text(candidate);
      if (value) return value;
    }
    return "";
  }

  function roleOf(element) {
    const explicit = text(element.getAttribute?.("role"), 40).toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = text(element.type, 30).toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "file") return "button";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return tag;
  }

  function absoluteUrl(value) {
    try {
      return new URL(String(value || ""), root.location.href).href;
    } catch {
      return "";
    }
  }

  function originOfUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "";
    } catch {
      return "";
    }
  }

  function formOf(element) {
    return element.form || element.closest?.("form") || null;
  }

  function metaOf(element, { checkOverlayMeaning = true } = {}) {
    const tag = element.tagName.toLowerCase();
    const uploadLabel = visibleUploadLabel(element);
    const choiceLabel = visibleChoiceLabel(element);
    const inputLabel = uploadLabel || choiceLabel;
    const uploadArea = transparentUploadArea(element, { requireUploadMeaning: checkOverlayMeaning });
    const readable = readableNodes.get(element);
    if (readable) return { tag, role: 'region', name: regionName(element, readable), text: '',
      readable: true, readOnly: true, regionKind: readable, disabled: false };
    const href = tag === "a" ? absoluteUrl(element.getAttribute("href")) : "";
    const form = formOf(element);
    const formAction = form ? absoluteUrl(element.getAttribute("formaction") || form.getAttribute("action") || "") : "";
    const inputType = ["input", "button"].includes(tag) ? text(element.type || "text", 30).toLowerCase() : "";
    const searchInput = Boolean(form?.querySelector?.("input[type='search']"));
    const scrollOnly = Boolean(scrollState(element)) && !interactive(element);
    return {
      tag,
      role: scrollOnly ? 'region' : roleOf(element),
      name: inputLabel ? accessibleName(inputLabel) : scrollOnly ? regionFor(element).name || '滚动区域'
        : accessibleName(element) || (uploadArea ? accessibleName(uploadArea) : ''),
      text: (scrollOnly || ["input", "textarea", "select"].includes(tag) || element.isContentEditable)
        ? "" : text(element.innerText || element.textContent, 180),
      type: inputType,
      autocomplete: text(element.getAttribute("autocomplete"), 80),
      domId: text(element.id, 80),
      fieldName: text(element.getAttribute("name"), 80),
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true"
        || inputLabel?.getAttribute?.('aria-disabled') === 'true' || uploadArea?.getAttribute?.('aria-disabled') === 'true',
      contentEditable: Boolean(element.isContentEditable),
      inputMode: text(element.getAttribute("inputmode"), 30),
      href,
      targetOrigin: originOfUrl(href),
      targetBlank: element.getAttribute("target") === "_blank" || form?.getAttribute("target") === "_blank",
      download: element.hasAttribute("download"),
      formRole: text(form?.getAttribute("role"), 40),
      formAction,
      formOrigin: originOfUrl(formAction),
      formIsSearch: form?.getAttribute("role") === "search" || searchInput,
      ...(tag === 'input' && inputType === 'file' ? { uploadOnly: true, fileInput: {
        accept: text(element.getAttribute('accept'), 200), multiple: element.multiple === true,
        viaLabel: Boolean(uploadLabel),
        viaOverlay: Boolean(uploadArea),
        directory: element.webkitdirectory === true || element.hasAttribute('webkitdirectory'),
        selectedFileCount: Math.min(1000, Number(element.files?.length) || 0),
        supported: typeof root.File === 'function' && typeof root.DataTransfer === 'function' && typeof root.atob === 'function'
          && typeof Object.getOwnPropertyDescriptor(root.HTMLInputElement?.prototype || {}, 'files')?.set === 'function',
      } } : {}),
      ...(scrollOnly ? { scrollOnly: true } : {}),
    };
  }

  function collectElements(limit = MAX_ELEMENTS) {
    const elements = [];
    const containers = [];
    const regions = [];
    const layoutCandidates = new Set();
    const seen = new Set();
    const visitedShadowRoots = new Set();
    let visited = 0;
    let layoutVisited = 0;
    let workTruncated = false;
    const inspectLayout = (host) => {
      const kind = readableKind(host);
      if (kind && isVisible(host)) {
        layoutCandidates.add(host);
        if (regions.length < 32) {
          readableNodes.set(host, kind);
          regions.push(host);
        }
      }
      if (host !== root.document.body && host !== root.document.documentElement
        && !host.closest?.('#' + OVERLAY_ID) && scrollState(host) && isVisible(host)) {
        layoutCandidates.add(host);
        if (containers.length < MAX_SCROLL_CONTAINERS) containers.push(host);
      }
      if (host.shadowRoot && !visitedShadowRoots.has(host.shadowRoot)) {
        visitedShadowRoots.add(host.shadowRoot);
        visit(host.shadowRoot);
      }
    };
    const visit = (scope) => {
      if (!scope?.querySelectorAll || visited >= MAX_CANDIDATES) return;
      // Browsers traverse candidates incrementally instead of materializing a
      // whole-document NodeList. The fallback is for limited DOM adapters.
      if (typeof root.document.createTreeWalker === 'function') {
        const walker = root.document.createTreeWalker(scope, 1);
        let host;
        while ((host = walker.nextNode())) {
          if (++layoutVisited > MAX_CANDIDATES) { workTruncated = true; break; }
          if (interactive(host)) {
            visited += 1;
            if (!seen.has(host) && !host.closest?.('#' + OVERLAY_ID)) {
              seen.add(host);
              if (observableTarget(host)) elements.push(host);
            }
          }
          inspectLayout(host);
        }
        return;
      }
      let nodes;
      try {
        nodes = scope.querySelectorAll(INTERACTIVE_SELECTOR);
      } catch {
        nodes = [];
      }
      for (const element of nodes) {
        visited += 1;
        if (visited > MAX_CANDIDATES) break;
        if (seen.has(element)) continue;
        seen.add(element);
        if (element.closest?.("#" + OVERLAY_ID)) continue;
        if (observableTarget(element)) elements.push(element);
      }
      let shadowHosts;
      try {
        shadowHosts = scope.querySelectorAll("*");
      } catch {
        shadowHosts = [];
      }
      for (const host of shadowHosts) {
        if (++layoutVisited > MAX_CANDIDATES) { workTruncated = true; break; }
        inspectLayout(host);
      }
    };
    visit(root.document);
    // Reserve entries for scroll targets, then share the remaining capacity
    // among page regions instead of letting a long first menu consume it all.
    const priority = node => ({ table: 100, cards: 70, list: 50, main: 10 })[readableNodes.get(node)] + Math.min(30, elementChildren(node).length);
    const mainRegion = regions.find(node => node.tagName === 'MAIN' || node.getAttribute?.('role') === 'main')
      || regions.find(node => readableNodes.get(node) === 'main');
    const selectedRegions = [...(mainRegion ? [mainRegion] : []), ...regions.filter(node => node !== mainRegion)
      .sort((a, b) => priority(b) - priority(a))].slice(0, MAX_READABLE_REGIONS);
    const result = [...new Set([...containers, ...selectedRegions])];
    const groups = new Map();
    for (const element of elements) {
      if (result.includes(element)) continue;
      const region = regionFor(element).region;
      if (!groups.has(region)) groups.set(region, []);
      groups.get(region).push(element);
    }
    while (result.length < limit && [...groups.values()].some(group => group.length)) {
      for (const group of groups.values()) {
        if (group.length && result.length < limit) result.push(group.shift());
      }
    }
    const selected = result.slice(0, limit);
    // This counts known, observed candidates omitted from the result. Nodes
    // beyond the work budget remain unknown and are covered by scanTruncated.
    const omittedCount = new Set([...elements, ...layoutCandidates]).size - selected.length;
    if (observationCache) Object.assign(observationCache.metrics, { candidateCount: new Set([...seen, ...layoutCandidates]).size,
      layoutNodeCount: Math.min(layoutVisited, MAX_CANDIDATES), omittedCount, candidateTruncated: omittedCount > 0,
      scanTruncated: workTruncated || visited > MAX_CANDIDATES || omittedCount > 0 });
    return selected;
  }

  function childrenOf(node) {
    return Array.from(node?.childNodes || node?.children || []);
  }

  function excludedTextNode(node) {
    const tag = String(node?.tagName || '').toUpperCase();
    if (/^(INPUT|TEXTAREA|SELECT|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|SVG|TITLE)$/.test(tag)) return true;
    const editable = node?.getAttribute?.('contenteditable') ?? node?.attributes?.contenteditable;
    if (node?.isContentEditable || (editable != null && editable !== 'false')) return true;
    if (node?.id === OVERLAY_ID || node?.id === OVERLAY_STYLE_ID || node?.hidden
      || node?.getAttribute?.('aria-hidden') === 'true') return true;
    const style = safeStyle(node);
    return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
      || (style?.opacity !== undefined && Number(style.opacity) === 0);
  }

  // Stop traversing once the output or work budget is reached. Never clone a
  // subtree or touch form values/innerText to build a short observation.
  function boundedText(node, maxChars = MAX_SUMMARY, maxNodes = 4000) {
    const stack = [node];
    let output = '', visited = 0, truncated = false;
    while (stack.length) {
      if (visited >= maxNodes || output.length >= maxChars) { truncated = true; break; }
      const current = stack.pop();
      if (!current) continue;
      if (typeof current === 'string') { output += current; continue; }
      visited += 1;
      const type = current.nodeType ?? 1;
      if (type === 3 || type === 4) {
        const raw = String(current.nodeValue ?? current.data ?? '').replace(/\s+/g, ' ');
        const remaining = maxChars - output.length;
        output += raw.slice(0, remaining);
        if (raw.length > remaining) truncated = true;
        continue;
      }
      if (type === 1 && excludedTextNode(current)) continue;
      const children = childrenOf(current);
      const block = /^(P|DIV|SECTION|ARTICLE|MAIN|LI|TR|TH|TD|H[1-6]|UL|OL|BR)$/.test(current.tagName || '');
      if (block && output && !output.endsWith('\n')) output += '\n';
      if (children.length) {
        if (block) stack.push('\n');
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
      } else if (!('childNodes' in current) && typeof current.textContent === 'string') {
        // Minimal DOM adapters can supply leaf text without Text nodes.
        const raw = current.textContent.replace(/\s+/g, ' ');
        const remaining = maxChars - output.length;
        output += raw.slice(0, remaining);
        if (raw.length > remaining) truncated = true;
      }
    }
    return { text: output.slice(0, maxChars).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), truncated, visited };
  }

  function readOnlyText(node, maxChars = MAX_SUMMARY) { return boundedText(node, maxChars).text; }

  function elementChildren(node) { return childrenOf(node).filter(child => (child.nodeType ?? 1) === 1); }

  function meaningfulName(value) {
    const label = String(value || '').trim();
    return label.length > 0 && label.length <= 160 && /[\p{L}]/u.test(label)
      && !/^(?:暂无数据|未知|N\/?A|null|undefined|详情|展开|收起|点击|查看|信用分|评分|缓存命中率|输入价格|输出价格|价格|rank|index|details?|view|expand|collapse)(?:\b|\s|[:：]|$)/i.test(label);
  }

  function visibleTextLeaves(node, maxNodes = 200) {
    return descendants(node, maxNodes).nodes.filter(child => {
      if (elementChildren(child).length) return false;
      for (let ancestor = child; ancestor && ancestor !== node; ancestor = parentOf(ancestor)) {
        if (ancestor.tagName === 'BUTTON' || ancestor.getAttribute?.('role') === 'button' || excludedTextNode(ancestor)) return false;
      }
      return Boolean(readOnlyText(child, 161));
    });
  }

  function blockLinkCard(node) {
    if (node.tagName !== 'A' || !node.getAttribute?.('href')) return false;
    const children = elementChildren(node);
    const block = /^(?:block|flex|grid|inline-block|inline-flex|inline-grid)$/.test(safeStyle(node)?.display || '')
      || children.some(child => /^(DIV|SECTION|ARTICLE)$/.test(child.tagName || ''));
    // A normal menu link has one label, perhaps with an icon. Require a
    // compound block and at least three independently rendered text fields.
    return block && children.length > 0 && visibleTextLeaves(node, 160).length >= 3;
  }

  function repeatedChildren(node) {
    const groups = new Map();
    for (const child of elementChildren(node).slice(0, 1000)) {
      if (excludedTextNode(child)) continue;
      const ordinaryCard = /^(DIV|SECTION|ARTICLE|LI)$/.test(child.tagName || '') && elementChildren(child).length >= 2;
      if (!ordinaryCard && !blockLinkCard(child)) continue;
      const key = `${child.tagName}:${String(typeof child.className === 'string' ? child.className : '').split(/\s+/).slice(0, 3).join('.')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(child);
    }
    return [...groups.values()].filter(group => group.length >= 3).sort((a, b) => b.length - a.length)[0] || [];
  }

  function readableKind(node) {
    if (!node?.tagName || node.closest?.('nav, header, [role="navigation"], #' + OVERLAY_ID) || excludedTextNode(node)) return '';
    const tag = node.tagName.toLowerCase(), role = node.getAttribute?.('role');
    if (tag === 'table' || role === 'table' || role === 'grid') return 'table';
    if (tag === 'ul' || tag === 'ol' || role === 'list') return 'list';
    if (tag === 'main' || tag === 'article' || role === 'main') return 'main';
    if ((tag === 'div' || tag === 'section') && repeatedChildren(node).length >= 3) return 'cards';
    return '';
  }

  function regionName(node, kind) {
    const explicit = text(node.getAttribute?.('aria-label') || node.getAttribute?.('title'), 100);
    const heading = node.querySelector?.('h1, h2, h3, caption');
    return explicit || readOnlyText(heading, 100) || ({ table: '数据表格', list: '列表内容', cards: '重复卡片列表', main: '主内容区域' })[kind] || '页面区域';
  }

  function descendants(node, maxNodes = 6000) {
    const result = [], stack = [...elementChildren(node)].reverse();
    let visited = 0;
    while (stack.length && visited < maxNodes) {
      const current = stack.pop(); visited += 1;
      if (excludedTextNode(current)) continue;
      result.push(current);
      for (const child of elementChildren(current).reverse()) stack.push(child);
    }
    return { nodes: result, truncated: stack.length > 0, visited };
  }

  function readRegion(snapshotId, elementId, expected = {}) {
    const started = root.performance?.now?.() ?? Date.now();
    const verifyRegion = () => {
      if (Date.now() >= expected.expiresAt) return { error: 'ERR_PAGE_READ_TIMEOUT' };
      const snapshot = root.__unkAiAgentSnapshots?.get(snapshotId);
      if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch) return { error: 'ERR_SNAPSHOT_EXPIRED' };
      if (root.location.href !== expected.frameUrl || snapshot.url !== expected.frameUrl) return { error: 'ERR_PAGE_CHANGED' };
      const record = snapshot.get(elementId);
      if (!record?.meta.readable || !record.meta.readOnly) return { error: 'ERR_REGION_INVALID' };
      if (!record.element.isConnected || hiddenByAncestor(record.element) || excludedTextNode(record.element)) return { error: 'ERR_ELEMENT_DETACHED' };
      for (let ancestor = parentOf(record.element); ancestor; ancestor = parentOf(ancestor)) {
        if (excludedTextNode(ancestor)) return { error: 'ERR_REGION_INVALID' };
      }
      return { record };
    };
    const initial = verifyRegion();
    if (initial.error) return initial;
    const region = initial.record.element;
    const query = String(expected.query || '').trim();
    if (query.length > 80) return { error: 'ERR_ACTION_INVALID' };
    const collection = descendants(region);
    const queryTerms = query.toLocaleLowerCase().split(/[\s,，、;；]+/).filter(Boolean);
    const matchesQuery = value => queryTerms.every(term => String(value || '').toLocaleLowerCase().includes(term));
    let source = region, sourceKind = initial.record.meta.regionKind;
    if (sourceKind === 'main') {
      const choices = collection.nodes.map(node => ({ node, kind: readableKind(node) }))
        .filter(choice => ['table', 'list', 'cards'].includes(choice.kind)).slice(0, 32);
      const matching = choices.map(choice => ({ ...choice, matched: matchesQuery(readOnlyText(choice.node, 6000)) }))
        .filter(choice => choice.matched)
        .sort((a, b) => elementChildren(b.node).length - elementChildren(a.node).length);
      if (matching.length) { source = matching[0].node; sourceKind = matching[0].kind; }
    }
    const table = sourceKind === 'table' ? source : null;
    let rowNodes = [], headers = [];
    if (table) {
      const tableNodes = table === region ? collection.nodes : descendants(table).nodes;
      const tableRows = tableNodes.filter(node => node.tagName === 'TR' || node.getAttribute?.('role') === 'row');
      const headerRow = tableRows.find(row => elementChildren(row).some(cell => cell.tagName === 'TH' || cell.getAttribute?.('role') === 'columnheader'));
      if (headerRow) headers = elementChildren(headerRow).map(cell => readOnlyText(cell, 160));
      rowNodes = tableRows.filter(row => row !== headerRow);
    } else {
      rowNodes = sourceKind === 'list' ? elementChildren(source).filter(node => node.tagName === 'LI' || node.getAttribute?.('role') === 'listitem')
        : sourceKind === 'cards' ? repeatedChildren(source) : [];
    }
    rowNodes = rowNodes.filter(node => !excludedTextNode(node));
    const totalRows = rowNodes.length;
    const rows = [];
    let remaining = 32000, truncated = collection.truncated || rowNodes.length > 200, visited = collection.visited;
    for (const row of rowNodes.slice(0, 200)) {
      if (remaining <= 0) { truncated = true; break; }
      const body = boundedText(row, Math.min(800, remaining), 1500);
      visited += body.visited; truncated ||= body.truncated;
      if (!body.text) continue;
      let label = '';
      const result = { label: '', text: body.text, truncated: body.truncated };
      if (table) {
        result.cells = elementChildren(row).filter(cell => /^(TD|TH)$/.test(cell.tagName) || ['cell', 'gridcell', 'rowheader'].includes(cell.getAttribute?.('role')))
          .slice(0, 30).map((cell, index) => {
            const value = boundedText(cell, 400, 1000);
            result.truncated ||= value.truncated;
            return { label: headers[index] || '', text: value.text };
          });
        const identityColumn = headers.findIndex(header => /商家|供应商|店铺|名称|(?:^|\b)(?:name|merchant|provider|vendor)(?:\b|$)/i.test(header));
        const candidate = identityColumn >= 0 ? result.cells[identityColumn] : result.cells.find((cell, index) =>
          !/排名|序号|排行|序列|^(?:rank|index|no\.?|#)$/i.test(headers[index] || '') && meaningfulName(cell.text));
        label = meaningfulName(candidate?.text) ? candidate.text : '';
        if (label) result.labelSource = identityColumn >= 0 ? 'table-header' : 'table-cell';
      } else {
        const nodes = descendants(row, 200).nodes;
        const heading = nodes.find(node => /^H[1-4]$/.test(node.tagName) && meaningfulName(readOnlyText(node, 161)));
        const explicit = row.getAttribute?.('aria-label') || referencedText(row);
        const link = nodes.find(node => node.tagName === 'A' && node.getAttribute?.('href') && meaningfulName(readOnlyText(node, 161)));
        const leaf = visibleTextLeaves(row).find(node => meaningfulName(readOnlyText(node, 161)));
        const identity = heading || (!meaningfulName(explicit) ? link || leaf : null);
        const identityText = boundedText(identity, 160);
        label = heading ? identityText.text : meaningfulName(explicit) ? explicit : identityText.text;
        result.truncated ||= identityText.truncated;
        if (label) result.labelSource = heading ? 'heading' : meaningfulName(explicit) ? 'aria-label' : link ? 'link' : 'visible-text';
      }
      result.label = text(label, 160);
      // Include duplicated cell/label text in the transport budget as well.
      let cost = result.text.length + result.label.length + (result.cells || []).reduce((sum, cell) => sum + cell.label.length + cell.text.length, 0);
      if (cost > remaining) { delete result.cells; result.text = result.text.slice(0, Math.max(0, remaining - result.label.length)); cost = result.text.length + result.label.length; result.truncated = true; }
      truncated ||= result.truncated;
      if (!result.text) { truncated = true; break; }
      remaining -= cost; rows.push(result);
    }
    const queryMatched = matchesQuery(headers.join(' ') + '\n' + rows.map(row => row.text).join('\n'));
    if (!queryMatched) rows.length = 0;
    const body = rows.length ? { text: '', truncated: false, visited: 0 } : boundedText(region, 16000, 6000);
    visited += body.visited; truncated ||= body.truncated;
    const after = verifyRegion();
    if (after.error) return after;
    return { ok: true, regionReading: { url: expected.pageUrl, frameUrl: root.location.href, title: root.document.title || '',
      capturedAt: new Date().toISOString(), regionId: expected.regionId, regionKey: stableKey(region), query,
      text: body.text, rows, truncated, totalRows, queryMatched,
      ...(!queryMatched ? { notice: '提供的区域数据中未定位到请求字段；未提供可用于排名的数据行。' } : {}) },
      metrics: { readMs: Math.max(0, (root.performance?.now?.() ?? Date.now()) - started), visitedNodeCount: visited, returnedRowCount: rows.length } };
  }

  function pageSummary() {
    const document = root.document;
    const bodyText = readOnlyText(document.body)
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter((node) => !node.closest?.("[contenteditable]:not([contenteditable='false'])"))
      .slice(0, 12)
      .map((heading) => text(heading.innerText || heading.textContent, 160))
      .filter(Boolean);
    const description = text(document.querySelector("meta[name='description']")?.getAttribute("content"), 300);
    const facts = [];
    const factPairs = [];
    const pushFact = (value) => {
      const raw = String(value || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 240) return;
      const line = raw;
      if (!line || facts.includes(line)) return;
      facts.push(line);
    };
    const factNodes = descendants(document.body, 1600).nodes;
    for (const node of factNodes) {
      if (facts.length >= 16) break;
      if (node.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) continue;
      if (!node.childElementCount) {
        const value = readOnlyText(node, 240);
        if (value && (MONEY_HINT.test(value) || PERCENT_HINT.test(value) || STATUS_HINT.test(value))) {
          pushFact(value);
          const parentText = text(readOnlyText(node.parentElement), 240);
          if (parentText && parentText !== value) factPairs.push(parentText);
        }
      }
    }
    const summary = [
      description,
      headings.length ? `标题结构：${headings.join(" / ")}` : "",
      facts.length
        ? `关键数据：${[...new Set([...factPairs, ...facts])].slice(0, 12).join("；").slice(0, 1200)}`
        : "",
      bodyText.slice(0, MAX_SUMMARY),
    ].filter(Boolean).join("\n\n").slice(0, MAX_SUMMARY);
    const passwordFields = Array.from(document.querySelectorAll("input[type='password']"))
      .filter((input) => isVisible(input)).length;
    const pageText = `${document.title || ""} ${bodyText}`;
    return {
      summary,
      viewport: { width: root.innerWidth || 0, height: root.innerHeight || 0 },
      scroll: scrollState(),
      ...mainContent(),
      scrollY: Math.round(root.scrollY || 0),
      pageHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
      flags: {
        passwordField: passwordFields > 0,
        captcha: CAPTCHA_HINT.test(pageText),
        login: passwordFields > 0 && (LOGIN_HINT.test(document.title || "") || LOGIN_HINT.test(root.location.href)),
        uploadRequiresHandoff: observationCache?.metrics.uploadRequiresHandoff === true,
      },
    };
  }

  function mainContent() {
    const main = root.document.querySelector('main, article, [role="main"], .markdown-section');
    if (!main) return {};
    const heading = main.querySelector?.('h1, h2') || null;
    return { content: { heading: text(heading?.innerText || heading?.textContent, 180), text: text(readOnlyText(main), 1200) } };
  }

  function pruneSnapshots() {
    while (root.__unkAiAgentSnapshots.size >= MAX_SNAPSHOTS) {
      const oldest = root.__unkAiAgentSnapshots.keys().next().value;
      root.__unkAiAgentSnapshots.delete(oldest);
    }
  }

  function scan(snapshotId, options = {}) {
    if (!snapshotId || typeof snapshotId !== "string") {
      return { error: "ERR_SNAPSHOT_INVALID", message: "缺少快照 ID。" };
    }
    if (!enableTakeoverGuard(options.taskId, options.epoch)) {
      return { error: "ERR_TASK_PAUSED", message: "任务已暂停，请确认后继续。" };
    }
    const limit = Math.min(MAX_ELEMENTS, Math.max(1, Number(options.maxElements) || MAX_ELEMENTS));
    const started = root.performance?.now?.() ?? Date.now();
    observationCache = { styles: new WeakMap(), rects: new WeakMap(), metrics: {} };
    try {
    const found = collectElements(limit);
    const ids = new Map(found.map((element, index) => [element, `e${index + 1}`]));
    const records = new Map();
    records.taskId = String(options.taskId || "");
    records.epoch = options.epoch;
    records.url = root.location.href;
      records.createdAt = Date.now();
    const elements = [];
    let index = 0;
    for (const element of found) {
      index += 1;
      const id = `e${index}`;
      const meta = metaOf(element);
      const uploadAnchor = visibleUploadLabel(element);
      const choiceAnchor = visibleChoiceLabel(element);
      const fileOverlayParent = transparentUploadArea(element);
      const visualTarget = uploadAnchor || choiceAnchor || element;
      let bounds;
      try {
        const rect = rectOf(visualTarget);
        bounds = {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      } catch {
        bounds = null;
      }
      records.set(id, { element, meta, bounds, ...(uploadAnchor ? { uploadAnchor,
        uploadAnchorSignature: semanticSignature(metaOf(uploadAnchor)) } : {}),
        ...(choiceAnchor ? { choiceAnchor, choiceAnchorSignature: semanticSignature(metaOf(choiceAnchor)) } : {}),
        ...(fileOverlayParent ? { fileOverlayParent,
          fileOverlayAnchorSignature: semanticSignature(metaOf(fileOverlayParent)) } : {}) });
      elements.push({ id, ...meta, ...layoutOf(element, ids, visualTarget),
        ...(bounds ? { rect: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } } : {}),
        ...(meta.href ? { navigation: { kind: navigationKind(meta.href) } } : {}) });
    }
    if (!root.__unkAiAgentSnapshots) root.__unkAiAgentSnapshots = new Map();
    pruneSnapshots();
    root.__unkAiAgentSnapshots.set(snapshotId, records);
    const summary = pageSummary();
    return {
      snapshotId,
      isTop: root.top === root,
      url: root.location.href,
      title: root.document.title || "",
      elements,
      ...summary,
      metrics: { ...observationCache.metrics, returnedCount: elements.length,
        scanMs: Math.max(0, (root.performance?.now?.() ?? Date.now()) - started) },
    };
    } finally { observationCache = null; }
  }

  function recordFor(snapshotId, elementId) {
    const snapshot = root.__unkAiAgentSnapshots?.get(snapshotId);
    if (!snapshot) return { error: "ERR_SNAPSHOT_EXPIRED", message: "页面快照已过期，请重新观察。" };
    const record = snapshot.get(elementId);
    if (!record || !record.element) return { error: "ERR_ELEMENT_NOT_FOUND", message: "目标元素不在当前快照中。" };
    return { record };
  }

  function sameOwner(owner, taskId, epoch) {
    return owner && (!taskId || owner.taskId === taskId) && (epoch === undefined || owner.epoch === epoch);
  }

  function removeTakeoverGuard(taskId, epoch) {
    if (!sameOwner(takeoverGuard, taskId, epoch)) return;
    for (const name of TAKEOVER_EVENTS) root.removeEventListener?.(name, takeoverGuard.handler, true);
    takeoverGuard = null;
  }

  function blockTakeoverEvent(event) {
    if (event.cancelable !== false) event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  // A pointerdown cancellation alone does not suppress its later browser click.
  function suppressTakeoverClick(pointerdown) {
    releaseTakeoverClick?.();
    let timer;
    const matchesPointer = (event) => !Number.isFinite(pointerdown.pointerId)
      || !Number.isFinite(event.pointerId) || event.pointerId === pointerdown.pointerId;
    const release = () => {
      root.clearTimeout?.(timer);
      root.removeEventListener?.("pointerup", swallow, true);
      root.removeEventListener?.("click", swallow, true);
      root.removeEventListener?.("pointercancel", interrupted, true);
      root.removeEventListener?.("blur", interrupted, true);
      if (releaseTakeoverClick === release) releaseTakeoverClick = null;
    };
    const interrupted = (event) => {
      if (event.isTrusted && (event.type === "blur" ? event.target === root : matchesPointer(event))) release();
    };
    const swallow = (event) => {
      if (!event.isTrusted || !matchesPointer(event)) return;
      blockTakeoverEvent(event);
      if (event.type === "click") release();
      else {
        // Long presses remain protected until release; only the missing-click
        // tail needs a deadline after pointerup has actually arrived.
        root.clearTimeout?.(timer);
        timer = root.setTimeout?.(release, 1200);
      }
    };
    root.addEventListener?.("pointerup", swallow, { capture: true, passive: false });
    root.addEventListener?.("click", swallow, { capture: true, passive: false });
    root.addEventListener?.("pointercancel", interrupted, true);
    root.addEventListener?.("blur", interrupted, true);
    releaseTakeoverClick = release;
  }

  function enableTakeoverGuard(taskId = "", epoch = 0) {
    taskId = String(taskId || "");
    if (!taskId) return true;
    if (cancelledTasks.has(taskId) && epoch <= cancelledTasks.get(taskId)) return false;
    if (sameOwner(takeoverGuard, taskId, epoch)) return true;
    if (takeoverGuard?.taskId === taskId && takeoverGuard.epoch > epoch) return false;
    removeTakeoverGuard();
    const handler = (event) => {
      if (!event.isTrusted || performing) return;
      const reason = event.type === "wheel" ? "user-scrolled-page"
        : event.type === "keydown" ? "user-typed-page"
          : ["beforeinput", "input"].includes(event.type) ? "user-edited-page" : "user-clicked-page";
      blockTakeoverEvent(event);
      if (event.type === "pointerdown") suppressTakeoverClick(event);
      cancelTask(taskId, epoch); // Revoke local action targets before asynchronous messaging.
      try {
        if (root.CustomEvent) root.dispatchEvent?.(new root.CustomEvent(OVERLAY_EVENT, { detail: { taskId, reason } }));
      } catch { /* Browser messaging below is the authoritative notification. */ }
      try {
        root.chrome?.runtime?.sendMessage?.({ type: "AGENT_TAKEOVER", taskId, reason }).catch?.(() => {});
      } catch { /* A disconnected extension must not restore revoked snapshots. */ }
    };
    takeoverGuard = { taskId, epoch, handler };
    for (const name of TAKEOVER_EVENTS) root.addEventListener?.(name, handler, { capture: true, passive: false });
    return true;
  }

  function cancelTask(taskId, epoch) {
    let cancelledEpoch = epoch;
    if (sameOwner(takeoverGuard, taskId, epoch)) cancelledEpoch ??= takeoverGuard.epoch;
    for (const [id, snapshot] of root.__unkAiAgentSnapshots || []) {
      if (sameOwner(snapshot, taskId, epoch)) {
        cancelledEpoch = Math.max(Number(cancelledEpoch) || 0, Number(snapshot.epoch) || 0);
        root.__unkAiAgentSnapshots.delete(id);
      }
    }
    if (Number.isFinite(cancelledEpoch)) cancelledTasks.set(taskId, Math.max(cancelledTasks.get(taskId) ?? -1, cancelledEpoch));
    for (const pending of pendingSettlements) if (sameOwner(pending, taskId, epoch)) pending.finish();
    for (const [id, probe] of uploadReceiptProbes) if (sameOwner(probe, taskId, epoch)) uploadReceiptProbes.delete(id);
    for (const read of uploadReceiptReads) if (sameOwner(read, taskId, epoch)) read.controller.abort();
    removeOverlay(taskId, epoch);
    return { ok: true };
  }

  function inspect(snapshotId, elementId, { checkOverlayMeaning = true } = {}) {
    const failure = result => {
      const trace = { stage: 'inspect', stages: [] };
      traceStage(trace, 'inspect', root.__unkAiAgentSnapshots?.get(snapshotId)?.get(elementId)?.element);
      return diagnosticResult(result, trace);
    };
    if (!root.__unkAiAgentSnapshots?.has(snapshotId)) return failure({ error: "ERR_SNAPSHOT_EXPIRED", message: "页面快照已过期。" });
    let element = root.document.activeElement;
    if (elementId) {
      const found = verify(snapshotId, elementId, { ignoreMoved: true, checkOverlayMeaning });
      if (found.error) return failure(found);
      element = found.record.element;
    }
    const meta = element?.tagName ? metaOf(element, { checkOverlayMeaning }) : {};
    return { meta, signature: semanticSignature(meta), url: root.location.href };
  }

  function inViewport(rect) {
    return rect.bottom > 0 && rect.top < root.innerHeight && rect.right > 0 && rect.left < root.innerWidth;
  }

  function verify(snapshotId, elementId, { editable = false, ignoreMoved = false, checkOverlayMeaning = true } = {}) {
    const found = recordFor(snapshotId, elementId);
    if (found.error) return found;
    const { record } = found;
    const element = record.element;
    if (!element.isConnected) return { error: "ERR_ELEMENT_DETACHED", message: "目标元素已从页面移除，请重新观察。" };
    const visualTarget = record.uploadAnchor || record.choiceAnchor || element;
    if (record.uploadAnchor && (visibleUploadLabel(element) !== record.uploadAnchor
      || semanticSignature(metaOf(record.uploadAnchor)) !== record.uploadAnchorSignature)) {
      return { error: 'ERR_ELEMENT_CHANGED', message: '上传标签的关联、可见性或含义已变化，请重新观察并确认。' };
    }
    if (record.choiceAnchor && (visibleChoiceLabel(element) !== record.choiceAnchor
      || semanticSignature(metaOf(record.choiceAnchor)) !== record.choiceAnchorSignature)) {
      return { error: 'ERR_ELEMENT_CHANGED', message: '选项标签的关联、可见性或含义已变化，请重新观察并确认。' };
    }
    if (record.fileOverlayParent && (transparentUploadArea(element, { requireUploadMeaning: checkOverlayMeaning }) !== record.fileOverlayParent
      || (checkOverlayMeaning && semanticSignature(metaOf(record.fileOverlayParent)) !== record.fileOverlayAnchorSignature))) {
      return { error: 'ERR_ELEMENT_CHANGED', message: '透明上传区域的归属、可见性或命中目标已变化，请重新观察并确认。' };
    }
    if (!isVisible(visualTarget) && !record.fileOverlayParent) return { error: "ERR_ELEMENT_NOT_FOUND", message: "目标元素当前不可见，请重新观察。" };
    if (element.disabled || element.getAttribute?.("aria-disabled") === "true"
      || visualTarget.getAttribute?.('aria-disabled') === 'true' || record.fileOverlayParent?.getAttribute?.('aria-disabled') === 'true') {
      return { error: "ERR_ELEMENT_DISABLED", message: "目标元素当前不可用。" };
    }
    if (editable && element.tagName?.toLowerCase() === "input" && element.type === "password") {
      return { error: "ERR_CREDENTIAL_BLOCKED", message: "密码字段不允许自动输入。" };
    }
    let rect;
    try {
      rect = visualTarget.getBoundingClientRect();
    } catch {
      return { error: "ERR_ELEMENT_NOT_FOUND", message: "无法读取目标元素位置。" };
    }
    if (!rect || rect.width < 2 || rect.height < 2) {
      return { error: "ERR_ELEMENT_NOT_FOUND", message: "目标元素尺寸异常，请重新观察。" };
    }
    if (!ignoreMoved && record.bounds && inViewport(rect)) {
      const moved = Math.hypot(
        (rect.left + rect.width / 2) - record.bounds.x,
        (rect.top + rect.height / 2) - record.bounds.y,
      );
      if (moved > 8) {
        return { error: "ERR_ELEMENT_MOVED", message: "页面布局已变化，请重新观察后再操作。" };
      }
    }
    return { record, rect };
  }

  function verifyAfterScroll(snapshotId, elementId, { editable = false } = {}) {
    const found = verify(snapshotId, elementId, { editable, ignoreMoved: true });
    if (found.error) return found;
    const element = found.record.choiceAnchor || found.record.element;
    try {
      element.scrollIntoView({ block: "center", inline: "center" });
    } catch {
      // Some elements reject scrollIntoView; the hit test below decides.
    }
    // Scrolling can synchronously replace or relink a styled native control.
    const current = verify(snapshotId, elementId, { editable, ignoreMoved: true });
    if (current.error) return current;
    const rect = element.getBoundingClientRect?.();
    if (!rect || !inViewport(rect)) {
      return { error: "ERR_ELEMENT_OCCLUDED", message: "目标元素不在可点击区域。" };
    }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    let top;
    try {
      top = deepElementFromPoint(x, y);
    } catch {
      top = null;
    }
    if (!top || (!containsHit(element, top) && (found.record.choiceAnchor || !top.contains(element)))) {
      return { error: "ERR_ELEMENT_OCCLUDED", message: "目标元素被其他元素遮挡。" };
    }
    return { record: found.record, rect };
  }

  function setNativeValue(element, value) {
    const tag = element.tagName.toLowerCase();
    const prototype = tag === 'select' ? root.HTMLSelectElement?.prototype
      : tag === "textarea" ? root.HTMLTextAreaElement?.prototype : root.HTMLInputElement?.prototype;
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatchInput(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function traceStage(trace, stage, element, fields = {}) {
    try {
      trace.stage = stage;
      if (trace.stages.length >= 16) return;
      const tag = String(element?.tagName || '').toLowerCase();
      const inputType = String(element?.type || '').toLowerCase();
      trace.stages.push({ stage,
        ...(['input', 'textarea', 'select', 'button', 'div', 'span'].includes(tag) ? { tag } : {}),
        ...(['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'hidden', 'file', 'button', 'submit'].includes(inputType) ? { inputType } : {}),
        ...(element ? { connected: element.isConnected === true,
          readOnly: element.readOnly === true || element.getAttribute?.('aria-readonly') === 'true',
          disabled: element.disabled === true || element.getAttribute?.('aria-disabled') === 'true',
          focused: root.document.activeElement === element } : {}),
        ...fields });
    } catch { /* Metadata collection cannot prevent or repeat the action. */ }
  }

  function diagnosticResult(result, trace) {
    try {
      return { ...result, diagnostics: { version: 1, stages: trace.stages,
        ...(trace.executionStatus ? { executionStatus: trace.executionStatus } : {}),
        ...(Number.isFinite(trace.snapshotAgeMs) ? { snapshotAgeMs: trace.snapshotAgeMs } : {}),
        ...(trace.changedFields?.length ? { changedFields: trace.changedFields } : {}),
        ...(result?.error || result?.ok === false ? { failureStage: trace.stage,
          ...(trace.errorName ? { errorName: trace.errorName } : {}) } : {}) } };
    } catch { return result; }
  }

  function traceFailure(trace, error) {
    try {
      if (['Error', 'TypeError', 'InvalidStateError', 'NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error?.name)) trace.errorName = error.name;
    } catch { /* Never retain an external exception message. */ }
  }

  function performClick(snapshotId, elementId, trace) {
    const found = verify(snapshotId, elementId);
    if (found.error) return found;
    const element = found.record.element;
    const visualTarget = found.record.choiceAnchor || element;
    try {
      visualTarget.scrollIntoView({ block: "center", inline: "center" });
    } catch {
      // Best effort; click still works for programmatically focusable nodes.
    }
    const verified = verifyAfterScroll(snapshotId, elementId);
    if (verified.error) return verified;
    try {
      if (!verified.record.choiceAnchor) verified.record.element.focus?.({ preventScroll: true });
    } catch {
      // Focus is best effort.
    }
    trace.executionStatus = 'started';
    (verified.record.choiceAnchor || verified.record.element).click();
    return {
      ok: true,
      message: `已点击「${verified.record.meta.name || '目标元素'}」`,
      url: root.location.href,
      title: root.document.title || "",
    };
  }

  function performType(snapshotId, elementId, args, trace) {
    traceStage(trace, 'target', root.__unkAiAgentSnapshots?.get(snapshotId)?.get(elementId)?.element);
    const found = verifyAfterScroll(snapshotId, elementId, { editable: true });
    if (found.error) return found;
    const element = found.record.element;
    try {
      element.focus?.({ preventScroll: true });
    } catch {
      // Best effort.
    }
    traceStage(trace, 'focus', element, { visible: true });
    const value = String(args.text ?? "");
    if (element.isContentEditable) {
      try {
        traceStage(trace, 'select', element);
        const selection = root.getSelection?.();
        const range = root.document.createRange?.();
        if (selection && range) {
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        traceStage(trace, 'set', element, { expectedChars: value.length });
        trace.executionStatus = 'started';
        if (!root.document.execCommand?.("insertText", false, value)) {
          element.textContent = value;
        }
        traceStage(trace, 'events', element);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      } catch {
        trace.executionStatus = 'started';
        element.textContent = value;
      }
    } else if (["input", "textarea"].includes(element.tagName.toLowerCase())) {
      try {
        traceStage(trace, 'focus', element);
        element.focus?.({ preventScroll: true });
        traceStage(trace, 'select', element);
        element.select?.();
        traceStage(trace, 'set', element, { expectedChars: value.length });
        trace.executionStatus = 'started';
        setNativeValue(element, value);
        traceStage(trace, 'events', element);
        dispatchInput(element);
      } catch (error) {
        traceFailure(trace, error);
        return { ok: false, error: "ERR_ACTION_FAILED", message: "无法写入这个输入框。" };
      }
    } else {
      traceStage(trace, 'target', element);
      return { ok: false, error: "ERR_NOT_EDITABLE", message: "目标不是可编辑元素。" };
    }
    const actual = element.isContentEditable
      ? String(element.textContent || "")
      : String(element.value ?? "");
    const expectedTail = value.slice(-5);
    const rejected = Boolean((value && !actual.includes(expectedTail)) || (!value && actual.length > 0));
    traceStage(trace, 'check', element, { expectedChars: value.length, actualChars: actual.length, valueMatched: actual === value });
    if (rejected) {
      return { ok: false, error: "ERR_ACTION_FAILED", message: "输入没有生效，页面可能拒绝了这次写入。" };
    }
    let submitted = false;
    if (args.submit === true) {
      traceStage(trace, 'submit', element);
      const form = element.form;
      if (form?.requestSubmit) {
        form.requestSubmit();
        submitted = true;
      } else {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
        submitted = true;
      }
    }
    return {
      ok: true,
      filled: true,
      chars: value.length,
      submitted,
      message: `已在「${found.record.meta.name || '输入框'}」输入 ${value.length} 个字符${submitted ? '并提交' : ''}`,
    };
  }

  function focusNext() {
    const focusable = Array.from(root.document.querySelectorAll(
      "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    )).filter((element) => isVisible(element) && !element.disabled);
    const active = root.document.activeElement;
    const index = focusable.indexOf(active);
    focusable[(index + 1) % Math.max(1, focusable.length)]?.focus?.();
  }

  function performPress(snapshotId, elementId, args, trace) {
    if (elementId) {
      const found = verify(snapshotId, elementId);
      if (found.error) return found;
      try {
        found.record.element.focus?.({ preventScroll: true });
      } catch {
        // Focus is best effort.
      }
    }
    const key = String(args.key || "");
    const target = root.document.activeElement;
    trace.executionStatus = 'started';
    if (key === "Enter") {
      const form = target?.form;
      if (form?.requestSubmit) {
        form.requestSubmit();
      } else {
        target?.dispatchEvent?.(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
        target?.dispatchEvent?.(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      }
    } else if (key === "Tab") {
      focusNext();
    } else {
      target?.dispatchEvent?.(new KeyboardEvent("keydown", { bubbles: true, key, code: key }));
      target?.dispatchEvent?.(new KeyboardEvent("keyup", { bubbles: true, key, code: key }));
    }
    return { ok: true, pressed: key, message: `已按 ${key}` };
  }

  function performScroll(snapshotId, elementId, args, trace) {
    const direction = String(args.direction || "down");
    const amount = Math.min(5, Math.max(1, Number(args.amount) || 1));
    let element = null;
    if (elementId) {
      const found = recordFor(snapshotId, elementId);
      if (found.error) return found;
      element = found.record.element;
    }
    const before = scrollState(element);
    const vertical = direction === 'up' || direction === 'down';
    if (!before || (element && !(vertical ? before.maxTop : before.maxLeft))) {
      return { ok: false, error: 'ERR_NOT_SCROLLABLE', message: '目标不能沿这个方向滚动，请选择观察中的滚动容器。' };
    }
    const distance = Math.max(1, Math.round((vertical ? before.clientHeight : before.clientWidth) * 0.82)) * amount;
    const delta = direction === 'down' || direction === 'right' ? distance : -distance;
    trace.executionStatus = 'started';
    if (element && (direction === "up" || direction === "down")) {
      element.scrollBy?.({ top: delta, behavior: "instant" });
    } else if (element && (direction === "left" || direction === "right")) {
      element.scrollBy?.({ left: delta, behavior: "instant" });
    } else if (direction === "up" || direction === "down") {
      root.scrollBy({ top: delta, behavior: "instant" });
    } else {
      root.scrollBy({ left: delta, behavior: "instant" });
    }
    const after = scrollState(element) || before;
    const moved = after.top !== before.top || after.left !== before.left;
    const status = moved ? 'moved' : !before.directions.includes(direction) ? 'at_boundary' : 'unchanged';
    const name = element ? metaOf(element).name || '滚动区域' : '页面';
    return { ok: true, scrollY: Math.round(root.scrollY || 0),
      effect: { type: 'scroll', status, targetId: elementId || '', targetKey: element ? stableKey(element) : 'page', direction,
        before: { top: before.top, left: before.left }, after: { top: after.top, left: after.left } },
      message: status === 'moved' ? `「${name}」已滚动（${before.left}, ${before.top} → ${after.left}, ${after.top}）`
        : status === 'at_boundary' ? `「${name}」已到滚动边界，没有移动。` : `「${name}」没有产生滚动位移。` };
  }

  async function performSelect(snapshotId, elementId, args, expected, trace) {
    traceStage(trace, 'target', root.__unkAiAgentSnapshots?.get(snapshotId)?.get(elementId)?.element);
    const found = verify(snapshotId, elementId);
    if (found.error) return found;
    const element = found.record.element;
    if (element.tagName.toLowerCase() !== "select") {
      return { ok: false, error: "ERR_NOT_EDITABLE", message: "目标不是原生 select。" };
    }
    const wanted = String(args.value ?? "");
    traceStage(trace, 'select', element);
    const option = Array.from(element.options || []).find((item) =>
      item.value === wanted || text(item.text, 300) === wanted);
    if (!option) return { ok: false, error: "ERR_ACTION_FAILED", message: "没有找到这个选项。" };
    if (option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled)) {
      return { ok: false, error: 'ERR_ELEMENT_DISABLED', message: '这个选项当前不可用。' };
    }
    const selectedValue = String(option.value);
    traceStage(trace, 'set', element);
    trace.executionStatus = 'started';
    setNativeValue(element, selectedValue);
    traceStage(trace, 'events', element);
    dispatchInput(element);
    traceStage(trace, 'settle', element);
    await new Promise(resolve => {
      const pending = { taskId: expected.taskId, epoch: expected.epoch, finish() {
        root.clearTimeout(timer);
        pendingSettlements.delete(pending);
        resolve();
      } };
      const timer = root.setTimeout(pending.finish, SELECT_SETTLE_MS);
      pendingSettlements.add(pending);
    });
    traceStage(trace, 'check', element);
    const snapshot = root.__unkAiAgentSnapshots?.get(snapshotId);
    if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch
      || (expected.taskId && !sameOwner(takeoverGuard, expected.taskId, expected.epoch))) {
      trace.executionStatus = 'uncertain';
      return { error: 'ERR_TASK_PAUSED', message: '任务已暂停，选择已发出但结果未核实。' };
    }
    if (snapshot.url !== root.location.href || originOfUrl(root.location.href) !== expected.frameOrigin) {
      trace.executionStatus = 'uncertain';
      return { error: 'ERR_PAGE_CHANGED', message: '页面已变化，选择结果未核实。' };
    }
    const current = inspect(snapshotId, elementId);
    if (current.error) {
      trace.executionStatus = 'uncertain';
      return { ...current, message: '选择后目标已不可核对，结果未确认。' };
    }
    const changedFields = changedSemanticFields(found.record.meta, current.meta);
    if (changedFields.length) {
      trace.changedFields = changedFields;
      trace.executionStatus = 'uncertain';
      return { error: 'ERR_ELEMENT_CHANGED', message: '选择后元素含义已变化，结果未核实。' };
    }
    const valueMatched = String(element.value) === selectedValue;
    traceStage(trace, 'check', element, { valueMatched });
    if (!valueMatched) return { ok: false, error: 'ERR_ACTION_NOT_APPLIED', message: '页面更新后未保留所选选项，选择没有生效。' };
    trace.executionStatus = 'verified';
    return { ok: true, selected: text(option.text, 300), message: `已核实选择「${text(option.text, 80)}」` };
  }

  async function performUpload(snapshotId, elementId, args, expected, trace) {
    let selectionStarted = false;
    let nativeUploadName = '';
    let guardFailure = '';
    const unavailable = () => ({ ok: false, error: 'ERR_UPLOAD_UNSUPPORTED', message: '这个上传控件或浏览器不支持受控文件选择，请接管上传后继续任务。' });
    const uncertain = () => {
      trace.executionStatus = 'uncertain';
      return { ok: false, error: 'ERR_UPLOAD_UNCERTAIN', message: '文件已交给页面，但选择结果未核实；网站可能已开始处理，请核对后继续，不会自动重新上传。' };
    };
    const guard = () => {
      guardFailure = '';
      const snapshot = root.__unkAiAgentSnapshots?.get(snapshotId);
      if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch
        || (expected.taskId && !sameOwner(takeoverGuard, expected.taskId, expected.epoch))) return false;
      if (snapshot.url !== root.location.href || originOfUrl(root.location.href) !== expected.frameOrigin) return false;
      const current = inspect(snapshotId, elementId, { checkOverlayMeaning: !selectionStarted });
      if (current.error) { guardFailure = current.error; return false; }
      // A nameless overlay borrowed its name from the visible area at capture.
      // After selection, normal preview/count text may replace that area text.
      const record = snapshot.get(elementId);
      const signature = selectionStarted && record.fileOverlayParent && !nativeUploadName && !accessibleName(record.element)
        ? semanticSignature({ ...current.meta, name: record.meta.name }) : current.signature;
      if (signature !== expected.signature) { guardFailure = 'ERR_ELEMENT_CHANGED'; return false; }
      return true;
    };
    traceStage(trace, 'target');
    const found = verify(snapshotId, elementId);
    if (found.error) return found;
    const element = found.record.element;
    nativeUploadName = accessibleName(element);
    const setter = Object.getOwnPropertyDescriptor(root.HTMLInputElement?.prototype || {}, 'files')?.set;
    if (element.tagName?.toLowerCase() !== 'input' || element.type !== 'file'
      || element.webkitdirectory === true || element.hasAttribute('webkitdirectory')
      || typeof root.File !== 'function' || typeof root.DataTransfer !== 'function'
      || typeof root.atob !== 'function' || typeof setter !== 'function') return unavailable();
    const payload = args.upload;
    const binding = payload?.target;
    if (!payload || payload.referenceId !== args.referenceId || !/^reference-[1-3]$/.test(payload.referenceId || '')
      || binding?.taskId !== expected.taskId || binding.epoch !== expected.epoch || binding.tabId !== expected.tabId
      || binding.frameId !== expected.frameId || binding.documentId !== expected.documentId
      || binding.url !== expected.topUrl || binding.frameUrl !== root.location.href || binding.frameOrigin !== expected.frameOrigin
      || binding.snapshotId !== snapshotId || binding.elementId !== elementId
      || !Number.isInteger(payload.size) || payload.size <= 0 || payload.size > 8 * 1024 * 1024
      || typeof payload.base64 !== 'string' || payload.base64.length > 11184812
      || typeof payload.name !== 'string' || payload.name.length > 120 || /[\\/\u0000-\u001f]/.test(payload.name)) {
      return { ok: false, error: 'ERR_UPLOAD_INVALID', message: '参考图片缺少有效的任务或页面绑定。' };
    }
    const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    if (!Object.hasOwn(extensions, payload.mime)) return { ok: false, error: 'ERR_UPLOAD_INVALID', message: '参考图片格式不可上传。' };
    const accept = String(element.getAttribute('accept') || '').toLowerCase();
    if (accept.length > 200) return unavailable();
    const filters = accept.split(',').map(value => value.trim()).filter(Boolean);
    if (filters.length && !filters.some(value => value === 'image/*' || value === payload.mime || value === extensions[payload.mime]
      || (payload.mime === 'image/jpeg' && value === '.jpeg'))) return unavailable();
    let file, transfer;
    try {
      const decoded = root.atob(payload.base64);
      if (decoded.length !== payload.size) return { ok: false, error: 'ERR_UPLOAD_INVALID', message: '参考图片大小不匹配。' };
      const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      file = new root.File([bytes], payload.name, { type: payload.mime, lastModified: Date.now() });
      transfer = new root.DataTransfer();
      transfer.items.add(file);
      if (transfer.files.length !== 1 || file.size !== payload.size) return unavailable();
    } catch (error) { traceFailure(trace, error); return unavailable(); }
    if (!guard()) return { ok: false, error: guardFailure || 'ERR_UPLOAD_SCOPE', message: '任务、文件输入框或可见上传区域已变化，尚未选择文件。' };
    let receiptScope = found.record.fileOverlayParent || found.record.uploadAnchor || element;
    for (let depth = 0; depth < 2; depth++) {
      const parent = parentOf(receiptScope);
      if (!parent || ['BODY', 'HTML'].includes(parent.tagName)) break;
      receiptScope = parent;
    }
    const baseline = uploadPreviewSnapshot(receiptScope);
    traceStage(trace, 'set', element);
    trace.executionStatus = 'started';
    selectionStarted = true;
    setter.call(element, transfer.files);
    // Event handlers may immediately submit, navigate or remove the input. Do
    // not send the next event after authority or target identity is lost.
    traceStage(trace, 'events', element);
    if (!guard()) return uncertain();
    element.dispatchEvent(new Event('input', { bubbles: true }));
    if (!guard()) return uncertain();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    traceStage(trace, 'settle', element);
    await new Promise(resolve => {
      const pending = { taskId: expected.taskId, epoch: expected.epoch, finish() {
        root.clearTimeout(timer); pendingSettlements.delete(pending); resolve();
      } };
      const timer = root.setTimeout(pending.finish, SELECT_SETTLE_MS);
      pendingSettlements.add(pending);
    });
    traceStage(trace, 'check', element);
    if (!guard()) return uncertain();
    const selected = element.files;
    const valueMatched = selected?.length === 1 && selected[0].name === file.name && selected[0].type === file.type
      && selected[0].size === file.size && selected[0].lastModified === file.lastModified;
    traceStage(trace, 'check', element, { valueMatched });
    if (!valueMatched) {
      const result = uncertain();
      if (!baseline || !expected.actionId) return result;
      if (uploadReceiptProbes.size >= 3) uploadReceiptProbes.delete(uploadReceiptProbes.keys().next().value);
      uploadReceiptProbes.set(expected.actionId, { taskId: expected.taskId, epoch: expected.epoch,
        actionId: expected.actionId, referenceId: payload.referenceId, tabId: expected.tabId, frameId: expected.frameId,
        documentId: expected.documentId, frameUrl: root.location.href, pageUrl: expected.topUrl,
        element, scope: receiptScope, baseline, base64: payload.base64, mime: payload.mime, size: payload.size,
        createdAt: Date.now() });
      return { ...result, upload: { referenceId: payload.referenceId, requiresAcceptanceVerification: true,
        epoch: expected.epoch, documentId: expected.documentId, frameId: expected.frameId } };
    }
    trace.executionStatus = 'verified';
    return { ok: true, upload: { referenceId: payload.referenceId, fileSelected: true, serverConfirmed: false },
      message: '已核实参考图片被选入页面文件框；网站是否上传成功仍需观察页面结果。' };
  }

  function uploadPreviewSnapshot(scope) {
    if (!scope?.isConnected || !scope.querySelectorAll || ['BODY', 'HTML', 'INPUT'].includes(scope.tagName)) return null;
    try {
      const nodes = scope.querySelectorAll('img');
      if (nodes.length > 24) return null;
      return new Map(Array.from(nodes, node => [node, String(node.currentSrc || node.src || '')]));
    } catch { return null; }
  }

  /** Read only a new, locally scoped image preview; never fetch a network image. */
  async function verifyUploadReceipt(snapshotId, elementId, expected = {}) {
    const unconfirmed = () => ({ ok: false, error: 'ERR_UPLOAD_ACCEPTANCE_UNCONFIRMED',
      message: '尚未核对到本次参考图片的新预览，不会重新上传或继续提交。' });
    const probe = uploadReceiptProbes.get(expected.actionId);
    if (!probe || probe.referenceId !== expected.referenceId || probe.taskId !== expected.taskId || probe.epoch !== expected.epoch
      || probe.tabId !== expected.tabId || probe.frameId !== expected.frameId || probe.documentId !== expected.documentId
      || probe.frameUrl !== expected.frameUrl || probe.pageUrl !== expected.pageUrl || Date.now() - probe.createdAt > 15000
      || !Number.isFinite(expected.expiresAt) || typeof root.AbortController !== 'function') return unconfirmed();
    const assertCurrent = (node, source) => {
      const snapshot = root.__unkAiAgentSnapshots?.get(snapshotId);
      if (Date.now() >= expected.expiresAt || uploadReceiptProbes.get(expected.actionId) !== probe
        || !snapshot || snapshot.taskId !== probe.taskId || snapshot.epoch !== probe.epoch
        || snapshot.url !== probe.frameUrl || root.location.href !== probe.frameUrl
        || snapshot.get(elementId)?.element !== probe.element || !probe.scope.isConnected
        || !probe.scope.contains(probe.element) || !sameOwner(takeoverGuard, probe.taskId, probe.epoch)
        || verify(snapshotId, elementId, { ignoreMoved: true, checkOverlayMeaning: false }).error
        || (node && (!probe.scope.contains(node) || !isVisible(node) || String(node.currentSrc || node.src || '') !== source))) {
        throw new Error('upload receipt target changed');
      }
    };
    const controller = new root.AbortController();
    const read = { taskId: probe.taskId, epoch: probe.epoch, controller };
    uploadReceiptReads.add(read);
    const timer = root.setTimeout(() => controller.abort(), Math.max(1, Math.min(3000, expected.expiresAt - Date.now())));
    const wait = promise => new Promise((resolve, reject) => {
      const abort = () => reject(new Error('upload receipt cancelled'));
      if (controller.signal.aborted) return abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    });
    try {
      assertCurrent();
      const current = uploadPreviewSnapshot(probe.scope);
      if (!current) return unconfirmed();
      const oldSources = new Set(probe.baseline.values());
      const candidates = [...current].filter(([node, source]) => isVisible(node) && source
        && probe.baseline.get(node) !== source && !oldSources.has(source)).slice(0, 3);
      let readBytes = 0;
      for (const [node, source] of candidates) {
        assertCurrent(node, source);
        let matched = source === `data:${probe.mime};base64,${probe.base64}`;
        if (!matched && source.startsWith('blob:') && typeof root.fetch === 'function') {
          let url;
          try { url = new URL(source); } catch { continue; }
          if (url.origin !== originOfUrl(probe.frameUrl) || !source.startsWith(`blob:${url.origin}/`)) continue;
          const response = await wait(root.fetch(source, { signal: controller.signal, credentials: 'omit', cache: 'no-store' }));
          assertCurrent(node, source);
          if (!response.ok || !response.body?.getReader) continue;
          const length = Number(response.headers?.get?.('content-length'));
          if (length > probe.size) continue;
          const reader = response.body.getReader();
          let offset = 0;
          matched = true;
          const bytes = root.atob(probe.base64);
          try {
            while (true) {
              const chunk = await wait(reader.read());
              assertCurrent(node, source);
              if (chunk.done) break;
              readBytes += chunk.value.length;
              if (readBytes > 8 * 1024 * 1024 || offset + chunk.value.length > probe.size) { matched = false; break; }
              for (let index = 0; index < chunk.value.length; index++) {
                if (chunk.value[index] !== bytes.charCodeAt(offset + index)) { matched = false; break; }
              }
              if (!matched) break;
              offset += chunk.value.length;
            }
            matched &&= offset === probe.size;
          } finally { void reader.cancel().catch(() => {}); }
        }
        assertCurrent(node, source);
        if (matched) return { ok: true, receipt: { version: 1, accepted: true, kind: 'new-matching-preview',
          actionId: probe.actionId, referenceId: probe.referenceId, taskId: probe.taskId, epoch: probe.epoch,
          tabId: probe.tabId, frameId: probe.frameId, documentId: probe.documentId,
          url: probe.pageUrl, snapshotId, serverConfirmed: false } };
      }
      return unconfirmed();
    } catch { return unconfirmed(); }
    finally { root.clearTimeout(timer); controller.abort(); uploadReceiptReads.delete(read); }
  }

  function perform(snapshotId, elementId, action, args = {}, expected = {}) {
    const trace = { stage: 'snapshot', stages: [], executionStatus: 'not-started' };
    const finish = result => diagnosticResult(result, trace);
    if (elementId && root.__unkAiAgentSnapshots?.get(snapshotId)?.get(elementId)?.meta.uploadOnly && action !== 'upload_reference_image') {
      return finish({ error: 'ERR_UPLOAD_ONLY', message: '这个文件输入目标仅允许专用参考图片上传，不能用作普通点击或输入。' });
    }
    if (elementId && root.__unkAiAgentSnapshots?.get(snapshotId)?.get(elementId)?.choiceAnchor && action !== 'click_element') {
      return finish({ error: 'ERR_CHOICE_CLICK_ONLY', message: '这个原生选项须通过已关联的可见标签点击，不能输入或发送按键。' });
    }
    if (elementId && root.__unkAiAgentSnapshots?.get(snapshotId)?.get(elementId)?.meta.readOnly && action !== 'scroll_page') {
      return finish({ error: 'ERR_REGION_READ_ONLY', message: '这是只读内容区域，不能作为点击或输入目标。' });
    }
    try {
      const snapshot = root.__unkAiAgentSnapshots?.get(snapshotId);
      if (Number.isFinite(snapshot?.createdAt)) trace.snapshotAgeMs = Math.max(0, Date.now() - snapshot.createdAt);
      traceStage(trace, 'snapshot');
      if (!snapshot || snapshot.taskId !== expected.taskId || snapshot.epoch !== expected.epoch) {
        return finish({ error: "ERR_SNAPSHOT_EXPIRED", message: "任务或页面快照已失效。" });
      }
      traceStage(trace, 'page-target');
      if (snapshot.url !== root.location.href) {
        return finish({ error: "ERR_PAGE_CHANGED", message: "页面地址已变化，请重新观察。" });
      }
      traceStage(trace, 'inspect', snapshot.get(elementId)?.element);
      const current = inspect(snapshotId, elementId);
      if (current.error) return finish(current);
      traceStage(trace, 'element-signature');
      let expectedMeta;
      try { expectedMeta = JSON.parse(expected.signature); } catch { /* Invalid expected signatures never authorize a write. */ }
      const validSignature = expectedMeta && typeof expectedMeta === 'object' && !Array.isArray(expectedMeta);
      const changedFields = validSignature ? changedSemanticFields(expectedMeta, current.meta) : [];
      if (changedFields.length) trace.changedFields = changedFields;
      if (originOfUrl(current.url) !== expected.frameOrigin || !validSignature || changedFields.length) {
        return finish({ error: "ERR_ELEMENT_CHANGED", message: "目标元素或页面来源已变化，请重新观察并确认。" });
      }
      performing = true;
      traceStage(trace, 'execute');
      if (action === "click_element") return finish(performClick(snapshotId, elementId, trace));
      if (action === "type_text") return finish(performType(snapshotId, elementId, args, trace));
      if (action === "press_key") return finish(performPress(snapshotId, elementId, args, trace));
      if (action === "scroll_page") return finish(performScroll(snapshotId, elementId, args, trace));
      if (action === "select_option") return performSelect(snapshotId, elementId, args, expected, trace).then(finish, error => {
        traceFailure(trace, error);
        if (trace.executionStatus === 'started') trace.executionStatus = 'uncertain';
        return finish({ ok: false, error: 'ERR_ACTION_FAILED', message: '无法核实这次选择的结果。' });
      });
      if (action === 'upload_reference_image') return performUpload(snapshotId, elementId, args, expected, trace).then(finish, error => {
        traceFailure(trace, error);
        const started = trace.executionStatus !== 'not-started';
        if (started) trace.executionStatus = 'uncertain';
        return finish({ ok: false, error: started ? 'ERR_UPLOAD_UNCERTAIN' : 'ERR_UPLOAD_UNSUPPORTED',
          message: started ? '文件选择已发起但结果未核实，请接管核对；不会自动重新上传。' : '浏览器无法执行受控文件选择，请接管上传后继续。' });
      });
      return finish({ ok: false, error: "ERR_ACTION_FAILED", message: "页面扫描器不支持这个动作。" });
    } catch (error) {
      traceFailure(trace, error);
      return finish({
        ok: false,
        error: "ERR_ACTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      performing = false;
    }
  }

  function removeOverlay(taskId, epoch) {
    removeTakeoverGuard(taskId, epoch);
    if (overlayOwner && !sameOwner(overlayOwner, taskId, epoch)) return { ok: true };
    try {
      root.document.getElementById(OVERLAY_ID)?.remove();
      root.document.getElementById(OVERLAY_STYLE_ID)?.remove();
      overlayOwner = null;
    } catch {
      // The page may be navigating away.
    }
    return { ok: true };
  }

  function showOverlay({ taskId = "", goal = "", label = "浏览器正在操作页面", epoch = 0 } = {}) {
    if (!enableTakeoverGuard(taskId, epoch)) return { ok: false, error: "ERR_TASK_PAUSED" };
    try {
      const doc = root.document;
      if (!doc?.documentElement) return { ok: false, error: "ERR_OVERLAY_FAILED" };
      doc.getElementById(OVERLAY_ID)?.remove();
      doc.getElementById(OVERLAY_STYLE_ID)?.remove();
      overlayOwner = { taskId, epoch };
      const style = doc.createElement("style");
      style.id = OVERLAY_STYLE_ID;
      style.textContent = [
        "#" + OVERLAY_ID + " {",
        "  position: fixed;",
        "  inset: 0;",
        "  z-index: 2147483646;",
        "  display: flex;",
        "  align-items: flex-start;",
        "  justify-content: center;",
        "  padding-top: 13vh;",
        "  background: rgba(246, 249, 247, 0.34);",
        "  backdrop-filter: saturate(0.9);",
        "  cursor: pointer;",
        "  pointer-events: none;",
        "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;",
        "}",
        "#" + OVERLAY_ID + " .unk-agent-overlay-card {",
        "  display: flex;",
        "  flex-direction: column;",
        "  gap: 5px;",
        "  width: min(340px, calc(100vw - 48px));",
        "  padding: 13px 16px;",
        "  border: 1px solid rgba(38, 101, 90, 0.22);",
        "  border-radius: 12px;",
        "  background: rgba(255, 255, 255, 0.96);",
        "  box-shadow: 0 10px 36px rgba(28, 53, 46, 0.16);",
        "  color: #1e3430;",
        "  text-align: left;",
        "  pointer-events: none;",
        "}",
        "#" + OVERLAY_ID + " .unk-agent-overlay-title { font-size: 13px; font-weight: 650; }",
        "#" + OVERLAY_ID + " .unk-agent-overlay-detail {",
        "  font-size: 12px;",
        "  color: #587069;",
        "  line-height: 1.45;",
        "}",
        "#" + OVERLAY_ID + " .unk-agent-overlay-action {",
        "  margin-top: 2px;",
        "  color: #20685d;",
        "  font-size: 12px;",
        "  font-weight: 650;",
        "}",
      ].join("\n");
      doc.documentElement.appendChild(style);
      const overlay = doc.createElement("div");
      overlay.id = OVERLAY_ID;
      overlay.setAttribute("role", "status");
      const card = doc.createElement("div");
      card.className = "unk-agent-overlay-card";
      for (const [className, copy] of [
        ["unk-agent-overlay-title", ""],
        ["unk-agent-overlay-detail", ""],
        ["unk-agent-overlay-action", "点击、输入或滚动页面即可暂停并接管"],
      ]) {
        const line = doc.createElement("span");
        line.className = className;
        line.textContent = copy;
        card.appendChild(line);
      }
      overlay.appendChild(card);
      overlay.querySelector(".unk-agent-overlay-title").textContent = label;
      overlay.querySelector(".unk-agent-overlay-detail").textContent = text(goal, 240) || "UNK AI 正在执行你确认过的任务";
      doc.documentElement.appendChild(overlay);
      return { ok: true };
    } catch {
      return { ok: false, error: "ERR_OVERLAY_FAILED" };
    }
  }

  if (!root.__unkAiAgentSnapshots) root.__unkAiAgentSnapshots = new Map();
  root.__unkAiAgentScanner = { version: 12, scan, readRegion, inspect, perform, verifyUploadReceipt, cancelTask, showOverlay, removeOverlay };
})(typeof globalThis !== "undefined" ? globalThis : this);
