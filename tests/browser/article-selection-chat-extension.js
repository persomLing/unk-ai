// Run only in a fresh isolated Chromium profile with the current dist loaded.
// Exercises the actual sidepanel, storage/outbox and grouped history with local
// model responses. Never run against a user's normal Chrome profile.
// playwright-cli -s=article-selection-extension run-code --filename tests/browser/article-selection-chat-extension.js
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const stableValue = value => Array.isArray(value) ? value.map(stableValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])])) : value;
  const sameContent = (left, right) => JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
  const waitBounded = async (pending, message, timeoutMs = 15000) => {
    let timer;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const context = page.context();
  const errors = [], modelRequests = [], blockedRequests = [];
  const onPageError = error => errors.push(error.message);
  page.on('pageerror', onPageError);
  const modelHost = 'model.article-selection.fixture.test';
  const sourceHost = 'source.article-selection.fixture.test';
  const selectedText = 'metadata 是每个 chunk 附带的键值对';
  const secondSelectedText = '这些字段用于过滤与引用';
  const firstComment = '请解释这里的 metadata 与正文向量之间的关系。';
  const editedFirstComment = '请用租户过滤的例子解释 metadata 与正文向量之间的关系。';
  const secondComment = '请说明这些字段怎样过滤结果并回溯来源。';
  const replacementSecondComment = '请给出字段过滤以及 source/page 回溯的具体例子。';
  const mainQuestion = '请按顺序回答这两处引用注释。';
  const sourceAnswer = '### 一、metadata 是什么\n\n在向量库和 RAG 中，metadata 是每个 chunk 附带的键值对，存储时不参与向量化。\n\n这些字段用于过滤与引用，还可以通过 source/page 回溯原始页面。';
  const mainReply = '本地引用回答：metadata 字段可按用户或文档类型过滤。';
  const floatingReply = '本地单独追问回答：metadata 的过滤字段不会参与向量化。';
  let streamCount = 0;
  let releaseFloatingReply, markFloatingRequestStarted;
  const floatingReplyReleased = new Promise(resolve => { releaseFloatingReply = resolve; });
  const floatingRequestStarted = new Promise(resolve => { markFloatingRequestStarted = resolve; });
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  const extensionUrl = `chrome-extension://${extensionId}/src/sidepanel/index.html`;
  const routeHandler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === modelHost) {
      const payload = request.postDataJSON();
      modelRequests.push({ url: request.url(), stream: payload?.stream === true, payload });
      if (payload?.stream) {
        const requestNumber = ++streamCount;
        const reply = requestNumber === 1 ? mainReply : floatingReply;
        // Keep the floating turn active while its saved history entry is opened.
        // Release in the scenario or finally so assertion failures cannot leave
        // a fixture model request waiting indefinitely.
        if (requestNumber === 2) {
          markFloatingRequestStarted();
          await floatingReplyReleased;
        }
        const chunks = [
          { id: `article-selection-${requestNumber}`, choices: [{ delta: { role: 'assistant', content: reply }, finish_reason: null }] },
          { id: `article-selection-${requestNumber}`, choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
        return route.fulfill({ status: 200, contentType: 'text/event-stream',
          body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }] }) });
    }
    if (url.hostname === sourceHost) return route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><html><head><title>无关资料标签页</title></head><body><article>UNRELATED_LIVE_PAGE_SENTINEL：这是与 metadata 选区无关的网页。</article></body></html>' });
    if (['chrome-extension:', 'data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue();
    blockedRequests.push({ host: url.hostname, type: request.resourceType() });
    return route.abort('blockedbyclient');
  };
  await context.route('**/*', routeHandler);
  let sourcePage;
  let ownedNewTemporaryId = null;
  const storedTemporary = () => worker.evaluate(async () => (await chrome.storage.local.get('temporaryConversation')).temporaryConversation || null);
  const seed = async id => worker.evaluate(async ({ id, answer, ownedNewTemporaryId }) => {
    const prior = await chrome.storage.local.get(['providerConfig', 'temporaryConversation']);
    if (prior.providerConfig?.endpointUrl && !prior.providerConfig.endpointUrl.includes('model.article-selection.fixture.test')) {
      throw new Error('This regression requires an isolated fixture profile, not a configured provider.');
    }
    if (prior.temporaryConversation?.id && !prior.temporaryConversation.id.startsWith('article-selection-')
      && prior.temporaryConversation.id !== ownedNewTemporaryId) {
      throw new Error('This regression requires an isolated fixture profile, not an existing conversation.');
    }
    const now = new Date().toISOString();
    const conversation = { version: 2, id, storage: 'temporary', title: `选区引用回归 ${id}`, createdAt: now, updatedAt: now,
      messages: [
        { id: `${id}-question`, role: 'user', content: 'metadata 是什么，有哪些用途？', displayContent: 'metadata 是什么，有哪些用途？', pageContextEnabled: false, createdAt: now },
        { id: `${id}-answer`, role: 'assistant', status: 'complete', content: answer, createdAt: now },
      ], pageContext: { title: '旧的无关页面', url: 'https://source.article-selection.fixture.test/unrelated', text: 'UNRELATED_CACHED_PAGE_SENTINEL' } };
    await chrome.storage.local.set({ providerConfig: { version: 4, endpointUrl: 'https://model.article-selection.fixture.test/v1',
      apiKey: 'local-fixture-only', selectedModelId: 'article-fixture', webSearchEnabled: false,
      models: [{ id: 'article-fixture', name: '选区提问本地模型替身', contextLength: 32000, maxOutputTokens: 1200, supportsVision: false, supportsReasoning: false }] },
      conversationOrganization: { version: 1, revision: 0,
        groups: [{ id: 'fixture-source-group', name: '原对话分组', createdAt: now }], assignments: { [id]: 'fixture-source-group' },
        titles: {}, preferences: { view: 'groups', collapsed: [] } }, temporaryConversation: conversation });
    return conversation;
  }, { id, answer: sourceAnswer, ownedNewTemporaryId });
  const openBuiltSidepanel = async seedId => {
    await page.goto(extensionUrl);
    await page.bringToFront();
    await page.waitForFunction(id => !document.querySelector('#message-input')?.readOnly
      && Boolean(document.querySelector(`[data-message-id="${id}-answer"] [data-message-content]`)), seedId);
    const bundle = await page.evaluate(() => [...document.scripts].map(script => script.src).find(src => /\/assets\/sidepanel-.*\.js$/.test(src)));
    check(bundle, 'actual dist sidepanel bundle is absent');
    await page.evaluate(() => {
      const fixture = window.articleSelectionExtensionFixture = { browserMessages: [] };
      for (const [api, position] of [[chrome.runtime, 0], [chrome.tabs, 1]]) {
        const nativeSend = api.sendMessage.bind(api);
        api.sendMessage = (...args) => {
          const message = args[position];
          if (message?.type) fixture.browserMessages.push({ type: message.type, tabId: message.tabId ?? args[0] });
          return nativeSend(...args);
        };
      }
      fixture.readOutbox = () => new Promise((resolve, reject) => {
        const open = indexedDB.open('unk-ai-conversation-sync', 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('outbox')) { database.close(); resolve([]); return; }
          const transaction = database.transaction('outbox', 'readonly');
          const request = transaction.objectStore('outbox').getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => database.close();
          transaction.onabort = () => { database.close(); reject(transaction.error); };
        };
      });
    });
    return bundle;
  };
  const selectMessage = async (messageId, text) => {
    await page.locator(`#messages [data-message-id="${messageId}"]`).scrollIntoViewIfNeeded();
    await page.evaluate(({ messageId, text }) => {
      const body = document.querySelector(`#messages [data-message-id="${messageId}"] [data-message-content]`);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && !node.nodeValue.includes(text)) {}
      if (!node) throw new Error('Native selection text is missing from the real answer.');
      const start = node.nodeValue.indexOf(text), range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + text.length);
      const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range);
    }, { messageId, text });
    await page.locator('.article-selection-menu').waitFor({ state: 'visible' });
    const menu = page.locator('.article-selection-menu');
    check(await menu.getByRole('button', { name: '引用到当前对话', exact: true }).count() === 1, 'quote wording is absent');
    check(await menu.getByRole('button', { name: '单独追问这段内容', exact: true }).count() === 1, 'semantic follow-up wording is absent');
    return menu;
  };
  const selectSource = (id, text = selectedText) => selectMessage(`${id}-answer`, text);
  const outbox = () => page.evaluate(() => window.articleSelectionExtensionFixture.readOutbox());
  const assertModelReference = request => {
    const contents = JSON.stringify(request.payload.messages);
    check(contents.includes(selectedText) && contents.includes('metadata 是什么，有哪些用途？'), 'model omitted the exact quote or original question');
    check(contents.includes('存储时不参与向量化') && contents.includes('过滤与引用'), 'model omitted source-answer context');
    check(!contents.includes('UNRELATED_CACHED_PAGE_SENTINEL') && !contents.includes('UNRELATED_LIVE_PAGE_SENTINEL'), 'model received unrelated browser-page body');
  };
  const assertModelAnnotations = (request, expected) => {
    const texts = request.payload.messages.flatMap(message => typeof message.content === 'string'
      ? [message.content] : (message.content || []).filter(part => part.type === 'text').map(part => part.text));
    const envelopes = texts.flatMap(content => content.split('\n').flatMap(line => {
      try {
        const data = JSON.parse(line);
        return data.source === 'conversation' && data.sourceVersion === 2 ? [data] : [];
      } catch { return []; }
    }));
    check(envelopes.length === 1 && envelopes[0].annotations?.length === 2, 'the model did not receive one two-annotation envelope');
    const envelope = envelopes[0], serialized = texts.join('\n');
    check(envelope.conversationId === expected.conversationId, 'the annotation envelope changed its conversation source');
    envelope.annotations.forEach((annotation, index) => {
      const persisted = expected.annotations[index];
      check(annotation.number === index + 1 && annotation.id === persisted.id, 'model annotations lost their ordered IDs');
      check(annotation.comment === persisted.comment && annotation.selectedText === persisted.text,
        'the model received an old comment or incorrect selected text');
      check(annotation.originalQuestion === 'metadata 是什么，有哪些用途？' && annotation.heading === '一、metadata 是什么',
        'the model omitted the captured original question or section heading');
      check(annotation.surroundingContext === persisted.context, 'the model changed the captured adjacent context');
      check(serialized.split(JSON.stringify(annotation.comment)).length - 1 === 1,
        'the model received a repeated annotation comment');
      check(serialized.split(JSON.stringify(annotation.surroundingContext)).length - 1 === 1,
        'the model received a repeated full annotation context');
    });
    check(!serialized.includes(firstComment) && !serialized.includes(secondComment), 'removed or edited annotation text remained in the model request');
  };
  const assertNoPageRead = async () => {
    const messages = await page.evaluate(() => window.articleSelectionExtensionFixture.browserMessages);
    check(!messages.some(message => /^EXTRACT_|^CAPTURE_|^NETWORK_READING_START/.test(message.type)), `chat reference performed a browser read: ${JSON.stringify(messages)}`);
    return messages.filter(message => message.type === 'GET_PAGE_SELECTION').length;
  };
  try {
    await page.setViewportSize({ width: 650, height: 900 });
    sourcePage = await context.newPage();
    await sourcePage.goto(`https://${sourceHost}/unrelated`);

    const quoteSource = await seed(`article-selection-quote-source-${Date.now()}`);
    const bundle = await openBuiltSidepanel(quoteSource.id);
    const draft = page.locator('#article-quote-draft');
    const quoteRows = () => page.evaluate(() => [...document.querySelectorAll('#article-quote-draft .article-quote-item')]
      .map(row => ({ id: row.dataset.quoteId, text: row.querySelector('.article-quote-text')?.textContent,
        comment: row.querySelector('.article-quote-comment')?.textContent })));
    const addQuote = async (text, comment) => {
      const quoteMenu = await selectSource(quoteSource.id, text);
      await quoteMenu.getByRole('button', { name: '引用到当前对话', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '添加引用注释', exact: true });
      await editor.waitFor({ state: 'visible' });
      check((await editor.locator('.article-quote-editor-preview').innerText()).includes(text), 'quote editor lost its fixed selected text');
      await editor.getByRole('textbox', { name: '引用注释', exact: true }).fill(comment);
      if (comment === firstComment) await page.screenshot({ path: 'output/playwright/article-selection-extension-annotation-editor.png' });
      await editor.getByRole('button', { name: '添加引用注释', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
    };
    await page.locator('#message-input').fill(mainQuestion);
    await addQuote(selectedText, firstComment);
    await addQuote(secondSelectedText, secondComment);
    await draft.waitFor({ state: 'visible' });
    check(await draft.getByRole('button', { name: '2 条引用注释', exact: true }).count() === 1, 'composer did not collect two current-conversation annotations');
    check(!await page.locator('#selection-chip').isVisible(), 'the legacy single selection chip duplicated the annotation draft');
    check(await page.locator('#message-input').inputValue() === mainQuestion, 'adding annotations overwrote the existing question draft');
    const initialQuotes = await quoteRows();
    check(initialQuotes.length === 2 && initialQuotes[0].comment === firstComment && initialQuotes[1].comment === secondComment,
      'two selected passages did not retain their distinct comments');
    check(streamCount === 0 && !(await outbox()).some(record => record.id === quoteSource.id),
      'preparing annotation drafts ran the model or saved a new conversation');

    const initialToggle = draft.getByRole('button', { name: '2 条引用注释', exact: true });
    if (await initialToggle.getAttribute('aria-expanded') !== 'true') await initialToggle.click();
    await draft.getByRole('button', { name: '修改第 1 条引用注释', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '修改引用注释', exact: true });
    await editor.waitFor({ state: 'visible' });
    check(await editor.getByRole('textbox', { name: '引用注释', exact: true }).inputValue() === firstComment,
      'editing an annotation did not restore its existing comment');
    await editor.getByRole('textbox', { name: '引用注释', exact: true }).fill(editedFirstComment);
    await editor.getByRole('button', { name: '修改引用注释', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
    check((await quoteRows())[0].id === initialQuotes[0].id && (await quoteRows())[0].comment === editedFirstComment,
      'editing a comment added a duplicate or failed to replace its text');
    await draft.getByRole('button', { name: '移除第 2 条引用注释', exact: true }).click();
    check((await quoteRows()).length === 1, 'removing a selected annotation did not update the draft');
    await addQuote(secondSelectedText, replacementSecondComment);
    const finalQuotes = await quoteRows();
    check(finalQuotes.length === 2 && finalQuotes[0].id === initialQuotes[0].id && finalQuotes[1].id !== initialQuotes[1].id,
      're-adding a removed passage reused a consumed annotation or changed the first owner');
    check(finalQuotes[0].comment === editedFirstComment && finalQuotes[1].comment === replacementSecondComment,
      'the final draft contains an edited or removed old comment');
    const toggle = draft.getByRole('button', { name: '2 条引用注释', exact: true });
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    await page.locator(`#messages > .assistant-message[data-message-id="${quoteSource.id}-answer"]`).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.article-quote-markers .article-quote-marker').length === 2);
    check((await page.locator('.article-quote-marker').allTextContents()).sort().join(',') === '1,2',
      'the two selected passages did not show stable numbered markers');
    await page.screenshot({ path: 'output/playwright/article-selection-extension-annotation-draft.png' });
    await sourcePage.bringToFront();
    await page.waitForTimeout(1300);
    check(await draft.isVisible() && sameContent(await quoteRows(), finalQuotes), 'native page-selection polling cleared or changed the edited annotation bundle');
    check(await page.locator('#message-input').inputValue() === mainQuestion, 'native selection polling changed the question draft');
    await page.bringToFront();
    await page.locator('#send-message').click();
    await page.waitForFunction(reply => [...document.querySelectorAll('#messages .assistant-message [data-message-content]')]
      .some(node => node.textContent.includes(reply)), mainReply);
    const firstStream = modelRequests.find(request => request.stream);
    check(firstStream && streamCount === 1, 'main quote did not produce one ordinary answer request');
    assertModelReference(firstStream);
    await page.waitForFunction(async question => {
      const saved = (await chrome.storage.local.get('temporaryConversation')).temporaryConversation;
      return saved?.messages.some(message => message.displayContent === question && message.selection?.sourceVersion === 2)
        && saved.messages.at(-1)?.role === 'assistant' && saved.messages.at(-1)?.status === 'complete';
    }, mainQuestion);
    const afterMain = await storedTemporary();
    const quotedUser = afterMain.messages.find(message => message.displayContent === mainQuestion);
    check(quotedUser?.selection?.source === 'conversation' && quotedUser.selection.conversationId === quoteSource.id, 'saved main question lost its fixed conversation source');
    check(quotedUser.selection.sourceVersion === 2 && quotedUser.selection.annotations?.length === 2
      && quotedUser.selection.revision >= 5, 'temporary storage lost the revised two-annotation bundle');
    check(sameContent(quotedUser.selection.annotations.map(annotation => ({ id: annotation.id, text: annotation.text, comment: annotation.comment })), finalQuotes),
      'temporary storage changed the annotation IDs, selected passages or final comments');
    check(sameContent(afterMain.messages.slice(0, 2), quoteSource.messages), 'annotated submission changed the original question or source answer');
    check(afterMain.messages.filter(message => message.role === 'user').length === 2
      && afterMain.messages.filter(message => message.role === 'assistant').length === 2, 'two annotations caused duplicate main turns');
    assertModelAnnotations(firstStream, quotedUser.selection);
    check(quotedUser.pageContextEnabled === false && !quotedUser.pageSource, 'conversation quote was misclassified as a browser-page turn');
    await draft.waitFor({ state: 'hidden' });
    check(await page.locator('.article-quote-marker').count() === 0, 'submitted annotations remained as an unsent draft');
    const quotePollingRequests = await assertNoPageRead();

    // Exercise the normal temporary-to-local promotion, rather than adding an
    // alternate persistence path just for annotations. The only extra seed
    // allowance is this exact empty draft ID created by our own UI action.
    await page.waitForFunction(() => document.querySelector('#new-chat')?.disabled === false);
    await page.locator('#new-chat').click();
    const ownedNewDraft = await worker.evaluate(async previousId => {
      const deadline = Date.now() + 5000;
      do {
        const saved = (await chrome.storage.local.get('temporaryConversation')).temporaryConversation;
        if (saved?.id && saved.id !== previousId && saved.messages?.length === 0) return saved;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error('The extension did not finish creating its own empty temporary draft.');
    }, quoteSource.id);
    check(ownedNewDraft?.id && ownedNewDraft.id !== quoteSource.id && ownedNewDraft.messages.length === 0,
      'the isolated promotion scenario did not create its own empty temporary draft');
    ownedNewTemporaryId = ownedNewDraft.id;
    await page.waitForFunction(async id => (await window.articleSelectionExtensionFixture.readOutbox())
      .some(record => record.id === id && record.conversation.storage === 'local'), quoteSource.id);
    const promotedMain = (await outbox()).find(record => record.id === quoteSource.id)?.conversation;
    const promotedUser = promotedMain?.messages.find(message => message.id === quotedUser.id);
    check(promotedUser?.selection?.sourceVersion === 2 && sameContent(promotedUser.selection.annotations, quotedUser.selection.annotations),
      'normal outbox promotion lost the saved annotation bundle');
    check(streamCount === 1, 'saving annotations or promotion started another main model request');

    // Start a distinct scenario so the earlier main quote cannot supply hidden
    // context or change this new floating conversation's storage assertions.
    await page.goto('about:blank');
    const floatingSource = await seed('article-selection-floating-source');
    await openBuiltSidepanel(floatingSource.id);
    const beforeEmpty = await outbox(), streamsBeforeEmpty = streamCount;
    const emptyMenu = await selectSource(floatingSource.id);
    await emptyMenu.getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    const floating = page.locator('.selection-chat-window');
    await floating.waitFor({ state: 'visible' });
    const emptyId = await floating.getAttribute('data-conversation-id');
    check(emptyId && emptyId !== floatingSource.id, 'floating window does not own a new conversation ID');
    check((await floating.locator('.selection-chat-storage').innerText()).includes('未分组'), 'empty follow-up inherited the source group');
    await floating.getByRole('button', { name: '关闭追问窗口', exact: true }).click();
    await floating.waitFor({ state: 'detached' });
    await page.waitForTimeout(550);
    check(JSON.stringify((await outbox()).map(record => record.id).sort()) === JSON.stringify(beforeEmpty.map(record => record.id).sort()), 'closing an empty floating chat saved a history record');
    check(streamCount === streamsBeforeEmpty, 'opening an empty chat performed a model request');
    const afterEmpty = await storedTemporary();
    check(afterEmpty?.id === floatingSource.id && sameContent(afterEmpty.messages, floatingSource.messages), 'empty floating chat cleared or changed the main temporary conversation');

    const askMenu = await selectSource(floatingSource.id);
    await askMenu.getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    await floating.waitFor({ state: 'visible' });
    const floatingId = await floating.getAttribute('data-conversation-id');
    check(floatingId && ![floatingSource.id, emptyId].includes(floatingId), 'a new floating window reused another conversation ID');
    await floating.locator('textarea').fill('为什么 metadata 不参与向量化？');
    await floating.getByRole('button', { name: '收起追问窗口', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'docked');
    const reuseMenu = await selectSource(floatingSource.id);
    await reuseMenu.getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'expanded');
    check(await floating.count() === 1 && await floating.getAttribute('data-conversation-id') === floatingId,
      'repeated source selection created another follow-up instead of reusing the first');
    check(await floating.locator('textarea').inputValue() === '为什么 metadata 不参与向量化？', 'reusing the branch lost its existing question draft');
    check((await floating.locator('.selection-chat-feedback').innerText()).includes('继续使用'), 'reuse notice is missing');
    await floating.locator('textarea').fill('为什么 metadata 不参与向量化？');
    await floating.getByRole('button', { name: '发送追问', exact: true }).click();
    await waitBounded(floatingRequestStarted, 'the floating model request did not start');
    await floating.getByRole('button', { name: '收起追问窗口', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'docked');
    check(await page.locator('.selection-chat-launcher[data-busy="true"]').isVisible(), 'busy collapsed branch lost its running indicator');
    const busyLauncher = await page.locator('.selection-chat-launcher').evaluate(node => ({
      unread: node.dataset.unread, ring: getComputedStyle(node, '::before').display,
      dot: getComputedStyle(node, '::after').display, animation: getComputedStyle(node, '::before').animationName,
    }));
    check(busyLauncher.unread === 'false' && busyLauncher.ring !== 'none'
      && busyLauncher.dot === 'none' && busyLauncher.animation !== 'none', 'built extension did not show busy animation without an unread dot');
    const pendingMenu = await selectSource(floatingSource.id, secondSelectedText);
    await pendingMenu.getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'expanded');
    check(await floating.count() === 1 && await floating.getAttribute('data-conversation-id') === floatingId,
      'busy selection created a competing branch');
    check((await floating.locator('blockquote').first().innerText()).includes(secondSelectedText)
      && (await floating.locator('.selection-chat-feedback').innerText()).includes('下一问'), 'pending reference notice is missing');
    await page.waitForFunction(async id => (await window.articleSelectionExtensionFixture.readOutbox())
      .some(record => record.id === id && record.conversation.messages.some(message => message.role === 'user' && !message.optimistic)), floatingId);
    await floating.getByRole('button', { name: '停止追问', exact: true }).waitFor({ state: 'visible' });
    await page.locator('#open-history').click();
    await page.waitForFunction(id => Boolean(document.querySelector(`.ho-group[data-group-id="none"] [data-open-chat="${id}"]`)), floatingId);
    const historyEntry = page.locator(`.ho-group[data-group-id="none"] [data-open-chat="${floatingId}"]`);
    await historyEntry.click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-feedback:not([hidden])')?.textContent.includes('等待'));
    check(await floating.isVisible() && await floating.getAttribute('data-conversation-id') === floatingId, 'opening a busy history entry released its floating owner');
    check(await floating.getByRole('button', { name: '停止追问', exact: true }).isVisible(), 'opening busy history ended the original floating run');
    check(await page.locator(`#messages [data-message-id="${floatingSource.id}-answer"]`).count() === 1
      && await page.locator('#messages .user-message').count() === 1
      && await page.locator('#messages .assistant-message').count() === 1, 'opening busy floating history replaced or duplicated the main conversation');
    const afterBusyHistory = await storedTemporary();
    check(afterBusyHistory?.id === floatingSource.id && sameContent(afterBusyHistory.messages, floatingSource.messages), 'opening busy floating history changed the main temporary conversation');
    check(!(await floating.locator('.selection-chat-messages').innerText()).includes(floatingReply), 'the deferred floating reply finished before the busy-history assertion');
    await page.screenshot({ path: 'output/playwright/article-selection-extension-busy-history.png' });
    await floating.getByRole('button', { name: '收起追问窗口', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'docked');
    releaseFloatingReply();
    await page.waitForFunction(reply => document.querySelector('.selection-chat-messages')?.textContent.includes(reply), floatingReply);
    await page.waitForFunction(async id => (await window.articleSelectionExtensionFixture.readOutbox())
      .some(record => record.id === id && record.conversation.messages.some(message => message.role === 'assistant' && message.status === 'complete')), floatingId);
    await page.waitForFunction(() => document.querySelector('.selection-chat-launcher')?.dataset.unread === 'true');
    check(await page.locator('.selection-chat-launcher').evaluate(node => getComputedStyle(node, '::after').display !== 'none'
      && getComputedStyle(node, '::before').display === 'none'), 'built extension completion did not replace the busy ring with an unread dot');
    await page.screenshot({ path: 'output/playwright/followup-activity-extension-unread.png' });
    await page.locator('.selection-chat-launcher').click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'expanded'
      && document.querySelector('.selection-chat-launcher')?.dataset.unread === 'false');
    await floating.getByRole('button', { name: '收起追问窗口', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'docked');
    check(await page.locator('.selection-chat-launcher').evaluate(node => node.dataset.unread === 'false'
      && getComputedStyle(node, '::after').display === 'none'), 'reopening and collapsing revived a read completion in the built extension');
    await page.locator('.selection-chat-launcher').click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'expanded');
    const storedFloating = (await outbox()).find(record => record.id === floatingId);
    check(storedFloating?.conversation.storage === 'local', 'floating question did not commit to the real browser outbox');
    const floatingUser = storedFloating.conversation.messages.find(message => message.role === 'user');
    const floatingAssistant = storedFloating.conversation.messages.find(message => message.role === 'assistant');
    check(floatingUser.selection?.conversationId === floatingSource.id && floatingUser.selection?.messageId === `${floatingSource.id}-answer`, 'floating source changed to the visible webpage');
    check(floatingUser.selection.text === selectedText, 'a new busy selection overwrote the submitted quote snapshot');
    assertModelReference(modelRequests.filter(request => request.stream).at(-1));
    const beforeReplace = await storedTemporary();
    check(beforeReplace?.id === floatingSource.id && sameContent(beforeReplace.messages, floatingSource.messages), 'floating answer altered the main conversation');
    check(await page.locator('#messages .user-message').count() === 1 && await page.locator('#messages .assistant-message').count() === 1, 'floating answer appeared as a second main reply');
    await page.waitForFunction(() => Boolean(document.querySelector('.selection-chat-send[aria-label="发送追问"]'))
      && document.querySelector('.selection-chat-replace')?.disabled === false);
    await historyEntry.waitFor({ state: 'visible' });
    const organization = await worker.evaluate(async () => (await chrome.storage.local.get('conversationOrganization')).conversationOrganization);
    check(!Object.hasOwn(organization.assignments, floatingId), 'floating chat inherited a group assignment');
    await page.screenshot({ path: 'output/playwright/article-selection-extension-floating-history.png' });

    await historyEntry.click();
    await page.waitForFunction(({ id, reply }) => !document.querySelector('.selection-chat-window')
      && document.querySelector(`#messages [data-message-id="${id}"] [data-message-content]`)?.textContent.includes(reply),
    { id: floatingAssistant.id, reply: floatingReply });
    const afterReplace = await storedTemporary();
    check(afterReplace?.id === floatingSource.id && sameContent(afterReplace.messages, floatingSource.messages), 'replace cleared the original temporary conversation');
    check((await page.locator('#conversation-title').innerText()).includes('为什么 metadata'), 'main chat did not adopt the floating conversation title');
    check(await page.locator(`#messages > .message[data-message-id="${floatingUser.id}"]`).count() === 1
      && await page.locator(`#messages > .message[data-message-id="${floatingAssistant.id}"]`).count() === 1
      && await page.locator('#messages .user-message').count() === 1
      && await page.locator('#messages .assistant-message').count() === 1, 'idle history transfer duplicated the floating turn in the main application');
    check((await outbox()).some(record => record.id === floatingId), 'replace lost the saved floating conversation');
    const floatingPollingRequests = await assertNoPageRead();
    check(errors.length === 0, `extension page errors: ${JSON.stringify(errors)}`);
    check(streamCount === 2, 'selection flows issued duplicate ordinary answer requests');
    await page.screenshot({ path: 'output/playwright/article-selection-extension-replaced-main.png' });
    const branchMenu = await selectMessage(floatingAssistant.id, floatingReply);
    await branchMenu.getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    await floating.waitFor({ state: 'visible' });
    const detachedId = await floating.getAttribute('data-conversation-id');
    await floating.getByRole('button', { name: '收起追问窗口', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.dockState === 'docked');
    await page.locator('#new-chat').click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window')?.dataset.detached === 'true');
    check((await page.locator('.selection-chat-scope').innerText()).includes('新的选区'), 'new main conversation did not show a detachment notice');
    await page.locator('#open-history').click();
    await page.locator(`[data-open-chat="${floatingId}"]`).click();
    await page.locator(`#messages [data-message-id="${floatingAssistant.id}"]`).waitFor({ state: 'visible' });
    const returnedMenu = await selectMessage(floatingAssistant.id, floatingReply);
    await returnedMenu.getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    const fresh = page.locator('.selection-chat-window').filter({ has: page.locator('.selection-chat-scope:not([title])') });
    const freshId = await fresh.getAttribute('data-conversation-id');
    check(freshId && freshId !== detachedId && await floating.count() === 2,
      'returning to the previous main revived its detached tracking session');
    await fresh.getByRole('button', { name: '关闭追问窗口', exact: true }).click();
    await page.locator('.selection-chat-launcher').click();
    const detached = page.locator(`.selection-chat-window[data-conversation-id="${detachedId}"]`);
    await page.waitForFunction(id => document.querySelector(`.selection-chat-window[data-conversation-id="${id}"]`)?.dataset.dockState === 'expanded', detachedId);
    check(await detached.getByRole('textbox', { name: '输入追问' }).isEnabled(), 'detached follow-up cannot continue independently');
    await detached.getByRole('button', { name: '关闭追问窗口', exact: true }).click();
    check(!(await outbox()).some(record => [freshId, detachedId].includes(record.id)), 'empty detached or fresh branches entered history');
    check(errors.length === 0 && streamCount === 2, 'session tracking introduced a page error or duplicate request');
    return { passed: true, environment: 'Actual dist in isolated Chromium extension tabs; real temporary storage, outbox and grouped history; all external traffic intercepted',
      bundle, mainQuote: { exactQuoteAndContext: true, annotationCount: 2, numberedMarkers: 2, existingQuestionDraftRetained: true,
        editedCommentRetained: true, removedAndReaddedSecond: true, annotationsSavedToTemporary: true,
        annotationsPromotedToRealOutbox: true, singleModelEnvelope: true, retainedAfterPollingMs: 1300,
        browserSelectionRequests: quotePollingRequests, noPageBodyRead: true },
      emptyFloating: { independentId: emptyId, noModelRequest: true, noOutboxWrite: true, sourceTemporaryUnchanged: true },
      answeredFloating: { conversationId: floatingId, savedToRealOutbox: true, ungroupedHistory: true, mainUnchanged: true, browserSelectionRequests: floatingPollingRequests },
      historyTransfer: { busyEntryBlocked: true, busyFloatingOwnerRetained: true, busyMainUnchanged: true,
        idleEntryTransferred: true, floatingWindowClosed: true, mainTurnCount: 1 },
      followupSession: { sameMainReused: true, busyCollapseContinues: true, busyReferenceHeldForNextQuestion: true,
        busyAnimationWithoutUnread: true, completionUnreadDot: true, expandAndRecollapseAcknowledged: true,
        submittedReferenceUnchanged: true, newMainDetaches: true, returningMainStartsFresh: true, detachedStillUsable: true, emptyBranchesUnsaved: true },
      replace: { trigger: 'history-entry', adoptedMainAssistantId: floatingAssistant.id, sourceTemporaryRetained: true, existingHistoryRetained: true },
      modelRequests: { main: streamCount, auxiliary: modelRequests.filter(request => !request.stream).length }, pageErrors: errors, blockedExternalRequests: blockedRequests.length };
  } finally {
    releaseFloatingReply();
    await context.unroute('**/*', routeHandler);
    page.off('pageerror', onPageError);
    if (sourcePage && !sourcePage.isClosed()) await sourcePage.close();
  }
}
