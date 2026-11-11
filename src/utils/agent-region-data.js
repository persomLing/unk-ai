// Structured readings have their own bounded task-local store. They must not
// compete with the sliding window of article bodies in agent-evidence.js.
const MAX_READINGS = 40;
const MAX_ROWS = 1200;
const MAX_CHARACTERS = 180000;
const MAX_PROMPT = 14000;
const RANKING_LIMIT = 20;
const clean = (value, max = 800) => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
const count = value => Math.min(1000000, Math.max(0, Math.floor(Number(value) || 0)));
const labelKey = value => clean(value, 160).replace(/\s+/g, '').toLowerCase();

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

function normalizeReading(value) {
  const url = httpUrl(value?.url);
  if (!url) return null;
  const input = Array.isArray(value.rows) ? value.rows : [];
  let rowTruncated = false;
  const rows = input.slice(0, 200).map(row => {
    const cells = (Array.isArray(row?.cells) ? row.cells : []).slice(0, 16).map(cell => ({
      label: clean(cell?.label, 80), text: clean(cell?.text, 160),
    }));
    const truncated = row?.truncated === true || String(row?.text || '').length > 800
      || String(row?.label || '').length > 160 || (row?.cells?.length || 0) > 16
      || (Array.isArray(row?.cells) && row.cells.some(cell => String(cell?.text || '').length > 160 || String(cell?.label || '').length > 80));
    rowTruncated ||= truncated;
    return { label: clean(row?.label, 160), text: clean(row?.text), ...(cells.length ? { cells } : {}), ...(truncated ? { truncated: true } : {}) };
  });
  const totalRows = Math.max(count(value.totalRows), input.length);
  return {
    version: 1, url, title: clean(value.title, 200), capturedAt: clean(value.capturedAt, 80),
    regionKey: clean(value.regionKey || value.regionId, 160), query: clean(value.query, 80),
    ...(typeof value.queryMatched === 'boolean' ? { queryMatched: value.queryMatched } : {}),
    ...(value.notice ? { notice: clean(value.notice, 300) } : {}),
    ...(httpUrl(value.frameUrl) ? { frameUrl: httpUrl(value.frameUrl) } : {}),
    ...(Number.isInteger(value.frameId) ? { frameId: value.frameId } : {}),
    text: clean(value.text, 2000), rows, totalRows,
    omittedRows: Math.max(count(value.omittedRows), totalRows - rows.length),
    omittedReadings: count(value.omittedReadings),
    discardedRows: count(value.discardedRows),
    truncated: value.truncated === true || rowTruncated || totalRows > rows.length || String(value.text || '').length > 2000,
  };
}

/** Replace a reread of the same region, preserving other pages and explicit overflow. */
export function mergeRegionReadings(previous = [], reading) {
  const next = normalizeReading(reading);
  const entries = (Array.isArray(previous) ? previous : []).map(normalizeReading).filter(Boolean);
  if (!next) return entries;
  const key = value => `${value.url}\n${value.frameUrl || ''}\n${value.regionKey}\n${value.query}`;
  const replaced = entries.find(value => key(value) === key(next));
  if (replaced?.omittedReadings) {
    // A fresh read can recover this region's omitted rows, but cannot recover
    // other pages already evicted from the task. Keep that loss separately.
    next.omittedReadings += replaced.omittedReadings;
    next.discardedRows += replaced.discardedRows;
    next.omittedRows += replaced.discardedRows;
    next.truncated = true;
  }
  const output = entries.filter(value => key(value) !== key(next));
  output.push(next);
  if (output.length > MAX_READINGS) {
    const dropped = output.splice(0, output.length - MAX_READINGS);
    next.omittedReadings += dropped.reduce((sum, entry) => sum + 1 + entry.omittedReadings, 0);
    const discardedRows = dropped.reduce((sum, entry) => sum + entry.rows.length + entry.omittedRows, 0);
    next.omittedRows += discardedRows;
    next.discardedRows += discardedRows;
    next.truncated = true;
  }
  let remainingRows = MAX_ROWS, remainingCharacters = MAX_CHARACTERS;
  for (const entry of output) {
    const retained = [];
    remainingCharacters -= entry.text.length;
    for (const row of entry.rows) {
      const size = JSON.stringify(row).length;
      if (remainingRows <= 0 || size > remainingCharacters) break;
      retained.push(row);
      remainingRows--;
      remainingCharacters -= size;
    }
    if (retained.length !== entry.rows.length) {
      entry.omittedRows += entry.rows.length - retained.length;
      entry.rows = retained;
      entry.truncated = true;
    }
  }
  return output;
}

function numericValue(value) {
  // Only a complete, unambiguous value is comparable. Units remain separate;
  // a missing cache rate must never fall through to a neighbouring availability.
  const raw = clean(value, 160).replace(/，/g, ',').replace(/％/g, '%').replace(/\s+/g, '');
  const match = raw.match(/^([$¥￥€£]?)([+-]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+))(%|元|秒|ms|s|(?:\/(?:[\d.]*[kKmM]|次|月|年|千|百万)(?:tokens?)?))?$/);
  if (!match) return null;
  const number = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(number) || (match[3] === '%' && (number < 0 || number > 100))) return null;
  return { value: number, unit: (match[1] === '￥' ? '¥' : match[1]) + (match[3] || ''), displayValue: raw };
}

function metricFor(row, query) {
  if (!query || !row.label || row.truncated) return null;
  const matching = (row.cells || []).filter(cell => labelKey(cell.label).replace(/[:：]$/, '') === labelKey(query).replace(/[:：]$/, ''));
  if (matching.length) {
    const values = matching.map(cell => numericValue(cell.text));
    return values.length === 1 ? values[0] : null;
  }
  const text = clean(row.text).replace(/[ \t]+/g, ' ');
  const escape = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if ([...text.matchAll(new RegExp(escape, 'g'))].length !== 1) return null;
  const pattern = new RegExp(`(?:^|[\\s;；,，。|])${escape}\\s*[:：]?\\s*([$¥￥€£]?[+-]?(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|\\.\\d+)\\s*(?:[%％]|元|秒|ms|s|\\/(?:[\\d.]*[kKmM]|次|月|年|千|百万)(?:tokens?)?)?)(?=$|[\\s;；,，。|])`, 'g');
  const values = [...text.matchAll(pattern)].map(match => numericValue(match[1]));
  return values.length === 1 ? values[0] : null;
}

export function regionReadingSources(readings = []) {
  const sources = new Map();
  for (const reading of (Array.isArray(readings) ? readings : []).map(normalizeReading).filter(Boolean)) {
    const url = reading.frameUrl || reading.url;
    const existing = sources.get(url);
    sources.set(url, { url, title: reading.title, capturedAt: reading.capturedAt,
      truncated: reading.truncated || Boolean(existing?.truncated), kind: 'region' });
  }
  return [...sources.values()];
}

/** Deterministic, unit-aware extrema plus coverage; all output remains untrusted page data. */
export function summarizeRegionReadings(readings = []) {
  const entries = (Array.isArray(readings) ? readings : []).slice(-MAX_READINGS).map(normalizeReading).filter(Boolean);
  const sources = entries.map((entry, index) => ({ id: index + 1, url: entry.frameUrl || entry.url,
    title: entry.title, query: entry.query, capturedAt: entry.capturedAt, rows: entry.rows.length,
    totalRows: entry.totalRows, truncated: entry.truncated,
    ...(typeof entry.queryMatched === 'boolean' ? { queryMatched: entry.queryMatched } : {}),
    ...(entry.notice ? { notice: entry.notice } : {}) }));
  const queries = new Map();
  entries.forEach((entry, index) => {
    if (!queries.has(entry.query)) queries.set(entry.query, []);
    entry.rows.forEach(row => queries.get(entry.query).push({ row, sourceId: index + 1 }));
  });
  const groups = [...queries].map(([query, records]) => {
    const signatures = new Map(), seenLabels = new Map(), unresolved = [];
    let duplicatesRemoved = 0;
    for (const { row, sourceId } of records) {
      const metric = metricFor(row, query);
      if (!metric) { unresolved.push({ label: row.label, text: row.text.slice(0, 180), sourceId, reason: row.truncated ? 'row_truncated' : 'missing_or_ambiguous_value' }); continue; }
      const key = `${labelKey(row.label)}\n${metric.unit}\n${metric.value}`;
      if (signatures.has(key)) {
        const existing = signatures.get(key);
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
        duplicatesRemoved++;
        continue;
      }
      const result = { label: row.label, ...metric, sourceIds: [sourceId] };
      signatures.set(key, result);
      const label = labelKey(row.label);
      if (!seenLabels.has(label)) seenLabels.set(label, new Set());
      seenLabels.get(label).add(key);
    }
    const conflicts = new Set([...seenLabels].filter(([, keys]) => keys.size > 1).map(([label]) => label));
    const units = new Map();
    for (const value of signatures.values()) {
      if (conflicts.has(labelKey(value.label))) {
        unresolved.push({ label: value.label, text: value.displayValue, sourceId: value.sourceIds[0], reason: 'conflicting_values' });
        continue;
      }
      if (!units.has(value.unit)) units.set(value.unit, []);
      units.get(value.unit).push(value);
    }
    const rankings = [...units].map(([unit, values]) => {
      const sorted = values.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
      return { unit, count: sorted.length, highest: sorted.slice(0, RANKING_LIMIT), lowest: [...sorted].reverse().slice(0, RANKING_LIMIT) };
    });
    return { query, rowCount: records.length, duplicatesRemoved, conflictingLabels: conflicts.size,
      unresolvedCount: unresolved.length, unresolved: unresolved.slice(0, 5), rankings };
  });
  const excerpts = entries.flatMap((entry, index) => entry.text && !entry.rows.length
    ? [{ sourceId: index + 1, text: entry.text, truncated: entry.truncated,
      ...(entry.notice ? { notice: entry.notice } : {}) }] : []);
  const result = { version: 1, rankingLimit: RANKING_LIMIT, sources, groups, excerpts,
    truncated: entries.some(entry => entry.truncated),
    omittedRows: entries.reduce((sum, entry) => sum + entry.omittedRows, 0),
    omittedReadings: entries.reduce((sum, entry) => sum + entry.omittedReadings, 0),
    summaryTruncated: false,
    coverage: '仅代表已读取的页面区域；未读取分页、缺失值、名称冲突及截断均不能视为完整榜单。' };
  // Trim structured arrays, never a JSON string. Stored rows and final source
  // metadata remain intact even when only a smaller ranking fits the prompt.
  while (JSON.stringify(result).length > MAX_PROMPT) {
    result.summaryTruncated = true;
    const arrays = result.groups.flatMap(group => [group.unresolved, ...group.rankings.flatMap(rank => [rank.highest, rank.lowest])]);
    const longest = arrays.sort((a, b) => b.length - a.length)[0];
    if (longest?.length) { longest.pop(); continue; }
    if (result.excerpts.length) { result.excerpts.pop(); continue; }
    if (result.sources.length) { result.sources.pop(); continue; }
    if (result.groups.length) { result.groups.pop(); continue; }
    break;
  }
  return result;
}
