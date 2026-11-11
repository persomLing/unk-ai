import test from 'node:test';
import assert from 'node:assert/strict';
import { needsPageQuestionChoice, createPageQuestionChoice } from '../src/sidepanel/features/page-reading/page-question-choice.js';

const active = { tabId: 7, url: 'https://page.test/config', title: '配置页' };
test('disabled page mode offers a choice for page questions and new ambiguous configuration questions', () => {
  for (const question of ['总结当前页', '不太懂这些配置啥的跟我讲一讲', '这个怎么选']) {
    assert.equal(needsPageQuestionChoice({ question, enabled: false, active }), true);
  }
  for (const extra of [{ enabled: true }, { independent: true }, { agentMode: true }, { active: null }]) {
    assert.equal(needsPageQuestionChoice({ question: '总结当前页', enabled: false, active, ...extra }), false);
  }
});

test('ordinary conversation, attachments and selections do not prompt unnecessarily', () => {
  for (const extra of [
    { question: '解释vCPU是什么' }, { question: '你好' },
    { question: '这些配置怎么选', messages: [{ role: 'assistant', content: '下面是配置建议' }] },
    { question: '这份PDF讲什么', attachments: [{}] },
    { question: '这个怎么选', selection: { text: '选中文字' } },
  ]) assert.equal(needsPageQuestionChoice({ enabled: false, active, ...extra }), false);
  assert.equal(needsPageQuestionChoice({ enabled: false, active, question: '结合当前页解释附件', attachments: [{}] }), true);
});

function fixture() {
  const state = { conversation: {}, draft: '这些配置怎么选', tabId: 7, url: active.url,
    title: active.title, mode: 'chat', source: '', selection: '', attachments: [] };
  const renders = [], submissions = [];
  let enables = 0;
  const choice = createPageQuestionChoice({ snapshot: () => ({ ...state, attachments: [...state.attachments] }),
    render: value => renders.push(value), enablePage: () => { enables++; },
    submit: (text, options) => { submissions.push({ text, options }); },
  });
  return { state, renders, submissions, choice, enables: () => enables };
}

test('a choice submits once and ordinary choice never enables page reading', () => {
  for (const usePage of [true, false]) {
    const fx = fixture();
    fx.choice.offer(fx.state.draft);
    assert.equal(fx.submissions.length, 0);
    fx.choice.choose(usePage);
    fx.choice.choose(usePage);
    assert.equal(fx.submissions.length, 1);
    assert.equal(fx.enables(), Number(usePage));
    assert.equal(fx.submissions[0].options.pageContextEnabled, usePage);
    assert.equal(fx.submissions[0].options.requirePage, usePage);
  }
});

test('navigation, edits, attachments and conversation changes invalidate pending choices', () => {
  for (const change of [state => { state.url += '#/new'; }, state => { state.tabId++; },
    state => { state.draft += '!'; }, state => { state.conversation = {}; },
    state => { state.attachments.push({}); }, state => { state.selection = 'new selection'; },
    state => { state.mode = 'agent'; }, state => { state.source = 'independent'; }]) {
    const fx = fixture();
    fx.choice.offer(fx.state.draft);
    change(fx.state);
    fx.choice.choose(true);
    assert.equal(fx.submissions.length, 0);
    assert.equal(fx.enables(), 0);
  }
});
