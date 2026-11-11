const EXPLICIT_PAGE_REFERENCE = /(?:当前|这个|这|本|该|这一|此)(?:个)?(?:网页|页面|页)|(?:本|这|当前|该|这一)(?:篇|份|节)?(?:文章|章节|课|节)|(?:这|此|本|该|当前)(?:个|篇|份)?\s*pdf|(?:this|current|the)\s+(?:page|webpage|pdf)/i;
const CONTEXTUAL_PAGE_REFERENCE = /(?:当前|这个|本|这一|此)(?:个)?(?:网页|页面|文章|篇|课|章节)|(?:网页|页面)(?:中|里|内|上|内容|正文)|本页|这页|当前页|全文|文中|文章里|本篇文章|这篇文章|这一课|本课|这一节|本节|(?:当前|这个|本|该|这份|此)?(?:PDF|pdf)/i;
const PAGE_ACTION = /(?:总结|概括|提炼|归纳|分析|解释|讲解|梳理|翻译|看看|看一下|读一下|主要内容|核心观点|讲了什么|讲了哪些|说了什么|是什么|怎么理解|要点)/;

/**
 * An explicit page reference is enough to request the current tab. Weaker
 * content references still need an action so "这个怎么理解" stays in-chat.
 */
export function asksForCurrentPage(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return false;
  return EXPLICIT_PAGE_REFERENCE.test(text)
    || (CONTEXTUAL_PAGE_REFERENCE.test(text) && PAGE_ACTION.test(text));
}

