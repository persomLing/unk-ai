const VISUAL_CUES = /(?:图|图表|图片|照片|截图|画面|视觉|布局|颜色|配色|连线|流程|箭头|坐标|曲线|趋势|界面|排版|设计稿|canvas|svg|chart|graph|image|layout|screenshot)/i;
const TEXT_ONLY_CUES = /(?:总结|概括|提炼|归纳|主要内容|核心观点|关键结论|讲了什么|翻译|润色|改写|引用|文字|正文|段落|代码|表格中的数据)/i;

function text(value, limit = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Cheap local preflight. The model remains the decision maker, but we avoid an
 * extra request on pages/questions that clearly have no visual dimension.
 */
export function needsVisualPreflight(question, page) {
  const prompt = text(question, 4000);
  if (!prompt) return false;
  if (VISUAL_CUES.test(prompt)) return true;
  if (TEXT_ONLY_CUES.test(prompt)) return false;
  // Figure metadata alone is not enough. Summaries and general reading tasks
  // rely on extracted text; screenshots are for explicit visual questions.
  return false;
}

export function buildVisualDecisionPrompt(question, page) {
  const figures = (Array.isArray(page?.figures) ? page.figures : [])
    .slice(0, 8)
    .map((figure, index) => {
      const label = text(figure?.caption || figure?.alt || figure?.title, 180) || '未命名图表';
      return `${index + 1}. [${text(figure?.type || 'image', 20)}] ${label}`;
    });
  return [
    '你要判断回答下一页网页问题时，是否需要查看网页截图。',
    '只能返回一个 JSON 对象，不要解释，不要 Markdown。',
    '格式：{"screenshot":true|false,"scope":"page"|"viewport","reason":"不超过20字"}',
    '若问题涉及图表、图片、布局、颜色、流程、界面或视觉细节，通常需要截图；纯文字归纳、翻译、改写或代码问题通常不需要。',
    `网页标题：${text(page?.title, 300)}`,
    `图片/图表索引：${figures.length ? `\n${figures.join('\n')}` : '无'}`,
    `用户问题：${text(question, 4000)}`,
  ].join('\n');
}

export function parseVisualDecision(value, fallback = null) {
  const source = String(value || '').trim();
  if (!source) return fallback;
  const candidate = source.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return fallback;
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed?.screenshot !== 'boolean') return fallback;
    if (!parsed.screenshot) return { screenshot: false, scope: 'none', reason: text(parsed.reason, 80) };
    return {
      screenshot: true,
      scope: parsed.scope === 'viewport' ? 'viewport' : 'page',
      reason: text(parsed.reason, 80),
    };
  } catch {
    return fallback;
  }
}

export function localVisualDecision(question, page) {
  const prompt = text(question, 4000);
  if (VISUAL_CUES.test(prompt)) {
    if (/(?:当前|可见|这个画面|这一屏|屏幕|视口)/.test(prompt)) {
      return { screenshot: true, scope: 'viewport', reason: '问题涉及当前画面' };
    }
    return { screenshot: true, scope: 'page', reason: '问题涉及页面视觉内容' };
  }
  return { screenshot: false, scope: 'none', reason: '纯文字问题' };
}
