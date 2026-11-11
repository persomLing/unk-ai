import test from 'node:test';
import assert from 'node:assert/strict';

import { generateContextualSuggestions } from '../src/sidepanel/features/messages/suggestions.js';

test('generates dynamic suggestions from mentioned files like manifest.json and config', () => {
  const answer = `如果想要，我可以直接读某个具体文件：
\`dist/chrome/manifest.json\` 、 \`default_config.json\` 这几个是未压缩的，能看到权限声明、内置站点规则。
要审实现细节，只能翻旧版归档仓库。`;

  const suggestions = generateContextualSuggestions(answer, '查看插件源码和设计', { url: 'https://github.com/foo/bar' });
  assert.equal(suggestions.length, 3);
  assert.equal(suggestions[0], '读一下 dist/chrome/manifest.json 的具体声明与规则');
  assert.equal(suggestions[1], '读一下 default_config.json 的具体声明与规则');
});

test('generates dynamic suggestions from dashboard bold metrics and optimization query', () => {
  const answer = `**账号池健康状况** 列出6个账号的运行态。
**本地内存持久化** 是自相矛盾的表述。
一个值得注意的指标：整体成功率 97.9% 却被标为「需关注」。`;

  const suggestions = generateContextualSuggestions(answer, '你觉得这个页面还有待优化的地方有哪些', { title: 'WorkBuddy2API 控制台' });
  assert.equal(suggestions.length, 3);
  assert.ok(suggestions.some((s) => s.includes('账号池健康状况')));
  assert.ok(suggestions.some((s) => s.includes('本地内存持久化')));
});

test('generates tailored suggestions for social post / 沸点', () => {
  const answer = `The page is a 掘金“沸点”帖子。作者表达了个人情绪，配了一张图片。信息局限较大。`;
  const suggestions = generateContextualSuggestions(answer, '请总结这个网页的主要内容', { title: '掘金沸点' });
  assert.equal(suggestions.length, 3);
  assert.ok(suggestions.some((s) => s.includes('分歧') || s.includes('争议') || s.includes('信息局限')));
});
