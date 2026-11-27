import { icon } from '../../icons.js';
import { escapeHtml } from '../../core/dom.js';
import { createTopicCarousel } from '../welcome/topic-carousel.js';
import {
  createYingmiMcpClient,
  hasFundModeApiKey,
  loadCachedMcpTools,
  loadFundModeConfig,
} from './fund-mode-config.js';
import {
  beijingDateKey,
  beijingMorningCycleKey,
  incrementDailyFundUsage,
  loadDailyFundFeed,
  loadDailyFundUsage,
  loadDailyMarketTemperature,
  saveDailyFundFeed,
  saveDailyMarketTemperature,
  saveRemoteFundQuota,
} from './fund-tool-cache.js';
import { getFundSkill, sanitizeFundToolArgs } from './fund-skills.js';

export const FUND_WORKFLOW_ITEMS = Object.freeze([
  {
    id: 'single-fund',
    skillId: 'fund-analysis',
    command: '/check',
    icon: 'stethoscope',
    title: '单基深度研报',
    menuDesc: '买前体检：看业绩、估值与最大回撤',
    description: '按权益/债基/QDII自动分支，输出业绩、估值穿透、归因与回撤修复',
    tip: '买之前做个“体检”：看这只基金稳不稳、最惨跌过多少、多久能回本。',
    example: '点击后补上代码，如「005827」或「易方达蓝筹」',
    prompt: '请按标准投研框架深度分析这只基金（请替换基金代码或名称）：',
    autoSend: false,
    keywords: ['tijian', 'check', '体检', '诊断', '单基', '研报'],
  },
  {
    id: 'fund-screen',
    skillId: 'fund-screener',
    command: '/screen',
    icon: 'search',
    title: '专业选基与债基排雷',
    menuDesc: '按条件筛候选基金，或排查债基跳水',
    description: '按收益/回撤/换手率/债基券种与信用评级筛选候选池，或排查债基异动',
    tip: '不知道买哪只时按条件缩小范围，也能专门查近期有没有异常大跌的债基。',
    example: '如「筛近3年最大回撤小于3%的高评级纯债基」',
    prompt: '请按专业选基框架帮我筛选符合以下条件的基金（可补充类型、回撤/评级/费率要求）：',
    autoSend: false,
    keywords: ['screen', 'xuanji', '筛选', '选基', '排雷', '债基', '跳水'],
  },
  {
    id: 'compare-funds',
    skillId: 'fund-analysis',
    command: '/pk',
    icon: 'scale',
    title: '多基横向对比',
    menuDesc: '多只基金 PK：看抗跌、费率与重合度',
    description: '对比多只基金阶段业绩、最大回撤、相关性重叠度与交易规则差异',
    tip: '纠结买哪只时拉表对比：谁更抗跌、费率谁低、两只买的重仓股是不是差不多。',
    example: '如「对比 110011 和 005827，谁更稳？」',
    prompt: '请帮我横向对比以下基金的业绩、回撤、持仓相关性与费率限额（用对比矩阵呈现）：',
    autoSend: false,
    keywords: ['pk', 'duibi', '对比', '比较', '相关性'],
  },
  {
    id: 'portfolio-diag',
    skillId: 'portfolio-analysis',
    command: '/portfolio',
    icon: 'pie-chart',
    title: '持仓组合诊断回测',
    menuDesc: '已买多只基金体检：看集中度与历史表现',
    description: '本地精准归一化与 HHI 测算，叠加资产穿透、相关性、回测与情景模拟',
    tip: '手里有 2 只以上基金时做全身检查，看看是不是全押在同一个行业、历史表现如何。',
    example: '如「110011 占40%，005827 占60%」',
    prompt: '请帮我诊断并回测以下基金持仓组合（补充基金代码与金额或占比）：\n',
    autoSend: false,
    keywords: ['zuhe', 'portfolio', '持仓', '组合', '回测', '蒙特卡洛'],
  },
  {
    id: 'strategy-hot',
    skillId: 'strategy-analysis',
    command: '/strategy',
    icon: 'compass',
    title: '投顾策略与调仓追踪',
    menuDesc: '看投顾组合持仓、调仓记录与服务费',
    description: '查询公开投顾策略详情、底层持仓穿透、调仓记录与投顾费率模式',
    tip: '想了解省心的专业投顾组合时用：查它底层买了啥基金、最近怎么调仓、收多少费。',
    example: '如「查一下且慢长赢策略的持仓和近期调仓」',
    prompt: '请按投顾策略研究框架分析这个策略（名称或代码，也可反查重仓某只基金的策略）：',
    autoSend: false,
    keywords: ['celue', 'strategy', '投顾', '策略', '调仓'],
  },
  {
    id: 'wealth-plan',
    skillId: 'wealth-planning',
    command: '/plan',
    icon: 'layers',
    title: '家庭财务与配置规划',
    menuDesc: '把闲钱按期限分成活钱/稳钱/长钱',
    description: '家庭财务健康体检、资金分桶配置方案与跨周期现金流缺口测算',
    tip: '不用提前给隐私信息！AI 会先问你期限和能承受多大亏损，再帮你做资金分配参考。',
    example: '如「5万闲钱，3年不用，最多能接受亏10%」',
    prompt: '请帮我做家庭财务与资产配置规划（可先列出需要我确认的风险、期限、流动性与资金目标）：',
    autoSend: false,
    keywords: ['plan', 'guihua', '家庭', '财务', '规划', '四笔钱', '资产配置'],
  },
  {
    id: 'product-rules',
    skillId: 'product-qa',
    command: '/rules',
    icon: 'shield-check',
    title: '费率规则与交易日历',
    menuDesc: '查手续费、A/C类对比与赎回到账日',
    description: '核验基金申赎/限额状态、A/C 类费率成本对比、分红与确认到账时间',
    tip: '避开 7 天 1.5% 高额赎回费！一键查买卖费率、买 A 类还是 C 类划算、哪天到账。',
    example: '如「005827 持有一个月买A还是买C？今天卖哪天到账？」',
    prompt: '请帮我核验以下基金的申赎状态、费率阶梯（含 7 天赎回费）、限额及确认到账时间轴：',
    autoSend: false,
    keywords: ['rules', 'feilv', '费率', '规则', '限额', '赎回', '交易日', '分红'],
  },
  {
    id: 'verify-page',
    skillId: 'fund-analysis',
    command: '/pagefund',
    icon: 'file-search',
    title: '核验当前网页基金',
    menuDesc: '读取当前页基金，用权威数据验真伪',
    description: '仅在你点击时读取当前标签页，并用盈米 MCP 权威数据交叉核验',
    tip: '在天天基金、雪球等页面看到基金拿不准时，点它用权威数据帮你验真伪、查风险。',
    example: '打开任意基金详情页或文章后直接点击发送',
    prompt: '请读取当前网页中提到的基金信息，并用盈米 MCP 权威数据按基金研报标准交叉核验其业绩、估值、风险与申赎限制。',
    autoSend: true,
    requirePage: true,
    wide: true,
    keywords: ['page', 'wangye', '网页', '核验', '当前页'],
  },
]);

export const MARKET_TEMP_PROMPT_SCENARIO = Object.freeze({
  id: 'market-temp',
  skillId: 'market-analysis',
  command: '/temp',
  icon: 'thermometer',
  title: '今日市场温度与复盘',
  menuDesc: '看大盘冷热、宽基估值与行情复盘',
  tip: '看今天 A 股整体是便宜还是贵（温度越低越便宜），AI 用大白话帮你总结行情。',
  example: '直接点击即可发送，无需额外输入',
  prompt: '请按市场洞察框架查询今日市场温度计、核心宽基指数估值与重要财经催化，用紧凑表格呈现并给出简明市场复盘。',
  autoSend: true,
  keywords: ['temp', 'wendu', '温度', '宽基', '估值', '市场', '复盘'],
});

const RATING_CODE_MAP = Object.freeze({
  EL: '极低估',
  L: '低估',
  LOW: '低估',
  ML: '较低估',
  M: '适中',
  MID: '适中',
  MEDIUM: '适中',
  MH: '偏高',
  H: '高估',
  HIGH: '高估',
  EH: '极高估',
});

function temperatureRating(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return { level: '—', tone: 'neutral' };
  if (num < 15) return { level: '极低估', tone: 'cold' };
  if (num < 30) return { level: '较低估', tone: 'cool' };
  if (num < 60) return { level: '适中', tone: 'neutral' };
  if (num < 80) return { level: '偏高', tone: 'warm' };
  return { level: '高估', tone: 'hot' };
}

function normalizeLevelLabel(explicitLevel, fallbackLevel) {
  const raw = String(explicitLevel || '').trim();
  if (!raw) return fallbackLevel;
  const upper = raw.toUpperCase();
  if (RATING_CODE_MAP[upper]) return RATING_CODE_MAP[upper];
  // If Yingmi returns an opaque ASCII code, use our Chinese fallback.
  if (/^[A-Za-z0-9_-]{1,6}$/.test(raw)) return fallbackLevel;
  return raw;
}

function formatPct(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[+-]?\d+(?:\.\d+)?%$/.test(trimmed)) {
      const n = parseFloat(trimmed);
      return { text: n > 0 && !trimmed.startsWith('+') ? `+${trimmed}` : trimmed, dir: n > 0 ? 'up' : n < 0 ? 'down' : 'flat' };
    }
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  const pct = Math.abs(num) <= 0.25 && num !== 0 ? num * 100 : num;
  const fixed = pct.toFixed(2);
  return { text: `${pct > 0 ? '+' : ''}${fixed}%`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Parse Yingmi `GetLatestQuotations` response into a structured, human-readable snapshot.
 */
export function parseMarketTemperatureSnapshot(raw) {
  const text = typeof raw?.text === 'string' ? raw.text : '';
  const data = (raw?.structured && typeof raw.structured === 'object' ? raw.structured : null)
    || tryParseJson(text);

  const gauges = [];
  const seenGauges = new Set();
  const indices = [];
  const seenIndices = new Set();
  let updatedOn = '';
  let calDate = '';

  const addGauge = (name, tempVal, explicitLevel = '') => {
    const label = String(name || '').trim();
    const num = Number(tempVal);
    if (!label || !Number.isFinite(num) || num < 0 || num > 100 || seenGauges.has(label)) return;
    seenGauges.add(label);
    const rated = temperatureRating(num);
    gauges.push({
      name: label,
      value: Number(num.toFixed(2)),
      level: normalizeLevelLabel(explicitLevel, rated.level),
      tone: rated.tone,
    });
  };

  const addIndex = (name, changeRaw, valuation = '') => {
    const label = String(name || '').trim();
    if (!label || seenIndices.has(label)) return;
    const pct = formatPct(changeRaw);
    if (!pct && !valuation) return;
    seenIndices.add(label);
    indices.push({
      name: label,
      changeText: pct?.text || '',
      dir: pct?.dir || 'flat',
      valuation: String(valuation || '').trim(),
    });
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    if (!updatedOn && typeof node.updatedOn === 'string' && node.updatedOn.trim()) updatedOn = node.updatedOn.trim();
    if (!updatedOn && typeof node.updateTime === 'string' && node.updateTime.trim()) updatedOn = node.updateTime.trim();
    if (!calDate && typeof node.calDate === 'string' && node.calDate.trim()) calDate = node.calDate.trim();
    if (!calDate && typeof node.tradeDate === 'string' && node.tradeDate.trim()) calDate = node.tradeDate.trim();

    const itemName = node.indexName || node.name || node.title || node.shortName || '';
    const tempField = node.temperature ?? node.temp ?? node.marketTemperature ?? node.score;
    const changeField = node.dailyChange ?? node.changePercent ?? node.changeRate ?? node.pctChange ?? node.dayReturn ?? node.riseFall ?? node.change;
    const levelField = node.level || node.rating || node.valuationStatus || node.statusDesc || '';

    if (itemName && tempField !== undefined && tempField !== null && tempField !== '') {
      addGauge(itemName, tempField, levelField);
    }
    if (itemName && (changeField !== undefined && changeField !== null && changeField !== '')) {
      addIndex(itemName, changeField, levelField);
    }
    if (!itemName && tempField !== undefined && tempField !== null && tempField !== '') {
      addGauge('市场温度', tempField, levelField);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };

  if (data) walk(data);

  if (!gauges.length && text && !text.trim().startsWith('{')) {
    const patterns = [
      ['中证全A', /中证全A[^\d]{0,12}(\d+(?:\.\d+)?)/],
      ['沪深300', /沪深300[^\d]{0,12}(\d+(?:\.\d+)?)/],
      ['中证500', /中证500[^\d]{0,12}(\d+(?:\.\d+)?)/],
    ];
    for (const [label, re] of patterns) {
      const m = text.match(re);
      if (m) addGauge(label, Number(m[1]));
    }
  }

  return {
    updatedOn: updatedOn || calDate || '',
    calDate,
    gauges: gauges.slice(0, 3),
    indices: indices.slice(0, 6),
    hasData: gauges.length > 0 || indices.length > 0,
  };
}

export function parseHotTopicsList(raw) {
  const text = typeof raw?.text === 'string' ? raw.text : '';
  let data = (raw?.structured && typeof raw.structured === 'object' ? raw.structured : null)
    || tryParseJson(text);
  if (!data && text) {
    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) data = tryParseJson(jsonMatch[1]);
  }
  const items = [];
  const seen = new Set();

  const pushTopic = (rawTitle, rawSummary = '') => {
    const cleanTitle = String(rawTitle || '')
      .replace(/^[\d.\s、\-*•#]+/, '')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/^【([^】]+)】\s*/, '$1：')
      .trim();
    if (cleanTitle.length < 3 || seen.has(cleanTitle)) return;
    seen.add(cleanTitle);
    const cleanSummary = typeof rawSummary === 'string' ? rawSummary.trim().slice(0, 72) : '';
    items.push({ title: cleanTitle.slice(0, 48), summary: cleanSummary });
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 5 || items.length >= 5) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (typeof node === 'string') {
      if (depth >= 1) pushTopic(node);
      return;
    }
    if (typeof node !== 'object') return;
    const title = node.topic || node.title || node.topicName || node.hotTopic || node.topicTitle || node.subject || node.headline || node.name || node.keyword || '';
    const summary = node.summary || node.description || node.reason || node.logic || node.abstract || node.content || '';
    if (typeof title === 'string' && title.trim().length >= 3) {
      pushTopic(title, summary);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  if (data) walk(data);

  // Fallback for Markdown / plain-text bullet or numbered topic lists
  if (!items.length && text) {
    for (const rawLine of text.split(/\r?\n/)) {
      if (items.length >= 5) break;
      const line = rawLine.trim();
      if (!line || line.startsWith('{') || line.startsWith('}') || line.startsWith('[') || line.startsWith(']')) continue;
      if (/^(?:共|总计|来源|数据|更新|截至|说明|免责|备注)/.test(line)) continue;
      const numbered = line.match(/^(?:\d+[.、)）]|[-*•])\s+(.+)$/);
      if (numbered) {
        const cleaned = numbered[1].replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
        const colonIdx = cleaned.search(/[：:]/);
        if (colonIdx >= 3) pushTopic(cleaned.slice(0, colonIdx), cleaned.slice(colonIdx + 1));
        else pushTopic(cleaned, '');
      }
    }
  }
  return items;
}

export function parsePopularFundsList(raw) {
  const text = typeof raw?.text === 'string' ? raw.text : '';
  const data = (raw?.structured && typeof raw.structured === 'object' ? raw.structured : null)
    || tryParseJson(text);
  const items = [];
  const seen = new Set();

  const pushFund = (code, name) => {
    const cleanCode = String(code || '').trim();
    const cleanName = String(name || '').replace(/^[\d.\s、\-*]+/, '').replace(/[（(\[]?\d{6}[）)\]]?$/, '').trim();
    if (!cleanCode || !cleanName || seen.has(cleanCode)) return;
    seen.add(cleanCode);
    items.push({ code: cleanCode, name: cleanName.slice(0, 28) });
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 6 || items.length >= 8) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const code = node.fundCode ?? node.code ?? node.fdCode ?? node.productCode ?? node.secuCode ?? node.symbol ?? '';
    const name = node.fundName ?? node.shortName ?? node.fundAbbr ?? node.productName ?? node.name ?? node.title ?? '';
    if (String(code).trim() && String(name).trim()) {
      pushFund(code, name);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  if (data) walk(data);

  // Fallback for Markdown / plain-text lines containing 6-digit fund codes
  if (!items.length && text) {
    for (const line of text.split(/\r?\n/)) {
      if (items.length >= 8) break;
      const m1 = line.match(/([^\s|｜（(\[\-:：]{2,28})\s*[（(\[]\s*(\d{6})\s*[）)\]]/);
      if (m1) { pushFund(m1[2], m1[1]); continue; }
      const m2 = line.match(/\b(\d{6})\b[\s\-—:：|｜]+([^\s|｜,，。;；]{2,28})/);
      if (m2) { pushFund(m2[1], m2[2]); }
    }
  }
  return items;
}

function defaultArgsFromSchema(toolDef, now = Date.now) {
  const schema = toolDef?.inputSchema;
  if (!schema || typeof schema !== 'object' || !schema.properties) return {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const args = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!required.has(key)) continue;
    if (prop && prop.default !== undefined) { args[key] = prop.default; continue; }
    if (Array.isArray(prop?.enum) && prop.enum.length) { args[key] = prop.enum[0]; continue; }
    const type = Array.isArray(prop?.type) ? prop.type[0] : prop?.type;
    if (type === 'number' || type === 'integer') {
      if (/day|period|range/i.test(key)) args[key] = prop.minimum ?? 7;
      else if (/page$/i.test(key)) args[key] = 1;
      else if (/size|limit|count|top|num/i.test(key)) args[key] = Math.min(prop.maximum ?? 10, Math.max(prop.minimum ?? 1, 6));
      else args[key] = prop.minimum ?? 1;
    } else if (type === 'boolean') {
      args[key] = false;
    } else if (type === 'array') {
      args[key] = [];
    } else if (type === 'string') {
      if (/date|day/i.test(key)) args[key] = beijingDateKey(now());
      else if (/query|keyword|topic|search/i.test(key)) args[key] = '今日财经热点';
      else args[key] = '';
    }
  }
  return args;
}

function friendlyFeedError(raw) {
  const text = String(raw || '');
  if (/401|403|auth|key|鉴权|密钥/i.test(text)) return '盈米 MCP 密钥无效或已失效，请前往设置页检查。';
  if (/429|quota|limit|配额|上限|频率/i.test(text)) return '今日调用额度已达上限，请明天 00:00 后再试。';
  if (/timeout|超时|network|连接|fetch/i.test(text)) return '网络连接不太稳定，暂时未能拉取今日速览。';
  return '暂未能自动拉取今日速览，你可以重试或直接让 AI 帮你查询。';
}

export function createFundModeController({
  appShell,
  welcome,
  fundBar,
  fundWelcome,
  input,
  attachMenuFundBtn,
  fundMenuSection,
  fundSkillChip,
  onQuickPrompt,
  onSkillChange,
  onOpenSettings,
  onModeChange,
  storage = globalThis.chrome?.storage?.local,
  now = Date.now,
} = {}) {
  let active = false;
  let activeSkillId = '';
  let config = null;
  let usage = { date: '', count: 0, limit: null, source: 'local' };
  let tempSnapshot = null;
  let tempError = '';
  let tempLoading = false;
  let feedTab = 'topics'; // 'topics' | 'popular'
  const feedState = {
    topics: { items: null, loading: false, error: '', fetchedCycle: '' },
    popular: { items: null, loading: false, error: '', fetchedCycle: '' },
  };
  let popoverOpen = false;
  let autoFetchedDate = '';
  let lastHasMessages = false;
  let lastBarHtml = '';
  let lastWelcomeHtml = '';
  let fundCarousel = null;
  let disposed = false;
  let tempController = null;
  const feedControllers = { topics: null, popular: null };
  const defaultPlaceholder = input?.getAttribute?.('placeholder') || '输入消息…';

  function emptyFeedMessage(tab) {
    return tab === 'topics'
      ? '今日财经热点暂时为空，可稍后重试或让 AI 直接汇总。'
      : '暂未能解析热门关注基金列表，可直接让 AI 帮你查询。';
  }

  function applyCachedFeed(cached) {
    const currentCycle = beijingMorningCycleKey(now());
    if (!cached) {
      for (const tab of ['topics', 'popular']) {
        if (feedState[tab].fetchedCycle && feedState[tab].fetchedCycle !== currentCycle && !feedState[tab].loading) {
          feedState[tab] = { items: null, loading: false, error: '', fetchedCycle: '' };
        }
      }
      return;
    }
    const meta = cached.meta && typeof cached.meta === 'object' ? cached.meta : {};
    const cycleKey = cached.cycleKey || currentCycle;
    for (const tab of ['topics', 'popular']) {
      const tabMeta = meta[tab];
      const hasItems = Array.isArray(cached[tab]);
      if (!hasItems && !tabMeta) continue;
      const items = hasItems ? cached[tab] : [];
      const tabCycle = tabMeta?.cycleKey || cycleKey;
      if (items.length) {
        feedState[tab] = { items, loading: feedState[tab].loading, error: '', fetchedCycle: tabCycle };
      } else if (tabMeta?.empty || hasItems) {
        feedState[tab] = { items: [], loading: feedState[tab].loading, error: emptyFeedMessage(tab), fetchedCycle: tabCycle };
      }
    }
  }

  function renderQuickPopover(configured) {
    if (!popoverOpen || !configured) return '';
    const tempStrip = tempSnapshot?.hasData && tempSnapshot.gauges.length
      ? `<div class="fund-pop-temp">
          <div class="fund-pop-temp-list">${tempSnapshot.gauges.map(g => {
            const label = normalizeLevelLabel(g.level, temperatureRating(g.value).level);
            return `<span class="fund-pop-temp-item tone-${g.tone}"><span>${escapeHtml(g.name)}</span><strong>${g.value.toFixed(2)}°</strong><em>${escapeHtml(label)}</em></span>`;
          }).join('')}</div>
          <button type="button" class="fund-temp-ask-btn" data-fund-action="ask-temp"><span>解读</span>${icon('arrow-right')}</button>
        </div>`
      : '';
    return `
      <div class="fund-quick-popover ui-popover" role="dialog" aria-label="今日市场速览">
        ${tempStrip}
        ${renderFeedWidget(configured, { compact: true })}
      </div>
    `;
  }

  function renderBar() {
    if (!fundBar) return;
    fundBar.hidden = !active;
    if (!active) {
      popoverOpen = false;
      lastBarHtml = '';
      return;
    }
    const configured = hasFundModeApiKey(config);
    const dotClass = configured ? 'fund-mode-dot is-live' : 'fund-mode-dot is-unconfigured';
    let usageMarkup = '<span class="fund-mode-usage">未配置密钥</span>';
    if (configured) {
      if (usage.source === 'remote' && usage.limit) {
        usageMarkup = `<a class="fund-mode-usage fund-mode-usage-link" href="https://qieman.com/mcp/account?tab=usage" target="_blank" rel="noopener noreferrer" title="来自 MCP 服务端实时额度 · 点击打开控制台">今日 ${usage.count}/${usage.limit}</a>`;
      } else {
        usageMarkup = `<a class="fund-mode-usage fund-mode-usage-link" href="https://qieman.com/mcp/account?tab=usage" target="_blank" rel="noopener noreferrer" title="本机兜底计数（盈米 MCP 网关未返回实时额度头）· 点击前往控制台查看全端真实用量">本机今日 ${usage.count} 次 ↗</a>`;
      }
    }
    const nextHtml = `
      <div class="fund-mode-bar-left">
        <span class="${dotClass}" aria-hidden="true"></span>
        <span class="fund-mode-badge">${icon('trending-up')}<span>基金研究 · 盈米 MCP</span></span>
        ${usageMarkup}
      </div>
      <div class="fund-mode-bar-actions">
        ${configured
          ? `<button type="button" class="fund-mode-bar-btn fund-mode-quick-btn${popoverOpen ? ' is-open' : ''}" data-fund-action="toggle-popover" aria-expanded="${popoverOpen}" title="随时展开市场温度、财经热点与热门关注基金">${icon('flame')}<span>速览</span></button>`
          : '<button type="button" class="fund-mode-bar-btn" data-fund-action="open-settings">配置密钥</button>'}
        <button type="button" class="fund-mode-bar-btn" data-fund-action="exit">退出</button>
      </div>
      ${renderQuickPopover(configured)}
    `;
    if (nextHtml !== lastBarHtml) {
      lastBarHtml = nextHtml;
      fundBar.innerHTML = nextHtml;
    }
  }

  function renderEditorialSheet(configured, pageVerifyItem) {
    const timeText = tempSnapshot?.updatedOn
      ? `截至 ${escapeHtml(tempSnapshot.updatedOn.replace(/^\d{4}年/, ''))}`
      : '盈米 71 项只读工具 · 输入 / 呼出指令';

    const verifyBtn = pageVerifyItem ? `
      <button type="button" class="fund-sheet-action" data-fund-scenario="${pageVerifyItem.id}" data-fund-tip="${escapeHtml(pageVerifyItem.tip || '')}" data-fund-example="${escapeHtml(pageVerifyItem.example || '')}">
        ${icon(pageVerifyItem.icon)}
        <span>核验当前页</span>
      </button>
    ` : '';

    let ledgerHtml = '';
    if (!configured) {
      ledgerHtml = '<p class="fund-temp-empty">配置盈米 MCP API Key 后，自动同步当日市场温度与宽基估值。</p>';
    } else if (tempLoading && !tempSnapshot?.hasData) {
      ledgerHtml = '<div class="fund-temp-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>';
    } else if (tempError && !tempSnapshot?.hasData) {
      ledgerHtml = `<p class="fund-temp-empty is-error">${escapeHtml(tempError)}</p>`;
    } else if (tempSnapshot?.hasData) {
      const gaugesHtml = tempSnapshot.gauges.length
        ? `<div class="fund-ledger-grid">${tempSnapshot.gauges.map(g => {
          const pctPos = Math.max(4, Math.min(100, g.value));
          const displayLevel = normalizeLevelLabel(g.level, temperatureRating(g.value).level);
          return `
            <div class="fund-ledger-col tone-${g.tone}">
              <div class="fund-ledger-head">
                <span class="fund-ledger-name">${escapeHtml(g.name)}</span>
                <span class="fund-ledger-tag">${escapeHtml(displayLevel)}</span>
              </div>
              <div class="fund-ledger-val">${g.value.toFixed(2)}<small>°</small></div>
              <div class="fund-ledger-bar" aria-hidden="true"><i style="--gauge-pct:${pctPos}%"></i></div>
            </div>
          `;
        }).join('')}</div>`
        : '';
      const indicesHtml = tempSnapshot.indices.length
        ? `<div class="fund-ticker-strip">${tempSnapshot.indices.map(idx => `
          <span class="fund-ticker-item">
            <span class="fund-ticker-name">${escapeHtml(idx.name.replace(/指数$/, ''))}</span>
            ${idx.changeText ? `<span class="fund-ticker-chg is-${idx.dir}">${escapeHtml(idx.changeText)}</span>` : ''}
          </span>
        `).join('')}</div>`
        : '';
      ledgerHtml = `${gaugesHtml}${indicesHtml}`;
    } else {
      ledgerHtml = '<p class="fund-temp-empty">点击右侧刷新同步今日市场温度，或点击「AI 解读」生成宽基估值复盘。</p>';
    }

    return `
      <section class="fund-atlas-sheet" aria-label="基金研究工作台与市场温度计">
        <header class="fund-sheet-masthead">
          <div class="fund-sheet-brand">
            <span class="fund-sheet-kicker">FUND FOLIO · 市场温度计</span>
            <div class="fund-sheet-title-row">
              <h2>基金研究工作台</h2>
              <span class="fund-sheet-time">${timeText}</span>
            </div>
          </div>
          <div class="fund-sheet-controls">
            ${verifyBtn}
            <button type="button" class="fund-sheet-action is-accent" data-fund-action="ask-temp"${!configured ? ' disabled' : ''}>
              <span>AI 解读</span>${icon('arrow-right')}
            </button>
            <button type="button" class="fund-sheet-icon-btn${tempLoading ? ' is-spinning' : ''}" data-fund-action="refresh-temp" title="刷新市场温度" aria-label="刷新市场温度"${tempLoading || !configured ? ' disabled' : ''}>${icon('regenerate')}</button>
          </div>
        </header>
        <div class="fund-sheet-body">
          ${ledgerHtml}
        </div>
      </section>
    `;
  }

  function renderFeedWidget(configured, { compact = false } = {}) {
    if (!configured) return '';
    const isTopics = feedTab === 'topics';
    const currentState = feedState[feedTab];
    const list = currentState.items;
    const visibleList = Array.isArray(list) ? (compact ? list : list.slice(0, isTopics ? 3 : 6)) : null;
    let bodyHtml = '';

    if (currentState.loading) {
      bodyHtml = '<p class="fund-feed-placeholder">正在同步今日速览…</p>';
    } else if (currentState.error) {
      bodyHtml = `<div class="fund-feed-error-box">
        <span>${escapeHtml(currentState.error)}</span>
        <div class="fund-feed-error-actions">
          <button type="button" class="fund-feed-load-btn" data-fund-action="refresh-feed">重试</button>
          <button type="button" class="fund-temp-ask-btn" data-fund-action="ask-feed-ai"><span>让 AI 查</span>${icon('arrow-right')}</button>
        </div>
      </div>`;
    } else if (Array.isArray(visibleList) && visibleList.length) {
      if (isTopics) {
        bodyHtml = `<div class="fund-feed-topics">${visibleList.map((item, i) => `
          <button type="button" class="fund-topic-row" data-fund-topic="${escapeHtml(item.title)}">
            <span class="fund-topic-rank">${String(i + 1).padStart(2, '0')}</span>
            <span class="fund-topic-copy"><strong>${escapeHtml(item.title)}</strong>${compact && item.summary ? `<small>${escapeHtml(item.summary)}</small>` : ''}</span>
            <span class="fund-topic-go" aria-hidden="true">${icon('arrow-right')}</span>
          </button>
        `).join('')}</div>`;
      } else {
        bodyHtml = `
          <div class="fund-feed-popular">${visibleList.map(item => `
            <button type="button" class="fund-popular-chip" data-fund-popular-code="${escapeHtml(item.code)}" data-fund-popular-name="${escapeHtml(item.name)}" title="点击深度体检 ${escapeHtml(item.name)}">
              <span class="fund-popular-code">${escapeHtml(item.code)}</span>
              <span class="fund-popular-name">${escapeHtml(item.name)}</span>
            </button>
          `).join('')}</div>
          ${compact ? '<p class="fund-feed-footnote">口径：近几日且慢基金页关注热度，非收益榜或推荐。</p>' : ''}
        `;
      }
    } else {
      bodyHtml = `<div class="fund-feed-cta">
        <span>按需加载今日${isTopics ? '财经热点' : '热门关注基金'}（每日 09:00 自动同步 1 次）</span>
        <button type="button" class="fund-feed-load-btn" data-fund-action="load-feed">立即加载</button>
      </div>`;
    }

    return `
      <section class="fund-feed-card${compact ? ' is-compact' : ''}" aria-label="今日市场速览">
        <div class="fund-feed-header">
          <div class="fund-feed-tabs" role="tablist">
            <button type="button" role="tab" aria-selected="${isTopics}" class="fund-feed-tab${isTopics ? ' is-active' : ''}" data-fund-feed-tab="topics">${icon('flame')}<span>财经热点</span></button>
            <button type="button" role="tab" aria-selected="${!isTopics}" class="fund-feed-tab${!isTopics ? ' is-active' : ''}" data-fund-feed-tab="popular">${icon('trending-up')}<span>热门关注基金</span></button>
          </div>
          <button type="button" class="fund-temp-icon-btn${currentState.loading ? ' is-spinning' : ''}" data-fund-action="refresh-feed" title="仅刷新当前标签" aria-label="仅刷新当前标签"${currentState.loading ? ' disabled' : ''}>${icon('regenerate')}</button>
        </div>
        ${bodyHtml}
      </section>
    `;
  }

  function mountFundCarousel() {
    fundCarousel?.dispose();
    fundCarousel = null;
    if (!fundWelcome || fundWelcome.hidden) return;
    const viewport = fundWelcome.querySelector('#fund-carousel');
    const track = viewport?.querySelector('.fund-carousel-track');
    const win = viewport?.ownerDocument?.defaultView;
    if (!viewport || !track || !win?.ResizeObserver || !win?.IntersectionObserver || !win?.matchMedia) return;
    fundCarousel = createTopicCarousel({ viewport, track });
    fundCarousel.setActive(true);
  }

  function renderWelcome(hasMessages = false) {
    lastHasMessages = Boolean(hasMessages);
    if (!fundWelcome) return;
    const showFundWelcome = active && !lastHasMessages;
    fundWelcome.hidden = !showFundWelcome;
    if (welcome) {
      if (showFundWelcome) welcome.hidden = true;
      else if (!lastHasMessages) welcome.hidden = false;
    }
    if (!showFundWelcome) {
      fundCarousel?.setActive(false);
      return;
    }

    const configured = hasFundModeApiKey(config);
    const carouselItems = FUND_WORKFLOW_ITEMS.filter(card => !card.wide);
    const pageVerifyItem = FUND_WORKFLOW_ITEMS.find(card => card.wide);
    const carouselCardsHtml = carouselItems.map(card => `
      <button type="button" class="fund-quick-card fund-carousel-card" data-fund-scenario="${card.id}" data-fund-tip="${escapeHtml(card.tip || '')}" data-fund-example="${escapeHtml(card.example || '')}">
        <span class="fund-card-icon" aria-hidden="true">${icon(card.icon)}</span>
        <span class="fund-card-body">
          <strong>${escapeHtml(card.title)}</strong>
          <small>${escapeHtml(card.menuDesc || card.description)}</small>
        </span>
      </button>
    `).join('');

    const nextWelcomeHtml = `
      ${renderEditorialSheet(configured, pageVerifyItem)}
      <div class="fund-setup-callout"${configured ? ' hidden' : ''}>
        <span>尚未配置盈米 MCP API Key，配置后即可在基金模式下查询专业数据。</span>
        <button type="button" data-fund-action="open-settings">去设置配置</button>
      </div>
      ${renderFeedWidget(configured)}
      <section class="fund-workflows-section" aria-label="盈米投研 SOP 快捷指令">
        <header class="fund-workflows-header">
          <h3>投研工作流</h3>
          <span>悬停看用法示例 · 可左右拖拽</span>
        </header>
        <div id="fund-carousel" class="fund-carousel" role="region" aria-label="投研工作流轮播">
          <div class="fund-carousel-track">${carouselCardsHtml}</div>
        </div>
      </section>
    `;
    if (nextWelcomeHtml !== lastWelcomeHtml) {
      lastWelcomeHtml = nextWelcomeHtml;
      fundWelcome.innerHTML = nextWelcomeHtml;
      mountFundCarousel();
    } else {
      fundCarousel?.setActive(true);
    }
  }

  function syncMenuAndComposer() {
    if (appShell) {
      if (active) appShell.dataset.workspaceMode = 'fund';
      else delete appShell.dataset.workspaceMode;
    }
    if (input) {
      input.placeholder = active
        ? '输入基金代码/名称、粘贴持仓，或输入 / 查看基金快捷指令…'
        : defaultPlaceholder;
    }
    if (attachMenuFundBtn) {
      attachMenuFundBtn.setAttribute('aria-pressed', String(active));
      attachMenuFundBtn.classList.toggle('is-active', active);
    }
    if (fundMenuSection) {
      fundMenuSection.hidden = !active;
    }
    renderSkillChip();
  }

  function renderSkillChip() {
    if (!fundSkillChip) return;
    const skill = active ? getFundSkill(activeSkillId) : null;
    fundSkillChip.hidden = !skill;
    if (!skill) {
      fundSkillChip.innerHTML = '';
      return;
    }
    fundSkillChip.innerHTML = `
      <span class="fund-skill-pill">
        ${icon(skill.icon || 'sparkles')}
        <strong>${escapeHtml(skill.shortLabel)}</strong>
        <button type="button" data-fund-clear-skill aria-label="清除投研指南" title="清除投研指南">${icon('close')}</button>
      </span>
      <small>已按盈米官方 SOP 预加载对应分析工具</small>
    `;
  }

  function setSkill(nextSkillId = '') {
    const normalized = getFundSkill(nextSkillId) ? nextSkillId : '';
    if (activeSkillId === normalized) {
      renderSkillChip();
      return activeSkillId;
    }
    activeSkillId = normalized;
    renderSkillChip();
    onSkillChange?.(activeSkillId);
    return activeSkillId;
  }

  async function refreshTemperature({ force = false, hasMessages = false } = {}) {
    if (tempLoading || !hasFundModeApiKey(config)) return;
    if (!force) {
      const cached = await loadDailyMarketTemperature({ storage, now });
      if (cached && cached.hasData) {
        tempSnapshot = cached;
        tempError = '';
        if (!disposed) renderWelcome(hasMessages);
        return;
      }
    }
    tempLoading = true;
    tempError = '';
    renderWelcome(hasMessages);
    tempController?.abort();
    tempController = new AbortController();
    try {
      const client = createYingmiMcpClient({ endpoint: config.endpoint, apiKey: config.apiKey, authMode: config.authMode });
      const result = await client.callTool('GetLatestQuotations', {}, { signal: tempController.signal, timeoutMs: 18000 });
      if (client.lastQuota) await saveRemoteFundQuota(client.lastQuota, { storage, now });
      usage = await incrementDailyFundUsage(1, { storage, now });
      const parsed = parseMarketTemperatureSnapshot(result);
      tempSnapshot = parsed;
      if (parsed.hasData) {
        await saveDailyMarketTemperature(parsed, { storage, now });
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        tempError = error?.message || '市场温度获取失败，请检查密钥或网络。';
      }
    } finally {
      tempLoading = false;
      tempController = null;
      if (!disposed) {
        renderBar();
        renderWelcome(hasMessages);
      }
    }
  }

  async function loadFeed(tab = feedTab, { force = false } = {}) {
    const targetTab = tab === 'popular' ? 'popular' : 'topics';
    const state = feedState[targetTab];
    if (state.loading || !hasFundModeApiKey(config)) return;
    const currentCycle = beijingMorningCycleKey(now());
    if (!force && state.fetchedCycle === currentCycle) return;
    if (!force) {
      const cached = await loadDailyFundFeed({ storage, now });
      applyCachedFeed(cached);
      if (feedState[targetTab].fetchedCycle === currentCycle) {
        if (!disposed) {
          renderBar();
          renderWelcome(lastHasMessages);
        }
        return;
      }
    }
    feedState[targetTab] = { ...feedState[targetTab], loading: true, error: '' };
    renderBar();
    renderWelcome(lastHasMessages);
    feedControllers[targetTab]?.abort();
    const controller = new AbortController();
    feedControllers[targetTab] = controller;
    try {
      const client = createYingmiMcpClient({ endpoint: config.endpoint, apiKey: config.apiKey, authMode: config.authMode });
      const toolName = targetTab === 'topics' ? 'SearchHotTopic' : 'GetPopularFund';
      const cachedTools = await loadCachedMcpTools(client.endpoint, { storage, now });
      const toolDef = Array.isArray(cachedTools) ? cachedTools.find(t => t?.name === toolName) : null;
      const toolArgs = sanitizeFundToolArgs(toolName, defaultArgsFromSchema(toolDef, now));
      const result = await client.callTool(toolName, toolArgs, { signal: controller.signal, timeoutMs: 18000 });
      if (client.lastQuota) await saveRemoteFundQuota(client.lastQuota, { storage, now });
      usage = await incrementDailyFundUsage(1, { storage, now });
      if (result.isError) {
        feedState[targetTab] = {
          ...feedState[targetTab],
          error: friendlyFeedError(result.text),
          fetchedCycle: currentCycle,
        };
      } else {
        const parsed = targetTab === 'topics' ? parseHotTopicsList(result) : parsePopularFundsList(result);
        const isEmpty = parsed.length === 0;
        feedState[targetTab] = {
          items: parsed,
          loading: false,
          error: isEmpty ? emptyFeedMessage(targetTab) : '',
          fetchedCycle: currentCycle,
        };
        await saveDailyFundFeed({
          [targetTab]: parsed,
          meta: {
            [targetTab]: {
              cycleKey: currentCycle,
              fetchedAt: now(),
              empty: isEmpty,
            },
          },
        }, { storage, now });
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        feedState[targetTab] = {
          ...feedState[targetTab],
          error: friendlyFeedError(error?.message),
          fetchedCycle: currentCycle,
        };
      }
    } finally {
      feedState[targetTab] = { ...feedState[targetTab], loading: false };
      if (feedControllers[targetTab] === controller) {
        feedControllers[targetTab] = null;
      }
      if (!disposed) {
        renderBar();
        renderWelcome(lastHasMessages);
      }
    }
  }

  async function refreshState(hasMessages = false, { autoSyncTemp = false } = {}) {
    lastHasMessages = Boolean(hasMessages);
    config = await loadFundModeConfig(storage);
    usage = await loadDailyFundUsage({ storage, now });
    const cachedTemp = await loadDailyMarketTemperature({ storage, now });
    if (cachedTemp && cachedTemp.hasData) {
      tempSnapshot = cachedTemp;
      tempError = '';
    }
    const cachedFeed = await loadDailyFundFeed({ storage, now });
    applyCachedFeed(cachedFeed);
    if (disposed) return;
    renderBar();
    renderWelcome(lastHasMessages);

    if (autoSyncTemp && active && hasFundModeApiKey(config)) {
      if (!cachedTemp) {
        const todayKey = usage.date || String(new Date(now()).toISOString().slice(0, 10));
        if (autoFetchedDate !== todayKey) {
          autoFetchedDate = todayKey;
          void refreshTemperature({ force: false, hasMessages: lastHasMessages });
        }
      }
      const currentCycle = beijingMorningCycleKey(now());
      if (feedState[feedTab].fetchedCycle !== currentCycle) {
        void loadFeed(feedTab, { force: false });
      }
    }
  }

  function setActive(nextActive, { hasMessages = false, silent = false } = {}) {
    const normalized = Boolean(nextActive);
    if (active === normalized) {
      syncMenuAndComposer();
      renderBar();
      renderWelcome(hasMessages);
      return active;
    }
    active = normalized;
    syncMenuAndComposer();
    renderBar();
    renderWelcome(hasMessages);
    if (active) void refreshState(hasMessages, { autoSyncTemp: true });
    if (!silent) onModeChange?.(active);
    return active;
  }

  function closePopover() {
    if (!popoverOpen) return;
    popoverOpen = false;
    renderBar();
  }

  function handleInteractiveClick(event, { closeOnPick = false } = {}) {
    const tabBtn = event.target.closest?.('[data-fund-feed-tab]');
    if (tabBtn) {
      const nextTab = tabBtn.dataset.fundFeedTab === 'popular' ? 'popular' : 'topics';
      if (feedTab !== nextTab) {
        feedTab = nextTab;
        renderBar();
        renderWelcome(lastHasMessages);
        const currentCycle = beijingMorningCycleKey(now());
        if (feedState[feedTab].fetchedCycle !== currentCycle) {
          void loadFeed(feedTab, { force: false });
        }
      }
      return true;
    }
    const topicBtn = event.target.closest?.('[data-fund-topic]');
    if (topicBtn) {
      const topic = topicBtn.dataset.fundTopic;
      if (closeOnPick) closePopover();
      onQuickPrompt?.({
        skillId: 'market-analysis',
        prompt: `请结合盈米财经资讯与基金数据，解读热点话题「${topic}」的核心驱动逻辑及其对相关行业板块基金的影响。`,
        autoSend: true,
      });
      return true;
    }
    const popBtn = event.target.closest?.('[data-fund-popular-code]');
    if (popBtn) {
      const code = popBtn.dataset.fundPopularCode;
      const name = popBtn.dataset.fundPopularName;
      if (closeOnPick) closePopover();
      onQuickPrompt?.({
        skillId: 'fund-analysis',
        prompt: `请按标准基金研报框架深度体检 ${name}（${code}）：阶段业绩、持仓估值 PE/PB/ROE、归因、最大回撤修复周期及申赎限额。`,
        autoSend: true,
      });
      return true;
    }
    const actionBtn = event.target.closest?.('[data-fund-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.fundAction;
      if (action === 'exit') { closePopover(); setActive(false); }
      else if (action === 'open-settings') { closePopover(); onOpenSettings?.(); }
      else if (action === 'toggle-popover') {
        popoverOpen = !popoverOpen;
        renderBar();
        const currentCycle = beijingMorningCycleKey(now());
        if (popoverOpen && feedState[feedTab].fetchedCycle !== currentCycle) {
          void loadFeed(feedTab, { force: false });
        }
      }
      else if (action === 'refresh-temp') void refreshTemperature({ force: true, hasMessages: lastHasMessages });
      else if (action === 'ask-temp') {
        if (closeOnPick) closePopover();
        onQuickPrompt?.(MARKET_TEMP_PROMPT_SCENARIO);
      }
      else if (action === 'load-feed') void loadFeed(feedTab, { force: false });
      else if (action === 'refresh-feed') void loadFeed(feedTab, { force: true });
      else if (action === 'ask-feed-ai') {
        if (closeOnPick) closePopover();
        const prompt = feedTab === 'popular'
          ? '请帮我查询近期且慢热门关注基金列表，并简要对比它们的类型、阶段业绩与风险特征。'
          : '请帮我汇总今日财经热点话题榜单，并分析对相关行业板块基金的影响。';
        onQuickPrompt?.({
          skillId: feedTab === 'popular' ? 'fund-screener' : 'market-analysis',
          prompt,
          autoSend: true,
        });
      }
      return true;
    }
    return false;
  }

  const onBarClick = (event) => {
    handleInteractiveClick(event, { closeOnPick: true });
  };

  const onWelcomeClick = (event) => {
    if (handleInteractiveClick(event, { closeOnPick: false })) return;
    const scenarioBtn = event.target.closest?.('[data-fund-scenario]');
    if (!scenarioBtn) return;
    const scenario = FUND_WORKFLOW_ITEMS.find(item => item.id === scenarioBtn.dataset.fundScenario);
    if (scenario) onQuickPrompt?.(scenario);
  };

  const onDocumentPointerDown = (event) => {
    if (!popoverOpen || !fundBar) return;
    if (!fundBar.contains(event.target)) closePopover();
  };

  const onDocumentKeyDown = (event) => {
    if (popoverOpen && event.key === 'Escape') {
      closePopover();
    }
    hideHoverTip();
  };

  // Lightweight floating hover guide tooltip shared across carousel, + menu, and / slash menu.
  const doc = fundBar?.ownerDocument || globalThis.document;
  let tipEl = null;
  let tipTarget = null;
  let tipTimer = null;

  function ensureTipEl() {
    if (tipEl || !doc?.body) return tipEl;
    tipEl = doc.createElement('div');
    tipEl.className = 'fund-hover-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
    doc.body.append(tipEl);
    return tipEl;
  }

  function hideHoverTip() {
    if (tipTimer !== null) {
      clearTimeout(tipTimer);
      tipTimer = null;
    }
    tipTarget = null;
    if (tipEl) tipEl.hidden = true;
  }

  function positionHoverTip(target) {
    if (!tipEl || !target?.isConnected || tipEl.hidden) return;
    const win = doc?.defaultView;
    const vw = win?.innerWidth || 420;
    const vh = win?.innerHeight || 720;
    const rect = target.getBoundingClientRect();
    const tipRect = tipEl.getBoundingClientRect();
    const pad = 10;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(pad, Math.min(vw - tipRect.width - pad, left));
    let top = rect.top - tipRect.height - 8;
    if (top < pad) top = rect.bottom + 8;
    if (top + tipRect.height > vh - pad) top = Math.max(pad, vh - tipRect.height - pad);
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
  }

  function showHoverTip(target) {
    const tip = target?.dataset?.fundTip || '';
    const example = target?.dataset?.fundExample || '';
    if (!tip && !example) { hideHoverTip(); return; }
    const el = ensureTipEl();
    if (!el) return;
    el.innerHTML = `
      ${tip ? `<p class="fund-hover-tip-text">${escapeHtml(tip)}</p>` : ''}
      ${example ? `<p class="fund-hover-tip-example"><span>示例</span>${escapeHtml(example)}</p>` : ''}
    `;
    el.hidden = false;
    positionHoverTip(target);
  }

  function resolveTipTarget(node) {
    if (!node?.closest) return null;
    const direct = node.closest('[data-fund-tip]');
    if (direct) return direct;
    const wfBtn = node.closest('[data-fund-workflow]');
    if (wfBtn) {
      const id = wfBtn.dataset.fundWorkflow;
      const item = id === MARKET_TEMP_PROMPT_SCENARIO.id
        ? MARKET_TEMP_PROMPT_SCENARIO
        : FUND_WORKFLOW_ITEMS.find(entry => entry.id === id);
      if (item?.tip) {
        wfBtn.dataset.fundTip = item.tip;
        if (item.example) wfBtn.dataset.fundExample = item.example;
        return wfBtn;
      }
    }
    return null;
  }

  const onTipPointerOver = (event) => {
    const target = resolveTipTarget(event.target);
    if (!target) {
      if (tipTarget) hideHoverTip();
      return;
    }
    if (target === tipTarget) return;
    if (tipTimer !== null) clearTimeout(tipTimer);
    tipTarget = target;
    tipTimer = setTimeout(() => {
      tipTimer = null;
      if (!disposed && tipTarget === target && target.isConnected) {
        showHoverTip(target);
      }
    }, 180);
  };

  const onTipPointerOut = (event) => {
    if (!tipTarget) return;
    const next = resolveTipTarget(event.relatedTarget);
    if (next !== tipTarget) hideHoverTip();
  };

  const onTipScrollOrDown = () => hideHoverTip();

  const onStorageChange = (changes, area) => {
    if (area !== 'local' || disposed) return;
    if (changes.fundModeConfig || changes.accountSession || changes.fundModeDailyUsage || changes.fundModeRemoteQuota || changes.fundModeDailyMarketTemp || changes.fundModeDailyFeed) {
      void refreshState(lastHasMessages);
    }
  };

  const onSkillChipClick = (event) => {
    if (event.target.closest?.('[data-fund-clear-skill]')) {
      setSkill('');
    }
  };

  fundBar?.addEventListener('click', onBarClick);
  fundWelcome?.addEventListener('click', onWelcomeClick);
  fundSkillChip?.addEventListener('click', onSkillChipClick);
  doc?.addEventListener?.('pointerdown', onDocumentPointerDown);
  doc?.addEventListener?.('pointerdown', onTipScrollOrDown, { capture: true });
  doc?.addEventListener?.('pointerover', onTipPointerOver);
  doc?.addEventListener?.('pointerout', onTipPointerOut);
  doc?.addEventListener?.('scroll', onTipScrollOrDown, { capture: true, passive: true });
  doc?.addEventListener?.('keydown', onDocumentKeyDown);
  globalThis.chrome?.storage?.onChanged?.addListener?.(onStorageChange);

  syncMenuAndComposer();
  void refreshState(false);

  return Object.freeze({
    isActive: () => active,
    hasApiKey: () => hasFundModeApiKey(config),
    getConfig: () => config,
    getSkillId: () => activeSkillId,
    setSkill,
    setActive,
    toggle: (options) => setActive(!active, options),
    syncView({ hasMessages = false } = {}) {
      syncMenuAndComposer();
      renderBar();
      renderWelcome(hasMessages);
    },
    async ensureConfigured() {
      config = await loadFundModeConfig(storage);
      return hasFundModeApiKey(config);
    },
    dispose() {
      disposed = true;
      popoverOpen = false;
      fundCarousel?.dispose();
      fundCarousel = null;
      tempController?.abort();
      feedControllers.topics?.abort();
      feedControllers.popular?.abort();
      fundBar?.removeEventListener('click', onBarClick);
      fundWelcome?.removeEventListener('click', onWelcomeClick);
      fundSkillChip?.removeEventListener('click', onSkillChipClick);
      doc?.removeEventListener?.('pointerdown', onDocumentPointerDown);
      doc?.removeEventListener?.('pointerdown', onTipScrollOrDown, { capture: true });
      doc?.removeEventListener?.('pointerover', onTipPointerOver);
      doc?.removeEventListener?.('pointerout', onTipPointerOut);
      doc?.removeEventListener?.('scroll', onTipScrollOrDown, { capture: true });
      doc?.removeEventListener?.('keydown', onDocumentKeyDown);
      hideHoverTip();
      tipEl?.remove();
      tipEl = null;
      globalThis.chrome?.storage?.onChanged?.removeListener?.(onStorageChange);
    },
  });
}
