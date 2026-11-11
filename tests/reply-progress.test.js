import test from 'node:test';
import assert from 'node:assert/strict';
import { replyProgressLabel } from '../src/sidepanel/features/messages/reply-progress.js';

test('empty streaming replies show their real preparation phase instead of model thinking', () => {
  const expected = {
    preparing: '正在准备请求…',
    reading: '正在读取网页…',
    saving: '正在保存消息…',
    compressing: '正在整理历史消息…',
    'checking-research': '正在判断是否需要联网…',
    'web-research': '正在搜索并读取公开网页…',
    researching: '正在查找并读取站内相关文章…',
    'waiting-model': '正在等待模型输出…',
  };
  for (const [requestPhase, label] of Object.entries(expected)) {
    const actual = replyProgressLabel({ status: 'streaming', requestPhase });
    assert.equal(actual, label);
    assert.doesNotMatch(actual, /深度思考/);
  }
});

test('elapsed time belongs to the current phase and never becomes negative', () => {
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'reading', phaseStartedAt: 1000 }, 4999), '正在读取网页 · 3 秒…');
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'saving', phaseStartedAt: 6000 }, 5000), '正在保存消息…');
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'unrecognized' }), '正在等待模型输出…');
});

test('model output waits explain missing content after fifteen seconds without inventing provider activity', () => {
  const message = { status: 'streaming', requestPhase: 'waiting-model', phaseStartedAt: 1000 };
  assert.equal(replyProgressLabel(message, 15999), '正在等待模型输出 · 14 秒…');
  const waiting = replyProgressLabel(message, 16000);
  assert.equal(waiting, '正在等待模型输出 · 15 秒… 尚未收到正文或思考内容。');
  assert.doesNotMatch(waiting, /正在思考|正在排队|模型排队|网络缓慢/);
  assert.equal(replyProgressLabel({ ...message, content: '回答' }, 16000), '');
  assert.equal(replyProgressLabel({ ...message, reasoning: '实际返回的思考' }, 16000), '');
});

test('research phases retain their own elapsed time without the model output wait explanation', () => {
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'checking-research', phaseStartedAt: 1000 }, 18000), '正在判断是否需要联网 · 17 秒…');
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'web-research', phaseStartedAt: 18000 }, 21000), '正在搜索并读取公开网页 · 3 秒…');
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'researching', phaseStartedAt: 1000 }, 18000), '正在查找并读取站内相关文章 · 17 秒…');
  assert.equal(replyProgressLabel({ status: 'streaming', requestPhase: 'waiting-model', phaseStartedAt: 21000 }, 22000), '正在等待模型输出 · 1 秒…');
});

test('received content, reasoning, agent tasks and settled replies do not show preparation labels', () => {
  for (const message of [
    { status: 'streaming', content: 'Answer' },
    { status: 'streaming', reasoning: 'Model reasoning' },
    { status: 'streaming', agent: { taskId: 'agent' } },
    { status: 'complete' }, { status: 'error' }, { status: 'stopped' }, null,
  ]) assert.equal(replyProgressLabel(message), '');
  assert.equal(replyProgressLabel({ status: 'streaming', content: '', reasoning: '' }), '正在等待模型输出…');
});
