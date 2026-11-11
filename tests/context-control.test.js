import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Only entry-owned presentation runs here; context budgeting/compression have direct-import tests.
const entry = readFileSync(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const start = entry.indexOf('function setContextPanel(open) {');
const end = entry.indexOf('function refreshContextUsage(options)', start);
assert.ok(start >= 0 && end > start);
const adapter = entry.slice(start, end);

function fixture({ model = { name: 'Example model' } } = {}) {
  const nodes = new Map();
  for (const id of ['context-meter-button', 'context-meter-label', 'context-progress-bar', 'context-model-name',
    'context-used-percent', 'context-remaining-percent', 'context-token-count', 'context-threshold-label', 'context-popover']) {
    const attributes = new Map(), classes = new Set();
    nodes.set(`#${id}`, {
      hidden: true, textContent: '', title: '', dataset: {}, style: {},
      classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: name => attributes.get(name),
    });
  }
  let usage;
  const state = { contextClosed: true, conversation: null, pendingPage: null };
  const context = vm.createContext({ state,
    $: selector => nodes.get(selector),
    currentContextUsage: () => usage,
    activeChatProfile: () => model,
    formatTokenCount: value => String(value),
    normalizePageContext: () => null,
    pageContextStats: () => ({}),
  });
  vm.runInContext(adapter, context);
  return { state, node: id => nodes.get(`#${id}`),
    render(percent) {
      usage = { percent, used: percent * 10, total: 1000, threshold: 900,
        remainingPercent: Math.max(0, 100 - percent), shouldCompress: percent >= 90 };
      context.renderContextUsage();
      return usage;
    },
    setPanel: open => context.setContextPanel(open),
  };
}

test('conversation organization control exposes usage through accessible text and tooltip without a ring', () => {
  const value = fixture();
  const usage = value.render(24);
  const button = value.node('context-meter-button');
  const description = '会话整理 · 容量已用 24%，点击查看详情与整理';
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-label'), description);
  assert.equal(button.title, description);
  assert.equal(button.dataset.tooltip, description);
  assert.equal(value.node('context-meter-label').textContent, '24%');
  assert.equal(value.node('context-progress-bar').style.width, '24%');
  assert.equal(value.state.contextUsage, usage);
  assert.equal(value.node('context-model-name').textContent, 'Example model');
});

test('the icon control preserves warning and danger thresholds and clears stale severity', () => {
  const value = fixture();
  for (const [percent, warning, danger] of [[20, false, false], [75, true, false], [89, true, false], [90, false, true], [100, false, true], [40, false, false]]) {
    value.render(percent);
    const button = value.node('context-meter-button');
    assert.equal(button.classList.contains('warning'), warning, `warning at ${percent}%`);
    assert.equal(button.classList.contains('danger'), danger, `danger at ${percent}%`);
    assert.match(button.dataset.tooltip, new RegExp(`容量已用 ${percent}%`));
  }
});

test('over-capacity usage keeps the trimming explanation and clamps only the popover progress bar', () => {
  const value = fixture();
  const usage = value.render(143);
  const button = value.node('context-meter-button');
  const description = '会话整理 · 资料估算为容量的 143%，发送前将按预算裁剪，点击查看详情与整理';
  assert.equal(button.getAttribute('aria-label'), description);
  assert.equal(button.title, description);
  assert.equal(button.dataset.tooltip, description);
  assert.equal(button.classList.contains('danger'), true);
  assert.equal(value.node('context-meter-label').textContent, '待裁剪');
  assert.equal(value.node('context-progress-bar').style.width, '100%');
  assert.match(value.node('context-threshold-label').textContent, /不是实际发送量或账单用量/);
  assert.equal(usage.percent, 143);
  assert.equal(usage.shouldCompress, true);
});

test('the control remains hidden without a selected model', () => {
  const value = fixture({ model: null });
  value.render(0);
  assert.equal(value.node('context-meter-button').hidden, true);
  assert.equal(value.node('context-model-name').textContent, '');
  assert.equal(value.node('context-progress-bar').style.width, '0%');
});

test('opening the existing popover still renders details and closing preserves the compact control', () => {
  const value = fixture();
  value.render(75);
  value.setPanel(true);
  assert.equal(value.node('context-popover').hidden, false);
  assert.equal(value.node('context-meter-button').getAttribute('aria-expanded'), 'true');
  assert.equal(value.node('context-used-percent').textContent, '75% 已用');
  value.setPanel(false);
  assert.equal(value.node('context-popover').hidden, true);
  assert.equal(value.node('context-meter-button').getAttribute('aria-expanded'), 'false');
  assert.equal(value.node('context-meter-button').hidden, false);
});
