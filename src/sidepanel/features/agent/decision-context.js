import { boundedPageReadings } from '../../../utils/agent-evidence.js';

const normalizedText = value => String(value || '').replace(/\r\n?/g, '\n').trim();

/** Query wording is not evidence of changed page content. Source identity still is. */
export function sameAgentReadingContent(before, after, { region = false } = {}) {
  if (!before || !after || before.url !== after.url || before.documentId !== after.documentId
    || (region && before.frameUrl !== after.frameUrl)) return false;
  const content = value => JSON.stringify([normalizedText(value.text), value.truncated === true,
    ...(region ? [value.rows || [], value.totalRows] : [])]);
  return content(before) === content(after);
}

/** Short action requests use excerpts; the task retains complete reading/source records. */
export function compactAgentPageReadings(values, { executionRequired = false, maxTextChars = 3000 } = {}) {
  const readings = boundedPageReadings(values);
  if (!executionRequired) return { readings, removed: 0, truncated: readings.some(item => item.truncated) };
  const unique = [];
  // Deduplicate before the shared total budget can truncate an earlier copy.
  for (const reading of [...(Array.isArray(values) ? values : [])].reverse()) {
    if (!unique.some(prior => sameAgentReadingContent(prior, reading))) unique.unshift(reading);
  }
  let remaining = Math.max(256, Math.min(6000, Number(maxTextChars) || 3000));
  const excerpts = [];
  for (const reading of boundedPageReadings(unique).reverse()) {
    if (remaining <= 0) break;
    const limit = Math.min(1500, remaining);
    let text = reading.text.slice(0, limit);
    const truncated = reading.truncated || text.length < reading.text.length;
    if (text.length < reading.text.length) {
      const notice = `\n[动作决策节选；完整已读正文保留在本任务中，共 ${reading.text.length} 字符。]`;
      text = reading.text.slice(0, Math.max(0, limit - notice.length)) + notice;
    }
    excerpts.unshift({ ...reading, text, truncated });
    remaining -= text.length;
  }
  return { readings: excerpts, removed: readings.length - excerpts.length, truncated: excerpts.some(item => item.truncated) };
}

/** Action-only region excerpts keep their source IDs; complete task evidence stays untouched. */
export function compactAgentRegionData(regionData, { executionRequired = false, maxChars = 3000 } = {}) {
  if (!executionRequired || !regionData || typeof regionData !== 'object') return regionData;
  const budget = Math.floor(Math.max(1024, Math.min(6000, Number(maxChars) || 3000)));
  if (JSON.stringify(regionData).length <= budget) return structuredClone(regionData);
  const sources = Array.isArray(regionData.sources) ? regionData.sources : [];
  const groups = Array.isArray(regionData.groups) ? regionData.groups : [];
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
  const count = value => Math.max(0, Math.floor(Number(value) || 0));
  const knownRows = Math.max(sources.reduce((sum, source) => sum + count(source.rows), 0),
    groups.reduce((sum, group) => sum + count(group.rowCount), 0));
  let result = {
    version: regionData.version, rankingLimit: 2, sources: [], groups: [], excerpts: [],
    truncated: true, omittedRows: 0, omittedReadings: 0, summaryTruncated: true,
    coverage: `${normalizedText(regionData.coverage).slice(0, 320)}\n动作决策节选；omittedRows 包含未发送的行示例，omittedReadings 包含未发送的来源；完整已读资料仍保留在本任务中。`,
  };
  const updateOmissions = candidate => {
    const representedRows = new Set();
    for (const group of candidate.groups) {
      for (const ranking of group.rankings) for (const item of [...ranking.highest, ...ranking.lowest]) {
        for (const sourceId of item.sourceIds) representedRows.add(JSON.stringify([sourceId, group.query, item.label, item.unit, item.value]));
      }
      for (const item of group.unresolved) representedRows.add(JSON.stringify([item.sourceId, group.query, item.label, item.text, item.reason]));
    }
    candidate.omittedRows = count(regionData.omittedRows) + Math.max(0, knownRows - representedRows.size);
    candidate.omittedReadings = count(regionData.omittedReadings) + sources.length - candidate.sources.length;
  };
  const addSources = (candidate, ids) => {
    // A value with missing provenance is omitted as a unit, never kept with an invented source.
    if (!ids.length || ids.some(id => !sourceById.has(id))) return false;
    for (const id of ids) if (!candidate.sources.some(source => source.id === id)) {
      const source = structuredClone(sourceById.get(id));
      // Descriptive metadata may shrink; source URL, query and capture identity stay whole.
      source.title = normalizedText(source.title).slice(0, 120);
      if (source.notice) source.notice = normalizedText(source.notice).slice(0, 120);
      candidate.sources.push(source);
    }
    return true;
  };
  const retain = mutate => {
    const candidate = structuredClone(result);
    if (mutate(candidate) === false) return false;
    updateOmissions(candidate);
    if (JSON.stringify(candidate).length > budget) return false;
    result = candidate;
    return true;
  };
  updateOmissions(result);
  if (sources.length) retain(candidate => addSources(candidate, [sources.at(-1).id]));

  // The latest form/region text is useful to the next action before older numeric examples.
  for (const excerpt of (Array.isArray(regionData.excerpts) ? regionData.excerpts : []).slice(-2).reverse()) {
    const text = String(excerpt.text || '');
    const withExcerpt = length => candidate => {
      if (!addSources(candidate, [excerpt.sourceId])) return false;
      candidate.excerpts.push({ ...structuredClone(excerpt), text: text.slice(0, length),
        truncated: excerpt.truncated === true || length < text.length });
    };
    let low = 0, high = Math.min(1200, text.length);
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      const candidate = structuredClone(result);
      if (withExcerpt(length)(candidate) === false) { high = length - 1; continue; }
      updateOmissions(candidate);
      if (JSON.stringify(candidate).length <= budget) low = length;
      else high = length - 1;
    }
    if (low > 0) retain(withExcerpt(low));
  }

  for (const group of groups.slice(-2).reverse()) {
    const header = { query: group.query, rowCount: group.rowCount, duplicatesRemoved: group.duplicatesRemoved,
      conflictingLabels: group.conflictingLabels, unresolvedCount: group.unresolvedCount, unresolved: [], rankings: [] };
    if (!retain(candidate => { candidate.groups.push(header); })) continue;
    const groupIndex = result.groups.length - 1;
    for (const ranking of (Array.isArray(group.rankings) ? group.rankings : []).slice(0, 2)) {
      if (!retain(candidate => { candidate.groups[groupIndex].rankings.push({ unit: ranking.unit, count: ranking.count, highest: [], lowest: [] }); })) continue;
      const rankingIndex = result.groups[groupIndex].rankings.length - 1;
      for (const direction of ['highest', 'lowest']) for (const item of (Array.isArray(ranking[direction]) ? ranking[direction] : []).slice(0, 2)) {
        if (!retain(candidate => {
          if (!addSources(candidate, Array.isArray(item.sourceIds) ? item.sourceIds : [])) return false;
          candidate.groups[groupIndex].rankings[rankingIndex][direction].push(structuredClone(item));
        })) break;
      }
    }
    for (const item of (Array.isArray(group.unresolved) ? group.unresolved : []).slice(0, 2)) retain(candidate => {
      if (!addSources(candidate, [item.sourceId])) return false;
      candidate.groups[groupIndex].unresolved.push(structuredClone(item));
    });
  }
  result.sources.sort((a, b) => sourceOrder.get(a.id) - sourceOrder.get(b.id));
  result.excerpts.sort((a, b) => sourceOrder.get(a.sourceId) - sourceOrder.get(b.sourceId));
  return result;
}

/** Only scalar sizes are exposed to diagnostics, never image bytes or prompt contents. */
export function agentDecisionInputMetrics(messages) {
  let inputTextChars = 0, imageCount = 0, imageBytes = 0;
  for (const message of messages || []) {
    if (typeof message.content === 'string') inputTextChars += message.content.length;
    else for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'text') inputTextChars += String(part.text || '').length;
      if (part.type === 'image_url') {
        imageCount += 1;
        const encoded = /^data:image\/[^;]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url || '');
        if (encoded) imageBytes += encoded[1].length * 3 / 4 - (encoded[1].endsWith('==') ? 2 : encoded[1].endsWith('=') ? 1 : 0);
      }
    }
  }
  return { inputTextChars, imageCount, imageBytes };
}
