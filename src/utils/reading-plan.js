const SCOPES = new Set(['none', 'page', 'auto', 'site']);
const bounded = (value, size = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);
const SITE_REQUEST = /本站|站内|这个站|这个网站|整个网站|目录|章节|相关文章|相关章|哪[一几]?章|第\s*\d+\s*章|\bchapters?\b|\bon this site\b/i;
const PAGE_REQUEST = /这(?:个|份|篇)?(?:网页|页面|文档|文章)|本页|当前页|当前网页|本文|\bthis page\b|\bcurrent page\b/i;
const READ_REQUEST = /总结|概括|解释|介绍|了解|阅读|读完|重点|区别|比较|对比|怎么|如何|原理|用法|实现|内容|summari[sz]e|explain|compare|read\b/i;
const LOCATE_REQUEST = /找|定位|哪里|在哪|有没有|哪[一几]?章|目录|\bfind\b|\bwhere\b|\blocate\b/i;

export function normalizeReadingPolicy(value) {
  if (!value || value.version !== 1 || !SCOPES.has(value.scope)) return null;
  const selectedUrls = [...new Set((Array.isArray(value.selectedUrls) ? value.selectedUrls : [])
    .filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)).map(url => url.slice(0, 2000)))].slice(0, 3);
  return { version: 1, scope: value.scope, intent: value.intent === 'locate' ? 'locate' : 'read',
    reason: bounded(value.reason, 120),
    ...(value.scope !== 'none' && value.requireCurrentPage === true ? { requireCurrentPage: true } : {}),
    ...(value.baseUrl ? { baseUrl: bounded(value.baseUrl) } : {}),
    ...(value.planned === true ? { planned: true, selectedUrls } : {}),
  };
}

/** Local policy only: page text can never turn itself into a request to read more. */
export function readingPolicyForTurn({ question = '', pageContextEnabled = true, directModelRequest = false, selection, attachments = [], mode = 'chat', pageTitle = '' } = {}) {
  const query = bounded(question);
  const policy = (scope, reason) => ({ version: 1, scope,
    intent: LOCATE_REQUEST.test(query) && !READ_REQUEST.test(query) ? 'locate' : 'read', reason,
    ...(scope !== 'none' ? { requireCurrentPage: true } : {}) });
  if (!pageContextEnabled || directModelRequest || ['agent', 'operation', 'page-operation'].includes(mode)) return policy('none', 'page-disabled-or-direct');
  const site = SITE_REQUEST.test(query);
  if (attachments.length && (/附件|上传(?:的)?文件|这(?:张|个|份)(?:图片|文件|文档)|attached|attachment/i.test(query)
    || !site && !/这页|本页|当前页|网页|page\b/i.test(query))) return policy('page', 'page-with-attachments');
  if (/只(?:看|读|解释|总结|使用|基于)|仅(?:看|读|解释|总结|使用|基于)|only (?:this|the current|selected)/i.test(query)
    && /这页|本页|当前页|本文|这段|选中|选区|this page|current page|selection|selected/i.test(query)) return policy('page', 'explicit-local');
  if (!site && (selection?.text || /(?:总结|概括|解释|翻译)(?:一下)?(?:这页|本页|当前页|本文|这段|选中)|结合上下文|这(?:句话|段话)|(?:上面|下面|这里)这段|summari[sz]e (?:this|the current) page/i.test(query))) return policy('page', 'current-page-or-selection');
  if (!site && PAGE_REQUEST.test(query)) return policy('page', 'explicit-current-page');
  if (site) return policy('auto', 'explicit-site-question');
  // Page mode always includes the current body. Topic matching only decides
  // whether related site chapters may supplement that required source.
  if (scoreReadingCandidate(query, { title: pageTitle }) > 0) return policy('auto', 'topic-on-current-site');
  return policy('page', 'page-mode-enabled');
}

/** Upgrading the app must not broaden a historical turn when it is retried. */
export function readingPolicyForRetry(message = {}) {
  if (message.pageContextEnabled === false || message.agentTask || message.mode === 'operation') return { version: 1, scope: 'none', intent: 'read', reason: 'original-page-disabled' };
  const recorded = normalizeReadingPolicy(message.readingPolicy);
  if (recorded) return recorded;
  if (!message.pageSource?.url && message.pageContextEnabled !== true && message.researchEnabled !== true) return { version: 1, scope: 'none', intent: 'read', reason: 'legacy-without-page' };
  return { version: 1, scope: message.researchEnabled === true ? 'site' : 'page', intent: 'read', reason: 'legacy-scope' };
}

export function permitsSiteReading(policy) {
  const normalized = normalizeReadingPolicy(policy);
  return normalized?.scope === 'auto' || normalized?.scope === 'site';
}

function matchingTerms(question) {
  const query = bounded(question).toLowerCase();
  // A named protocol is one topic. Its generic component words must not turn
  // an MCP request into reads of every model/context chapter on the site.
  const mcp = /\bmcp\b|模型上下文协议|model\s+context\s+protocol/.test(query);
  const rag = /\brag\b|检索增强生成|retrieval[ -]augmented[ -]generation/.test(query);
  const lexical = query.replace(/模型上下文协议|model\s+context\s+protocol|检索增强生成|retrieval[ -]augmented[ -]generation/g, ' ');
  const excluded = new Set(['this', 'that', 'the', 'and', 'for', 'with', 'please', 'page', 'site', 'chapter', 'chapters', 'find', 'where', 'read', 'summarize', 'explain', 'compare', 'how', 'what', 'which', 'implementation', 'implementations', 'implement', 'ways', 'way', 'information', '内容', '相关', '章节', '目录', '原理', '技术', '基础', '方法', '问题', '介绍', '总结', '一下', '哪些', '哪里', '帮我', '这个', '网站', '站内', '当前', '找到', '查找', '对比', '比较', '解释', '了解', '阅读', '分析', '信息', '实现', '方式', '用法', '如何', '怎么']);
  const terms = new Set((lexical.match(/[a-z][a-z0-9+-]{1,40}/g) || []).filter(term => !excluded.has(term)));
  const runs = lexical.replace(/(?:帮我|请|想|需要|先|再|并|能不能|可以|找到|查找|总结|介绍|解释|了解|阅读|对比|分析|相关|章节|目录|这个网站|当前页面)/g, ' ');
  if (typeof Intl.Segmenter === 'function') {
    for (const item of new Intl.Segmenter('zh', { granularity: 'word' }).segment(runs)) {
      if (item.isWordLike && /^[\u3400-\u9fff]{2,12}$/.test(item.segment) && !excluded.has(item.segment)) terms.add(item.segment);
    }
  } else {
    for (const term of runs.match(/[\u3400-\u9fff]{2,12}/g) || []) if (!excluded.has(term)) terms.add(term);
  }
  if (/\bagents?\b|智能体/.test(query)) { terms.add('agent'); terms.add('智能体'); }
  if (mcp) { terms.add('mcp'); terms.add('模型上下文协议'); terms.add('model context protocol'); }
  if (rag) { terms.add('rag'); terms.add('检索增强生成'); terms.add('retrieval augmented generation'); }
  const chapters = [...query.matchAll(/第?\s*(\d{1,3})\s*章|chapter\s*(\d{1,3})/gi)].map(match => Number(match[1] || match[2]));
  return { query, terms: [...terms].slice(0, 40), chapters };
}

/** Whole meaningful terms outrank weak fragments; no article text is used as instructions. */
export function scoreReadingCandidate(question, candidate) {
  const { terms, chapters } = matchingTerms(question);
  const title = bounded(candidate?.title, 300).toLowerCase();
  const chapter = title.match(/第?\s*(\d{1,3})\s*(?:章|[-–])|chapter\s*(\d{1,3})/i);
  if (chapters.length) return chapter && chapters.includes(Number(chapter[1] || chapter[2])) ? 1000 : 0;
  // Instruction words were removed above; each explicitly requested topic can
  // match its own chapter, including comparisons such as RAG and fine-tuning.
  let hits = 0;
  let score = 0;
  for (const term of terms) {
    const matches = /^[a-z]/.test(term)
      ? new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s)?(?:$|[^a-z0-9])`, 'i').test(title)
      : title.includes(term);
    if (!matches) continue;
    hits += 1;
    score += /^[a-z]/.test(term) || term.length >= 3 ? 100 : 55;
  }
  if (!hits) return 0;
  if (/智能体|\bagents?\b/i.test(question) && /langgraph|a2a|多智能体/i.test(title)) score += 35;
  return score + (chapter ? 10 : 0) + Math.min(hits, 3) * 5;
}
