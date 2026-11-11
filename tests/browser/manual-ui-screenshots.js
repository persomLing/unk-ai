// Creates documentation images from the real built extension and isolated demo data.
// Use only a dedicated profile: this fixture clears that profile's extension storage.
// No model generation, upload or native user folder is used.
// First create an ignored output/playwright/manual-ui-screenshots.config.json with:
// browser.browserName = "chromium", browser.userDataDir = an unused output/playwright/ profile,
// browser.launchOptions.executablePath = your installed Chromium executable,
// browser.launchOptions.ignoreDefaultArgs = ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
// browser.launchOptions.args = ["--disable-extensions-except=<absolute dist path>", "--load-extension=<absolute dist path>"].
// playwright-cli -s=manual-ui-0181 open about:blank --config=output/playwright/manual-ui-screenshots.config.json
// playwright-cli -s=manual-ui-0181 run-code --filename tests/browser/manual-ui-screenshots.js
// playwright-cli -s=manual-ui-0181 close
async (page) => {
  await page.setViewportSize({ width: 420, height: 900 });
  const check = (value, label) => { if (!value) throw new Error(label); };
  const context = page.context(), pageErrors = [], modelRequests = [], shots = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('https://model.manual.fixture.test/**', route => {
    modelRequests.push(route.request().url());
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Documentation fixture does not generate"}}' });
  });
  const fixtureUrl = 'https://reading.manual.fixture.test/guide';
  await context.route('https://reading.manual.fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>UNK AI 使用指南 · 页面阅读</title></head><body><h1>页面阅读</h1><p>自动模式先读取正文，再根据资料缺口补读页面结构。基础模式只读取正文，深入模式最多追加一次结构读取。</p><p>本页面仅用于操作手册演示。</p></body></html>' }));
  const sourcePage = await context.newPage();
  await sourcePage.goto(fixtureUrl);
  let worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2];
  const seeded = await worker.evaluate(async fixtureUrl => {
    await chrome.storage.local.clear();
    const sourceTab = (await chrome.tabs.query({})).find(tab => tab.url === fixtureUrl);
    const today = '2026-11-06T08:00:00.000Z', earlier = '2026-11-06T07:42:00.000Z', yesterday = '2026-11-05T06:35:00.000Z';
    const pageSource = { tabId: sourceTab.id, url: fixtureUrl, title: 'UNK AI 使用指南 · 页面阅读', capturedAt: today };
    const common = { version: 2, storage: 'local', createdAt: today };
    const conversations = [
      { ...common, id: 'manual-reading', title: '网页阅读与来源', updatedAt: today,
        pageContext: { ...pageSource, text: '自动、基础、深入三种页面读取方式。', bodyStatus: 'available' },
        messages: [
          { id: 'manual-q1', role: 'user', content: '总结这页的三种读取方式，说明分别适合什么问题。', pageContextEnabled: true, pageSource, createdAt: today },
          { id: 'manual-a1', role: 'assistant', status: 'complete', model: '演示视觉模型', createdAt: today,
            content: '**先读正文，再按需要补充资料。**\n\n- **自动**：适合日常总结和解释。\n- **基础**：正文已够用时，不追加结构读取。\n- **深入**：配置或表格信息不足时，补读一次。\n\n可展开下方来源，核对本次读过的页面。',
            sources: [{ url: fixtureUrl, title: 'UNK AI 使用指南 · 页面阅读' }] },
        ] },
      { ...common, id: 'manual-images', title: '图片保存与附件回退', updatedAt: earlier,
        messages: [
          { id: 'manual-q2', role: 'user', content: '图片保存在哪里？怎样把旧问题重新放回输入框？', pageContextEnabled: false, createdAt: earlier },
          { id: 'manual-a2', role: 'assistant', status: 'complete', model: '演示视觉模型', createdAt: earlier,
            content: '正式会话图片保存在所选数据目录的 **images/** 中。\n\n悬停自己的提问，点击右下方的回退图标，文字和附件会一起恢复到输入框。重新发送前，检查附件和页面开关。' },
        ] },
      { ...common, id: 'manual-agent', title: '网页任务失败后重启', updatedAt: yesterday,
        messages: [
          { id: 'manual-q3', role: 'user', content: '在本页找到导出入口并查看保存选项。', agentTask: true, pageContextEnabled: false, pageSource, createdAt: yesterday },
          { id: 'manual-a3', role: 'assistant', status: 'error', model: '演示视觉模型', createdAt: yesterday, content: '任务未完成，请先核对网页，再决定是否重新开始。',
            errorMessage: '控件已变化，本次动作未执行。',
            agent: { taskId: 'manual-agent-demo-task', goal: '查看导出入口和保存选项', status: 'failed', result: '已停止后续动作，等待重新核对原页面。',
              steps: [{ kind: 'info', title: '已观察原页面', detail: '读取页面中可见的导出入口。' },
                { kind: 'error', title: '控件状态已变化', detail: '动作前核验失败，没有提交这次点击。' }] } },
        ] },
    ];
    const opfsRoot = await navigator.storage.getDirectory();
    const folder = await opfsRoot.getDirectoryHandle('UNK AI 演示资料', { create: true });
    const permission = await folder.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('Isolated demo directory permission unavailable');
    const directory = await folder.getDirectoryHandle('conversations', { create: true });
    for (const conversation of conversations) {
      const file = await directory.getFileHandle(`${conversation.id}.json`, { create: true });
      const writer = await file.createWritable(); await writer.write(JSON.stringify(conversation)); await writer.close();
    }
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('unk-ai-file-storage', 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('handles')) open.result.createObjectStore('handles'); };
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(folder, 'conversation-directory');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    await chrome.storage.local.set({ theme: 'light', storageDirectoryMeta: { name: folder.name, granted: true, permission: 'granted', configuredAt: today },
      providerConfig: { version: 4, endpointUrl: 'https://model.manual.fixture.test/v1', apiKey: 'DOCUMENTATION_DEMO_KEY', selectedModelId: 'manual-vision',
        selectedEffort: 'default', webSearchEnabled: false, models: [{ id: 'manual-vision', name: '演示视觉模型', contextLength: 32768,
          maxOutputTokens: 2048, supportsVision: true, supportsReasoning: true, reasoningEnabled: true, reasoningDefaultEffort: 'default' }] },
      conversationOrganization: { version: 1, revision: 1, groups: [
        { id: 'manual-reading-group', name: '阅读与提问', createdAt: today }, { id: 'manual-operation-group', name: '网页任务', createdAt: today } ],
        assignments: { 'manual-reading': 'manual-reading-group', 'manual-images': 'manual-reading-group', 'manual-agent': 'manual-operation-group' },
        titles: {}, preferences: { view: 'groups', collapsed: [] } },
    });
    return { sourceTabId: sourceTab.id, conversationCount: conversations.length, directoryName: folder.name };
  }, fixtureUrl);
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), seeded.sourceTabId);
  await page.waitForFunction(() => document.querySelector('#conversation-title')?.textContent === '网页阅读与来源'
    && !document.querySelector('#composer-page-control')?.hidden && !document.querySelector('#message-input')?.readOnly);
  await page.evaluate(() => document.fonts.ready);
  const bundle = await page.evaluate(() => [...document.scripts].map(value => value.src).find(value => /\/assets\/sidepanel-.*\.js$/.test(value)));
  check(bundle, 'Real dist bundle missing');
  async function capture(filename, selectors, clip = null) {
    const meta = await page.evaluate(selectors => ({ viewport: { width: innerWidth, height: innerHeight },
      boxes: Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector), rect = element?.getBoundingClientRect();
        return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: Boolean(rect.width && rect.height) } : null];
      })) }), selectors);
    const crop = clip || { x: 0, y: 0, width: meta.viewport.width, height: meta.viewport.height };
    await page.screenshot({ path: `output/playwright/${filename}`, clip: crop });
    shots.push({ filename, ...meta, crop });
  }
  await page.locator('#message-input').fill('请比较“自动”和“深入”读取的区别。');
  await capture('user-guide-overview.png', ['#conversation-title', '#model-trigger', '#open-history', '#export-selected', '#new-chat',
    '#composer-page-pill', '#agent-toggle', '#composer-reading-depth', '#composer-network-allowed', '#context-meter-button', '#attach-button', '#send-message', '#message-input']);
  await page.locator('#export-selected').click();
  await page.locator('#conversation-export-menu').waitFor({ state: 'visible' });
  const menuBox = await page.locator('#conversation-export-menu').boundingBox();
  await capture('user-guide-export.png', ['#conversation-title', '#export-selected', '#conversation-export-menu',
    '[data-conversation-export="document"]', '[data-conversation-export="markdown"]', '[data-conversation-export="diagnostics"]'],
    { x: 0, y: 0, width: 420, height: Math.ceil(menuBox.y + menuBox.height + 14) });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1259, height: 840 });
  await page.waitForFunction(() => document.querySelector('#app').classList.contains('history-docked'));
  await capture('user-guide-history-wide.png', ['#history-drawer', '#close-history', '#history-search-input', '#history-view', '#history-list',
    '#open-settings', '#conversation-title', '#composer-page-pill', '#message-input']);
  await page.setViewportSize({ width: 420, height: 840 });
  await page.locator('#history-drawer').waitFor({ state: 'hidden' });
  await page.locator('#open-history').click();
  await page.locator('#history-drawer').waitFor({ state: 'visible' });
  await capture('user-guide-history-narrow.png', ['#history-drawer', '#close-history', '#history-search-input', '#history-view', '#history-new-chat',
    '#history-manage', '#history-list', '#open-settings', '#drawer-backdrop']);
  await page.locator('[data-open-chat="manual-images"]').click();
  await page.waitForFunction(() => document.querySelector('#conversation-title').textContent === '图片保存与附件回退');
  await page.locator('.user-message').hover();
  const questionBox = await page.locator('.user-message').boundingBox();
  await capture('user-guide-rewind.png', ['#conversation-title', '.user-message', '.user-message-actions', '.user-message [data-action="rewind"]', '.user-message [data-action="copy-user"]'],
    { x: 0, y: 0, width: 420, height: Math.ceil(questionBox.y + questionBox.height + 75) });
  await page.locator('#open-history').click();
  await page.locator('[data-open-chat="manual-agent"]').click();
  await page.waitForFunction(() => document.querySelector('#conversation-title').textContent === '网页任务失败后重启');
  await page.locator('.message-agent-head').click();
  await page.locator('[data-action="restart-agent"]').scrollIntoViewIfNeeded();
  await capture('user-guide-agent-restart.png', ['#conversation-title', '.message-agent-details', '.message-agent-head', '.message-agent-body',
    '.message-diagnostic-export', '[data-action="restart-agent"]', '#composer-page-pill'], { x: 0, y: 0, width: 420, height: 750 });
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await page.setViewportSize({ width: 1000, height: 840 });
  await page.locator('[data-settings-nav="storage-section"]').click();
  await page.locator('.diagnostic-settings').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#diagnostic-status').textContent !== '正在读取日志状态…');
  const diagnosticBox = await page.locator('.diagnostic-settings').boundingBox();
  await capture('user-guide-diagnostics.png', ['#storage-title', '.diagnostic-settings', '#diagnostic-status', '#export-diagnostics', '#flush-diagnostics'],
    { x: Math.max(0, Math.floor(diagnosticBox.x - 12)), y: Math.max(0, Math.floor(diagnosticBox.y - 12)),
      width: Math.min(1000 - Math.max(0, Math.floor(diagnosticBox.x - 12)), Math.ceil(diagnosticBox.width + 24)), height: Math.ceil(diagnosticBox.height + 24) });
  check(pageErrors.length === 0, 'Page errors encountered'); check(modelRequests.length === 0, 'Unexpected model call');
  const report = { passed: true, bundle, seeded, modelRequests, pageErrors, shots, note: 'Real dist UI; isolated OPFS demo directory and conversations; screenshot annotations are added separately.' };
  console.log(`MANUAL_REPORT=${JSON.stringify(report)}`);
  return report;
}
