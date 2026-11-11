// Open tests/browser/text-preview.html on loopback, then run with playwright-cli.
async (page) => {
  const parsed = new URL(page.url());
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/tests/browser/text-preview.html') throw new Error('Open the isolated text-preview fixture first.');
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  const check = (value, message) => { if (!value) throw new Error(message); };
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const dialog = page.locator('.text-preview-dialog');
  const long = page.locator('[data-message-id="long"] .user-text-preview');
  const fullText = await page.evaluate(() => window.textPreviewFixture.messages[0].content);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layouts = [];
  try {
    for (const width of [320, 544, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await settle();
      const layout = await long.evaluate(element => {
        const body = element.querySelector('[data-text-preview-content]');
        const styles = getComputedStyle(body);
        return { collapsed: element.classList.contains('is-collapsed'), height: body.getBoundingClientRect().height,
          lineHeight: parseFloat(styles.lineHeight), fullHeight: body.scrollHeight,
          role: element.getAttribute('role'), documentWidth: document.documentElement.scrollWidth };
      });
      check(layout.collapsed && layout.role === 'button', `${width}: long message lacks full-text activation`);
      check(layout.height <= layout.lineHeight * 5 + 1 && layout.fullHeight > layout.height, `${width}: long text is not clipped to five lines`);
      check(layout.documentWidth <= width, `${width}: document overflow`);
      check(await page.locator('[data-message-id="short"] .user-text-preview').count() === 0, 'short question should keep its normal markup');
      await long.click();
      await dialog.waitFor({ state: 'visible' });
      check(await dialog.locator('.text-preview-content').textContent() === fullText, `${width}: preview lost text or whitespace`);
      check(await dialog.locator('.text-preview-content script').count() === 0, `${width}: text was interpreted as HTML`);
      const box = await dialog.boundingBox();
      check(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 901, `${width}: dialog is outside the screen`);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      check(await long.evaluate(element => document.activeElement === element), `${width}: focus was not restored`);
      layouts.push({ width, ...layout });
    }
    // The same text is long at a narrow width and fully visible at a wide width.
    const responsive = page.locator('[data-message-id="responsive"] .user-text-preview');
    await page.setViewportSize({ width: 320, height: 900 });
    await settle();
    check(await responsive.evaluate(element => element.classList.contains('is-collapsed')), 'narrow text should collapse');
    await page.setViewportSize({ width: 960, height: 900 });
    await settle();
    check(await responsive.getAttribute('data-text-preview') === null, 'wide text that fits should not keep a false expand control');

    await page.setViewportSize({ width: 544, height: 900 });
    await settle();
    await long.focus();
    await long.press('Space');
    await dialog.waitFor({ state: 'visible' });
    await page.evaluate(() => window.textPreviewFixture.redraw());
    check(await dialog.locator('.text-preview-content').textContent() === fullText, 'same-conversation redraw changed the open snapshot');
    await dialog.getByRole('button', { name: '关闭文本预览' }).click();
    check(await page.locator('#fallback').evaluate(element => document.activeElement === element), 'detached trigger should restore the fallback input');

    // Selecting visible text does not accidentally open the modal on mouseup.
    const body = long.locator('[data-text-preview-content]');
    await body.evaluate(element => {
      const range = document.createRange();
      range.setStart(element.firstChild, 0);
      range.setEnd(element.firstChild, 12);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    check(await dialog.count() === 0, 'selecting a piece of the question opened a modal');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    for (const action of ['copy-user', 'rewind']) {
      await page.locator('.user-message[data-message-id="long"]').hover();
      await page.locator(`[data-message-id="long"] [data-action="${action}"]`).click();
      check(await dialog.count() === 0, `${action} opened text preview`);
    }
    const events = await page.evaluate(() => window.textPreviewFixture.events);
    check(events.length === 2 && events.every(event => event.content === fullText), 'copy or rewind stopped receiving full original content');

    await long.click();
    await page.screenshot({ path: 'output/playwright/text-preview-light.png', animations: 'disabled' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: 'output/playwright/text-preview-dark.png', animations: 'disabled' });
    await page.evaluate(() => window.textPreviewFixture.switchConversation());
    check(await dialog.count() === 0, 'conversation switch did not close the preview');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: 'output/playwright/text-preview-collapsed.png', animations: 'disabled' });
    check(await page.evaluate(() => window.textPreviewFixture.unchanged() && !window.injected && window.textPreviewFixture.errors.length === 0), 'preview changed data or executed text');
    check(errors.length === 0, `page errors: ${errors.join(', ')}`);
    return { passed: true, layouts, fullTextPreserved: true, measuredOverflow: true, keyboard: true, selectionPreserved: true,
      copyAndRewindUnaffected: true, sameConversationPreserved: true, switchedConversationClosed: true, pageErrors: errors };
  } finally {
    page.off('pageerror', onError);
  }
}
