(function (root) {
  "use strict";
  const runtime = root?.chrome?.runtime;
  if (!runtime?.onMessage?.addListener) return;
  if (root.__unkAiFigurePicker) return;
  root.__unkAiFigurePicker = true;

  let active = false;
  let overlay = null;
  let tooltip = null;
  let highlighted = null;

  const SELECTOR = [
    "figure",
    "img",
    "canvas",
    "svg",
    "[role='img']",
    "[aria-label*='图']",
    "[class*='chart']",
    "[class*='graph']",
    "[class*='plot']",
    "[class*='diagram']",
    "[id*='chart']",
    "[id*='graph']",
  ].join(",");

  function candidates() {
    try {
      return Array.from(document.querySelectorAll(SELECTOR)).filter((element) => {
        if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= 80 && rect.height >= 60;
      });
    } catch {
      return [];
    }
  }

  function labelOf(element) {
    const figure = element.closest("figure");
    const caption = figure?.querySelector("figcaption")?.innerText;
    return String(
      element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.getAttribute("alt")
      || caption
      || (element.tagName === "CANVAS" ? "Canvas 图表" : element.tagName === "SVG" ? "SVG 图表" : "图片"),
    ).replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function ensureChrome() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.setAttribute("data-unk-figure-picker", "chrome");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:rgba(18,28,22,.06);";
    tooltip = document.createElement("div");
    tooltip.style.cssText = "position:fixed;z-index:2147483648;pointer-events:none;display:none;padding:6px 9px;border-radius:6px;background:#1f2722;color:#fff;font:12px/1.4 system-ui,sans-serif;box-shadow:0 3px 12px #0003;max-width:320px;";
    overlay.appendChild(tooltip);
    document.documentElement.appendChild(overlay);
  }

  function clearHighlight() {
    if (!highlighted) return;
    highlighted.element.style.outline = highlighted.outline;
    highlighted.element.style.outlineOffset = highlighted.offset;
    highlighted = null;
  }

  function highlight(element, x, y) {
    if (highlighted?.element !== element) {
      clearHighlight();
      highlighted = {
        element,
        outline: element.style.outline,
        offset: element.style.outlineOffset,
      };
      element.style.outline = "2px solid #4c9b78";
      element.style.outlineOffset = "3px";
    }
    tooltip.textContent = labelOf(element);
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.min(x + 14, innerWidth - 330)}px`;
    tooltip.style.top = `${Math.min(y + 14, innerHeight - 50)}px`;
  }

  function stop() {
    active = false;
    clearHighlight();
    overlay?.remove();
    overlay = null;
    tooltip = null;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
  }

  function onMove(event) {
    if (!active) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const candidate = element?.closest(SELECTOR);
    if (candidate) highlight(candidate, event.clientX, event.clientY);
    else {
      clearHighlight();
      if (tooltip) tooltip.style.display = "none";
    }
  }

  function onClick(event) {
    if (!active) return;
    const candidate = document.elementFromPoint(event.clientX, event.clientY)?.closest(SELECTOR);
    if (!candidate) return;
    const rect = candidate.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    active = false;
    clearHighlight();
    overlay?.remove();
    overlay = null;
    try {
      runtime.sendMessage({
        type: "PAGE_FIGURE_PICKED",
        payload: {
          label: labelOf(candidate),
          rect: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
          viewport: { width: innerWidth, height: innerHeight },
          scrollY: window.scrollY,
          title: document.title,
          url: location.href,
        },
      }).catch(() => {});
    } catch {
      // Keep the page untouched if the extension was reloaded.
    }
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(event) {
    if (event.key === "Escape") stop();
  }

  runtime.onMessage.addListener((message) => {
    if (message?.type !== "START_FIGURE_PICKER") return undefined;
    ensureChrome();
    active = true;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return false;
  });
})();
