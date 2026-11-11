import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryLayout } from '../src/sidepanel/features/history/history-layout.js';

function fixture(width = 420) {
  const document = { activeElement: null }, listeners = new Set(), notices = [];
  const node = parentNode => {
    const attributes = new Map(), classes = new Set();
    const element = { parentNode, ownerDocument: document, inert: false, hidden: false, focusCalls: [],
      classList: { contains: name => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
      setAttribute: (name, value) => attributes.set(name, String(value)), removeAttribute: name => attributes.delete(name),
      getAttribute: name => attributes.get(name) ?? null,
      contains(other) { for (let current = other; current; current = current.parentNode) if (current === element) return true; return false; },
      focus(options) { element.focusCalls.push(options); document.activeElement = element; },
    };
    Object.defineProperty(element, 'innerHTML', { set() { throw new Error('Layout cannot rebuild history DOM'); } });
    return element;
  };
  const app = node(), drawer = node(app), backdrop = node(app), trigger = node(app), closeButton = node(drawer), searchInput = node(drawer),
    composer = node(app), row = node(drawer);
  document.activeElement = composer;
  const media = { matches: width >= 960,
    addEventListener(type, listener) { assert.equal(type, 'change'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'change'); listeners.delete(listener); },
  };
  const window = { innerWidth: width, matchMedia(query) { assert.equal(query, '(min-width: 960px)'); return media; } };
  const layout = createHistoryLayout({ app, drawer, backdrop, trigger, closeButton, searchInput, window,
    onOpenChange: value => notices.push(value) });
  return { layout, app, drawer, backdrop, trigger, closeButton, searchInput, composer, row, document, notices, listeners, media,
    resize(next) { window.innerWidth = next; const changed = media.matches !== (next >= 960); media.matches = next >= 960;
      if (changed) for (const listener of [...listeners]) listener({ matches: media.matches }); },
  };
}

function assertVisibility(value, { open, docked, dialog }) {
  assert.equal(value.layout.isOpen(), open);
  assert.equal(value.layout.isDocked(), docked);
  assert.equal(value.app.classList.contains('history-docked'), docked);
  assert.equal(value.drawer.classList.contains('open'), open);
  assert.equal(value.drawer.getAttribute('aria-hidden'), String(!open));
  assert.equal(value.drawer.inert, !open);
  assert.equal(value.backdrop.hidden, !open || docked);
  assert.equal(value.trigger.getAttribute('aria-expanded'), String(open));
  assert.equal(value.trigger.getAttribute('aria-haspopup'), dialog ? 'dialog' : null);
}

test('narrow startup keeps the existing drawer closed without moving composer focus', () => {
  const value = fixture();
  assertVisibility(value, { open: false, docked: false, dialog: true });
  assert.equal(value.document.activeElement, value.composer);
  assert.deepEqual(value.notices, [false]);
});

test('960px automatically docks the same history DOM and leaves the active input focused', () => {
  const value = fixture(960), originalDrawer = value.drawer;
  assertVisibility(value, { open: true, docked: true, dialog: false });
  assert.equal(value.drawer, originalDrawer);
  assert.equal(value.document.activeElement, value.composer);
  assert.equal(value.searchInput.focusCalls.length, 0);
  assert.deepEqual(value.notices, [true]);
});

test('crossing the breakpoint opens wide and closes narrow, while same-mode sync preserves user choices', () => {
  const value = fixture(959);
  value.resize(960); assertVisibility(value, { open: true, docked: true, dialog: false });
  value.resize(1259); value.layout.sync(); assertVisibility(value, { open: true, docked: true, dialog: false });
  value.resize(959); assertVisibility(value, { open: false, docked: false, dialog: true });
  assert.equal(value.document.activeElement, value.composer);
  value.resize(960); assertVisibility(value, { open: true, docked: true, dialog: false });
  assert.deepEqual(value.notices, [false, true, false, true]);
});

test('manual wide close stays collapsed until explicitly opened or the next narrow-to-wide transition', () => {
  const value = fixture(1259);
  value.row.focus(); value.layout.setOpen(false);
  assertVisibility(value, { open: false, docked: false, dialog: false });
  assert.equal(value.document.activeElement, value.trigger);
  value.resize(1100); value.layout.sync(); assert.equal(value.layout.isOpen(), false);
  value.layout.setOpen(true);
  assertVisibility(value, { open: true, docked: true, dialog: false });
  assert.equal(value.document.activeElement, value.searchInput);
  value.layout.setOpen(false); value.resize(959); value.composer.focus(); value.resize(960);
  assertVisibility(value, { open: true, docked: true, dialog: false });
  assert.equal(value.document.activeElement, value.composer);
});

test('narrow explicit opening focuses search and every explicit close restores the history trigger', () => {
  const value = fixture();
  value.layout.setOpen(true); assertVisibility(value, { open: true, docked: false, dialog: true });
  assert.equal(value.document.activeElement, value.searchInput);
  value.layout.setOpen(false); assert.equal(value.document.activeElement, value.trigger);
  value.layout.setOpen(true); value.composer.focus(); value.layout.setOpen(false);
  assert.equal(value.document.activeElement, value.trigger);
  assert.equal(value.trigger.focusCalls.length, 2);
});

test('backdrop or close-button pointerdown moving focus to BODY cannot prevent explicit close focus restoration', () => {
  for (const width of [420, 960]) {
    const value = fixture(width);
    value.layout.setOpen(true);
    value.document.activeElement = { tagName: 'BODY' };
    value.layout.setOpen(false);
    assert.equal(value.document.activeElement, value.trigger);
    assertVisibility(value, { open: false, docked: false, dialog: width < 960 });
  }
});

test('wide conversation navigation keeps the panel open and never pulls focus into history', () => {
  const value = fixture(960);
  value.composer.focus(); value.layout.setOpen(false, { keepDocked: true });
  assertVisibility(value, { open: true, docked: true, dialog: false });
  assert.equal(value.document.activeElement, value.composer);
  assert.equal(value.searchInput.focusCalls.length, 0);
  value.row.focus(); value.layout.setOpen(false, { keepDocked: true });
  assert.equal(value.document.activeElement, value.row, 'the still-visible history row need not lose focus');
  value.layout.setOpen(false); value.composer.focus(); value.layout.setOpen(false, { keepDocked: true });
  assert.equal(value.layout.isOpen(), false, 'navigation cannot reopen a manually collapsed wide panel');
  assert.equal(value.document.activeElement, value.composer);
});

test('keepDocked closes narrow navigation normally and a shrinking panel moves only its own focus', () => {
  const value = fixture();
  value.layout.setOpen(true); value.layout.setOpen(false, { keepDocked: true });
  assertVisibility(value, { open: false, docked: false, dialog: true });
  value.resize(960); value.row.focus(); value.resize(959);
  assert.equal(value.document.activeElement, value.trigger);
  value.composer.focus(); value.resize(960); value.resize(959);
  assert.equal(value.document.activeElement, value.composer);
});

test('explicit opening can use the existing close button when no search input is supplied', () => {
  const value = fixture(); value.layout.dispose();
  const layout = createHistoryLayout({ app: value.app, drawer: value.drawer, backdrop: value.backdrop,
    trigger: value.trigger, closeButton: value.closeButton, window: { matchMedia: () => value.media } });
  layout.setOpen(true); assert.equal(value.document.activeElement, value.closeButton);
});

test('dispose removes the media listener and ignores late resize and user commands', () => {
  const value = fixture(960), lateListener = [...value.listeners][0];
  value.layout.dispose(); value.layout.dispose();
  assert.equal(value.listeners.size, 0);
  const notices = [...value.notices], focusCalls = value.searchInput.focusCalls.length;
  value.media.matches = false; lateListener({ matches: false }); value.layout.sync(); value.layout.setOpen(false);
  assertVisibility(value, { open: true, docked: true, dialog: false });
  assert.deepEqual(value.notices, notices);
  assert.equal(value.searchInput.focusCalls.length, focusCalls);
});
