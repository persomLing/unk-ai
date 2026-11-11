// Load the current dist in a fresh isolated Chromium profile, then run with
// playwright-cli run-code --filename tests/browser/long-text-extension.js.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const context = page.context();
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const host = 'model.long-text.fixture.test';
  const requests = [], errors = [];
  let releaseFirst;
  const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const routeModel = async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== host) {
      return ['chrome-extension:', 'about:', 'data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    }
    const payload = route.request().postDataJSON();
    if (!payload.stream) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }] }) });
    requests.push(payload);
    if (requests.length === 1) await firstReleased;
    const chunks = [
      { choices: [{ delta: { role: 'assistant', content: '本地长文本回归回答。完整文字保留在原用户消息中。' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n' });
  };
  await context.route('**/*', routeModel);
  try {
    await worker.evaluate(async () => {
      const previous = await chrome.storage.local.get(['providerConfig', 'temporaryConversation']);
      if (previous.providerConfig || previous.temporaryConversation) throw new Error('A fresh isolated profile is required.');
      const time = new Date().toISOString();
      await chrome.storage.local.set({ providerConfig: { version: 4, endpointUrl: 'https://model.long-text.fixture.test/v1',
        apiKey: 'fixture-only', selectedModelId: 'long-text-fixture', webSearchEnabled: false,
        models: [{ id: 'long-text-fixture', name: '本地测试', contextLength: 32000, maxOutputTokens: 1000, supportsVision: false, supportsReasoning: false }] },
        temporaryConversation: { version: 2, id: 'long-text-fixture', storage: 'temporary', title: '长文本交互回归', createdAt: time, updatedAt: time,
          messages: [{ id: 'seed-user', role: 'user', content: '开始本地测试。', createdAt: time },
            { id: 'seed-answer', role: 'assistant', status: 'complete', content: '这段测试回答用于独立追问。', createdAt: time }] } });
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/sidepanel/index.html`);
    await page.waitForFunction(() => document.querySelector('#message-input')?.readOnly === false);
    const input = page.locator('#message-input');
    const paste = async (target, text) => target.evaluate((element, text) => {
      element.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, text);
    const first = Array.from({ length: 30 }, (_, i) => `  const item${i} = "保留空格与原文 <tag> & 引号";\n`).join('');
    const second = Array.from({ length: 22 }, (_, i) => `下一轮代码 ${i}：排队时保留完整文字。\n`).join('');
    const prefix = '请核对下面的代码：\n';
    const suffix = '\n请逐条解释。';
    await input.fill(prefix);
    await input.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await paste(input, first);
    check(await page.locator('#pasted-text-list .pasted-text-card').count() === 1, 'Long paste did not create a card.');
    check(await input.inputValue() === prefix, 'The folded text still fills the textarea.');
    await page.locator('#pasted-text-list .pasted-text-open').click();
    check(await page.locator('.text-preview-content').textContent() === first, 'Pasted preview changed the full text.');
    await page.screenshot({ path: 'output/playwright/long-text-paste-preview.png' });
    await page.keyboard.press('Escape');
    await page.locator('#pasted-text-list .pasted-text-edit').click();
    check(await input.inputValue() === prefix + first, 'Editing lost pasted text.');
    await paste(input, first); // Editing selected only this original pasted span.
    await input.focus();
    await page.keyboard.insertText(suffix);
    await page.screenshot({ path: 'output/playwright/long-text-draft-card.png' });
    const expectedFirst = (prefix + first + suffix).trim();
    await page.locator('#send-message').click();
    await page.waitForFunction(() => document.querySelector('#messages .user-text-preview.is-collapsed'));
    check(await page.locator('#pasted-text-list .pasted-text-card').count() === 0, 'Submission left the old card in the next draft.');
    await paste(input, second);
    await page.locator('#send-message').click();
    await page.waitForFunction(() => !document.querySelector('#queue-bar').hidden);
    check(await page.locator('#pasted-text-list .pasted-text-card').count() === 0, 'Queueing left a stale pasted span.');
    releaseFirst();
    await page.waitForFunction(() => document.querySelectorAll('#messages .assistant-message').length === 3 && document.querySelector('#stop-generation').hidden, null, { timeout: 20000 });
    const conversation = await worker.evaluate(async () => (await chrome.storage.local.get('temporaryConversation')).temporaryConversation);
    const users = conversation.messages.filter(message => message.role === 'user');
    check(users.length === 3 && users[1].content === expectedFirst && users[2].content === second.trim(), 'Saved user text differs from the complete drafts.');
    check(requests.length === 2, 'The main requests were duplicated.');
    const userPayload = value => value.messages.filter(message => message.role === 'user').at(-1).content;
    const includesText = (payload, value) => typeof payload === 'string' ? payload.includes(value) : payload.some(part => part.type === 'text' && part.text.includes(value));
    check(includesText(userPayload(requests[0]), expectedFirst) && includesText(userPayload(requests[1]), second.trim()), 'The model did not receive complete user content.');
    const firstMessage = page.locator(`#messages article[data-message-id="${users[1].id}"]`);
    await firstMessage.locator('.user-text-preview').click();
    check(await page.locator('.text-preview-content').textContent() === expectedFirst, 'Sent-message popup omitted text.');
    await page.screenshot({ path: 'output/playwright/long-text-message-preview.png' });
    await page.keyboard.press('Escape');
    await firstMessage.hover();
    await firstMessage.locator('[data-action="rewind"]').click();
    await page.waitForFunction(value => document.querySelector('#message-input').value === value, expectedFirst);
    check(await input.inputValue() === expectedFirst, 'Rewind did not restore the full original question.');
    await page.locator('#messages article[data-message-id="seed-answer"]').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const body = document.querySelector('#messages article[data-message-id="seed-answer"] [data-message-content]');
      const range = document.createRange();
      range.selectNodeContents(body.querySelector('p') || body);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('.article-selection-menu').getByRole('button', { name: '单独追问这段内容', exact: true }).click();
    const floating = page.locator('.selection-chat-window');
    const floatingInput = floating.locator('textarea');
    await paste(floatingInput, second);
    check(await floating.locator('.pasted-text-card').count() === 1, 'Follow-up composer did not fold pasted text.');
    await floating.locator('.pasted-text-open').click();
    check(await page.locator('.text-preview-content').textContent() === second, 'Follow-up card lost text.');
    await page.keyboard.press('Escape');
    await floating.locator('.selection-chat-send').click();
    await page.waitForFunction(() => document.querySelector('.selection-chat-window .assistant-message') && document.querySelector('.selection-chat-send')?.title === '发送追问');
    check(requests.length === 3 && includesText(userPayload(requests[2]), second.trim()), 'Follow-up request lost or duplicated the full draft.');
    await floating.locator('.user-text-preview.is-collapsed').click();
    check(await page.locator('.text-preview-content').textContent() === second.trim(), 'Follow-up message cannot open its complete text.');
    await page.keyboard.press('Escape');
    await paste(floatingInput, first);
    await floating.evaluate(element => { element.style.width = '280px'; element.style.height = '260px'; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(await floating.evaluate(element => {
      const outer = element.getBoundingClientRect(), send = element.querySelector('.selection-chat-send').getBoundingClientRect();
      return send.bottom <= outer.bottom && send.right <= outer.right;
    }), 'Pasted card hid the send button in a small follow-up window.');
    await page.screenshot({ path: 'output/playwright/long-text-followup-small.png' });
    await floating.locator('.selection-chat-close').click();
    check(await input.inputValue() === expectedFirst, 'Follow-up paste changed the main draft.');
    check(errors.length === 0, `Page errors: ${errors.join(', ')}`);
    return { passed: true, mainRequests: requests.length, preservedCharacters: expectedFirst.length + second.trim().length,
      pastedCard: true, fullPreview: true, editAndRefold: true, queueSnapshot: true, savedText: true, rewind: true,
      followupPaste: true, smallFollowupLayout: true, pageErrors: errors };
  } finally {
    releaseFirst();
    page.off('pageerror', onError);
    await context.unroute('**/*', routeModel);
  }
}
