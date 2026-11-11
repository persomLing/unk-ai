import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/content/agent-scanner.js', import.meta.url), 'utf8');

/** Small DOM adapter with light-tree containment and explicit shadow hit tests. */
export function scannerDom() {
  const descendants = scope => (scope.children || []).flatMap(child => [child, ...descendants(child)]);
  const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const interactiveRoles = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'combobox', 'textbox']);
  const matches = (element, selector) => selector.split(',').some(raw => {
    const part = raw.trim();
    if (part === '*') return true;
    if (part.startsWith('#')) return element.id === part.slice(1);
    if (/^[a-z][a-z0-9-]*$/i.test(part)) return element.tagName === part.toUpperCase();
    if (part === 'a[href]') return element.tagName === 'A' && element.hasAttribute('href');
    const role = part.match(/^\[role=['"]([^'"]+)['"]\]$/);
    if (role) return element.getAttribute('role') === role[1];
    if (part === "[contenteditable='true']") return element.isContentEditable;
    if (part === "[tabindex]:not([tabindex='-1'])") return element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1';
    return false;
  });
  const query = scope => ({
    querySelectorAll(selector) { return descendants(scope).filter(element => matches(element, selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementById(id) { return descendants(scope).find(element => element.id === id) || null; },
  });
  let sequence = 0;
  const element = (tag = 'button', name = '', extra = {}) => {
    const node = {
      nodeType: 1, tagName: tag.toUpperCase(), id: `node-${++sequence}`, type: tag === 'button' ? 'button' : '',
      name: '', innerText: name, textContent: name, attributes: {}, style: { opacity: '1' },
      children: [], isConnected: true, clicks: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0,
      get childNodes() { return [...(this.textContent ? [{ nodeType: 3, nodeValue: this.textContent, parentElement: this }] : []), ...this.children]; },
      get childElementCount() { return this.children.length; },
      getAttribute(key) { return key === 'id' ? this.id : this.attributes[key] ?? null; },
      hasAttribute(key) { return key === 'id' ? Boolean(this.id) : key in this.attributes; },
      setAttribute(key, value) { if (key === 'id') this.id = value; else this.attributes[key] = value; },
      getRootNode() { return this.parentNode?.getRootNode?.() || document; },
      appendChild(child) { this.children.push(child); child.parentElement = this; child.parentNode = this; return child; },
      contains(other) { return this === other || descendants(this).includes(other); },
      closest(selector) { return matches(this, selector) ? this : this.parentElement?.closest(selector) || null; },
      matches(selector) {
        if (selector.includes('a[href]')) return interactiveTags.has(this.tagName) || interactiveRoles.has(this.getAttribute('role'))
          || this.isContentEditable || (this.hasAttribute('tabindex') && this.getAttribute('tabindex') !== '-1');
        return matches(this, selector);
      },
      getBoundingClientRect() { return { top: 100, bottom: 130, left: 100, right: 220, width: 120, height: 30 }; },
      scrollIntoView() {},
      focus() { document.activeElement = this; },
      click() { this.clicks++; },
      dispatchEvent() { return true; },
      ...extra,
    };
    Object.assign(node, query(node));
    return node;
  };
  const body = element('body');
  const documentElement = element('html');
  documentElement.appendChild(body);
  const document = {
    title: 'Scanner fixture', body, documentElement, children: [documentElement], hit: null,
    getRootNode() { return this; },
    elementFromPoint() { return this.hit; },
    createTreeWalker(scope) { const nodes = descendants(scope); let index = 0; return { nextNode: () => nodes[index++] || null }; },
  };
  documentElement.parentNode = document;
  Object.assign(document, query(document));
  const attachShadow = host => {
    const shadow = { nodeType: 11, host, children: [], hit: null,
      getRootNode() { return this; },
      appendChild(child) { this.children.push(child); child.parentElement = null; child.parentNode = this; return child; },
      elementFromPoint() { return this.hit; },
    };
    Object.assign(shadow, query(shadow));
    host.shadowRoot = shadow;
    return shadow;
  };
  const context = vm.createContext({ document, location: new URL('https://scanner.test/form'), URL, URLSearchParams,
    Map, Set, Event, setTimeout, clearTimeout, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: node => node.style, addEventListener() {}, removeEventListener() {},
    chrome: { runtime: { sendMessage: async () => ({}) } },
  });
  vm.runInContext('globalThis.top=globalThis', context);
  vm.runInContext(source, context);
  let snapshot;
  return {
    context, document, body, element, attachShadow,
    scan(options = {}) { snapshot = context.__unkAiAgentScanner.scan(`snapshot-${++sequence}`, { taskId: 'task', epoch: 1, ...options }); return snapshot; },
    perform(target, action = 'click_element', args = {}) {
      const observed = snapshot.elements.find(item => item.domId === target.id);
      if (!observed) throw new Error('Target was not observed');
      const record = context.__unkAiAgentSnapshots.get(snapshot.snapshotId).get(observed.id);
      return context.__unkAiAgentScanner.perform(snapshot.snapshotId, observed.id, action, args, {
        taskId: 'task', epoch: 1, frameOrigin: context.location.origin, signature: JSON.stringify(record.meta),
      });
    },
  };
}
