import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { normalizePageContext, pageContextForModel } from '../src/utils/reading-context.js';

import "../src/content/extractor.js";

const { extractPageContent } = globalThis.__unkAiExtractor;

class FakeNode {
  constructor(type, name = "") {
    this.nodeType = type;
    this.nodeName = name;
    this.tagName = type === 1 ? name : undefined;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this.style = {};
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
    return this;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    return this;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  querySelectorAll(selector) {
    const tags = selector.toUpperCase().split(",").map((tag) => tag.trim());
    const matches = [];
    const visit = (node) => {
      if (node.nodeType === 1 && tags.includes(node.tagName)) matches.push(node);
      for (const child of node.childNodes) visit(child);
    };
    const root = this.nodeType === 9 ? this.documentElement : this;
    if (root) visit(root);
    return matches;
  }
}

const element = (name, ...children) => new FakeNode(1, name.toUpperCase()).append(...children);
const text = (value) => {
  const node = new FakeNode(3, "#text");
  node.nodeValue = value;
  return node;
};

function installDocument(body, options = {}) {
  const document = new FakeNode(9, "#document");
  document.body = body;
  document.documentElement = element("html", body);
  document.title = options.title || "Test page";
  document.location = { href: options.url || "https://example.test/article" };
  document.defaultView = options.defaultView || null;
  globalThis.document = document;
  return document;
}

test.afterEach(() => {
  delete globalThis.document;
  delete globalThis.chrome;
});

test('production ARIA bundle plus extractor never reads form values or editable drafts', () => {
  const password = element('input').setAttribute('type', 'password');
  const textarea = element('textarea', text('PRIVATE_TEXTAREA_DRAFT'));
  for (const input of [password, textarea]) {
    Object.defineProperty(input, 'value', { get() { throw new Error('private value accessed'); } });
  }
  const doc = installDocument(element('body', element('main',
    element('h1', text('Public heading')),
    element('p', text('Public reading content should remain available.')),
    element('form', element('label', text('Password'), password), textarea),
    element('div', text('PRIVATE_EDITABLE_DRAFT')).setAttribute('contenteditable', 'true'),
    element('div', text('PRIVATE_ROLE_DRAFT')).setAttribute('role', 'textbox'),
  )));
  const context = vm.createContext({ document: doc });
  vm.runInContext(readFileSync(new URL('../src/content/aria-snapshot-bundle.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../src/content/extractor.js', import.meta.url), 'utf8'), context);
  const result = context.__unkAiExtractor.extractPageContent({ includeStructure: true });
  assert.match(result.text, /Public reading content/);
  assert.equal(result.sections[0].text, 'Public heading');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test("returns metadata and preserves paragraphs, headings, and preformatted code", () => {
  const article = element("article",
    element("h1", text("Heading")),
    element("p", text("First "), element("strong", text("paragraph")), text(".")),
    element("pre", element("code", text("const x = 1;\n  return x;"))),
    element("p", text("Last paragraph.")),
  );
  installDocument(element("body", article));
  assert.deepEqual(extractPageContent(), {
    title: "Test page",
    url: "https://example.test/article",
    text: "Heading\n\nFirst paragraph.\n\nconst x = 1;\n  return x;\n\nLast paragraph.",
    truncated: false,
    sections: [{ level: 1, text: "Heading" }],
    figures: [],
  });
});

test("keeps image alt text and image URLs as useful figure context", () => {
  installDocument(element("body", element("article",
    element("p", text("Before figure.")),
    element("img").setAttribute("alt", "线性变换示意图"),
    element("img").setAttribute("src", "https://cdn.example.test/chart.png"),
  )));
  const result = extractPageContent();
  assert.match(result.text, /线性变换示意图/);
  assert.match(result.text, /https:\/\/cdn\.example\.test\/chart\.png/);
});

test("builds a section outline and a figure index for charts and images", () => {
  const figure = element("figure",
    element("img")
      .setAttribute("alt", "RAG 流程图")
      .setAttribute("src", "/images/rag.png"),
    element("figcaption", text("从检索到生成的完整流程")),
  );
  installDocument(element("body", element("article",
    element("h1", text("AI Agent 指南")),
    element("h2", text("RAG")),
    element("p", text("RAG 是检索增强生成。")),
    figure,
    element("canvas").setAttribute("aria-label", "方案诊断关系图"),
  )));
  const result = extractPageContent();
  assert.deepEqual(result.sections.map((item) => item.text), ["AI Agent 指南", "RAG"]);
  assert.equal(result.figures[0].type, "img");
  assert.equal(result.figures[0].caption, "从检索到生成的完整流程");
  assert.equal(result.figures[0].src, "https://example.test/images/rag.png");
  assert.deepEqual(result.figures[0].section, ["AI Agent 指南", "RAG"]);
  assert.equal(result.figures[1].type, "canvas");
  assert.equal(result.figures[1].title, "方案诊断关系图");
});

test("nested blocks do not erase preceding or following inline text", () => {
  installDocument(element("body", element("main",
    element("p", text("Before"), element("div", text("Middle")), text("After")),
  )));
  assert.equal(extractPageContent().text, "Before\n\nMiddle\n\nAfter");
});

test("preserves code layout while omitting hidden and non-text code children", () => {
  installDocument(element("body", element("pre",
    text("visible();\n"),
    element("span", text("hidden();")).setAttribute("hidden", ""),
    element("script", text("notCode();")),
    element("span", text("  indented();")),
  )));
  assert.equal(extractPageContent().text, "visible();\n  indented();");
});

test("skips hidden, navigation, footer, and form-control values", () => {
  const secret = element("input");
  secret.value = "must-not-be-read";
  const body = element("body",
    element("nav", text("Navigation")),
    element("main",
      element("p", text("Visible text")),
      element("div", text("Hidden text")).setAttribute("hidden", ""),
      element("div", text("CSS hidden")).setAttribute("style", "display: none"),
      element("div", text("ARIA hidden")).setAttribute("aria-hidden", "true"),
      element("form", element("p", text("Form text")), secret),
      element("footer", text("Footer")),
    ),
  );
  installDocument(body);
  assert.equal(extractPageContent().text, "Visible text\n\nForm text");
});

test("keeps quiz text and option labels inside form-like containers", () => {
  installDocument(element("body",
    element("main",
      element("h2", text("学习小测验")),
      element("form",
        element("p", text("1. 线性变换必须满足哪个性质？")),
        element("button", text("A. 保持直线")),
        element("button", text("B. 任意曲线不变")),
      ),
    ),
  ));
  assert.equal(
    extractPageContent().text,
    "学习小测验\n\n1. 线性变换必须满足哪个性质？\n\nA. 保持直线\n\nB. 任意曲线不变",
  );
});

test("chooses the densest article-like div when no landmark exists", () => {
  const lesson = element("section",
    element("h1", text("什么是线性变换")),
    ...Array.from({ length: 8 }, (_, index) => element("p", text(`第 ${index + 1} 段课程正文，解释矩阵乘法的几何意义。`.repeat(4)))),
  );
  installDocument(element("body",
    element("aside", element("a", text("导航"))),
    element("div", element("nav", text("章节列表")), lesson),
  ));
  const result = extractPageContent(60000);
  assert.match(result.text, /什么是线性变换/);
  assert.match(result.text, /第 8 段课程正文/);
  assert.doesNotMatch(result.text, /章节列表/);
});

test("uses computed visibility without excluding off-screen readable content", () => {
  const visible = element("p", text("Visible"));
  const hidden = element("p", text("Hidden"));
  installDocument(element("body", visible, hidden), {
    defaultView: { getComputedStyle: (node) => node === hidden ? { display: "none" } : { display: "block" } },
  });
  assert.equal(extractPageContent().text, "Visible");
});

test("uses a single article and falls back to body when landmarks are unsuitable", () => {
  installDocument(element("body",
    element("p", text("Body noise")),
    element("article", element("p", text("Article text"))),
  ));
  assert.equal(extractPageContent().text, "Article text");

  installDocument(element("body", element("p", text("Only body text"))));
  assert.equal(extractPageContent().text, "Only body text");
});

test("multiple articles fall back to a common readable parent", () => {
  installDocument(element("body",
    element("article", text("One")),
    element("article", text("Two")),
  ));
  assert.equal(extractPageContent().text, "One\n\nTwo");
});

test('an empty docsify article does not turn the surrounding site shell into body text', () => {
  const article = element('article').setAttribute('class', 'markdown-section');
  installDocument(element('body',
    element('header', text('RAG 学习教程：第一章、第二章、第三章，完整站点导航和其他链接')),
    element('main', article),
  ), { url: 'https://example.test/#/chapter-3' });
  assert.equal(extractPageContent().text, '');
  article.append(element('h1', text('第 3 章 RAG')), element('p', text('检索增强生成先检索相关文档，再将证据交给模型生成有依据的回答。')));
  const refreshed = extractPageContent();
  assert.match(refreshed.text, /检索增强生成先检索/);
  assert.doesNotMatch(refreshed.text, /完整站点导航/);
});

test('docsify bootstrap loading reads only its app root and then fresh rendered content', () => {
  const app = element('div', text('Loading...')).setAttribute('id', 'app');
  installDocument(element('body',
    element('header', text('A long tutorial site title and chapter navigation, unrelated to the article')),
    app,
    element('script').setAttribute('src', 'https://cdn.example.test/npm/docsify@4/lib/docsify.min.js'),
  ));
  assert.equal(extractPageContent().text, 'Loading...');
  app.childNodes = [];
  app.append(element('article', element('p', text('This is the loaded chapter body, not the initial site shell.'))).setAttribute('class', 'markdown-section'));
  assert.equal(extractPageContent().text, 'This is the loaded chapter body, not the initial site shell.');
});

test('the presence of a docsify script does not discard an existing custom article', () => {
  installDocument(element('body',
    element('article', element('p', text('A customized reader has real article text.'))),
    element('script').setAttribute('src', '/vendor/docsify.min.js'),
  ));
  assert.equal(extractPageContent().text, 'A customized reader has real article text.');
});

test('reinjection replaces an older extractor so retries use the updated implementation', () => {
  const doc = installDocument(element('body', element('article', text('Fresh current article body.'))));
  const context = vm.createContext({ document: doc, __unkAiExtractor: { extractPageContent: () => ({ text: 'Old implementation' }) } });
  vm.runInContext(readFileSync(new URL('../src/content/extractor.js', import.meta.url), 'utf8'), context);
  assert.equal(context.__unkAiExtractor.extractPageContent().text, 'Fresh current article body.');
});

test("keeps short text and reports no truncation", () => {
  installDocument(element("body", element("p", text("短文本"))));
  assert.deepEqual(extractPageContent(), {
    title: "Test page",
    url: "https://example.test/article",
    text: "短文本",
    truncated: false,
    sections: [],
    figures: [],
  });
});

test("honors exact budgets and retains both ends of long content", () => {
  installDocument(element("body", element("p", text("a".repeat(1000)))));
  for (const budget of [0, 1, 5, 20, 21, 40, 100]) {
    const result = extractPageContent(budget);
    assert.ok(result.text.length <= budget, `budget ${budget}`);
    assert.equal(result.truncated, true);
  }
  const result = extractPageContent(100);
  assert.match(result.text, /^a+/);
  assert.match(result.text, /截断/);
  assert.match(result.text, /a+$/);
  assert.equal(extractPageContent(1000).truncated, false);
  assert.equal(extractPageContent(999).text.length, 999);
});

test("does not read input values, mutate the DOM, or install DOM observers", () => {
  const input = element("input");
  Object.defineProperty(input, "value", {
    get() { throw new Error("input value must not be read"); },
  });
  globalThis.MutationObserver = class {
    constructor() { throw new Error("MutationObserver must not be installed"); }
  };
  const body = element("body", element("main", element("p", text("Safe")), input));
  installDocument(body);
  const before = JSON.stringify(body, (key, value) => key === "parentNode" ? undefined : value);
  assert.equal(extractPageContent().text, "Safe");
  const after = JSON.stringify(body, (key, value) => key === "parentNode" ? undefined : value);
  assert.equal(after, before);
  delete globalThis.MutationObserver;
});

test("both files run as classic injected scripts and respond only to EXTRACT_PAGE", () => {
  installDocument(element("body", element("p", text("Message text"))));
  const listeners = [];
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: globalThis.document,
    chrome: { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } } },
  });
  context.globalThis = context;
  vm.runInContext(readFileSync(new URL("../src/content/extractor.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("../src/content/content.js", import.meta.url), "utf8"), context);
  assert.equal(listeners.length, 1);

  let response;
  const returnValue = listeners[0]({ type: "EXTRACT_PAGE" }, {}, (value) => { response = value; });
  assert.equal(returnValue, false);
  assert.equal(response.text, "Message text");
  assert.equal(response.truncated, false);

  response = undefined;
  assert.equal(listeners[0]({ type: "OTHER" }, {}, (value) => { response = value; }), undefined);
  assert.equal(response, undefined);
});

test("builds bounded semantic landmarks, headings, links, tables, forms, and figures", () => {
  const article = element("article")
    .setAttribute("aria-label", "主教程");
  const nav = element("nav").setAttribute("aria-label", "章节导航");
  const table = element("table",
    element("caption", text("指标对照")),
    element("thead", element("tr",
      element("th", text("方案")).setAttribute("scope", "col"),
      element("th", text("延迟")).setAttribute("scope", "col"),
    )),
    element("tbody", element("tr",
      element("td", text("RAG")),
      element("td", text("120ms")),
    )),
  );
  const form = element("form",
    element("label", text("关键词")),
    element("input").setAttribute("name", "query").setAttribute("required", ""),
  ).setAttribute("aria-label", "站内搜索");
  const figure = element("figure",
    element("img")
      .setAttribute("alt", "流程图")
      .setAttribute("src", "/flow.png"),
    element("figcaption", text("检索流程")),
  );
  article.append(
    element("h1", text("RAG 指南")),
    nav.append(element("a", text("跳到表格")).setAttribute("href", "#metrics")),
    element("h2", text("指标")),
    element("p", text("查看 "), element("a", text("完整报告")).setAttribute("href", "/report")),
    table,
    form,
    figure,
  );
  installDocument(element("body", article));

  const result = extractPageContent({ includeStructure: true });
  assert.equal(result.structure.landmarks[0].role, "article");
  assert.equal(result.structure.landmarks[0].label, "主教程");
  assert.ok(result.structure.landmarks.some((item) => item.role === "navigation" && item.label === "章节导航"));
  assert.deepEqual(result.structure.headings.map((item) => [item.level, item.text]), [[1, "RAG 指南"], [2, "指标"]]);
  assert.equal(result.structure.links[0].text, "跳到表格");
  assert.equal(result.structure.links[0].href, "https://example.test/article#metrics");
  assert.deepEqual(result.structure.links[0].section, ["RAG 指南"]);
  assert.deepEqual(result.structure.tables[0].section, ["RAG 指南", "指标"]);
  assert.equal(result.structure.tables[0].caption, "指标对照");
  assert.deepEqual(result.structure.tables[0].headers, ["方案", "延迟"]);
  assert.equal(result.structure.tables[0].rows[0][0].header, true);
  assert.equal(result.structure.tables[0].rows[1][1].text, "120ms");
  assert.equal(result.structure.forms[0].label, "站内搜索");
  assert.equal(result.structure.forms[0].fields[0].name, "query");
  assert.equal(result.structure.forms[0].fields[0].required, true);
  assert.equal(result.structure.figures[0].alt, "流程图");
  assert.equal(result.structure.figures[0].caption, "检索流程");
  assert.deepEqual(result.structure.figures[0].section, ["RAG 指南", "指标"]);
  assert.equal(result.links, result.structure.links);
  assert.equal(result.figures[0].caption, "检索流程");
});

test("caps semantic node and collection counts without changing legacy output", () => {
  const article = element("article",
    ...Array.from({ length: 12 }, (_, index) =>
      element("p", text(`段落 ${index} `), element("a", text(`链接 ${index}`)).setAttribute("href", `/${index}`))),
  );
  installDocument(element("body", article));
  const legacy = extractPageContent(60000);
  assert.equal("structure" in legacy, false);
  assert.equal("links" in legacy, false);

  const result = extractPageContent({
    includeStructure: true,
    limits: { nodes: 12, links: 3, landmarks: 1, headings: 1 },
  });
  assert.ok(result.structure.links.length <= 3);
  assert.ok(result.structure.landmarks.length <= 1);
  assert.equal(result.structure.truncated.visited, true);
  assert.equal(result.structure.truncated.links, true);
});

test('reading preserves live native choice states and selected labels without reading values', () => {
  const radio = element('input').setAttribute('type', 'radio').setAttribute('aria-label', '2 vCPU');
  radio.checked = true;
  const unchecked = element('input').setAttribute('type', 'radio').setAttribute('aria-label', '4 vCPU').setAttribute('checked', '');
  unchecked.checked = false;
  const mixed = element('input').setAttribute('type', 'checkbox').setAttribute('aria-label', '批量选择');
  mixed.checked = false;
  mixed.indeterminate = true;
  const oldOption = element('option', text('华东')).setAttribute('selected', '');
  oldOption.selected = false;
  const currentOption = element('option', text('华北2（北京）'));
  currentOption.selected = true;
  const select = element('select', oldOption, currentOption).setAttribute('aria-label', '地域').setAttribute('role', 'combobox');
  for (const node of [radio, unchecked, mixed, select, oldOption, currentOption]) {
    Object.defineProperty(node, 'value', { get() { throw new Error('choice values must not be read'); } });
  }
  installDocument(element('body', element('main',
    element('p', text('云服务器配置说明：请选择地域、实例规格和付费方式。')),
    element('form', radio, unchecked, mixed, select).setAttribute('aria-label', '购买配置'),
  )));
  const page = extractPageContent({ includeStructure: true });
  const fields = page.structure.forms[0].fields;
  assert.equal(fields[0].checked, true);
  assert.equal(fields[1].checked, false, 'the default HTML attribute must not override live state');
  assert.equal(fields[2].checked, 'mixed');
  assert.deepEqual(fields[3].options, ['华东', '华北2（北京）']);
  assert.deepEqual(fields[3].selectedOptions, ['华北2（北京）']);
  const model = pageContextForModel(normalizePageContext(normalizePageContext(page)));
  assert.match(model, /2 vCPU（已选中）/);
  assert.match(model, /4 vCPU（未选中）/);
  assert.match(model, /批量选择（部分选中）/);
  assert.match(model, /地域（已选：华北2（北京））/);
});

test('semantic choices outside forms retain explicit states but never infer them from CSS or editable content', () => {
  const choices = [
    element('div', text('包年包月')).setAttribute('role', 'radio').setAttribute('aria-checked', 'true'),
    element('div', text('按量付费')).setAttribute('role', 'radio').setAttribute('aria-checked', 'false'),
    element('div', text('GPU')).setAttribute('role', 'tab').setAttribute('aria-selected', 'false'),
    element('div', text('通用算力型')).setAttribute('role', 'option').setAttribute('aria-selected', 'true'),
    element('div', text('未知规格')).setAttribute('role', 'radio').setAttribute('class', 'selected'),
  ];
  const nestedSecret = element('div', element('div', text('PRIVATE_EDITABLE_CHOICE')).setAttribute('role', 'checkbox').setAttribute('aria-checked', 'true'))
    .setAttribute('contenteditable', 'true');
  installDocument(element('body', element('main',
    element('p', text('请选择计费方式与实例架构。当前页面展示多个可选配置。')),
    ...choices,
    nestedSecret,
    element('div', text('PRIVATE_HIDDEN_CHOICE')).setAttribute('role', 'radio').setAttribute('aria-checked', 'true').setAttribute('hidden', ''),
    element('form', element('div', element('input').setAttribute('type', 'radio').setAttribute('aria-label', 'PRIVATE_FORM_DRAFT'))
      .setAttribute('contenteditable', 'true')),
  )));
  const page = extractPageContent({ includeStructure: true });
  const fields = page.structure.forms.flatMap(form => form.fields);
  const byLabel = Object.fromEntries(fields.map(field => [field.label, field]));
  assert.equal(byLabel['包年包月']?.checked, true);
  assert.equal(byLabel['按量付费']?.checked, false);
  assert.equal(byLabel.GPU?.selected, false);
  assert.equal(byLabel['通用算力型']?.selected, true);
  assert.equal(byLabel['未知规格']?.checked, undefined);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_/);
  const model = pageContextForModel(page);
  assert.match(model, /包年包月（已选中）/);
  assert.match(model, /GPU（未选中）/);
  assert.match(model, /未知规格（选择状态未知）/);
});

test('choice serialization keeps a bounded selection summary and preserves unknown legacy states', () => {
  const page = { title: 'Config', url: 'https://example.test/config', text: 'Readable configuration content.', structure: { forms: [{ label: '配置', fields: [
    { tag: 'select', label: 'Legacy region', options: ['北京', '上海'] },
    { tag: 'input', type: 'radio', label: 'Unknown radio', checked: 'true', value: 'PRIVATE_VALUE' },
    { tag: 'select', label: 'Large choice', selectedOptions: Array.from({ length: 60 }, (_, i) => `choice-${i}`), selectionKnown: true },
  ] }] } };
  const model = pageContextForModel(page);
  assert.match(model, /Legacy region（选择状态未知）/);
  assert.match(model, /Unknown radio（选择状态未知）/);
  assert.match(model, /Large choice（已选：choice-0/);
  assert.match(model, /选择摘要已截断/);
  assert.doesNotMatch(model, /choice-59|PRIVATE_VALUE/);
});

test('truncated native options never claim the current selection is empty', () => {
  const options = Array.from({ length: 41 }, (_, index) => {
    const option = element('option', text(`地域-${index}`));
    option.selected = index === 40;
    return option;
  });
  installDocument(element('body', element('main',
    element('p', text('选择地域前请确认可用区和网络要求，区域选项已展示。')),
    element('select', ...options).setAttribute('aria-label', '地域'),
  )));
  const page = extractPageContent({ includeStructure: true });
  const field = page.structure.forms[0].fields[0];
  assert.equal(field.options.length, 40);
  assert.equal(field.selectionKnown, false);
  assert.equal(field.selectionTruncated, true);
  const model = pageContextForModel(page);
  assert.match(model, /地域（选择状态未知）［选择摘要已截断］/);
  assert.doesNotMatch(model, /未选中任何选项/);
});

test("semantic mode exposes tables, links and figure captions in one related payload", () => {
  const table = element("table",
    element("thead", element("tr", element("th", text("名称")))),
    element("tbody", element("tr", element("td", text("值")))),
  );
  const figure = element("figure",
    element("img").setAttribute("src", "/asset.png"),
    element("figcaption", text("图注")),
  );
  installDocument(element("body", element("main",
    element("h2", text("章节")),
    table,
    figure,
  )));
  const result = extractPageContent({ includeStructure: true });
  assert.equal(result.structure.tables.length, 1);
  assert.deepEqual(result.structure.tables[0].rows[0], [
    { text: "名称", column: 0, row: 0, header: true, scope: "auto" },
  ]);
  assert.deepEqual(result.structure.tables[0].rows[1], [
    { text: "值", column: 0, row: 1, header: false },
  ]);
  assert.equal(result.structure.tables[0].section[0], "章节");
  assert.equal(result.structure.tables[0].rows.length, 2);
  assert.equal(result.structure.figures[0].caption, "图注");
  assert.deepEqual(result.structure.figures[0].section, ["章节"]);
  assert.equal("node" in result.structure.figures[0], false);
});

test("page selection bridge reports text and clears without reading the DOM body", () => {
  const listeners = [];
  const eventTarget = {
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
  };
  const selection = {
    toString() { return "选中的一句话"; },
    rangeCount: 1,
    getRangeAt() {
      return {
        startContainer: { nodeType: 1, tagName: "P", innerText: "前文。选中的一句话。后文。", parentElement: null },
      };
    },
    removeAllRanges() { this.cleared = true; },
  };
  const document = {
    ...eventTarget,
    title: "Selection fixture",
    addEventListener(type, listener) { listeners.push([type, listener]); },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    window: { addEventListener() {} },
    document,
    location: { href: "https://example.test/page" },
    getSelection: () => selection,
    setTimeout,
    clearTimeout,
    Date,
    console,
    chrome: {
      runtime: {
        sendMessage: async () => {},
        onMessage: { addListener(listener) { listeners.push(["message", listener]); } },
      },
    },
  });
  vm.runInContext(
    readFileSync(new URL("../src/content/page-selection.js", import.meta.url), "utf8"),
    context,
  );
  const messageListener = listeners.find(([type]) => type === "message")?.[1];
  assert.equal(typeof messageListener, "function");
  assert.deepEqual(messageListener({ type: "GET_PAGE_SELECTION" }, {}, (value) => { selection.response = value; }), false);
  assert.equal(selection.response.text, "选中的一句话");
});
