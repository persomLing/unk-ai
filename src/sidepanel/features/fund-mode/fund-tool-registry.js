export const DISCOVER_TOOLS_NAME = 'discover_fund_tools';
export const MAX_TOOL_RESULT_CHARS = 22000;

const SHORT_TTL_MS = 10 * 60 * 1000;
const MEDIUM_TTL_MS = 30 * 60 * 1000;

/** Layer 1: 18 high-frequency core tools exposed by default in Fund Mode. */
export const CORE_FUND_TOOL_NAMES = Object.freeze([
  'GuessFundCode',
  'SearchFunds',
  'BatchGetFundsDetail',
  'BatchGetFundNavHistory',
  'GetBatchFundPerformance',
  'AnalyzeFundRisk',
  'fund-recovery-ability',
  'getStockAllocationAndMetricsByFundCode',
  'getFundIndustryAllocation',
  'getFundBrinsonIndicator',
  'getBondIndicator',
  'GetFundDiagnosis',
  'DiagnoseFundPortfolio',
  'GetFundsCorrelation',
  'GetFundsBackTest',
  'GetAssetAllocation',
  'GetLatestQuotations',
  'SearchFinancialNews',
  'BatchGetFundTradeLimit',
  'BatchGetFundTradeRules',
]);

/** Layer 2: Categorized long-tail tools unlocked on demand via `discover_fund_tools`. */
export const FUND_TOOL_CATEGORIES = Object.freeze({
  bond_deep: {
    label: '债基专项分析',
    description: '债基净值异动告警、跳水次数、券种风格筛选、信用评级分布与 Campisi 归因',
    tools: [
      'getBondFundWithAlertRecord',
      'filterBondFundByBondType',
      'filterBondFundByCreditRating',
      'getFundDiveCount',
      'getBondAllocationByFundCode',
      'getBondFundCreditRatingLevel',
      'getFundCampisiIndicator',
    ],
  },
  style_attribution: {
    label: '深度风格、择时与分红',
    description: '换手率筛选、行业偏好与集中度、权益仓位/板块偏好、QDII 地区配置、择时能力、行业收益拆解、业绩基准、分红与拆分记录',
    tools: [
      'filterStockFundByStockTurnover',
      'getFundBenchmarkInfo',
      'getFundIndustryPreference',
      'getFundIndustryConcentration',
      'getFundTurnoverRate',
      'fund-equity-position',
      'fund-sector-preference',
      'getQdFundAreaAllocation',
      'getFundIndustryReturns',
      'getMarketTimingIndicator',
      'BatchGetFundsDividendRecord',
      'BatchGetFundsSplitHistory',
    ],
  },
  advisor_strategy: {
    label: '投顾策略研究',
    description: '投顾策略搜索、详情、重仓基金反查、持仓明细、交易成分、大类资产分布、业绩基准、历史净值、调仓记录与投顾费率模式',
    tools: [
      'StrategySearchByKeyword',
      'GetStrategyDetails',
      'GetFundRelatedStrategies',
      'BatchGetStrategyRiskInfo',
      'GetPortfolioNavHistory',
      'BatchGetStrategiesComposition',
      'BatchGetPoTradeComposition',
      'GetStrategyAssetClassAnalysis',
      'GetStrategyBenchmark',
      'GetStrategyAdjustments',
      'GetAdvisorChargeFeeModel',
      'GetPomodelTradeRule',
    ],
  },
  wealth_planning: {
    label: '家庭财务与组合规划',
    description: '家庭收支/资产负债/财务指标/家庭结构/现金流预测、资产大类分布、投后风险分析、蒙特卡洛收益测算、资产配置与复合基金方案',
    tools: [
      'AnalyzeIncomeExpense',
      'AnalyzeFinancialIndicators',
      'AnalyzeAssetLiability',
      'AnalyzeFamilyMembers',
      'AnalyzeCashFlow',
      'GetFundAssetClassAnalysis',
      'AnalyzePortfolioRisk',
      'MonteCarloSimulate',
      'GetAssetAllocationPlan',
      'GetCompositeModel',
      'AnalyzeInvestmentPerformance',
      'GetTxnDayRange',
    ],
  },
  market_content: {
    label: '市场热点与投顾观点',
    description: '热门基金、热点财经话题榜单、实时资讯 AI 解读、基金经理观点与投顾研报内容',
    tools: [
      'GetPopularFund',
      'SearchHotTopic',
      'searchRealtimeAiAnalysis',
      'SearchManagerViewpoint',
      'searchInvestAdvisorContent',
    ],
  },
  render_utils: {
    label: '时间与图表渲染工具',
    description: '获取服务器当前时间、生成 ECharts 图表图片与 HTML 转 PDF',
    tools: [
      'GetCurrentTime',
      'RenderEchart',
      'RenderHtmlToPdf',
    ],
  },
});

const TOOL_LABELS = Object.freeze({
  [DISCOVER_TOOLS_NAME]: '加载专项基金分析工具',
  calculate_portfolio_math: '计算组合权重与 HHI 集中度',
  GuessFundCode: '匹配基金代码',
  SearchFunds: '搜索筛选基金',
  GetPopularFund: '获取热门关注基金',
  getBondFundWithAlertRecord: '查询债基净值异动',
  filterStockFundByStockTurnover: '按换手率筛选基金',
  filterBondFundByBondType: '按券种风格筛选债基',
  filterBondFundByCreditRating: '按信用评级筛选债基',
  BatchGetFundsDetail: '获取基金详细信息',
  getFundBenchmarkInfo: '查询业绩比较基准',
  BatchGetFundNavHistory: '查询历史净值走势',
  GetBatchFundPerformance: '对比阶段业绩表现',
  AnalyzeFundRisk: '分析基金风险指标',
  getFundDiveCount: '查询债基跳水异动次数',
  'fund-recovery-ability': '评估回撤修复能力',
  getBondIndicator: '分析债基久期与杠杆',
  getFundIndustryAllocation: '查询行业配置比例',
  getFundIndustryPreference: '分析长期行业偏好',
  getFundIndustryConcentration: '计算行业持仓集中度',
  getStockAllocationAndMetricsByFundCode: '穿透持仓估值与盈利指标',
  getFundTurnoverRate: '查询持仓换手率',
  'fund-equity-position': '分析权益仓位偏好',
  'fund-sector-preference': '分析板块配置偏好',
  getBondAllocationByFundCode: '解析债基券种配置',
  getBondFundCreditRatingLevel: '拆解债基信用评级',
  getQdFundAreaAllocation: '解析 QDII 地区配置',
  getFundBrinsonIndicator: '执行 Brinson 业绩归因',
  getFundCampisiIndicator: '执行 Campisi 债基归因',
  getFundIndustryReturns: '拆解行业收益贡献',
  getMarketTimingIndicator: '评估权益择时能力',
  BatchGetFundsDividendRecord: '查询历史分红记录',
  BatchGetFundsSplitHistory: '查询历史拆分记录',
  GetFundDiagnosis: '生成基金综合诊断',
  BatchGetStrategyRiskInfo: '查询策略风险画像',
  GetPortfolioNavHistory: '查询组合历史净值',
  GetFundRelatedStrategies: '反查重仓投顾策略',
  StrategySearchByKeyword: '搜索投顾策略',
  GetStrategyDetails: '查询投顾策略详情',
  BatchGetStrategiesComposition: '查询策略底层持仓',
  BatchGetPoTradeComposition: '查询策略交易成分',
  GetStrategyAssetClassAnalysis: '穿透策略大类资产',
  GetStrategyBenchmark: '查询策略业绩基准',
  GetStrategyAdjustments: '查询策略调仓记录',
  AnalyzeIncomeExpense: '分析家庭收支结构',
  AnalyzeFinancialIndicators: '计算财务健康指标',
  AnalyzeAssetLiability: '分析资产负债状况',
  AnalyzeFamilyMembers: '识别家庭生命周期',
  AnalyzeCashFlow: '预测跨期现金流',
  GetAssetAllocation: '穿透组合大类资产配置',
  GetFundAssetClassAnalysis: '分析基金资产大类分布',
  DiagnoseFundPortfolio: '执行持仓组合综合诊断',
  GetFundsCorrelation: '计算基金持仓相关性',
  AnalyzePortfolioRisk: '测算组合投后风险',
  GetFundsBackTest: '执行组合历史回测',
  MonteCarloSimulate: '运行蒙特卡洛收益测算',
  GetAssetAllocationPlan: '生成资产配置方案',
  GetCompositeModel: '获取复合基金方案',
  AnalyzeInvestmentPerformance: '评估投资方案可行性',
  GetLatestQuotations: '获取今日市场温度计',
  SearchFinancialNews: '检索财经资讯',
  SearchHotTopic: '查询热点财经话题',
  searchRealtimeAiAnalysis: '检索实时资讯 AI 解读',
  SearchManagerViewpoint: '检索基金经理观点',
  searchInvestAdvisorContent: '检索投顾研报观点',
  BatchGetFundTradeLimit: '查询基金申赎限额',
  BatchGetFundTradeRules: '查询申赎费率与确认规则',
  GetTxnDayRange: '查询有效交易日',
  GetAdvisorChargeFeeModel: '查询投顾费率模式',
  GetPomodelTradeRule: '查询组合交易规则',
  GetCurrentTime: '获取服务器当前时间',
  RenderHtmlToPdf: '渲染 PDF 报告',
  RenderEchart: '渲染 ECharts 图表',
});

const NO_CACHE_TOOLS = new Set(['GetCurrentTime', 'RenderHtmlToPdf', 'RenderEchart']);
const SHORT_CACHE_TOOLS = new Set([
  'GetLatestQuotations',
  'SearchFinancialNews',
  'SearchHotTopic',
  'searchRealtimeAiAnalysis',
  'GetPopularFund',
  'getBondFundWithAlertRecord',
]);

export function fundToolLabel(name) {
  return TOOL_LABELS[name] || `查询 ${name}`;
}

export function fundToolCacheTtl(name) {
  if (NO_CACHE_TOOLS.has(name)) return 0;
  if (SHORT_CACHE_TOOLS.has(name)) return SHORT_TTL_MS;
  return MEDIUM_TTL_MS;
}

export function discoverToolsSchema() {
  const categoryList = Object.entries(FUND_TOOL_CATEGORIES)
    .map(([key, meta]) => `${key}（${meta.label}：${meta.description}）`)
    .join('；');
  return {
    type: 'function',
    function: {
      name: DISCOVER_TOOLS_NAME,
      description: `按需加载更多盈米专项基金分析工具（不消耗远程配额）。当默认核心工具不足时调用。可选分类：${categoryList}`,
      parameters: {
        type: 'object',
        properties: {
          categories: {
            type: 'array',
            items: {
              type: 'string',
              enum: Object.keys(FUND_TOOL_CATEGORIES),
            },
            description: '要启用的工具分类列表（每次最多 2 个分类）。',
          },
        },
        required: ['categories'],
        additionalProperties: false,
      },
    },
  };
}

/** Convert an MCP tool descriptor into an OpenAI-compatible function tool schema. */
export function toOpenAiToolSchema(mcpTool) {
  const rawParams = mcpTool?.inputSchema && typeof mcpTool.inputSchema === 'object'
    ? structuredClone(mcpTool.inputSchema)
    : { type: 'object', properties: {} };
  if (!rawParams.type) rawParams.type = 'object';
  if (rawParams.type === 'object' && !rawParams.properties) rawParams.properties = {};
  return {
    type: 'function',
    function: {
      name: String(mcpTool.name),
      description: String(mcpTool.description || fundToolLabel(mcpTool.name)).slice(0, 600),
      parameters: rawParams,
    },
  };
}

/** Select the initial core tool subset (plus fallback to first 20 tools if server naming differs). */
export function selectCoreMcpTools(allTools = []) {
  const byName = new Map(allTools.filter(tool => tool?.name).map(tool => [tool.name, tool]));
  const selected = [];
  for (const name of CORE_FUND_TOOL_NAMES) {
    if (byName.has(name)) selected.push(byName.get(name));
  }
  if (!selected.length) {
    return allTools.slice(0, 20);
  }
  return selected;
}

export function selectCategoryMcpTools(allTools = [], categories = []) {
  const byName = new Map(allTools.filter(tool => tool?.name).map(tool => [tool.name, tool]));
  const activated = [];
  const seen = new Set();
  for (const rawCategory of Array.isArray(categories) ? categories.slice(0, 2) : []) {
    const meta = FUND_TOOL_CATEGORIES[String(rawCategory || '').trim()];
    if (!meta) continue;
    for (const name of meta.tools) {
      if (byName.has(name) && !seen.has(name)) {
        seen.add(name);
        activated.push(byName.get(name));
      }
    }
  }
  return activated;
}

/** Safely trim an oversized MCP tool payload to fit within a character budget. */
export function trimToolPayload(payload, maxChars = MAX_TOOL_RESULT_CHARS) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (serialized.length <= maxChars) {
    return { data: payload, truncated: false };
  }
  if (typeof payload === 'string') {
    return {
      data: `${payload.slice(0, maxChars)}\n…[数据过长已截断，原文共 ${serialized.length} 字符]`,
      truncated: true,
    };
  }
  const cloned = structuredClone(payload);
  const shrink = (node, depth = 0) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length > 24) node.length = 24;
      for (const item of node) shrink(item, depth + 1);
      return;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string' && value.length > 1200) {
        node[key] = `${value.slice(0, 1200)}…`;
      } else if (value && typeof value === 'object') {
        shrink(value, depth + 1);
      }
    }
  };
  shrink(cloned);
  const compact = JSON.stringify(cloned);
  if (compact.length <= maxChars) {
    return { data: cloned, truncated: true };
  }
  return {
    data: `${compact.slice(0, maxChars)}…[结构化结果已按预算截断]`,
    truncated: true,
  };
}

const CHART_KEY_RE = /(echart|chart|radar|graph|image).*url$|^echartUrl$/i;
const IMAGE_URL_RE = /^https:\/\/[^\s"'<>]+(?:\.(?:png|jpe?g|webp|svg)(?:\?[^\s"'<>]*)?|(?:echart|chart|render)[^\s"'<>]*)/i;

/** Extract verified HTTPS chart image URLs returned by Yingmi MCP tools. */
export function extractSafeChartUrls(payload, label = '研报图表') {
  const urls = [];
  const seen = new Set();
  const pushUrl = (raw) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('https://') || seen.has(trimmed)) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:') return;
      seen.add(trimmed);
      urls.push({ url: parsed.toString(), label });
    } catch {
      // Ignore malformed URLs.
    }
  };

  const walk = (node, depth = 0) => {
    if (depth > 6 || !node || urls.length >= 4) return;
    if (typeof node === 'string') {
      const match = node.match(IMAGE_URL_RE);
      if (match) pushUrl(match[0]);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string' && CHART_KEY_RE.test(key)) {
          pushUrl(value);
        } else if (value && typeof value === 'object') {
          walk(value, depth + 1);
        }
      }
    }
  };

  walk(payload);
  return urls;
}
