import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblePdfPageText,
  buildPdfPageContext,
  extractPdfPages,
  isPdfUrl,
  looksLikePdf,
  pdfTitleFromUrl,
} from '../src/utils/pdf-reader.js';
import { normalizePageContext, pageContextForModel, pageContextStats } from '../src/utils/reading-context.js';

function item(str, { x = 0, y = 700, width = 20, height = 10, hasEOL = false } = {}) {
  return { str, width, height, hasEOL, transform: [height, 0, 0, height, x, y] };
}

function makePdf(lines) {
  const content = `BT /F1 16 Tf 40 700 Td (${lines[0]}) Tj 0 -24 Td (${lines[1]}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test('PDF tab detection covers online, local and query URLs without false positives', () => {
  assert.equal(isPdfUrl('https://example.test/report.PDF?download=1#page=2'), true);
  assert.equal(isPdfUrl('https://example.test/%E5%B9%B4%E6%8A%A5.pdf'), true);
  assert.equal(isPdfUrl('file:///C:/Users/me/Desktop/report.pdf'), true);
  assert.equal(isPdfUrl('https://example.test/paper'), false);
  assert.equal(isPdfUrl('https://example.test/article.pdf/view'), false);
  assert.equal(isPdfUrl('chrome-extension://abc/report.pdf'), false);
  assert.equal(isPdfUrl('not a url'), false);
  assert.equal(pdfTitleFromUrl('https://example.test/Annual%20Report.pdf'), 'Annual Report');
});

test('PDF magic bytes are detected before handing bytes to the parser', () => {
  assert.equal(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n...')), true);
  assert.equal(looksLikePdf(new TextEncoder().encode('<html><body>login</body></html>')), false);
  assert.equal(looksLikePdf(new Uint8Array()), false);
});

test('text items are reflowed with English spacing and CJK without inserted spaces', () => {
  const text = assemblePdfPageText([
    item('Hello', { x: 0, y: 700, width: 25 }),
    item('PDF', { x: 30, y: 700, width: 18 }),
    item('中文', { x: 0, y: 680, width: 20 }),
    item('报告', { x: 22, y: 680, width: 20, hasEOL: true }),
    item('Second line', { x: 0, y: 660, width: 60 }),
  ]);
  assert.equal(text, 'Hello PDF\n中文报告\nSecond line');
});

test('punctuation after a word does not gain an artificial space', () => {
  assert.equal(assemblePdfPageText([
    item('Total', { x: 0, y: 700, width: 25 }),
    item(':', { x: 28, y: 700, width: 3 }),
    item('42', { x: 34, y: 700, width: 10 }),
  ]), 'Total:42');
});

test('PDF page context preserves every page, budget and page coverage', () => {
  const page = buildPdfPageContext({
    title: 'Quarterly Report',
    url: 'https://example.test/report.pdf',
    pages: ['第一页内容', '第二页内容'],
    pageCount: 2,
    maxBudget: 60000,
    capturedAt: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(page.title, 'Quarterly Report');
  assert.equal(page.truncated, false);
  assert.match(page.text, /\[第 1 页\]\n第一页内容/);
  assert.match(page.text, /\[第 2 页\]\n第二页内容/);
  assert.equal(page.sections.length, 2);
  assert.deepEqual(page.structure.pdf, { pageCount: 2, pagesRead: 2, truncated: false });
  const normalized = normalizePageContext(page);
  assert.deepEqual(pageContextStats(normalized), {
    chars: page.text.length,
    outline: 2,
    semanticNodes: 2,
    tables: 0,
    links: 0,
    figures: 0,
    forms: 0,
    pdfPages: 2,
    pdfPagesRead: 2,
    truncated: false,
  });
  const prompt = pageContextForModel(normalized);
  assert.match(prompt, /PDF 文档《Quarterly Report》/);
  assert.match(prompt, /<pdf_document pages="2" pages_read="2">/);
  assert.match(prompt, /<page_outline>/);
  assert.doesNotMatch(prompt, /<semantic_tree>/);
});

test('PDF context records omitted pages when the document exceeds the budget', () => {
  const page = buildPdfPageContext({
    title: 'Long report',
    url: 'file:///C:/reports/long.pdf',
    pages: ['A'.repeat(1500), 'B'.repeat(1500)],
    pageCount: 5,
    maxBudget: 2000,
  });
  assert.equal(page.truncated, true);
  assert.equal(page.structure.pdf.pagesRead, 2);
  assert.match(page.text, /其余 3 页未包含在本次读取中/);
  assert.ok(page.text.length <= 2000, `expected <= 2000 chars, got ${page.text.length}`);
  const stats = pageContextStats(page);
  assert.equal(stats.pdfPages, 5);
  assert.equal(stats.pdfPagesRead, 2);
  assert.equal(stats.truncated, true);
});

test('a single oversized page is cut and marked as truncated', () => {
  const page = buildPdfPageContext({
    title: 'One page',
    pages: ['C'.repeat(5000)],
    pageCount: 1,
    maxBudget: 2000,
  });
  assert.equal(page.truncated, true);
  assert.equal(page.structure.pdf.pagesRead, 1);
  assert.match(page.text, /本页内容已截断/);
  assert.doesNotMatch(page.text, /其余 \d+ 页/);
});

test('real PDF bytes are parsed into page text', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: makePdf(['Hello PDF', 'Second line']),
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const document = await task.promise;
  try {
    const extracted = await extractPdfPages(document);
    assert.equal(extracted.pageCount, 1);
    assert.match(extracted.pages[0], /Hello PDF/);
    assert.match(extracted.pages[0], /Second line/);
    const context = buildPdfPageContext({
      title: 'Sample',
      url: 'file:///C:/sample.pdf',
      pages: extracted.pages,
      pageCount: extracted.pageCount,
    });
    assert.match(context.text, /\[第 1 页\]\nHello PDF\nSecond line/);
  } finally {
    await document.destroy();
  }
});
