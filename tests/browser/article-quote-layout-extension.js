// Run after article-selection-chat-extension.js in its isolated fixture profile.
// Checks only the built UI and never sends a model request.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const context = page.context();
  const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  check(worker && page.url().startsWith('chrome-extension://'), 'Open the isolated extension fixture first.');
  const safe = await worker.evaluate(async () => {
    const config = (await chrome.storage.local.get('providerConfig')).providerConfig;
    return config?.endpointUrl === 'https://model.article-selection.fixture.test/v1';
  });
  check(safe, 'This layout regression requires the isolated local model fixture.');
  const block = route => ['http:', 'https:'].includes(new URL(route.request().url()).protocol)
    ? route.abort('blockedbyclient') : route.continue();
  await context.route('**/*', block);
  try {
    const original = await page.evaluate(async () => (await window.articleSelectionExtensionFixture.readOutbox())
      .find(record => record.id.startsWith('article-selection-quote-source-'))?.conversation);
    check(original, 'The annotated source conversation was not promoted to the fixture outbox.');
    await page.locator('#open-history').click();
    await page.locator(`[data-open-chat="${original.id}"]`).click();
    const answer = original.messages.find(message => message.role === 'assistant');
    const source = page.locator(`#messages > .assistant-message[data-message-id="${answer.id}"]`);
    await source.waitFor({ state: 'visible' });
    const results = [];
    for (const { width, theme } of [{ width: 320, theme: 'light' }, { width: 544, theme: 'dark' }]) {
      await page.setViewportSize({ width, height: 780 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await source.scrollIntoViewIfNeeded();
      await page.evaluate(id => {
        const body = document.querySelector(`#messages > .assistant-message[data-message-id="${id}"] [data-message-content]`);
        const text = 'metadata 是每个 chunk 附带的键值对';
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && !node.nodeValue.includes(text)) {}
        if (!node) throw new Error('The exact reference source is missing.');
        const at = node.nodeValue.indexOf(text), range = document.createRange();
        range.setStart(node, at); range.setEnd(node, at + text.length);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      }, answer.id);
      const menu = page.getByRole('toolbar', { name: '选中内容操作' });
      await menu.waitFor({ state: 'visible' });
      await menu.getByRole('button', { name: '引用到当前对话', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '添加引用注释', exact: true });
      await editor.waitFor({ state: 'visible' });
      await editor.getByRole('textbox', { name: '引用注释' }).fill('这里与向量检索是什么关系？\n请结合原问题和前后文解释。');
      const layout = await editor.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          controls: [...node.querySelectorAll('textarea, button')].map(child => {
            const bounds = child.getBoundingClientRect();
            return bounds.left >= rect.left && bounds.right <= rect.right && bounds.top >= rect.top && bounds.bottom <= rect.bottom;
          }) };
      });
      check(layout.left >= 0 && layout.top >= 0 && layout.right <= width && layout.bottom <= 780
        && layout.controls.every(Boolean), `${width}/${theme}: reference editor or controls were clipped.`);
      await page.screenshot({ path: `output/playwright/article-quote-editor-${width}-${theme}.png` });
      await editor.getByRole('button', { name: '取消引用注释', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      check(!await page.locator('#article-quote-draft').isVisible(), 'Cancelling a comment added an unsent reference.');
      results.push({ width, theme, editorWithinViewport: true, controlsVisible: true, cancelledWithoutCommit: true });
    }
    return { passed: true, results, modelRequest: false };
  } finally {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await context.unroute('**/*', block);
  }
}
