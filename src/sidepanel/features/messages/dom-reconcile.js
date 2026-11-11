const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const COMMENT_NODE = 8;

function syncAttributes(current, next) {
  const nextNames = new Set(next.getAttributeNames?.() || []);
  for (const name of current.getAttributeNames?.() || []) {
    if (!nextNames.has(name)) current.removeAttribute?.(name);
  }
  for (const name of nextNames) {
    const value = next.getAttribute(name);
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
}

/** Patch a freshly rendered subtree into an existing one, reusing every
 * compatible node. Streaming markdown grows incrementally, so replacing the
 * whole message on each delta causes avoidable layout and paint churn. */
export function syncNode(current, next) {
  if (!current || !next || current.nodeType !== next.nodeType) return false;
  if (current.nodeType === ELEMENT_NODE) {
    if (current.nodeName !== next.nodeName) return false;
    syncAttributes(current, next);
    syncChildren(current, next);
    return true;
  }
  if ([TEXT_NODE, CDATA_SECTION_NODE, COMMENT_NODE].includes(current.nodeType)) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
  }
  return true;
}

export function syncChildren(current, next) {
  let currentNode = current.firstChild;
  let nextNode = next.firstChild;
  while (nextNode) {
    const following = nextNode.nextSibling;
    if (!currentNode) {
      current.appendChild(nextNode);
    } else {
      const followingCurrent = currentNode.nextSibling;
      if (syncNode(currentNode, nextNode)) {
        currentNode = followingCurrent;
      } else {
        current.replaceChild(nextNode, currentNode);
        currentNode = followingCurrent;
      }
    }
    nextNode = following;
  }
  while (currentNode) {
    const following = currentNode.nextSibling;
    currentNode.remove();
    currentNode = following;
  }
}
