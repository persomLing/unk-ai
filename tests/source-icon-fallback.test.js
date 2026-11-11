import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceIconFallback } from '../src/sidepanel/features/messages/source-icons.js';

class Element extends EventTarget {
  constructor(document, tag = 'span') {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.complete = false;
    this.naturalWidth = 0;
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  contains(target) { return this === target || this.children.some(node => node.contains(target)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    return selector.split(',').some(item => {
      const tag = item.trim().match(/^[a-z]+/i)?.[0];
      const attribute = item.match(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
      return (!tag || this.tagName === tag.toUpperCase()) && (!attribute ||
        (this.hasAttribute(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2])));
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture(t, { observe = true } = {}) {
  const document = new EventTarget();
  const observers = [];
  document.defaultView = observe ? {
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
  } : {};
  document.body = new Element(document, 'section');
  const root = document.body;
  const addIcon = ({ complete = false, width = 0, source = true, host = root } = {}) => {
    const frame = new Element(document), fallback = new Element(document), image = new Element(document, 'img');
    fallback.setAttribute('data-source-favicon-fallback', '');
    if (source) image.setAttribute('data-source-favicon', '');
    else image.setAttribute('data-image-preview', '');
    image.setAttribute('src', 'https://icon.fixture.test/favicon.ico');
    image.complete = complete;
    image.naturalWidth = width;
    frame.append(fallback, image); host.append(frame);
    return { frame, fallback, image };
  };
  const fire = (type, target) => {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    root.dispatchEvent(event);
  };
  const mutate = records => observers.filter(observer => observer.connected).forEach(observer => observer.callback(records));
  const create = () => {
    const controller = createSourceIconFallback({ root });
    t.after(() => controller.dispose());
    return controller;
  };
  return { document, root, observers, addIcon, fire, mutate, create };
}

function showsDefault(icon) { assert.equal(icon.image.hidden, true); assert.equal(icon.fallback.hidden, false); }
function showsFavicon(icon) { assert.equal(icon.image.hidden, false); assert.equal(icon.fallback.hidden, true); }

test('initial synchronization shows defaults for pending and cached failures while retaining a cached successful favicon', t => {
  const fx = fixture(t);
  const pending = fx.addIcon(), failed = fx.addIcon({ complete: true }), success = fx.addIcon({ complete: true, width: 16 });
  fx.create();
  showsDefault(pending);
  showsDefault(failed);
  showsFavicon(success);
});

test('actual image load and error state switch between the favicon and its default, including a pending replacement URL', t => {
  const fx = fixture(t), icon = fx.addIcon();
  fx.create();
  icon.image.complete = true; icon.image.naturalWidth = 16;
  fx.fire('load', icon.image); showsFavicon(icon);
  icon.image.naturalWidth = 0;
  fx.fire('error', icon.image); showsDefault(icon);
  icon.image.complete = true; icon.image.naturalWidth = 16;
  fx.fire('load', icon.image); showsFavicon(icon);
  icon.image.setAttribute('src', 'https://icon.fixture.test/replacement.ico');
  icon.image.complete = false; icon.image.naturalWidth = 0;
  fx.mutate([{ type: 'attributes', target: icon.image, attributeName: 'src' }]);
  showsDefault(icon);
  // A late load notification cannot pretend that the current URL has pixels.
  fx.fire('load', icon.image); showsDefault(icon);
  icon.image.complete = true; icon.image.naturalWidth = 24;
  fx.fire('load', icon.image); showsFavicon(icon);
});

test('subtree insertion and explicit synchronization recover images whose cache settled before their source row appeared', t => {
  const fx = fixture(t);
  const controller = fx.create();
  const container = new Element(fx.document, 'div');
  fx.root.append(container);
  const inserted = fx.addIcon({ complete: true, width: 32, host: container });
  fx.mutate([{ type: 'childList', target: fx.root, addedNodes: [container], removedNodes: [] }]);
  showsFavicon(inserted);
  inserted.image.naturalWidth = 0;
  controller.sync(container);
  showsDefault(inserted);
});

test('source handling ignores attachment pictures and disconnected rows, and disposal removes all later effects', t => {
  const fx = fixture(t);
  const icon = fx.addIcon({ complete: true, width: 16 });
  const attachment = fx.addIcon({ source: false, complete: true, width: 32 });
  attachment.image.hidden = true;
  const controller = fx.create();
  showsFavicon(icon);
  fx.fire('load', attachment.image);
  assert.equal(attachment.image.hidden, true);
  assert.equal(attachment.fallback.hidden, false);
  icon.frame.remove();
  icon.image.naturalWidth = 0;
  fx.fire('error', icon.image);
  controller.sync(icon.frame);
  showsFavicon(icon);
  const later = fx.addIcon();
  controller.sync(); showsDefault(later);
  controller.dispose();
  later.image.complete = true; later.image.naturalWidth = 16;
  fx.fire('load', later.image); controller.sync();
  fx.mutate([{ type: 'attributes', target: later.image, attributeName: 'src' }]);
  showsDefault(later);
  assert.ok(fx.observers.every(observer => !observer.connected));
});

test('capture events and manual cached synchronization remain usable without a mutation observer', t => {
  const fx = fixture(t, { observe: false }), icon = fx.addIcon();
  const controller = fx.create();
  showsDefault(icon);
  icon.image.complete = true; icon.image.naturalWidth = 16;
  fx.fire('load', icon.image); showsFavicon(icon);
  icon.image.naturalWidth = 0; controller.sync(); showsDefault(icon);
});
