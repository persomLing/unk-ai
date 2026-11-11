import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/sidepanel/features/messages/message-view.js', import.meta.url), 'utf8');
const guard = source.slice(source.indexOf('function protectMath'), source.indexOf('function replaceToken'));
const protectMath = new Function(`${guard}\nreturn protectMath;`)();

test('KaTeX warnings are disabled and CJK prose is rejected before rendering', () => {
  assert.match(source, /throwOnError:\s*true/);
  assert.match(source, /strict:\s*'ignore'/);
  assert.match(source, /\[\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\]/);
});

test('prices, Chinese prose and shell text remain ordinary text', () => {
  for (const text of ['门票 $90—120 元', '最近“异常”，包含中文', '$2c012ac1-b9f7-439f-9144-e6cb5c2ef4…']) {
    const protectedText = protectMath(text);
    assert.equal(protectedText.expressions.length, 0, text);
    assert.equal(protectedText.text, text);
  }
  assert.equal(protectMath('公式 $E=mc^2$').expressions.length, 1);
});
