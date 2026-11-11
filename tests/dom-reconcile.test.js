import test from 'node:test';
import assert from 'node:assert/strict';
import { syncChildren } from '../src/sidepanel/features/messages/dom-reconcile.js';

class Node {
  constructor(nodeType, nodeName, nodeValue = '') {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
    this.parentNode = null;
    this.children = [];
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  replaceChild(next, current) {
    const index = this.children.indexOf(current);
    if (index < 0) throw new Error('missing child');
    next.remove();
    next.parentNode = this;
    this.children[index] = next;
    current.parentNode = null;
    return current;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}

class Element extends Node {
  constructor(name) {
    super(1, name.toUpperCase());
    this.attributes = new Map();
  }
  getAttributeNames() { return [...this.attributes.keys()]; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
}

const text = value => new Node(3, '#text', value);
const element = (name, children = [], attributes = {}) => {
  const node = new Element(name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  for (const child of children) node.appendChild(child);
  return node;
};

test('appending streamed markdown reuses existing blocks and text nodes', () => {
  const currentFirstText = text('第一段');
  const currentSecondText = text('第二段');
  const current = element('div', [
    element('p', [currentFirstText]),
    element('p', [currentSecondText]),
  ]);
  const next = element('div', [
    element('p', [text('第一段')]),
    element('p', [text('第二段继续')]),
    element('p', [text('第三段')]),
  ]);

  syncChildren(current, next);

  assert.equal(current.children.length, 3);
  assert.equal(current.children[0].children[0], currentFirstText, 'unchanged first paragraph text is reused');
  assert.equal(current.children[1].children[0], currentSecondText, 'growing paragraph text is updated in place');
  assert.equal(currentSecondText.nodeValue, '第二段继续');
  assert.equal(current.children[2].children[0].nodeValue, '第三段');
});

test('a changed markdown block is replaced without touching its siblings', () => {
  const kept = text('保留');
  const oldList = element('ul', [text('旧结构')]);
  const current = element('div', [oldList, element('p', [kept])]);
  const next = element('div', [element('p', [text('新结构')]), element('p', [text('保留')])]);

  syncChildren(current, next);

  assert.equal(current.children[0].nodeName, 'P');
  assert.equal(current.children[0].children[0].nodeValue, '新结构');
  assert.equal(current.children[1].children[0], kept, 'the compatible following node keeps its identity');
});
