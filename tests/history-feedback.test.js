import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryFeedback } from '../src/sidepanel/features/history/history-feedback.js';

function fixture() {
  let current = 0;
  const scheduled = [];
  const changes = [];
  const feedback = createHistoryFeedback({
    now: () => current,
    setTimer: (callback, delay) => {
      const timer = { callback, at: current + delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
    onChange: value => changes.push(value),
  });
  return { feedback, scheduled, changes,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const next = scheduled.filter(timer => !timer.cleared && timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        current = next.at;
        next.cleared = true;
        next.callback();
      }
      current = target;
    },
  };
}

test('an ordinary history notice disappears after exactly three seconds', () => {
  const value = fixture();
  value.feedback.show('名称已保存');
  value.advance(2999);
  assert.equal(value.feedback.snapshot().notice.message, '名称已保存');
  value.advance(1);
  assert.equal(value.feedback.snapshot().notice, null);
  assert.equal(value.changes.length, 2);
});

test('a new notice gets a fresh lifetime and cannot be closed by an old timer callback', () => {
  const value = fixture();
  value.feedback.show('第一条提示');
  const first = value.scheduled[0];
  value.advance(2500);
  value.feedback.show('第二条提示');
  first.callback();
  value.advance(500);
  assert.equal(value.feedback.snapshot().notice.message, '第二条提示');
  value.advance(2500);
  assert.equal(value.feedback.snapshot().notice, null);
});

test('manual close hides feedback immediately and invalidates its timer', () => {
  const value = fixture();
  value.feedback.show('已移动对话');
  value.advance(200);
  value.feedback.dismiss();
  assert.equal(value.feedback.snapshot().notice, null);
  const count = value.changes.length;
  value.scheduled[0].callback();
  value.advance(4000);
  assert.equal(value.changes.length, count);
});

test('hover pauses the remaining time and leaving resumes it without restarting the full delay', () => {
  const value = fixture();
  value.feedback.show('已移动对话');
  value.advance(1200);
  value.feedback.pause('hover');
  value.advance(10000);
  assert.equal(value.feedback.snapshot().notice.message, '已移动对话');
  value.feedback.pause('hover', false);
  value.advance(1799);
  assert.ok(value.feedback.snapshot().notice);
  value.advance(1);
  assert.equal(value.feedback.snapshot().notice, null);
});

test('keyboard focus keeps feedback paused after the pointer leaves', () => {
  const value = fixture();
  value.feedback.show('已删除 1 条', { undoToken: 'deleted-a' });
  value.advance(1000);
  value.feedback.pause('hover');
  value.feedback.pause('focus');
  value.feedback.pause('hover', false);
  value.advance(4000);
  assert.ok(value.feedback.snapshot().notice);
  value.feedback.pause('focus', false);
  value.advance(2000);
  assert.equal(value.feedback.snapshot().notice, null);
  assert.equal(value.feedback.snapshot().undoToken, 'deleted-a');
});

test('a replacement notice shown while hovered receives three seconds after interaction ends', () => {
  const value = fixture();
  value.feedback.show('原提示');
  value.advance(2700);
  value.feedback.pause('hover');
  value.feedback.show('更新后的提示');
  value.advance(5000);
  value.feedback.pause('hover', false);
  value.advance(2999);
  assert.equal(value.feedback.snapshot().notice.message, '更新后的提示');
  value.advance(1);
  assert.equal(value.feedback.snapshot().notice, null);
});

test('deletion feedback expires or closes without losing the undo token', () => {
  const value = fixture();
  value.feedback.show('已删除 1 条', { undoToken: 'batch-a' });
  value.advance(3000);
  assert.deepEqual(value.feedback.snapshot(), { notice: null, undoToken: 'batch-a' });
  value.feedback.show('已删除 2 条', { undoToken: 'batch-b' });
  value.feedback.dismiss();
  assert.deepEqual(value.feedback.snapshot(), { notice: null, undoToken: 'batch-b' });
});

test('moving or renaming never inherits the delete action from an earlier notice', () => {
  const value = fixture();
  value.feedback.show('已删除 1 条', { undoToken: 'batch-a' });
  value.feedback.show('已将 1 条对话移至学习');
  assert.deepEqual(value.feedback.snapshot(), {
    notice: { message: '已将 1 条对话移至学习', undoToken: null },
    undoToken: 'batch-a',
  });
  value.feedback.show('名称已保存');
  assert.equal(value.feedback.snapshot().notice.undoToken, null);
});

test('restoring the last deletion makes undo available without resurrecting a dismissed notice', () => {
  const value = fixture();
  value.feedback.rememberUndo('previous-session-batch');
  assert.deepEqual(value.feedback.snapshot(), { notice: null, undoToken: 'previous-session-batch' });
  assert.equal(value.scheduled.length, 0);
});

test('partial undo retains recovery and an old completion cannot clear a newer deletion', () => {
  const value = fixture();
  value.feedback.show('已删除 1 条', { undoToken: 'batch-a' });
  value.feedback.resolveUndo('batch-a', { pending: true });
  assert.equal(value.feedback.snapshot().undoToken, 'batch-a');
  value.feedback.show('已删除 2 条', { undoToken: 'batch-b' });
  value.feedback.resolveUndo('batch-a');
  assert.equal(value.feedback.snapshot().undoToken, 'batch-b');
  value.feedback.resolveUndo('batch-b');
  assert.equal(value.feedback.snapshot().undoToken, null);
  assert.equal(value.feedback.snapshot().notice.undoToken, null);
});

test('disposing clears timers and refuses late notices or callbacks', () => {
  const value = fixture();
  value.feedback.show('已移动对话');
  const timer = value.scheduled[0];
  const count = value.changes.length;
  value.feedback.dispose();
  timer.callback();
  value.feedback.show('迟到提示');
  value.feedback.rememberUndo('late-batch');
  value.advance(4000);
  assert.equal(timer.cleared, true);
  assert.equal(value.changes.length, count);
  assert.deepEqual(value.feedback.snapshot(), { notice: null, undoToken: null });
});
