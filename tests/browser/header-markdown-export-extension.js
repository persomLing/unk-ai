// Run only in an isolated Chromium profile with current dist loaded.
// Exercises real built sidepanel, storage, menu and Markdown Blob generation.
// Browser download calls are captured locally; native download coverage is separate.
// No model traffic or user Chrome profile is used.
// playwright-cli -s=header-markdown-export run-code --filename tests/browser/header-markdown-export-extension.js
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const context = page.context(), errors = [], modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  const modelPattern = 'https://model.header-export.fixture.test/**';
  await context.route(modelPattern, route => {
    modelRequests.push(route.request().url());
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"unexpected local fixture request"}}' });
  });
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2];
  const expected = await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    const createdAt = new Date().toISOString();
    const title = '这是一个用于验证顶部固定标题和 Markdown 快照的长会话标题，包含完整的问题与回答记录';
    const messages = [];
    for (let index = 1; index <= 24; index++) {
      messages.push({ id: `header-question-${index}`, role: 'user', content: `第 ${index} 轮问题：请保留本轮问题的原始 Markdown 内容。`,
        pageContextEnabled: false, createdAt });
      messages.push({ id: `header-answer-${index}`, role: 'assistant', status: 'complete', model: 'fixture-model-v1', createdAt,
        content: `### 第 ${index} 轮回答\n\n${'这段回答用于验证长会话滚动时顶部标题保持可见，导出内容来自当前对话。'.repeat(18)}\n\n- 保留第一项\n- 保留第二项\n\n\`原始代码标记\``,
        reasoning: 'DO_NOT_EXPORT_REASONING', ...(index === 1 ? { agent: { goal: '本地页面核对', steps: [{ title: '核对已完成', detail: '仅本地测试' }] } } : {}) });
    }
    const conversation = { version: 2, storage: 'temporary', id: 'header-markdown-export-regression', title, createdAt,
      updatedAt: createdAt, messages, pageContext: { title: '本地来源', url: 'https://source.header-export.fixture.test/page', content: 'DO_NOT_EXPORT_PRIVATE_PAGE_BODY' },
      contextSummary: { text: 'DO_NOT_EXPORT_PRIVATE_SUMMARY' } };
    await chrome.storage.local.set({ temporaryConversation: conversation,
      providerConfig: { version: 4, endpointUrl: 'https://model.header-export.fixture.test/v1', apiKey: 'DO_NOT_EXPORT_LOCAL_API_KEY_0181',
        selectedModelId: 'fixture-model-v1', webSearchEnabled: false,
        models: [{ id: 'fixture-model-v1', name: '本地导出验证模型', contextLength: 200000, maxOutputTokens: 1200, supportsVision: false, supportsReasoning: false }] } });
    return { id: conversation.id, title, createdAt, messages: messages.map(message => ({ role: message.role, content: message.content })) };
  });
  try {
    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await page.waitForFunction(() => !document.querySelector('#message-input')?.readOnly
      && document.querySelectorAll('.user-message').length === 24);
    const bundle = await page.evaluate(() => [...document.scripts].map(script => script.src).find(src => /\/assets\/sidepanel-.*\.js$/.test(src)));
    check(bundle, 'actual dist bundle absent');
    const before = await page.evaluate(() => {
      const title = document.querySelector('#conversation-title'), header = document.querySelector('.app-header');
      const box = title.getBoundingClientRect(), scroll = document.querySelector('#conversation-view');
      return { text: title.textContent, tooltip: title.title, hidden: title.hidden, titleInHeader: header.contains(title),
        browserTitle: document.title, y: box.y, height: box.height, headerHeight: header.getBoundingClientRect().height,
        scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, legacyButtons: document.querySelectorAll('#export-chat, #chat-heading').length };
    });
    check(!before.hidden && before.text === expected.title && before.tooltip === expected.title && before.titleInHeader, 'full current title is not in fixed header');
    check(before.browserTitle === `${expected.title} - UNK AI` && before.legacyButtons === 0, 'browser title or obsolete title/export entry remained');
    check(before.scrollHeight > before.clientHeight * 3, 'fixture is not a long scrollable conversation');
    await page.locator('#conversation-view').evaluate(item => { item.scrollTop = item.scrollHeight; });
    await page.waitForFunction(() => {
      const scroll = document.querySelector('#conversation-view');
      return scroll.scrollTop > 1000 && Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 3;
    });
    const after = await page.locator('#conversation-title').boundingBox();
    check(after && Math.abs(after.y - before.y) < 1 && after.y >= 0 && after.y + after.height < before.headerHeight, 'title scrolled out with conversation');
    await page.screenshot({ path: 'output/playwright/header-markdown-export-long-bottom.png' });

    // Keep the original native function and assert replacement before issuing any save.
    const intercepted = await page.evaluate(() => {
      const fixture = window.headerExportDownloads = { calls: [], pending: [], original: chrome.downloads.download };
      const capture = options => {
        const record = { url: options.url, filename: options.filename, saveAs: options.saveAs };
        fixture.calls.push(record);
        void fetch(options.url).then(async response => { record.type = response.headers.get('content-type'); record.content = await response.text(); });
        if (!options.filename.endsWith('.md')) return Promise.resolve(100 + fixture.calls.length);
        return new Promise(resolve => fixture.pending.push(resolve));
      };
      chrome.downloads.download = capture;
      return chrome.downloads.download === capture;
    });
    check(intercepted, 'native download call was not intercepted; abort before saving');
    await page.locator('#export-selected').click();
    const menu = page.locator('#conversation-export-menu');
    await menu.waitFor({ state: 'visible' });
    const entries = await menu.locator('[data-conversation-export]').evaluateAll(options => options.map(option => ({ kind: option.dataset.conversationExport,
      title: option.querySelector('strong').textContent, disabled: option.disabled })));
    check(JSON.stringify(entries.map(item => item.kind)) === JSON.stringify(['document', 'markdown', 'diagnostics']), 'menu does not expose exactly three current entries');
    check(entries.every(item => !item.disabled), 'ordinary conversation export entry disabled');
    await page.screenshot({ path: 'output/playwright/header-markdown-export-menu.png' });
    await menu.locator('[data-conversation-export="document"]').click();
    const documentDialog = page.locator('#conversation-export-dialog');
    await documentDialog.waitFor({ state: 'visible' });
    check(await documentDialog.locator('.export-turn-option').count() === 24, 'existing document path lost current turns');
    check(await documentDialog.locator('input[value="png"]').count() === 1 && await documentDialog.locator('input[value="pdf"]').count() === 1, 'PNG/PDF choices absent');
    await documentDialog.locator('[data-export-close]').last().click();
    await documentDialog.waitFor({ state: 'hidden' });
    await page.locator('#export-selected').click();
    await menu.locator('[data-conversation-export="diagnostics"]').click();
    await page.waitForFunction(() => window.headerExportDownloads.calls.some(call => call.filename.endsWith('.json') && call.content));
    const diagnostic = await page.evaluate(() => window.headerExportDownloads.calls.find(call => call.filename.endsWith('.json')));
    const diagnosticBundle = JSON.parse(diagnostic.content);
    const diagnosticConversationId = await worker.evaluate(async conversationId => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('unk-ai-diagnostics', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      let state;
      try { state = await new Promise((resolve, reject) => {
        const request = database.transaction('state', 'readonly').objectStore('state').get('current');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }); } finally { database.close(); }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${state.salt}\u0000${conversationId}`));
      return `h_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }, expected.id);
    check(diagnostic.saveAs === true && diagnostic.url.startsWith('blob:') && diagnosticBundle.scope?.conversationId === diagnosticConversationId, 'diagnostic export did not preserve current scope/save adapter');

    await page.locator('#export-selected').click();
    await menu.locator('[data-conversation-export="markdown"]').click();
    await page.waitForFunction(() => window.headerExportDownloads.calls.some(call => call.filename.endsWith('.md') && call.content));
    const markdown = await page.evaluate(() => window.headerExportDownloads.calls.find(call => call.filename.endsWith('.md')));
    check(markdown.saveAs === true && markdown.url.startsWith('blob:') && markdown.type?.startsWith('text/markdown'), 'Markdown did not use real Blob and saveAs adapter');
    check(markdown.filename.endsWith('-header-m.md') && markdown.content.startsWith(`# ${expected.title}\n\n`) && markdown.content.includes(`Created: ${expected.createdAt}`), 'Markdown filename/current title snapshot changed');
    check(expected.messages.every(message => markdown.content.includes(message.content)), 'Markdown lost original question/answer formatting');
    check((markdown.content.match(/^## User$/gm) || []).length === 24 && (markdown.content.match(/^## Assistant$/gm) || []).length === 24, 'Markdown did not export exactly the current 24 turns');
    check(markdown.content.includes('Model: fixture-model-v1') && markdown.content.includes('### Browser task: 本地页面核对') && markdown.content.includes('- 核对已完成 — 仅本地测试'), 'old Markdown model/Agent format changed');
    check(!markdown.content.includes('DO_NOT_EXPORT_') && !markdown.content.includes('model.header-export.fixture.test'), 'Markdown leaked configuration or private non-export fields');
    await menu.locator('[data-conversation-export="markdown"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.locator('#export-selected').click();
    check(await menu.locator('[data-conversation-export="markdown"]').isDisabled(), 'pending Markdown save is not locked');
    await menu.locator('[data-conversation-export="markdown"]').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const markdownCalls = await page.evaluate(() => window.headerExportDownloads.calls.filter(call => call.filename.endsWith('.md')).length);
    check(markdownCalls === 1, 'repeated menu events issued a duplicate Markdown save');
    await page.keyboard.press('Escape');
    await page.locator('#new-chat').click();
    await page.waitForFunction(() => document.querySelector('#welcome') && !document.querySelector('#welcome').hidden
      && document.querySelector('#conversation-title').hidden && !document.querySelector('.user-message'));
    const empty = await page.evaluate(() => ({ titleHidden: document.querySelector('#conversation-title').hidden,
      titleText: document.querySelector('#conversation-title').textContent, browserTitle: document.title,
      headerHeight: document.querySelector('.app-header').getBoundingClientRect().height }));
    check(empty.titleHidden && empty.titleText === '' && empty.headerHeight === 52 && empty.browserTitle === 'UNK AI - 阅读与对话', 'new empty conversation retains an extra header title row');
    await page.evaluate(() => window.headerExportDownloads.pending.splice(0).forEach(resolve => resolve(201)));
    await page.waitForTimeout(100);
    check(!(await page.locator('#toast-region').innerText()).includes('正在保存 Markdown'), 'late old download success appeared in new conversation');
    await page.locator('#export-selected').click();
    const emptyEntries = await menu.locator('[data-conversation-export]').evaluateAll(options => options.map(option => ({ kind: option.dataset.conversationExport, disabled: option.disabled })));
    check(emptyEntries.filter(option => option.kind !== 'diagnostics').every(option => option.disabled)
      && !emptyEntries.find(option => option.kind === 'diagnostics').disabled, 'new conversation export availability is incorrect');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#toast-region .toast'));
    await page.screenshot({ path: 'output/playwright/header-markdown-export-empty.png' });

    const historyLayout = [];
    const layoutState = () => page.evaluate(() => {
      const box = selector => {
        const element = document.querySelector(selector), rect = element.getBoundingClientRect();
        return { x: rect.x, width: rect.width, hidden: element.hidden };
      };
      const input = document.querySelector('#message-input'), rect = input.getBoundingClientRect();
      return { width: innerWidth, docked: document.querySelector('#app').classList.contains('history-docked'),
        drawerOpen: document.querySelector('#history-drawer').classList.contains('open'),
        drawerAriaHidden: document.querySelector('#history-drawer').getAttribute('aria-hidden'),
        drawerInert: document.querySelector('#history-drawer').inert,
        backdropHidden: document.querySelector('#drawer-backdrop').hidden,
        triggerExpanded: document.querySelector('#open-history').getAttribute('aria-expanded'),
        triggerHasPopup: document.querySelector('#open-history').getAttribute('aria-haspopup'),
        focus: document.activeElement.id, drawer: box('#history-drawer'), header: box('.app-header'),
        title: box('#conversation-title'), toolbar: box('.header-toolbar'), messages: box('#messages'),
        stage: box('#conversation-stage'), composer: box('#composer'), input: box('#message-input'),
        composerReceivesPointer: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input };
    });
    const waitDocked = async () => {
      await page.waitForFunction(() => document.querySelector('#app').classList.contains('history-docked')
        && Math.abs(document.querySelector('#history-drawer').getBoundingClientRect().x) < 1
        && document.querySelector('.app-header').getBoundingClientRect().x >= 359);
    };
    const narrow = await layoutState();
    check(narrow.width === 420 && !narrow.drawerOpen && narrow.drawerAriaHidden === 'true' && narrow.drawerInert && narrow.backdropHidden,
      '420px default history drawer is not closed');
    historyLayout.push({ case: '420-default', ...narrow });
    await page.locator('#message-input').focus();
    await page.setViewportSize({ width: 1259, height: 840 });
    await waitDocked();
    const wide = await layoutState();
    check(wide.drawerOpen && wide.drawerAriaHidden === 'false' && !wide.drawerInert && wide.backdropHidden
      && Math.abs(wide.drawer.width - 360) < 1 && wide.triggerHasPopup === null && wide.focus === 'message-input',
      '1259px automatic history docking is incorrect or stole composer focus');
    check(['header', 'toolbar', 'stage', 'composer', 'input'].every(key => wide[key].x >= 359) && wide.composerReceivesPointer,
      'docked history obstructs right main area');
    historyLayout.push({ case: '1259-auto', ...wide });
    await page.locator(`[data-open-chat="${expected.id}"]`).click();
    await page.waitForFunction(title => document.querySelector('#conversation-title').textContent === title
      && !document.querySelector('#conversation-title').hidden && document.querySelectorAll('.user-message').length === 24, expected.title);
    await waitDocked();
    const selectedWide = await layoutState();
    check(['title', 'toolbar', 'messages', 'stage', 'composer', 'input'].every(key => selectedWide[key].x >= 359)
      && selectedWide.composerReceivesPointer && selectedWide.backdropHidden, 'history selection lost docking or obscures title/messages/input');
    historyLayout.push({ case: '1259-selected-chat', ...selectedWide });
    await page.screenshot({ path: 'output/playwright/header-markdown-export-wide-history.png' });
    await page.locator('#new-chat').click();
    await page.waitForFunction(() => !document.querySelector('#welcome').hidden && document.querySelector('#conversation-title').hidden);
    await waitDocked();
    historyLayout.push({ case: '1259-new-chat', ...(await layoutState()) });
    await page.locator('#close-history').click();
    await page.locator('#history-drawer').waitFor({ state: 'hidden' });
    const collapsedWide = await layoutState();
    check(!collapsedWide.docked && !collapsedWide.drawerOpen && collapsedWide.header.x < 1 && collapsedWide.backdropHidden
      && collapsedWide.triggerExpanded === 'false', 'wide close did not restore main area and history trigger');
    await page.locator('#open-history').click();
    await waitDocked();
    historyLayout.push({ case: '1259-reopened', ...(await layoutState()) });

    await page.locator('#message-input').focus();
    await page.setViewportSize({ width: 959, height: 840 });
    await page.locator('#history-drawer').waitFor({ state: 'hidden' });
    const belowBoundary = await layoutState();
    check(!belowBoundary.docked && !belowBoundary.drawerOpen && belowBoundary.backdropHidden && belowBoundary.header.x < 1
      && belowBoundary.triggerHasPopup === 'dialog' && belowBoundary.focus === 'message-input', '959px history boundary or retained composer focus incorrect');
    historyLayout.push({ case: '959-auto-closed', ...belowBoundary });
    await page.setViewportSize({ width: 960, height: 840 });
    await waitDocked();
    const atBoundary = await layoutState();
    check(atBoundary.drawerOpen && atBoundary.backdropHidden && Math.abs(atBoundary.drawer.width - 360) < 1
      && atBoundary.focus === 'message-input', '960px auto docking boundary incorrect');
    historyLayout.push({ case: '960-auto-open', ...atBoundary });
    await page.locator('#history-search-input').focus();
    await page.setViewportSize({ width: 959, height: 840 });
    await page.locator('#history-drawer').waitFor({ state: 'hidden' });
    const focusedNarrow = await layoutState();
    check(focusedNarrow.focus === 'open-history', 'narrowing left focus in the now-hidden drawer');
    historyLayout.push({ case: '959-focus-restored', ...focusedNarrow });
    await page.setViewportSize({ width: 420, height: 840 });
    await page.locator('#open-history').click();
    await page.locator('#history-drawer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => Math.abs(document.querySelector('#history-drawer').getBoundingClientRect().x) < 1);
    const manualNarrow = await layoutState();
    check(!manualNarrow.docked && manualNarrow.drawerOpen && !manualNarrow.backdropHidden && manualNarrow.header.x < 1,
      '420px manual history drawer/backdrop behavior incorrect');
    historyLayout.push({ case: '420-manual-drawer', ...manualNarrow });
    await page.screenshot({ path: 'output/playwright/header-markdown-export-narrow-drawer.png' });
    await page.locator('#drawer-backdrop').click({ position: { x: 410, y: 300 } });
    await page.locator('#history-drawer').waitFor({ state: 'hidden' });
    const backdropClosed = await layoutState();
    check(!backdropClosed.drawerOpen && backdropClosed.backdropHidden && backdropClosed.focus === 'open-history',
      '420px backdrop did not close drawer and restore focus');
    historyLayout.push({ case: '420-backdrop-closed', ...backdropClosed });
    check(errors.length === 0 && modelRequests.length === 0, `page errors or unexpected model traffic: ${JSON.stringify({ errors, modelRequests })}`);
    return { passed: true, environment: 'Actual dist extension page in isolated Chromium; real menu/storage/Markdown Blob; native download call locally captured',
      bundle, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      title: { fixedAtBottom: true, fullTooltip: true, browserTitleSynced: true, scrollHeight: before.scrollHeight, headerHeight: before.headerHeight },
      menu: { entries, documentTurns: 24, pngAndPdfAvailable: true, diagnosticScopeMatched: true },
      markdown: { filename: markdown.filename, type: markdown.type, saveAs: true, characters: markdown.content.length,
        turns: 24, originalFormattingPreserved: true, configurationExcluded: true, duplicateDownloads: 0, lateCompletionIsolated: true },
      emptyConversation: empty, historyLayout, modelRequests: 0, pageErrors: errors };
  } finally {
    await page.evaluate(() => { const fixture = window.headerExportDownloads; if (fixture) { fixture.pending.splice(0).forEach(resolve => resolve(299)); chrome.downloads.download = fixture.original; } }).catch(() => {});
    await context.unroute(modelPattern);
  }
}
