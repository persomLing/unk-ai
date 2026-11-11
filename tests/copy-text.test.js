import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPlainText, messageCopyContent } from '../src/sidepanel/features/messages/copy-text.js';

test('plain copy removes presentation syntax while preserving Chinese paragraphs and line breaks', () => {
  assert.equal(markdownToPlainText('# 计算说明\n\n**价格**与*数量*，~~旧值~~。\n继续说明。  \n明确换行。\n\n> 引用的第一段\n>\n> 引用的第二段'),
    '计算说明\n\n价格与数量，旧值。\n继续说明。\n明确换行。\n\n引用的第一段\n\n引用的第二段');
});

test('ordered lists retain their starting number and nested lists remain indented', () => {
  assert.equal(markdownToPlainText('3. 第三项\n4. 第四项\n   - 子项一\n   - 子项二\n\n     子项二的补充说明\n5. 第五项'),
    '3. 第三项\n4. 第四项\n   • 子项一\n   • 子项二\n     \n     子项二的补充说明\n5. 第五项');
});

test('tables retain readable columns and rows without Markdown separator rows', () => {
  assert.equal(markdownToPlainText('| 商品 | 价格 | 资料 |\n| --- | ---: | --- |\n| **甲** | 150$ | [说明](https://example.com/a) |\n| 乙 | `x_y` | 无 |'),
    '商品\t价格\t资料\n甲\t150$\t说明 (https://example.com/a)\n乙\tx_y\t无');
});

test('code is copied verbatim without fences and preserves indentation, entities and blank lines', () => {
  assert.equal(markdownToPlainText('```js\nconst value = "**raw** &amp; $x_i$";\n  console.log(value);\n\n// end\n```\n\n行内 `a_b <tag> &amp;`。'),
    'const value = "**raw** &amp; $x_i$";\n  console.log(value);\n\n// end\n\n行内 a_b <tag> &amp;。');
});

test('links and images retain destinations, entities are decoded, and autolinks are not duplicated', () => {
  assert.equal(markdownToPlainText('[指南 &amp; 示例](https://example.com/docs?a=1&amp;b=2)\n\nhttps://example.com/guide\n\n![流程图](https://example.com/image.png)\n\nA &lt; B &#x4E2D; &copy;'),
    '指南 & 示例 (https://example.com/docs?a=1&b=2)\n\nhttps://example.com/guide\n\n流程图 (https://example.com/image.png)\n\nA < B 中 ©');
});

test('formulas keep TeX escapes and subscripts while surrounding Markdown is removed', () => {
  assert.equal(markdownToPlainText('**公式**：$x_i + y_j = \\frac{a}{b}$\n\n$$\n\\sum_{i=1}^{n} x_i\n$$\n\n\\(a_b + c_d\\) 与 \\[x_1\\]'),
    '公式：x_i + y_j = \\frac{a}{b}\n\n\\sum_{i=1}^{n} x_i\n\na_b + c_d 与 x_1');
});

test('prices, unmatched formula markers and visible raw HTML remain literal data', () => {
  assert.equal(markdownToPlainText('10元=150$，预算 $5 和 $6。\n\n未完成 $x_i\n\n<script>alert(1)</script>'),
    '10元=150$，预算 $5 和 $6。\n\n未完成 $x_i\n\n<script>alert(1)</script>');
});

test('copy content prefers the response and captures the original Markdown independently of future changes', () => {
  const message = { content: '**回答**\n\n- 第一项', reasoning: '思考内容' };
  const captured = messageCopyContent(message);
  message.content = '后续更新';
  assert.deepEqual(captured, { markdown: '**回答**\n\n- 第一项', plainText: '回答\n\n• 第一项', reasoningOnly: false });
});

test('reasoning-only fallback is explicit and empty messages stay empty', () => {
  assert.deepEqual(messageCopyContent({ content: ' \n ', reasoning: '**思考**过程' }),
    { markdown: '**思考**过程', plainText: '思考过程', reasoningOnly: true });
  assert.deepEqual(messageCopyContent({ content: '', reasoning: ' \n' }),
    { markdown: '', plainText: '', reasoningOnly: false });
  assert.deepEqual(messageCopyContent(null), { markdown: '', plainText: '', reasoningOnly: false });
});
