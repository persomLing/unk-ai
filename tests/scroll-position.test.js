import test from 'node:test';
import assert from 'node:assert/strict';
import { captureViewPosition, restoreViewPosition } from '../src/sidepanel/features/messages/scroll-position.js';

function fixture() {
  let top = 300;
  const view = {
    clientHeight: 400,
    scrollHeight: 1200,
    dataset: {},
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect() { return { top: 100, bottom: 500 }; },
  };
  let articles = [];
  function article(id, layoutTop, height, panels = {}) {
    return {
      dataset: { messageId: id },
      layoutTop, height,
      querySelectorAll(selector) { return panels[selector] || []; },
      getBoundingClientRect() {
        const top = 100 + this.layoutTop - view.scrollTop;
        return { top, bottom: top + this.height };
      },
    };
  }
  const messages = { querySelectorAll() { return articles; } };
  return { view, messages, article, replace(value) { articles = value; } };
}

function panel({ top = 0, left = 0, height = 500, client = 100 } = {}) {
  return { scrollTop: top, scrollLeft: left, scrollHeight: height, clientHeight: client };
}

test('growth above the visible message preserves the same text position', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('old', 0, 250), article('visible', 250, 500)]);
  const saved = captureViewPosition(view, messages);
  assert.equal(saved.anchorId, 'visible');
  assert.equal(saved.offset, -50);

  const anchor = article('visible', 400, 500);
  replace([article('old', 0, 400), anchor]);
  view.scrollTop = 0; // Subtree replacement can reset browser scroll state.
  restoreViewPosition(view, messages, saved, false);
  assert.equal(view.scrollTop, 450);
  assert.equal(anchor.getBoundingClientRect().top - view.getBoundingClientRect().top, saved.offset);
});

test('replaced thinking and table panels retain independent vertical and horizontal positions', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('answer', 250, 800, {
    '.thinking-content': [panel({ top: 80 })],
    '.md-table-scroll': [panel({ left: 150, height: 100 }), panel({ left: 330, height: 100 })],
  })]);
  const saved = captureViewPosition(view, messages);
  const thinking = panel({ height: 900 });
  const tables = [panel({ height: 100 }), panel({ height: 100 })];
  replace([article('answer', 250, 900, { '.thinking-content': [thinking], '.md-table-scroll': tables })]);
  restoreViewPosition(view, messages, saved, false);
  assert.equal(thinking.scrollTop, 80);
  assert.deepEqual(tables.map(item => item.scrollLeft), [150, 330]);
});

test('a nested panel follows appended text only if it was already at the bottom', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('answer', 250, 800, {
    '.thinking-content': [panel({ top: 70 })],
    '.message-agent-body': [panel({ top: 400 })],
  })]);
  const saved = captureViewPosition(view, messages);
  const thinking = panel({ height: 750 });
  const agent = panel({ height: 800 });
  replace([article('answer', 250, 900, { '.thinking-content': [thinking], '.message-agent-body': [agent] })]);
  restoreViewPosition(view, messages, saved, true);
  assert.equal(view.scrollTop, view.scrollHeight - view.clientHeight);
  assert.equal(thinking.scrollTop, 70);
  assert.equal(agent.scrollTop, 700);
});

test('missing messages and panels do not throw or force an unrelated scroll anchor', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('removed', 250, 800, { '.thinking-content': [panel({ top: 80 })] })]);
  const saved = captureViewPosition(view, messages);
  replace([article('other', 0, 1100)]);
  view.scrollTop = 100;
  assert.doesNotThrow(() => restoreViewPosition(view, messages, saved, false));
  assert.equal(view.scrollTop, saved.top);
});

function errorPanel(options = {}, expanded = true) {
  return { ...panel(options), closest: () => ({ classList: { contains: name => name === 'is-expanded' && expanded } }) };
}

test('expanded error diagnostics and thinking retain separate reading positions', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('answer', 250, 800, {
    '.thinking-content': [panel({ top: 60 })],
    '.message-error-detail': [errorPanel({ top: 190 })],
  })]);
  const saved = captureViewPosition(view, messages);
  const thinking = panel({ height: 900 });
  const error = errorPanel({ height: 1100 });
  replace([article('answer', 250, 900, { '.thinking-content': [thinking], '.message-error-detail': [error] })]);
  restoreViewPosition(view, messages, saved, false);
  assert.equal(thinking.scrollTop, 60);
  assert.equal(error.scrollTop, 190);
  assert.equal(view.scrollTop, 300);
});

test('collapsing an error restores its opening lines instead of a hidden mid-diagnostic scroll position', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('answer', 250, 800, { '.message-error-detail': [errorPanel({ top: 270 })] })]);
  const saved = captureViewPosition(view, messages);
  const collapsed = errorPanel({ top: 270, client: 37 }, false);
  replace([article('answer', 250, 500, { '.message-error-detail': [collapsed] })]);
  restoreViewPosition(view, messages, saved, false);
  assert.equal(collapsed.scrollTop, 0);
  assert.equal(view.scrollTop, 300);
});

test('expanding a collapsed error begins at the top and never inherits follow-to-bottom from the preview', () => {
  const { view, messages, article, replace } = fixture();
  replace([article('answer', 250, 500, { '.message-error-detail': [errorPanel({ height: 37, client: 37 }, false)] })]);
  const saved = captureViewPosition(view, messages);
  assert.equal(saved.panels.length, 0);
  const expanded = errorPanel({ height: 1100 });
  replace([article('answer', 250, 800, { '.message-error-detail': [expanded] })]);
  restoreViewPosition(view, messages, saved, false);
  assert.equal(expanded.scrollTop, 0);
  assert.equal(view.scrollTop, 300);
});
