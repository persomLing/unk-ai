import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import MarkdownIt from 'markdown-it';

const root = resolve(import.meta.dirname, '..');
const docs = resolve(root, 'docs');
const source = readFileSync(resolve(docs, 'USER-GUIDE.md'), 'utf8');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const date = source.match(/更新日期：([^*\r\n]+)/)?.[1]?.trim();
if (!date || !source.includes(`适用版本：${version}`)) throw new Error('Manual date/version does not match the release.');
const md = new MarkdownIt({ html: false, linkify: false });
const escape = md.utils.escapeHtml;
const tokens = md.parse(source, {});
const headings = [], figures = [];
let section = 0;
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token.type === 'heading_open' && token.tag === 'h2') {
    const label = tokens[i + 1].content;
    const id = `section-${++section}`;
    token.attrSet('id', id);
    headings.push({ id, label });
  }
  for (const child of token.children || []) {
    if (child.type === 'image') {
      const src = child.attrGet('src');
      const file = resolve(docs, src);
      const within = relative(resolve(docs, 'images'), file);
      if (within.startsWith('..') || isAbsolute(within)) throw new Error(`Image outside docs/images: ${src}`);
      const mime = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(file).toLowerCase()];
      if (!mime) throw new Error(`Unsupported image: ${src}`);
      const caption = tokens[i + 3]?.content || '';
      const number = Number(caption.match(/^\*?图\s*(\d+)/)?.[1]);
      if (!number || figures.some(figure => figure.number === number)) throw new Error(`Missing or duplicate figure number: ${src}`);
      const kind = mime === 'image/svg+xml' ? 'diagram' : 'screen';
      figures.push({ number, path: src, alt: child.content, kind });
      child.attrSet('src', `data:${mime};base64,${readFileSync(file).toString('base64')}`);
      child.attrSet('data-figure', String(number));
      child.attrSet('data-kind', kind);
    }
    if (child.type === 'link_open') {
      const href = child.attrGet('href') || '';
      if (!/^(?:https?:|#)/.test(href) && /\.md(?:#.*)?$/.test(href)) {
        child.attrSet('title', `项目内参考：${href}`);
        child.attrSet('href', '#references');
      }
    }
  }
}
let body = md.renderer.render(tokens, md.options, {});
body = body.replace(/<p>(<img [^>]+data-figure="(\d+)"[^>]+data-kind="(screen|diagram)"[^>]*>)<\/p>\s*<p><em>(图\s*\d+[\s\S]*?)<\/em><\/p>/g,
  (_all, img, number, kind, caption) => `<figure id="figure-${number}" class="${kind}"><div class="figure-scroll" tabindex="0" aria-label="图 ${number}，可横向滚动查看">${img}</div><figcaption>${caption}</figcaption></figure>`);
body = body.replace(/<table>/g, '<div class="table-scroll" tabindex="0" aria-label="信息表，可横向滚动查看"><table>').replace(/<\/table>/g, '</table></div>');
if ((body.match(/<figure /g) || []).length !== figures.length) throw new Error('Every figure requires a caption.');
const css = readFileSync(resolve(docs, 'user-guide-reader.css'), 'utf8')
  + '\n' + readFileSync(resolve(root, 'src/styles/scrollbars.css'), 'utf8');
figures.sort((a, b) => a.number - b.number);
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>UNK AI 操作手册 · ${escape(version)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2320685d'/%3E%3Ctext x='16' y='24' text-anchor='middle' font-size='26' fill='white'%3E✳%3C/text%3E%3C/svg%3E">
<style>${css}</style></head><body>
<a class="skip-link" href="#guide-content">跳到正文</a>
<header class="masthead"><div class="brand"><span class="brand-mark">✳</span> UNK AI</div><span class="edition">操作手册 · v${escape(version)}</span></header>
<div class="layout"><aside class="toc" aria-label="操作手册目录"><p class="toc-title">阅读目录</p><nav>${headings.map(({ id, label }) => `<a href="#${id}">${escape(label)}</a>`).join('\n')}</nav>
<details class="figure-index"><summary>图解索引 · ${figures.length} 张</summary>${figures.map(figure => `<a href="#figure-${figure.number}">图 ${figure.number} · ${escape(figure.alt)}</a>`).join('\n')}</details>
<small>依据当前插件实现核对<br>更新于 ${escape(date)}<br>全部图片已嵌入，可离线打开<br>宽图与表格可横向滚动查看</small></aside>
<article id="guide-content">${body}<p id="references">本阅读版正文与 ${figures.length} 幅图解均已嵌入文件，可独立打开。可编辑原文为项目 docs/USER-GUIDE.md；开发参考文档位于相邻目录。</p></article></div>
</body></html>
`;
writeFileSync(resolve(docs, 'USER-GUIDE.html'), html);
mkdirSync(resolve(root, 'output'), { recursive: true });
const report = { version, date, sections: headings, figures, embeddedImages: figures.length, bytes: Buffer.byteLength(html) };
writeFileSync(resolve(root, 'output/user-guide-render-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ version, sections: headings.length, figures: figures.length, bytes: report.bytes }));
