const MAX_AX_NODES = 320;
const MAX_AX_CHARS = 18_000;
const MAX_DOM_NODES = 12_000;
const MAX_DOM_LINKS = 160;
const MAX_DOM_IMAGES = 80;

const KEY_AX_ROLES = new Set([
  'article', 'banner', 'complementary', 'contentinfo', 'dialog', 'form', 'main',
  'navigation', 'region', 'search', 'heading', 'link', 'button', 'textbox',
  'searchbox', 'combobox', 'checkbox', 'radio', 'tab', 'treeitem', 'list',
  'listitem', 'table', 'row', 'columnheader', 'rowheader', 'cell', 'grid',
  'img', 'figure', 'paragraph', 'blockquote', 'code', 'note',
]);

function text(value, limit = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function valueOf(node, name) {
  return node?.[name]?.value;
}

function levelOf(node) {
  const properties = Array.isArray(node?.properties) ? node.properties : [];
  const property = properties.find((item) => item?.name === 'level');
  const value = property?.value?.value;
  return Number.isFinite(Number(value)) ? Math.max(1, Math.min(6, Number(value))) : 1;
}

/**
 * Convert a CDP Accessibility.getFullAXTree result into a bounded reading
 * outline. This is intentionally a summary: the complete AX payload can be
 * megabytes and must never be sent to the model verbatim.
 */
export function summarizeAccessibilityTree(nodes, {
  maxNodes = MAX_AX_NODES,
  maxChars = MAX_AX_CHARS,
} = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map();
  for (const node of list) {
    if (node?.nodeId != null) byId.set(node.nodeId, node);
  }
  const output = [];
  const roleCounts = Object.create(null);
  let characters = 0;
  let truncated = false;
  const seen = new Set();

  function visit(node) {
    if (!node || output.length >= maxNodes || characters >= maxChars) {
      if (node && output.length >= maxNodes) truncated = true;
      return;
    }
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = text(valueOf(node, 'role'), 40).toLowerCase();
    // Editable values and their descendants are drafts, not reading material.
    const editable = (node.properties || []).some((property) =>
      property?.name === 'editable' && property?.value?.value);
    if (editable || ['textbox', 'searchbox', 'combobox'].includes(role)) return;
    if (!node.ignored && KEY_AX_ROLES.has(role)) {
      const name = text(
        valueOf(node, 'name') || valueOf(node, 'description'),
        600,
      );
      if (name) {
        const remaining = Math.max(1, maxChars - characters);
        const clipped = name.slice(0, remaining);
        output.push({
          type: role,
          level: role === 'heading' ? levelOf(node) : 1,
          text: clipped,
        });
        characters += clipped.length;
        roleCounts[role] = (roleCounts[role] || 0) + 1;
        if (clipped.length < name.length) truncated = true;
      }
    }
    for (const childId of Array.isArray(node.childIds) ? node.childIds : []) {
      visit(byId.get(childId));
    }
  }

  const roots = list.filter((node) => !node.parentId);
  for (const root of roots.length ? roots : list) visit(root);
  if (output.length >= maxNodes || characters >= maxChars) truncated = true;
  return {
    nodes: output,
    roleCounts,
    nodeCount: list.length,
    includedNodeCount: output.length,
    chars: characters,
    truncated,
  };
}

function stringAt(strings, value) {
  if (typeof value === 'number') return strings[value] || '';
  return value == null ? '' : String(value);
}

function attributeMap(node, strings) {
  const output = Object.create(null);
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = stringAt(strings, attributes[index]).toLowerCase();
    if (name) output[name] = stringAt(strings, attributes[index + 1]);
  }
  return output;
}

/**
 * Extract only useful structure from DOMSnapshot.captureSnapshot. The full
 * snapshot is deliberately reduced to counts and references before it reaches
 * the model context.
 */
export function summarizeDomSnapshot(snapshot, {
  maxNodes = MAX_DOM_NODES,
  maxLinks = MAX_DOM_LINKS,
  maxImages = MAX_DOM_IMAGES,
} = {}) {
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const links = [];
  const images = [];
  const counts = { documents: documents.length, nodes: 0, links: 0, images: 0, tables: 0, iframes: 0, forms: 0 };
  let truncated = false;
  let visited = 0;

  for (const document of documents) {
    const nodes = Array.isArray(document?.nodes?.nodeName) ? document.nodes.nodeName : [];
    const attributes = Array.isArray(document?.nodes?.attributes) ? document.nodes.attributes : [];
    const baseUrl = stringAt(strings, document?.documentURL);
    for (let index = 0; index < nodes.length; index += 1) {
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      visited += 1;
      counts.nodes += 1;
      const tag = stringAt(strings, nodes[index]).toUpperCase();
      const attrs = attributeMap({ attributes: attributes[index] }, strings);
      if (tag === 'A') {
        counts.links += 1;
        if (links.length < maxLinks && attrs.href) {
          let href = attrs.href;
          try { href = new URL(href, baseUrl || undefined).href; } catch { /* keep raw */ }
          if (!links.some((item) => item.href === href)) {
            links.push({
              text: text(attrs.title || attrs['aria-label'] || href, 220),
              href: text(href, 800),
              title: text(attrs.title, 300),
              section: [],
            });
          }
        }
      } else if (tag === 'IMG') {
        counts.images += 1;
        if (images.length < maxImages) {
          images.push({
            type: 'image',
            alt: text(attrs.alt, 300),
            title: text(attrs.title || attrs['aria-label'], 300),
            src: text(attrs.src || attrs['data-src'], 800),
            caption: '',
            section: [],
          });
        }
      } else if (tag === 'TABLE') {
        counts.tables += 1;
      } else if (tag === 'IFRAME' || tag === 'FRAME') {
        counts.iframes += 1;
      } else if (tag === 'FORM') {
        counts.forms += 1;
      }
    }
    if (truncated) break;
  }
  return { counts, links, images, truncated };
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = typeof key === 'function' ? key(item) : item?.[key];
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function countByRole(nodes) {
  const counts = {};
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const role = text(node?.type || node?.role || 'text', 40) || 'text';
    counts[role] = (counts[role] || 0) + 1;
  }
  return counts;
}

/**
 * Merge deep CDP reading into the existing extractor output without throwing
 * away the ordinary page text, table rows, captions or section paths.
 */
export function mergeDeepReading(page, deep) {
  const base = page && typeof page === 'object' ? page : {};
  const deepTree = Array.isArray(deep?.semanticTree) ? deep.semanticTree : [];
  const baseTree = Array.isArray(base.semanticTree) ? base.semanticTree
    : Array.isArray(base.structure?.semanticTree) ? base.structure.semanticTree : [];
  const semanticTree = deepTree.length ? deepTree : baseTree;
  const semanticTreeSource = deepTree.length ? 'cdp-ax' : base.semanticTreeSource || base.structure?.semanticTreeSource;
  const dom = deep?.dom && typeof deep.dom === 'object' ? deep.dom : null;
  const baseStructure = base.structure && typeof base.structure === 'object' ? base.structure : {};
  const links = uniqueBy([
    ...(Array.isArray(baseStructure.links) ? baseStructure.links : []),
    ...(Array.isArray(base.links) ? base.links : []),
    ...(Array.isArray(dom?.links) ? dom.links : []),
  ], 'href').slice(0, 300);
  const figures = uniqueBy([
    ...(Array.isArray(base.figures) ? base.figures : []),
    ...(Array.isArray(baseStructure.figures) ? baseStructure.figures : []),
    ...(Array.isArray(dom?.images) ? dom.images : []),
  ], (figure) => figure?.src || `${figure?.caption || ''}\u0000${figure?.alt || ''}`).slice(0, 100);
  const structure = {
    ...baseStructure,
    links,
    figures,
    semanticTree,
    semanticTreeSource,
    deepReading: {
      source: 'cdp',
      available: deep?.available !== false,
      error: deep?.available === false ? text(deep?.error, 500) : undefined,
      frameCount: Number(deep?.frameCount) || 0,
      axNodeCount: Number(deep?.ax?.nodeCount) || 0,
      axIncludedNodeCount: deepTree.length,
      domNodeCount: Number(dom?.counts?.nodes) || 0,
      domDocumentCount: Number(dom?.counts?.documents) || 0,
      truncated: Boolean(deep?.truncated || deep?.ax?.truncated || dom?.truncated),
    },
  };
  return {
    ...base,
    links,
    figures,
    structure,
    semanticTree,
    semanticTreeSource,
    deepReading: structure.deepReading,
    deepRoleCounts: countByRole(semanticTree),
  };
}
