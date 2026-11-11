/**
 * Dynamic, context-aware suggestions for "Try next" (下一步探索).
 *
 * Extracts specific files, technical identifiers, bold modules, metrics, and
 * key arguments directly from the model's response and user query to craft
 * tailored follow-up explorations rather than static templates.
 */

export function generateContextualSuggestions(fullText, userQuery = '', pageContext = null) {
  const suggestions = [];
  const text = String(fullText || '');
  const query = String(userQuery || '');
  const pageTitle = pageContext?.title || '';

  // 1. Extract specific files, configurations, or identifiers in backticks
  // e.g. `dist/chrome/manifest.json`, `default_config.json`, `state.json`
  const codeItems = [...text.matchAll(/`([a-zA-Z0-9_\-\./\\]{3,40}\.[a-zA-Z0-9]{1,8})`/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i && !v.startsWith('http') && !v.includes('...'));

  // 2. Extract bold concepts or key terms (e.g. **账号池健康状况**, **本地内存持久化**, **微信授权二维码**)
  const boldTerms = [...text.matchAll(/\*\*([^\*\n\:：]{2,20})\*\*/g)]
    .map((m) => m[1].replace(/^[0-9]+[\.、]\s*/, '').trim())
    .filter((v, i, a) => a.indexOf(v) === i && !/^(总结|核心|建议|注意|重要|优点|缺点|问题|方案|限制|一句话总结|定位总结|前言|目录)$/.test(v));

  // 3. Extract numbered or bulleted key headings
  const sectionHeadings = [...text.matchAll(/^[#0-9\.\-\*、\s]*([^\n\:：]{3,22})(?:[：\:]|$)/gm)]
    .map((m) => m[1].replace(/^[#0-9\.\-\*、\s]+/, '').replace(/[\*\_]/g, '').trim())
    .filter((v, i, a) => a.indexOf(v) === i && v.length >= 3 && v.length <= 18 && !/^(总结|核心观点|关键结论|定位总结|一句话总结|优先修三件事|核心论点|信息局限)$/.test(v));

  // Strategy A: If specific files or code items exist (e.g., manifest.json, default_config.json):
  for (const file of codeItems) {
    if (suggestions.length >= 3) break;
    if (file.endsWith('.json') || file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.py') || file.endsWith('.vue') || file.endsWith('.md')) {
      if (file.includes('manifest') || file.includes('config') || file.includes('rule')) {
        suggestions.push(`读一下 ${file} 的具体声明与规则`);
      } else {
        suggestions.push(`分析 ${file} 的实现逻辑与依赖`);
      }
    }
  }

  // Strategy B: If bold concepts exist (e.g., specific metrics/modules):
  for (const term of boldTerms) {
    if (suggestions.length >= 3) break;
    if (!suggestions.some((s) => s.includes(term))) {
      if (/指标|率|延迟|成功|失败|熔断|性能/i.test(term)) {
        suggestions.push(`针对「${term}」的表现如何做进一步优化？`);
      } else if (/持久化|缓存|存储|配置|架构|接口|安全/i.test(term)) {
        suggestions.push(`展开分析「${term}」的实现与潜在风险`);
      } else {
        suggestions.push(`深入探讨「${term}」的具体落地方案`);
      }
    }
  }

  // Strategy C: Section headings if needed
  for (const heading of sectionHeadings) {
    if (suggestions.length >= 3) break;
    if (!suggestions.some((s) => s.includes(heading))) {
      suggestions.push(`关于「${heading}」，还有哪些未展开的细节？`);
    }
  }

  // Strategy D: Intent-tailored contextual suggestions based on query & page
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();

  if (suggestions.length < 3) {
    if (lowerQuery.includes('优化') || lowerQuery.includes('改进') || lowerText.includes('优化') || lowerText.includes('优先修')) {
      const candidates = [
        '为上述优化建议制定一份优先级落地清单',
        '针对改动成本最高的一项给出具体重构方案',
        '对比同类产品，这套系统还有哪些体验差距？',
      ];
      for (const c of candidates) {
        if (suggestions.length >= 3) break;
        if (!suggestions.includes(c)) suggestions.push(c);
      }
    } else if (lowerQuery.includes('代码') || lowerText.includes('function') || lowerText.includes('class') || lowerText.includes('repo')) {
      const candidates = [
        '这段实现可能存在哪些边界情况或隐患？',
        '为这段逻辑编写单元测试的思路',
        '分析核心模块之间的依赖调用关系',
      ];
      for (const c of candidates) {
        if (suggestions.length >= 3) break;
        if (!suggestions.includes(c)) suggestions.push(c);
      }
    } else if (lowerText.includes('沸点') || lowerText.includes('帖子') || lowerText.includes('动态') || lowerText.includes('言论') || lowerText.includes('情绪')) {
      const candidates = [
        '分析作者情绪背后与朋友的核心分歧点',
        '从社交互动角度分析此类话题容易引发争议的原因',
        '针对信息局限，有哪些事实证据仍需补充？',
      ];
      for (const c of candidates) {
        if (suggestions.length >= 3) break;
        if (!suggestions.includes(c)) suggestions.push(c);
      }
    } else if (pageTitle || lowerQuery.includes('总结') || lowerText.includes('文章') || lowerText.includes('论点')) {
      const candidates = [
        '作者的这一结论在现实中有哪些适用限制？',
        '针对文章提出的核心论点，有无相反视角的论据？',
        '将上述要点提炼为一份可执行的行动指南',
      ];
      for (const c of candidates) {
        if (suggestions.length >= 3) break;
        if (!suggestions.includes(c)) suggestions.push(c);
      }
    } else {
      const candidates = [
        '能结合一个具体生动的场景来说明吗？',
        '在实际落地中通常有哪些关键注意事项？',
        '基于上述回答，还能做哪些延伸探索？',
      ];
      for (const c of candidates) {
        if (suggestions.length >= 3) break;
        if (!suggestions.includes(c)) suggestions.push(c);
      }
    }
  }

  return suggestions.slice(0, 3);
}
