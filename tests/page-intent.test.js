import test from "node:test";
import assert from "node:assert/strict";

import { asksForCurrentPage } from "../src/utils/page-intent.js";

test("explicit page references trigger a current-page read on their own", () => {
  assert.equal(asksForCurrentPage("本页面"), true);
  assert.equal(asksForCurrentPage("当前页面"), true);
  assert.equal(asksForCurrentPage("当前页"), true);
  assert.equal(asksForCurrentPage("这个网页"), true);
  assert.equal(asksForCurrentPage("这篇 PDF"), true);
  assert.equal(asksForCurrentPage("THIS PAGE"), true);
  assert.equal(asksForCurrentPage("Current Page"), true);
  assert.equal(asksForCurrentPage("This PDF"), true);
});

test("natural-language requests for the current page are detected", () => {
  assert.equal(asksForCurrentPage("这个页面讲了什么，帮我总结一下"), true);
  assert.equal(asksForCurrentPage("总结本篇文章的核心观点"), true);
  assert.equal(asksForCurrentPage("当前网页里的内容主要是什么"), true);
  assert.equal(asksForCurrentPage("这一课讲了哪些概念"), true);
  assert.equal(asksForCurrentPage("总结这个 PDF 的主要内容"), true);
  assert.equal(asksForCurrentPage("这份 PDF 讲了什么"), true);
  assert.equal(asksForCurrentPage("查看本页面的项目"), true);
});

test("ordinary summarization requests do not read the tab", () => {
  assert.equal(asksForCurrentPage("总结一下这段话"), false);
  assert.equal(asksForCurrentPage("帮我概括刚才的回答"), false);
  assert.equal(asksForCurrentPage("你好"), false);
  assert.equal(asksForCurrentPage("这个怎么理解"), false);
  assert.equal(asksForCurrentPage("本文怎么理解"), false);
  assert.equal(asksForCurrentPage("这个是什么"), false);
});

