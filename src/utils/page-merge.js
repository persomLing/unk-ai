function frameReference(result) {
  const title = String(result?.title || '').trim();
  const url = String(result?.url || '').trim();
  return [title, url].filter(Boolean).join(' · ').slice(0, 500);
}

function boundedFrameText(value, budget) {
  const text = String(value || '').trim();
  if (text.length <= budget) return { text, truncated: false };
  if (budget <= 40) return { text: text.slice(0, Math.max(0, budget)), truncated: true };
  const separator = '\n\n[…嵌入内容已截断…]\n\n';
  const available = Math.max(1, budget - separator.length);
  return {
    text: `${text.slice(0, Math.ceil(available * 0.65))}${separator}${text.slice(-Math.floor(available * 0.35))}`,
    truncated: true,
  };
}

function mergeStructure(results) {
  const structures = results
    .map((entry) => entry?.result?.structure)
    .filter((value) => value && typeof value === 'object');
  if (!structures.length) return null;
  const output = { truncated: {} };
  const limits = {
    landmarks: 40,
    headings: 160,
    links: 300,
    tables: 30,
    forms: 20,
    figures: 100,
  };
  for (const [key, limit] of Object.entries(limits)) {
    output[key] = structures.flatMap((item) =>
      Array.isArray(item[key]) ? item[key] : []).slice(0, limit);
    output.truncated[key] = structures.some((item) => item.truncated?.[key]);
  }
  output.truncated.visited = structures.some((item) => item.truncated?.visited);
  return output;
}

export function mergeFramePages(results, requestedBudget = 60000) {
  const valid = (Array.isArray(results) ? results : [])
    .filter((entry) => entry?.result && typeof entry.result.text === 'string' && !entry.result.error);
  if (!valid.length) return null;

  const topEntry = valid.find((entry) => entry.frameId === 0) || valid[0];
  const embedded = valid
    .filter((entry) => entry !== topEntry && entry.result.text.trim().length >= 20)
    .slice(0, 8);
  const budget = Math.max(1000, Math.floor(Number(requestedBudget) || 60000));
  const frameReserve = embedded.length ? Math.min(12000, Math.floor(budget * 0.3)) : 0;
  const topBudget = Math.max(1000, budget - frameReserve);
  const top = topEntry.result;
  const topText = boundedFrameText(top.text, topBudget);
  let text = topText.text;
  let truncated = Boolean(top.truncated || topText.truncated);
  let remaining = Math.max(0, budget - text.length);
  const frameBudget = embedded.length ? Math.max(400, Math.floor(remaining / embedded.length)) : 0;
  const frameSections = [];
  const frameFigures = [];

  for (const entry of embedded) {
    if (remaining < 300) {
      truncated = true;
      break;
    }
    const part = boundedFrameText(entry.result.text, Math.min(frameBudget, remaining - 180));
    if (!part.text) continue;
    const label = frameReference(entry.result) || `frame ${entry.frameId}`;
    const block = `\n\n<embedded_frame source="${label.replaceAll('"', "'")}">\n${part.text}\n</embedded_frame>`;
    if (block.length > remaining) {
      truncated = true;
      break;
    }
    text += block;
    remaining -= block.length;
    truncated ||= part.truncated;
    frameSections.push(...(Array.isArray(entry.result.sections) ? entry.result.sections : []));
    frameFigures.push(...(Array.isArray(entry.result.figures) ? entry.result.figures : [])
      .map((figure) => ({ ...figure, frame: label })));
  }

  const structure = mergeStructure(valid);
  return {
    ...top,
    text,
    truncated,
    sections: [
      ...(Array.isArray(top.sections) ? top.sections : []),
      ...frameSections,
    ].slice(0, 180),
    figures: [
      ...(Array.isArray(top.figures) ? top.figures : []),
      ...frameFigures,
    ].slice(0, 100),
    links: structure?.links || [],
    structure,
    frameCount: embedded.length,
    lazyMaterialization: valid
      .map((entry) => entry.result.lazyMaterialization)
      .find((value) => value && !value.error) || null,
  };
}
