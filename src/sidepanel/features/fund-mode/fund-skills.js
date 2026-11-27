/**
 * Built-in Yingmi Official Research Skill Playbooks, Deterministic Portfolio Math,
 * Parameter Pitfall Guards, and Compliance Disclaimers.
 *
 * Distilled from Yingmi AI Open Platform official `yingmi-skill` workflows so UNK AI
 * runs structured institutional-grade fund research locally in Chrome MV3.
 */

export const PORTFOLIO_MATH_TOOL_NAME = 'calculate_portfolio_math';
export const FUND_METRICS_MATH_TOOL_NAME = 'analyze_fund_metrics';

export const FUND_DISCLAIMERS = Object.freeze({
  research: '数据由盈米 MCP 提供；公募重仓与行业配置受法定季报披露周期限制存在滞后。历史业绩不预示未来表现，以上研究分析仅供参考，不构成投资建议。',
  planning: '财务测算基于你提供的假设与盈米 MCP 模型结果，市场收益存在不确定性；本规划仅作情景参考，不构成收益承诺或投资建议。',
  allocation: '资产配置方案需结合有效风险测评、资金期限与流动性约束综合评估；历史回测与蒙特卡洛模拟不代表未来实际收益，不构成投资建议。',
  product: '基金费率、限额与确认规则以基金合同、招募说明书及销售机构最新公告为准；以上规则整理仅供参考，不构成交易指令。',
});

export const FUND_SKILLS = Object.freeze({
  'fund-analysis': {
    id: 'fund-analysis',
    name: '基金深度研报',
    shortLabel: '基金研报 SOP',
    icon: 'stethoscope',
    disclaimerType: 'research',
    preloadCategories: ['style_attribution', 'bond_deep'],
    sop: [
      '【执行 Skill：fund-analysis（公募基金深度研究 SOP）】',
      '1. 身份与分类校准（必做）：先用 GuessFundCode/SearchFunds（若给名称）再调 BatchGetFundsDetail 核对真实名称、代码与基金类型，严禁跳过详情直接推断类型。',
      '2. 通用基线：调用 GetBatchFundPerformance（多区间业绩/同类分位/夏普/回撤）；深度或风险分析补充 AnalyzeFundRisk 与 BatchGetFundNavHistory（画曲线必须传 isDesc: false）。',
      '3. 按基金类型分支深挖（严禁跨类混用）：',
      '   - 权益/偏股混合：调 getStockAllocationAndMetricsByFundCode（PE/PB/ROE/集中度）、getFundIndustryAllocation、getFundBrinsonIndicator（配置/选股超额）与 fund-recovery-ability。若 getFundIndustryAllocation 对某只基金返回空数组（常见于最新季报尚未有中信口径穿透），可切换口径/省略报告期或改用重仓股与 getFundIndustryPreference 交叉补充，勿用相同参数重复空查。',
      '   - 债券基金：调 getBondIndicator（久期/杠杆/集中度）、getBondAllocationByFundCode（券种，assetType 用下划线如 bond_asset）、getBondFundCreditRatingLevel、getFundCampisiIndicator、getFundDiveCount。',
      '   - QDII 查 getQdFundAreaAllocation；指数基金查 getFundBenchmarkInfo；货币基金只看 7 日年化/万份收益/规模流动性，不跑股票归因。',
      '4. 多基金对比时必调 GetFundsCorrelation 评估相关性与重仓重叠度。',
      '5. 口径防误读与四项质检：异常值先做「净值日新鲜度 / 成立时长样本完整度 / 接口降级或隐藏标记 / 净值与累计收益自洽性（排除分红拆分）」四项核查；managers[].periodReturn 是基金经理历史从业期回报，绝不能写成“本基金任职回报”；不编造无字段支撑的指标。缺少持仓穿透时，结论止步于“风险收益特征偏离”，不臆测具体操盘动作。',
      '6. 研报节奏与可视化结构：按「`> **核心结论**` 与读图引导 → `fund-kpi` 核心指标卡 → `fund-chart`（多基横向对比优先配 `scatter` 散点象限图或 `bar` / `line` 走势图）→ 显式口径说明 → 关键指标对比表 → 持仓结构与归因（`hbar`）→ `fund-steps` 方法论总结（如适用）→ `> **风险提示**`、申赎费率与适配场景」组织。',
    ].join('\n'),
  },
  'fund-screener': {
    id: 'fund-screener',
    name: '基金筛选与排雷',
    shortLabel: '专业选基 SOP',
    icon: 'scale',
    disclaimerType: 'research',
    preloadCategories: ['bond_deep', 'style_attribution', 'market_content'],
    sop: [
      '【执行 Skill：fund-screener（基金筛选与排雷 SOP）】',
      '1. 候选池初筛：通用筛选用 SearchFunds（严禁同时传 keyword 与 category；page 从 0 开始；指数基金可按跟踪误差排序）；债基券种/信用硬条件用 filterBondFundByBondType / filterBondFundByCreditRating（assetType 必须用驼峰如 bondAsset/totalNetAsset）；换手率用 filterStockFundByStockTurnover；债基排雷用 getBondFundWithAlertRecord。',
      '2. 交集收敛与核验：多条件取交集收敛到 <=20 只，必须调 BatchGetFundsDetail 核对身份与申赎状态，再按需补 GetBatchFundPerformance、AnalyzeFundRisk、fund-recovery-ability、BatchGetFundTradeLimit。',
      '3. 硬约束红线与本地统计：若无完全匹配结果，先如实告知并列出瓶颈条件，严禁静默放宽硬约束。多只候选横向比对时，优先调用本地 `analyze_fund_metrics` 一次算出分位正常带（P25–P75）、Tukey 偏离阈值、离散度、相对基准超额及净值陈旧标记，严禁口算或估算。',
      '4. 输出规范：先给结论与读图引导，再配 `fund-chart`（有两项以上连续指标如收益 vs 回撤/波动/Beta 时优先用 `scatter` 散点图，或用 `bar` 对比）与显式口径说明，随后给出精选 3–5 只候选基金结构化对比表及「正常/偏离对照表」，逐只写明「核心优势」与「需要接受的权衡/风险」；热门访问榜与跳水记录均不得直接作为买卖推荐。',
    ].join('\n'),
  },
  'portfolio-analysis': {
    id: 'portfolio-analysis',
    name: '持仓组合诊断回测',
    shortLabel: '组合诊断 SOP',
    icon: 'pie-chart',
    disclaimerType: 'allocation',
    preloadCategories: ['wealth_planning'],
    sop: [
      '【执行 Skill：portfolio-analysis（持仓组合体检与回测 SOP）】',
      '1. 身份与权重标准化：先用 GuessFundCode + BatchGetFundsDetail 核对每只基金；若涉及多只基金金额或权重，优先调用本地工具 calculate_portfolio_math（不扣远端额度）合并重复基金、计算归一化权重与 HHI 集中度。纯权重输入使用名义金额测算，严禁表述为用户真实资产。',
      '2. 完整体检调用链：DiagnoseFundPortfolio（综合诊断）→ GetFundAssetClassAnalysis / GetAssetAllocation（六大类资产穿透）→ GetFundsCorrelation（只传 [{fundCode}]，严禁传 amount/fundName）→ GetFundsBackTest（传 [{fundCode, amount}]，严禁传 fundName）→ AnalyzePortfolioRisk。',
      '3. 进阶情景（按需）：流动性查 BatchGetFundTradeLimit + BatchGetFundTradeRules；未来情景调 MonteCarloSimulate（必须齐全六大类键且合计为 1，未穿透出的类别严禁填 0；且不可用于模拟定投路径）。',
      '4. 避坑红线：GetPortfolioNavHistory 仅用于投顾组合 poCode，绝不能用于用户自建基金篮子。',
      '5. 输出结构：`> **核心结论**` → `fund-kpi` 组合核心指标（集中度 HHI/预期回撤/收益）→ `fund-chart`（`donut` 六大类资产穿透 + `bar` 或 `line` 历史回测）→ 权重与相关性表 → 按「证据 → 问题 → 改善目标 → 可能代价 → 待确认条件」组织的优化建议与 `> **风险提示**`。',
    ].join('\n'),
  },
  'strategy-analysis': {
    id: 'strategy-analysis',
    name: '投顾策略深度研究',
    shortLabel: '投顾策略 SOP',
    icon: 'compass',
    disclaimerType: 'research',
    preloadCategories: ['advisor_strategy'],
    sop: [
      '【执行 Skill：strategy-analysis（投顾策略分析 SOP）】',
      '1. 策略识别：先用 StrategySearchByKeyword 定位策略代码，或用 GetFundRelatedStrategies(fundCode) 反查重仓持有某基金的投顾策略。',
      '2. 全面拆解：调 GetStrategyDetails → BatchGetStrategyRiskInfo → GetStrategyAssetClassAnalysis → GetStrategyBenchmark → BatchGetStrategiesComposition（当前持仓截面）与 BatchGetPoTradeComposition（交易成分）→ GetStrategyAdjustments（历史调仓记录）→ GetAdvisorChargeFeeModel / GetPomodelTradeRule（费率与规则）。',
      '3. 避坑红线：区分「当前持仓截面」与「交易成分」；GetPortfolioNavHistory 仅能传接口核验返回的 poCode，严禁直接代入 strategyCode 或 assetPlanId。',
      '4. 输出结构：策略定位与主理人 → 风险收益与基准对比 → 大类穿透与底层持仓 → 调仓纪律与风格变化 → 投顾费率模式与适配人群。',
    ].join('\n'),
  },
  'market-analysis': {
    id: 'market-analysis',
    name: '市场复盘与研报洞察',
    shortLabel: '市场洞察 SOP',
    icon: 'flame',
    disclaimerType: 'research',
    preloadCategories: ['market_content', 'render_utils'],
    sop: [
      '【执行 Skill：market-analysis（市场洞察与复盘 SOP）】',
      '1. 时间与行情校准：必要时调 GetCurrentTime / GetTxnDayRange（beforeDays/afterDays 必传字符串）确认最近交易日，再调 GetLatestQuotations 获取收盘市场温度与核心宽基指数估值。',
      '2. 事实与观点分离：用 SearchFinancialNews 获取权威财经事实，searchRealtimeAiAnalysis 仅作次级线索（过滤其中主观买卖建议），叠加 SearchManagerViewpoint / searchInvestAdvisorContent 汇总具名观点；仅用户问平台热度时查 SearchHotTopic / GetPopularFund(size: 8)。',
      '3. 口径红线：GetLatestQuotations 为交易日收盘截面，非盘中实时价；区间涨跌幅禁止用首尾日涨跌幅相减；无结构化数据时严禁编造行业涨跌榜、两市成交额或北向资金数字。',
      '4. 输出结构：`> **核心结论**` → `fund-chart`（`gauge` 市场温度仪表条）与核心宽基估值表 → 关键催化事件与逻辑拆解 → 基金经理/投顾观点对照 → 观察要点与 `> **风险提示**`。',
    ].join('\n'),
  },
  'wealth-planning': {
    id: 'wealth-planning',
    name: '家庭财务与配置规划',
    shortLabel: '财富配置 SOP',
    icon: 'pie-chart',
    disclaimerType: 'planning',
    preloadCategories: ['wealth_planning'],
    sop: [
      '【执行 Skill：family-wealth-planning & advisor-allocation（财富规划与配置 SOP）】',
      '1. 适当性前置闸门（强制）：若用户要求生成个性化大类配置方案，必须先确认 5 项核心约束（风险承受能力、资金期限、流动性需求、投资目标、最大可接受回撤）+ 可投资金额（需明确剔除应急金）与禁投资产；若明显缺失，先输出简洁的「待确认信息清单」引导补充，严禁凭空假设并直接调用 GetAssetAllocationPlan 输出个性化权重！',
      '2. 家庭财务体检链：AnalyzeIncomeExpense → AnalyzeAssetLiability → AnalyzeFinancialIndicators（monthlyEssentialExpense 必须直接复用 AnalyzeIncomeExpense 返回的月必要性支出，严禁总支出/12 冒充）→ AnalyzeCashFlow。',
      '3. 分桶配置原则：严禁将 1 年内刚性用款与 5 年以上长期资金混为一桶；逐桶按期限（spare/oneYear/oneToThree/threeToFive/overFive）调用 GetAssetAllocationPlan，需要具体基金篮子时再用 GetCompositeModel(assetPlanId) 展开并做相关性/回测校验（严禁简单加权最大回撤）。',
      '4. 利率口径：AnalyzeInvestmentPerformance 的 4% 仅为技术缺省值，必须明确标出用户假设报酬率，未确认时可做 0% 本金压力测试。',
    ].join('\n'),
  },
  'product-qa': {
    id: 'product-qa',
    name: '费率规则与交易日历',
    shortLabel: '产品规则 SOP',
    icon: 'shield-check',
    disclaimerType: 'product',
    preloadCategories: ['style_attribution', 'advisor_strategy', 'wealth_planning'],
    sop: [
      '【执行 Skill：advisor-product-communication（产品规则与费率答疑 SOP）】',
      '1. 身份与状态确认：先调 BatchGetFundsDetail 核对基金全称、A/C 份额差异与申购/认购/赎回状态（内部区分 canAllot 日常申购与 canSubscribe 募集期认购；已成立基金日常开放申购时 canSubscribe=false 属正常现象，输出表格时转成清晰中文如「开放申购」「非募集期」「开放赎回」，勿裸露英文字段名）。',
      '2. 规则核验链：调 BatchGetFundTradeLimit（起购/限额/定投限制）→ BatchGetFundTradeRules（申赎费率、确认与到账时间）→ GetTxnDayRange（查询具体交易日与确认日历，beforeDays/afterDays 传字符串）；按需补 BatchGetFundsDividendRecord / BatchGetFundsSplitHistory 或 GetAdvisorChargeFeeModel。',
      '3. 输出结构：用清晰表格整理「申购/赎回费率阶梯（含 7 天惩罚性赎回费提醒）」「限额与状态」「T+N 确认与到账时间轴」，以及 A/C 份额持有期成本对比与常见误区提示。',
    ].join('\n'),
  },
});

export function getFundSkill(skillId) {
  return skillId && FUND_SKILLS[skillId] ? FUND_SKILLS[skillId] : null;
}

export function disclaimerForSkill(skillId) {
  const skill = getFundSkill(skillId);
  return FUND_DISCLAIMERS[skill?.disclaimerType || 'research'] || FUND_DISCLAIMERS.research;
}

/** Lightweight keyword-based Skill suggestion when user didn't explicitly pick one. */
export function inferFundSkillId(question = '') {
  const q = String(question || '').trim();
  if (!q) return '';
  if (/投顾|策略|发车|调仓|主理人/.test(q)) return 'strategy-analysis';
  if (/组合|持仓|回测|蒙特卡洛|分散|相关性|仓位配比/.test(q)) return 'portfolio-analysis';
  if (/家庭|现金流|资产负债|养老|教育金|四笔钱|资产配置方案|规划/.test(q)) return 'wealth-planning';
  if (/筛选|推荐几只|排雷|跳水|选基|找几只|换手率|信用评级/.test(q)) return 'fund-screener';
  if (/费率|申购|赎回|限额|确认时间|到账|交易日|分红|拆分|A类.*C类|C类.*A类/i.test(q)) return 'product-qa';
  if (/市场温度|宽基|复盘|早报|热点|行情|大盘|指数估值/.test(q)) return 'market-analysis';
  if (/\b\d{6}\b|体检|诊断|归因|回撤|净值|对比|PK|基金经理/i.test(q)) return 'fund-analysis';
  return '';
}

const SNAKE_ASSET_MAP = Object.freeze({
  totalAsset: 'total_asset',
  totalNetAsset: 'total_net_asset',
  bondAsset: 'bond_asset',
});

const CAMEL_ASSET_MAP = Object.freeze({
  total_asset: 'totalAsset',
  total_net_asset: 'totalNetAsset',
  bond_asset: 'bondAsset',
});

/**
 * Deterministic parameter pitfall guard based on Yingmi official `tool-routing.md`.
 * Auto-fixes known schema mismatches before dispatching remote MCP calls.
 */
export function sanitizeFundToolArgs(toolName, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? structuredClone(rawArgs) : {};

  if (toolName === 'GetPopularFund') {
    const size = Number(args.size);
    args.size = Number.isFinite(size) && size >= 1 ? Math.min(20, Math.round(size)) : 8;
    return args;
  }

  if (toolName === 'SearchFunds') {
    if (args.keyword && String(args.keyword).trim() && args.category !== undefined) {
      delete args.category;
    }
    return args;
  }

  if (toolName === 'BatchGetFundNavHistory') {
    if (args.isDesc === undefined) args.isDesc = false;
    return args;
  }

  if (toolName === 'GetFundsCorrelation' && Array.isArray(args.fundList)) {
    args.fundList = args.fundList
      .map(item => (item && typeof item === 'object' ? { fundCode: String(item.fundCode || item.code || '').trim() } : null))
      .filter(item => item && item.fundCode);
    return args;
  }

  if (toolName === 'GetFundsBackTest' && Array.isArray(args.fundList)) {
    args.fundList = args.fundList
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const fundCode = String(item.fundCode || item.code || '').trim();
        const next = { fundCode };
        if (item.amount !== undefined) next.amount = Number(item.amount);
        if (item.weight !== undefined && item.amount === undefined) next.weight = Number(item.weight);
        return fundCode ? next : null;
      })
      .filter(Boolean);
    return args;
  }

  if (toolName === 'GetTxnDayRange') {
    if (args.beforeDays !== undefined && typeof args.beforeDays !== 'string') args.beforeDays = String(args.beforeDays);
    if (args.afterDays !== undefined && typeof args.afterDays !== 'string') args.afterDays = String(args.afterDays);
    return args;
  }

  if (toolName === 'getBondAllocationByFundCode' && typeof args.assetType === 'string') {
    if (SNAKE_ASSET_MAP[args.assetType]) args.assetType = SNAKE_ASSET_MAP[args.assetType];
    return args;
  }

  if ((toolName === 'filterBondFundByBondType' || toolName === 'filterBondFundByCreditRating') && typeof args.assetType === 'string') {
    if (CAMEL_ASSET_MAP[args.assetType]) args.assetType = CAMEL_ASSET_MAP[args.assetType];
    return args;
  }

  if (toolName === 'GetPortfolioNavHistory') {
    delete args.poManagerId;
    delete args.broker;
    return args;
  }

  return args;
}

export function portfolioMathToolSchema() {
  return {
    type: 'function',
    function: {
      name: PORTFOLIO_MATH_TOOL_NAME,
      description: '本地确定性组合计算工具（不消耗盈米远程额度）：合并重复基金、计算归一化权重、HHI 集中度与前三大占比，并直接生成可直接传给 GetFundsCorrelation / GetFundsBackTest / AnalyzePortfolioRisk 的标准入参。',
      parameters: {
        type: 'object',
        properties: {
          holdings: {
            type: 'array',
            description: '持仓列表，每项提供 fundCode 以及 amount（金额）或 weight（权重/百分比）之一。',
            items: {
              type: 'object',
              properties: {
                fundCode: { type: 'string', description: '6 位基金代码' },
                amount: { type: 'number', description: '持有金额（可选）' },
                weight: { type: 'number', description: '权重小数或百分比（可选，如 0.3 或 30）' },
              },
              required: ['fundCode'],
            },
          },
          nominalTotal: {
            type: 'number',
            description: '纯权重输入时用于回测的名义总金额，默认 100000。',
          },
        },
        required: ['holdings'],
        additionalProperties: false,
      },
    },
  };
}

/** Deterministic portfolio aggregation & concentration math (mirrors Yingmi `portfolio_math.py`). */
export function computePortfolioMath({ holdings = [], nominalTotal = 100000 } = {}) {
  const list = Array.isArray(holdings) ? holdings : [];
  if (!list.length) {
    return { ok: false, error: '持仓列表为空，请至少提供一只基金及其金额或权重。' };
  }

  const hasAmount = list.some(item => Number.isFinite(Number(item?.amount)) && Number(item.amount) > 0);
  const merged = new Map();
  for (const item of list) {
    const code = String(item?.fundCode || item?.code || '').trim();
    if (!code) continue;
    const val = hasAmount ? Number(item.amount) : Number(item.weight);
    if (!Number.isFinite(val) || val <= 0) continue;
    merged.set(code, (merged.get(code) || 0) + val);
  }

  if (!merged.size) {
    return { ok: false, error: '未解析到有效的正数金额或权重。' };
  }

  const rawTotal = [...merged.values()].reduce((sum, v) => sum + v, 0);
  const baseTotal = hasAmount ? rawTotal : (Number(nominalTotal) > 0 ? Number(nominalTotal) : 100000);

  const normalized = [...merged.entries()]
    .map(([fundCode, rawValue]) => {
      const weight = rawValue / rawTotal;
      return {
        fundCode,
        weight: Number(weight.toFixed(6)),
        weightPercent: `${(weight * 100).toFixed(2)}%`,
        amount: Number((weight * baseTotal).toFixed(2)),
      };
    })
    .sort((a, b) => b.weight - a.weight);

  const hhi = normalized.reduce((sum, item) => sum + item.weight * item.weight, 0);
  const effectiveHoldings = hhi > 0 ? Number((1 / hhi).toFixed(2)) : 0;
  const top1Weight = normalized[0]?.weight || 0;
  const top3Weight = normalized.slice(0, 3).reduce((sum, item) => sum + item.weight, 0);
  const concentrationLevel = hhi >= 0.35 ? '高集中' : hhi >= 0.2 ? '中度集中' : '较分散';

  return {
    ok: true,
    inputBasis: hasAmount ? 'actual-amount' : 'weight-nominal',
    totalAmount: Number(baseTotal.toFixed(2)),
    holdingCount: normalized.length,
    hhi: Number(hhi.toFixed(4)),
    effectiveHoldings,
    concentrationLevel,
    top1Percent: `${(top1Weight * 100).toFixed(2)}%`,
    top3Percent: `${(top3Weight * 100).toFixed(2)}%`,
    holdings: normalized,
    correlationFundList: normalized.map(item => ({ fundCode: item.fundCode })),
    backTestFundList: normalized.map(item => ({ fundCode: item.fundCode, amount: item.amount })),
    riskHoldings: normalized.map(item => ({ fundCode: item.fundCode, weight: item.weight })),
    notice: hasAmount
      ? '已按真实输入金额合并重复基金并归一化。'
      : `输入为纯权重，回测金额按名义金额 ${baseTotal} 元等比换算，报告中严禁表述为用户真实持有金额。`,
  };
}

export function fundMetricsMathToolSchema() {
  return {
    type: 'function',
    function: {
      name: FUND_METRICS_MATH_TOOL_NAME,
      description: '本地确定性多基金统计与偏离识别工具（不消耗盈米远程额度）：对批量基金指标计算样本数、均值、标准差、P25/中位数/P75 正常带、IQR 离散度、Tukey 异常偏离阈值、相对基准超额差值、排名及净值新鲜度核查。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '基金样本列表（最多 200 条），每项包含 name/id、可选 navDate(YYYY-MM-DD) 与 metrics 数值字典。',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '基金代码或标识' },
                name: { type: 'string', description: '基金名称' },
                group: { type: 'string', description: '策略或分组标签（可选）' },
                navDate: { type: 'string', description: '最新净值日期 YYYY-MM-DD（可选，用于陈旧度核查）' },
                metrics: {
                  type: 'object',
                  description: '数值指标键值对，如 {"return1y": 18.5, "maxDrawdown1y": -11.2, "volatility1y": 14.3, "beta": 0.85}',
                },
              },
              required: ['metrics'],
            },
          },
          metricKeys: {
            type: 'array',
            items: { type: 'string' },
            description: '需要统计的指标键列表；不传则自动聚合所有数值指标。',
          },
          benchmark: {
            type: 'object',
            description: '可选基准对照对象，包含 name 与 metrics 字典。',
            properties: {
              name: { type: 'string' },
              metrics: { type: 'object' },
            },
          },
          sortBy: { type: 'string', description: '按哪个指标排序（可选）。' },
          sortOrder: { type: 'string', enum: ['desc', 'asc'], description: '排序方向，默认 desc。' },
          iqrMultiplier: { type: 'number', description: 'Tukey 异常偏离倍数 k，默认 1.5。' },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  };
}

function roundStat(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseStatNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/,/g, '').replace(/[%％]/g, '').replace(/[＋]/g, '+').replace(/[−]/g, '-');
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function parseIsoDayMs(raw) {
  const m = String(raw || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Deterministic cross-sectional statistics, benchmark excess, outlier fencing,
 * and NAV-freshness hygiene check for multi-fund due diligence.
 */
export function computeFundMetricsAnalysis({
  items = [],
  metricKeys = [],
  benchmark = null,
  sortBy = '',
  sortOrder = 'desc',
  iqrMultiplier = 1.5,
} = {}) {
  const rawList = Array.isArray(items) ? items.slice(0, 200) : [];
  if (!rawList.length) {
    return { ok: false, error: '样本列表为空，请至少提供一只基金的 metrics 数值数据。' };
  }

  const k = Number.isFinite(Number(iqrMultiplier)) && Number(iqrMultiplier) > 0 ? Number(iqrMultiplier) : 1.5;
  const normalizedItems = rawList.map((entry, index) => {
    const src = entry && typeof entry === 'object' ? entry : {};
    const rawMetrics = src.metrics && typeof src.metrics === 'object' ? src.metrics : {};
    const metrics = {};
    for (const [key, val] of Object.entries(rawMetrics)) {
      const parsed = parseStatNumber(val);
      if (parsed !== null) metrics[key] = parsed;
    }
    return {
      id: String(src.id || src.fundCode || src.code || `item-${index + 1}`).trim(),
      name: String(src.name || src.fundName || src.id || `样本 ${index + 1}`).trim(),
      group: src.group ? String(src.group).trim() : '',
      navDate: src.navDate ? String(src.navDate).trim() : '',
      metrics,
    };
  });

  const explicitKeys = Array.isArray(metricKeys)
    ? metricKeys.map(key => String(key || '').trim()).filter(Boolean)
    : [];
  const discoveredKeys = [];
  const seenKeys = new Set();
  for (const item of normalizedItems) {
    for (const key of Object.keys(item.metrics)) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        discoveredKeys.push(key);
      }
    }
  }
  const keys = (explicitKeys.length ? explicitKeys : discoveredKeys).slice(0, 16);
  if (!keys.length) {
    return { ok: false, error: '未在样本中解析到有效的数值指标（metrics）。' };
  }

  const benchMetrics = {};
  if (benchmark && typeof benchmark === 'object' && benchmark.metrics && typeof benchmark.metrics === 'object') {
    for (const [key, val] of Object.entries(benchmark.metrics)) {
      const parsed = parseStatNumber(val);
      if (parsed !== null) benchMetrics[key] = parsed;
    }
  }

  const stats = {};
  for (const key of keys) {
    const vals = normalizedItems
      .map(item => item.metrics[key])
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (!vals.length) {
      stats[key] = { count: 0, missingCount: normalizedItems.length };
      continue;
    }
    const sum = vals.reduce((acc, v) => acc + v, 0);
    const mean = sum / vals.length;
    const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length;
    const p25 = quantileSorted(vals, 0.25);
    const median = quantileSorted(vals, 0.5);
    const p75 = quantileSorted(vals, 0.75);
    const iqr = p75 - p25;
    const min = vals[0];
    const max = vals[vals.length - 1];
    stats[key] = {
      count: vals.length,
      missingCount: normalizedItems.length - vals.length,
      min: roundStat(min),
      p25: roundStat(p25),
      median: roundStat(median),
      p75: roundStat(p75),
      max: roundStat(max),
      mean: roundStat(mean),
      stdDev: roundStat(Math.sqrt(variance)),
      iqr: roundStat(iqr),
      dispersion: roundStat(max - min),
      normalBand: [roundStat(p25), roundStat(p75)],
      tukeyLow: roundStat(p25 - k * iqr),
      tukeyHigh: roundStat(p75 + k * iqr),
      ...(benchMetrics[key] !== undefined ? { benchmarkValue: roundStat(benchMetrics[key]) } : {}),
    };
  }

  const analyzed = normalizedItems.map(item => {
    const excessVsBenchmark = {};
    const outlierFlags = [];
    const missingMetrics = [];
    for (const key of keys) {
      const val = item.metrics[key];
      if (!Number.isFinite(val)) {
        missingMetrics.push(key);
        continue;
      }
      if (benchMetrics[key] !== undefined) {
        excessVsBenchmark[key] = roundStat(val - benchMetrics[key]);
      }
      const st = stats[key];
      if (st && st.count >= 4 && Number.isFinite(st.iqr) && st.iqr > 0) {
        if (val < st.tukeyLow) {
          outlierFlags.push({ metric: key, direction: 'low', value: roundStat(val), fence: st.tukeyLow });
        } else if (val > st.tukeyHigh) {
          outlierFlags.push({ metric: key, direction: 'high', value: roundStat(val), fence: st.tukeyHigh });
        }
      }
    }
    return {
      id: item.id,
      name: item.name,
      ...(item.group ? { group: item.group } : {}),
      ...(item.navDate ? { navDate: item.navDate } : {}),
      metrics: item.metrics,
      ...(Object.keys(excessVsBenchmark).length ? { excessVsBenchmark } : {}),
      outlierFlags,
      missingMetrics,
    };
  });

  const activeSortKey = sortBy && keys.includes(sortBy) ? sortBy : '';
  const dir = sortOrder === 'asc' ? 1 : -1;
  if (activeSortKey) {
    analyzed.sort((a, b) => {
      const av = a.metrics[activeSortKey];
      const bv = b.metrics[activeSortKey];
      const aValid = Number.isFinite(av);
      const bValid = Number.isFinite(bv);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return (av - bv) * dir;
    });
  }

  const rankedItems = analyzed.map((item, idx) => ({
    rank: idx + 1,
    ...item,
  }));

  const dated = normalizedItems
    .map(item => ({ item, ms: parseIsoDayMs(item.navDate) }))
    .filter(entry => entry.ms !== null);
  const latestMs = dated.length ? Math.max(...dated.map(d => d.ms)) : null;
  const latestNavDate = latestMs !== null ? new Date(latestMs).toISOString().slice(0, 10) : '';
  const staleItems = latestMs === null
    ? []
    : dated
      .map(entry => ({
        id: entry.item.id,
        name: entry.item.name,
        navDate: entry.item.navDate,
        lagDays: Math.round((latestMs - entry.ms) / 86_400_000),
      }))
      .filter(entry => entry.lagDays > 7);

  return {
    ok: true,
    sampleCount: normalizedItems.length,
    metricKeys: keys,
    ...(benchmark?.name ? { benchmarkName: String(benchmark.name) } : {}),
    stats,
    rankedItems,
    outliers: rankedItems.filter(item => item.outlierFlags.length > 0).map(item => ({
      id: item.id,
      name: item.name,
      flags: item.outlierFlags,
    })),
    dataHygiene: {
      latestNavDate,
      staleItems,
      missingMetricItems: rankedItems
        .filter(item => item.missingMetrics.length > 0)
        .map(item => ({ id: item.id, name: item.name, missingMetrics: item.missingMetrics })),
    },
  };
}
