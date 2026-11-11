import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebResearcher, needsWebResearch, parseSearchResults, researchQueries, staleForCurrentYear, webResearchSources } from '../src/sidepanel/features/web-research/web-research.js';

const html = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fofficial.test%2Frelease">Official release</a>
<div class="result__snippet">Published on November 2 with the actual release details.</div>
<a class="result__a" href="https://news.test/report">Independent report</a>
<div class="result__snippet">An independent report with publication evidence.</div>
<a class="result__a" href="https://community.test/discussion">Community implementation</a>
<div class="result__snippet">A reproducible community implementation.</div>`;

function page(title, body) {
  return new Response(`<html><head><title>${title}</title></head><body><article>${body.repeat(10)}</article></body></html>`, { headers: { 'content-type': 'text/html' } });
}

test('only time-sensitive or specific version claims trigger web research', () => {
  for (const question of ['现在社区解决codex生图接入外部模型了嘛', 'DeepSeek V4.1 Flash 什么时候发布', '整理近24小时国内外大事']) assert.equal(needsWebResearch(question), true, question);
  for (const question of ['第一次去洛阳怎么玩，门票和开放时间怎么安排', '洛阳牡丹文化节是什么时间']) assert.equal(needsWebResearch(question), true, question);
  for (const question of ['你好', '什么是闭包', '总结这页']) assert.equal(needsWebResearch(question), false, question);
  for (const question of ['现在是几月几号', '今天星期几？', '现在几点了']) assert.equal(needsWebResearch(question), false, question);
});

test('public fallback searches the current Beijing year and filters older source years', async () => {
  const requested = [];
  const research = createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'), now: () => '2026-11-03T02:00:00Z',
    fetchImpl: async url => {
      requested.push(decodeURIComponent(url));
      if (url.startsWith('https://html.duckduckgo.com/')) return new Response(`${html}
        <a class="result__a" href="https://old.test/2025-guide">2025 洛阳旅游攻略</a><div class="result__snippet">开放时间 2025</div>`);
      return page(new URL(url).hostname, '2026 年官方开放时间和票价，当前公告可核实。');
    } });
  const result = await research('第一次去洛阳怎么玩，门票和开放时间怎么安排');
  assert.match(requested[0], /2026/);
  assert.equal(result.year, '2026');
  assert.ok(result.sources.every(source => !/2025/.test(`${source.title} ${source.url}`)));
  assert.match(result.context, /结合搜索结果的发布时间/);
  assert.equal(staleForCurrentYear('2025洛阳旅游攻略', '2026'), true);
  assert.equal(staleForCurrentYear('2026洛阳旅游攻略', '2026'), false);
});

test('search markup is read as inert data and only public destination links are retained', () => {
  const results = parseSearchResults(`${html}<a class="result__a" href="http://127.0.0.1/private">Private</a><script>globalThis.compromised=true</script>`);
  assert.equal(results.length, 3);
  assert.equal(results[0].url, 'https://official.test/release');
  assert.equal(results[0].title, 'Official release');
  assert.match(results[0].snippet, /November 2/);
});

test('declared GBK source pages are decoded before evidence is read', async () => {
  const bytes = new Uint8Array([0xbb, 0xd8, 0xc3, 0xfb]); // 页面 in GBK
  const research = createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'), now: () => '2026-11-03T02:00:00Z', fetchImpl: async url => {
    if (url.startsWith('https://html.duckduckgo.com/')) return new Response(html);
    return new Response(bytes, { headers: { 'content-type': 'text/html; charset=gbk' } });
  } });
  await assert.rejects(research('洛阳景区开放时间'), /来源不足/);
});

test('research reads up to three independent public sources and exposes real source records', async () => {
  const requests = [];
  const research = createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'), now: () => '2026-11-03T02:00:00Z', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.startsWith('https://html.duckduckgo.com/')) return new Response(html);
    if (url === 'https://community.test/discussion') throw new Error('blocked');
    return page(new URL(url).hostname, '2026 verifiable source body with dates and implementation details.');
  } });
  const result = await research('DeepSeek V4.1 Flash 什么时候发布？');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources.filter(source => source.readStatus === 'body').length, 2);
  assert.match(result.context, /独立来源域名数：2/);
  assert.match(result.context, /不得依据训练记忆补充具体事实/);
  assert.ok(result.sources.every(source => source.capturedAt === '2026-11-03T02:00:00Z'));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.init === undefined));
  assert.equal(webResearchSources(result).length, 2);
});

test('a failed search is explicit and cannot fall back to model memory', async () => {
  const research = createWebResearcher({ fetchImpl: async () => new Response('unavailable', { status: 503 }) });
  await assert.rejects(research('整理最近24小时新闻'), /需要联网核实.*503/);
  const empty = createWebResearcher({ fetchImpl: async () => new Response('<html>No results</html>') });
  await assert.rejects(empty('目前有没有官方支持'), /没有返回可核实的来源/);
});

test('a browser network rejection keeps a useful transport error', async () => {
  const research = createWebResearcher({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(research('查一下社区有没有方案'), /联网核实.*搜索站点不可达/);
});

test('an unrelated question does not make any network request', async () => {
  const research = createWebResearcher({ fetchImpl: async () => assert.fail('No network request') });
  assert.equal(await research('解释闭包的原理'), null);
});

test('snippet-only or single-body results cannot be presented as verified research', async () => {
  for (const bodies of [0, 1]) {
    const research = createWebResearcher({ fetchImpl: async url => {
      if (url.startsWith('https://html.duckduckgo.com/')) return new Response(html);
      if (bodies === 1 && url === 'https://official.test/release') return page('Official', 'One accessible body without independent corroboration.');
      throw new Error('Source unavailable');
    } });
    await assert.rejects(research('目前是否有官方发布的模型？'), /来源不足/);
  }
});

test('configured gateway search supplies result summaries before the public fallback', async () => {
  let publicCalls = 0;
  const research = createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'), now: () => '2026-11-03T02:00:00Z',
    gatewaySearch: async query => ({ engine: 'workbuddy',
      results: [{ title: '广州天气', url: 'https://weather.test/guangzhou', snippet: `2026-11-03 ${query} 27°C 多云`, favicon: 'https://weather.test/i.png' },
        { title: '广州天气预报', url: 'https://forecast.test/gz', snippet: '2026-11-03 广州 24~29°C' }] }),
    fetchImpl: async () => { publicCalls++; assert.fail('No public fallback'); } });
  const result = await research('今天广州天气');
  assert.equal(publicCalls, 0);
  assert.equal(result.engine, 'workbuddy');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].readStatus, 'search-summary');
  assert.match(result.context, /广州天气/);
  assert.equal(webResearchSources(result)[0].favicon, 'https://weather.test/i.png');
});

test('gateway fetch replaces search summaries with readable page evidence', async () => {
  const fetched = [];
  const research = createWebResearcher({
    clock: () => new Date('2026-11-03T02:00:00Z'),
    now: () => '2026-11-03T02:00:00Z',
    gatewaySearch: async () => ({ engine: 'deepseek', results: [
      { title: '官方公告', url: 'https://official.test/release', snippet: '搜索摘要' },
      { title: '媒体报道', url: 'https://news.test/report', snippet: '另一条搜索摘要' },
    ] }),
    gatewayFetch: async url => {
      fetched.push(url);
      return { title: `正文 ${url}`, url, content: `已读取的公开正文 ${url} `.repeat(20), truncated: false };
    },
    fetchImpl: async () => { throw new Error('local HTML fallback should not run'); },
  });
  const result = await research('DeepSeek V4.1 Flash 什么时候发布？');
  assert.deepEqual(fetched, ['https://official.test/release', 'https://news.test/report']);
  assert.ok(result.sources.every(source => source.readStatus === 'body' && source.readVia === 'gateway-fetch'));
  assert.match(result.context, /已读取公开正文/);
});

test('time-sensitive questions keep undated search results while volatile facts stay year-strict', async () => {
  const result = await createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'),
    now: () => '2026-11-03T02:00:00Z', gatewaySearch: async () => ({
      results: [{ title: '新生代女演员盘点', url: 'https://example.test/actresses',
        snippet: '沈佳钰、王楚然等年轻演员的介绍，页面未标注统一更新时间。' }],
    }) })('国内现在新生代女艺人有哪些', { search: true, yearStrict: false });
  assert.equal(result.sources.length, 1);
  assert.match(result.context, /不强制每条结果都标注年份/);

  await assert.rejects(createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'),
    now: () => '2026-11-03T02:00:00Z', gatewaySearch: async () => ({
      results: [{ title: '2025 景区开放时间', url: 'https://example.test/2025', snippet: '2025 年开放时间' }],
    }) })('景区现在开放时间', { search: true, yearStrict: true }), /可核实的来源不足/);
});

test('ambiguous community questions get bounded follow-up searches and stop at three rounds', async () => {
  const queries = [];
  const pending = createWebResearcher({ clock: () => new Date('2026-11-03T02:00:00Z'),
    now: () => '2026-11-03T02:00:00Z', gatewaySearch: async query => {
      queries.push(query);
      return { results: queries.length < 2
        ? [{ title: query, url: `https://${queries.length}.test/result`, snippet: `${query} 社区讨论，页面未统一标注日期` }]
        : [{ title: query, url: `https://${queries.length}.test/result`, snippet: `${query} 社区讨论，页面未统一标注日期` },
          { title: `${query} 官方`, url: `https://official-${queries.length}.test/result`, snippet: `${query} 官方公告` }] };
    } })('红果短剧去广告方案到底是否可靠', { search: true, yearStrict: false });
  const research = await pending;
  assert.ok(queries.length <= 3);
  assert.ok(queries.length >= 2);
  assert.ok(research.sources.length >= 2);
  assert.equal(research.rounds.length, queries.length);
  assert.match(research.context, /官方已确认.*社区经验.*来源冲突/s);
  assert.match(research.context, /上限 3 轮/);
});

test('research query decomposition stays focused and bounded', () => {
  assert.deepEqual(researchQueries('解释闭包的原理'), ['解释闭包的原理']);
  const queries = researchQueries('红果短剧社区去广告方案现在是否可靠');
  assert.ok(queries.length <= 3);
  assert.match(queries[0], /红果短剧/);
});
