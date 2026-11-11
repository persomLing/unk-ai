// Open the loopback Vite fixture tests/browser/article-selection-chat.html first.
// playwright-cli -s=article-selection run-code --filename tests/browser/article-selection-chat.js
async (page) => {
  const initialUrl = new URL(page.url());
  if (!['127.0.0.1', 'localhost'].includes(initialUrl.hostname)
    || initialUrl.pathname !== '/tests/browser/article-selection-chat.html') throw new Error('Open the isolated article-selection fixture first.');
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort('blockedbyclient'));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const quote = 'metadata 是每个 chunk 附带的键值对';
  const snapshot = () => page.evaluate(() => window.articleSelectionFixture.snapshot());
  const toolbar = page.getByRole('toolbar', { name: '选中内容操作' });
  const dialog = page.getByRole('dialog', { name: '单独追问这段内容' });
  const select = async (text = quote, options) => {
    const selected = await page.evaluate(({ text, options }) => window.articleSelectionFixture.selectText(text, options), { text, options });
    check(selected.text === text, 'The native Range did not capture the exact quote');
    await toolbar.waitFor({ state: 'visible' });
  };
  const open = async () => { await select(); await toolbar.getByRole('button', { name: '单独追问这段内容', exact: true }).click(); await dialog.waitFor({ state: 'visible' }); };
  const closed = () => dialog.waitFor({ state: 'detached' });
  const settled = () => page.waitForFunction(() => {
    const data = window.articleSelectionFixture.snapshot();
    return !data.busy && data.branch?.messages.at(-1)?.status === 'complete';
  });
  const reload = async width => {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  };
  const inside = (rect, width, height = 900) => rect.left >= 0 && rect.top >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1;
  const results = [];

  for (const width of [320, 544, 960]) {
    await reload(width);
    await select();
    check(await toolbar.getByRole('button', { name: '引用到当前对话', exact: true }).isVisible(), `${width}: quote label missing`);
    check(await toolbar.getByRole('button', { name: '单独追问这段内容', exact: true }).isVisible(), `${width}: semantic ask label missing`);
    check(inside((await snapshot()).menu, width), `${width}: selection toolbar overflowed`);
    await toolbar.getByRole('button', { name: '引用到当前对话', exact: true }).click();
    await page.getByRole('button', { name: '添加引用注释', exact: true }).click();
    let data = await snapshot();
    check(data.quotes.length === 1 && data.quotes[0].text === quote, `${width}: quote was lost`);
    check(data.quotes[0].heading === '一、metadata 是什么', `${width}: section heading was lost`);
    check(data.quotes[0].question === '请解释 metadata 在 RAG 中的用途。', `${width}: original question was lost`);
    check(data.quotes[0].context.includes('在向量库和 RAG 中') && data.quotes[0].context.includes('过滤和回溯来源'), `${width}: nearby semantics were lost`);
    check(data.answerRequests.length === 0 && data.writeCount === 0 && data.currentMainUnchanged, `${width}: merely quoting ran or saved a conversation`);
    check(data.activeElement === 'main-input', `${width}: quote did not focus main input`);
    await open();
    data = await snapshot();
    check(data.branch.id !== data.main.id && data.branch.groupId === undefined, `${width}: branch did not get a fresh ungrouped identity`);
    check(data.answerRequests.length === 0 && data.writeCount === 0, `${width}: opening an empty branch called model or saved`);
    check(inside(data.window, width), `${width}: floating window overflowed viewport`);
    await dialog.getByRole('button', { name: '关闭追问窗口' }).click(); await closed();
    data = await snapshot();
    check(data.writeCount === 0 && data.answerRequests.length === 0 && data.currentMainUnchanged, `${width}: closing an empty branch changed history`);

    await open();
    await dialog.getByRole('textbox', { name: '输入追问' }).fill('结合上下文解释这里的 metadata。');
    await dialog.getByRole('button', { name: '发送追问' }).click();
    await settled(); await page.evaluate(() => window.articleSelectionFixture.flush());
    data = await snapshot();
    check(data.answerRequests.length === 1 && data.branch.messages.length === 2, `${width}: first submit did not create exactly one turn`);
    check(data.currentMainUnchanged && data.originalRetained, `${width}: independent answer modified source conversation`);
    check(data.savedIds.includes(data.branch.id) && data.branch.groupId === undefined, `${width}: branch was not saved ungrouped`);
    const request = JSON.stringify(data.answerRequests[0].request.messages);
    check(request.includes(quote) && request.includes('在向量库和 RAG 中') && request.includes('请解释 metadata 在 RAG 中的用途。'), `${width}: model did not receive fixed semantic context`);
    check(!request.includes('UNRELATED_CURRENT_WEBPAGE') && !request.includes('PRIVATE_THOUGHT'), `${width}: unrelated data leaked into selection request`);

    const beforeDrag = data.window;
    const header = await dialog.locator('header').boundingBox();
    const dragPoint = { x: header.x + 32, y: header.y + 16 };
    await page.mouse.move(dragPoint.x, dragPoint.y); await page.mouse.down();
    await page.mouse.move(dragPoint.x + (width > 320 ? -60 : 0), dragPoint.y - 100, { steps: 10 }); await page.mouse.up();
    const afterDrag = (await snapshot()).window;
    check(afterDrag.top < beforeDrag.top - 20 && inside(afterDrag, width), `${width}: header drag did not move window safely`);
    const resizeHandle = await dialog.getByRole('button', { name: '调整窗口大小' }).boundingBox();
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2); await page.mouse.down();
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2 + (width === 320 ? -20 : 50),
      resizeHandle.y + resizeHandle.height / 2 + 60, { steps: 10 }); await page.mouse.up();
    const afterResize = (await snapshot()).window;
    check(afterResize.height > afterDrag.height + 20 && inside(afterResize, width), `${width}: corner resize did not enlarge window safely`);
    if (width > 320) check(afterResize.width > afterDrag.width + 35, `${width}: corner resize did not enlarge the window width`);
    await page.screenshot({ path: `output/playwright/article-selection-chat-${width}.png` });
    await dialog.getByRole('textbox', { name: '输入追问' }).fill('再用一个例子说明。');
    await dialog.getByRole('button', { name: '发送追问' }).click(); await settled();
    data = await snapshot();
    check(data.answerRequests.length === 2 && data.branch.messages.length === 4, `${width}: follow-up did not stay in its branch`);
    check(JSON.stringify(data.answerRequests[1].request.messages).includes('结合上下文解释这里的 metadata'), `${width}: follow-up lost branch history`);
    const branchId = data.branch.id;
    await dialog.getByRole('button', { name: '替换当前对话', exact: true }).click(); await closed();
    data = await snapshot();
    check(data.main.id === branchId && data.main.storage === 'local' && data.main.groupId === undefined, `${width}: replace did not open the saved ungrouped branch`);
    check(data.originalRetained && data.replacements.length === 1, `${width}: replace deleted source conversation`);
    check(data.errors.length === 0, `${width}: fixture reported errors: ${JSON.stringify(data.errors)}`);
    results.push({ width, quoteWithContext: true, emptyWindowUnsaved: true, firstTurnUnique: true, mainUnchangedUntilReplace: true,
      drag: { before: beforeDrag, after: afterDrag }, resize: { after: afterResize }, followUpRetained: true, replacedUngrouped: true, oldRecordRetained: true });
  }

  await reload(544); await open();
  await page.evaluate(() => window.articleSelectionFixture.holdNextAnswer());
  await dialog.getByRole('textbox', { name: '输入追问' }).fill('挂起回答用于关闭测试。');
  await dialog.getByRole('button', { name: '发送追问' }).dblclick();
  await page.waitForFunction(() => window.articleSelectionFixture.snapshot().pendingCount === 1);
  check((await snapshot()).busy, 'The second send click accidentally stopped the running answer');
  const closingBranch = (await snapshot()).branch.id;
  await dialog.getByRole('button', { name: '关闭追问窗口' }).click(); await closed();
  await page.evaluate(async () => { window.articleSelectionFixture.releaseLate(); await window.articleSelectionFixture.flushAll(); });
  let data = await snapshot();
  check(data.currentMainUnchanged && data.originalRetained, 'Closing a running branch changed source chat');
  const stopped = data.records.find(record => record.id === closingBranch);
  check(stopped?.messages.at(-1)?.status === 'stopped', 'Closing did not save an explicit stopped answer');
  check(!JSON.stringify(data.records).includes('LATE_CALLBACK_MUST_BE_IGNORED'), 'A late callback entered saved history after close');

  await open(); await page.evaluate(() => window.articleSelectionFixture.holdNextAnswer());
  await dialog.getByRole('textbox', { name: '输入追问' }).fill('挂起回答用于停止测试。');
  await dialog.getByRole('button', { name: '发送追问' }).click();
  await page.waitForFunction(() => window.articleSelectionFixture.snapshot().pendingCount === 1);
  await dialog.getByRole('button', { name: '停止追问' }).click();
  await page.waitForFunction(() => !window.articleSelectionFixture.snapshot().busy);
  await page.evaluate(() => window.articleSelectionFixture.releaseLate());
  await dialog.getByRole('textbox', { name: '输入追问' }).fill('停止之后发送一个新的问题。');
  await dialog.getByRole('button', { name: '发送追问' }).click(); await settled();
  data = await snapshot();
  check(data.branch.messages.length === 4 && data.branch.messages.at(-1).status === 'complete', 'Stop prevented a fresh unique follow-up');
  check(!JSON.stringify(data.branch).includes('LATE_CALLBACK_MUST_BE_IGNORED'), 'Old callbacks overwrote the new branch turn');
  const escapedBefore = data.escapedOutside;
  await dialog.getByRole('textbox', { name: '输入追问' }).focus(); await page.keyboard.press('Escape'); await closed();
  check((await snapshot()).escapedOutside === escapedBefore, 'Window Escape reached an unrelated global listener');
  check((await snapshot()).activeElement === 'main-input', 'Window Escape did not restore main input focus');
  await select(); await page.keyboard.press('Escape');
  await toolbar.waitFor({ state: 'hidden' });
  check((await snapshot()).escapedOutside === escapedBefore, 'Toolbar Escape reached an unrelated global listener');
  await page.evaluate(() => window.articleSelectionFixture.selectText('请解释 metadata 在 RAG 中的用途。', { selector: '[data-message-id="main-question"] .message-content' }));
  await page.waitForTimeout(80);
  check(!(await snapshot()).menuVisible, 'A user question became an article selection');
  await reload(544); await open();
  await page.evaluate(() => {
    const window = document.querySelector('.selection-chat-window');
    window.style.width = '280px';
    window.style.height = '260px';
    window.querySelector('blockquote').textContent = '长段落引用及其语义上下文。'.repeat(500);
    window.querySelector('textarea').style.height = '120px';
    const feedback = window.querySelector('.selection-chat-feedback');
    feedback.hidden = false;
    feedback.textContent = '保存结果尚未确认，请保留窗口重新核对。'.repeat(20);
  });
  const compact = await page.evaluate(() => {
    const window = document.querySelector('.selection-chat-window');
    const rect = window.getBoundingClientRect();
    return [...window.querySelectorAll('.selection-chat-send, .selection-chat-replace, .selection-chat-close')].map(button => {
      const bounds = button.getBoundingClientRect();
      return { name: button.getAttribute('aria-label') || button.textContent, visible: bounds.top >= rect.top
        && bounds.bottom <= rect.bottom && bounds.left >= rect.left && bounds.right <= rect.right
        && button.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)) };
    });
  });
  check(compact.every(button => button.visible), `Compact window clipped a control: ${JSON.stringify(compact)}`);
  await page.screenshot({ path: 'output/playwright/article-selection-chat-compact.png' });
  await dialog.getByRole('button', { name: '关闭追问窗口' }).click(); await closed();
  const result = { passed: true, results, compactControls: compact, nativeRange: true, localModelGatewayAndApplication: true,
    closeStopsAndIgnoresLate: true, stopAllowsFreshTurn: true, escapeIsolated: true, sourceRetained: true };
  await page.evaluate(result => { window.fixtureResult = result; document.querySelector('#result').textContent = '通过：选区语境、引用、独立追问、保存、拖动缩放、停止关闭及替换'; }, result);
  return result;
}
