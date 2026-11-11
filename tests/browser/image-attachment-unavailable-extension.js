// Run only in a fresh isolated Chromium profile with the current dist loaded.
// Uses the real built sidepanel, temporary storage, rewind and submission paths.
// Model traffic is intercepted locally so this never contacts a live provider.
// playwright-cli -s=image-attachment-unavailable run-code --filename tests/browser/image-attachment-unavailable-extension.js
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const context = page.context(), modelRequests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const modelPattern = 'https://model.missing-image.fixture.test/**';
  await context.route(modelPattern, route => {
    modelRequests.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"unexpected fixture model request"}}' });
  });
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2];
  const expected = await worker.evaluate(async () => {
    const now = new Date().toISOString(), content = '根据这张参考图片解释设置，并保留这个提问。';
    const image = { id: 'missing-reference', type: 'image', name: 'reference.png', mime: 'image/png', width: 160, height: 180,
      imageStorageVersion: 1, imagePath: `images/${'a'.repeat(64)}.png`, loadError: '原图片文件缺失，请重新添加。' };
    const question = { id: 'missing-image-question', role: 'user', content, displayContent: content, createdAt: now,
      pageContextEnabled: false, attachments: [image] };
    const answer = { id: 'missing-image-answer', role: 'assistant', status: 'error', content: '图片缺失，请核对原图片文件。', createdAt: now };
    await chrome.storage.local.set({ providerConfig: { version: 4, endpointUrl: 'https://model.missing-image.fixture.test/v1',
      apiKey: 'local-fixture-only', selectedModelId: 'vision-fixture', webSearchEnabled: false,
      models: [{ id: 'vision-fixture', name: '本地视觉测试替身', contextLength: 32000, maxOutputTokens: 1200, supportsVision: true, supportsReasoning: false }] },
      temporaryConversation: { version: 2, id: 'image-unavailable-extension-regression', storage: 'temporary',
        title: '实际扩展缺图回退与发送回归', messages: [question, answer], createdAt: now, updatedAt: now } });
    return { content, name: image.name, imagePath: image.imagePath, reason: image.loadError };
  });
  try {
    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await page.waitForFunction(() => !document.querySelector('#message-input')?.readOnly
      && document.querySelector('[data-message-id="missing-image-question"].user-message'));
    const bundle = await page.evaluate(() => [...document.scripts].map(script => script.src).find(src => /\/assets\/sidepanel-.*\.js$/.test(src)));
    check(bundle, 'real dist sidepanel bundle did not load');
    const question = page.locator('[data-message-id="missing-image-question"].user-message');
    const historyError = await question.locator('.message-file-error').innerText();
    check(historyError.includes(expected.name) && historyError.includes(expected.reason), 'history omitted the missing image reason');
    check(await question.locator('.message-image').count() === 0, 'relative imagePath was treated as image pixels');
    await page.screenshot({ path: 'output/playwright/image-attachment-unavailable-history.png' });
    await question.hover();
    await question.locator('[data-action="rewind"]').click();
    await page.waitForFunction(() => document.querySelector('#message-input')?.value.includes('根据这张参考图片')
      && document.querySelector('#attachment-list .attachment-error'));
    const draft = await page.evaluate(() => ({ value: document.querySelector('#message-input').value,
      attachments: document.querySelectorAll('#attachment-list .attachment-item').length,
      images: document.querySelectorAll('#attachment-list img').length,
      error: document.querySelector('#attachment-list .attachment-error').textContent,
      errorWraps: getComputedStyle(document.querySelector('#attachment-list .attachment-error')).whiteSpace === 'normal',
      historyRemoved: !document.querySelector('[data-message-id="missing-image-question"]') }));
    check(draft.value === expected.content && draft.attachments === 1 && draft.images === 0 && draft.historyRemoved, 'rewind lost the incomplete original attachment or question');
    check(draft.error.includes(expected.reason) && draft.errorWraps, 'rewind did not show a wrapping missing image explanation');
    await page.waitForFunction(() => !document.querySelector('#toast-region .toast'));
    await page.screenshot({ path: 'output/playwright/image-attachment-unavailable-rewind.png' });
    check(await page.locator('#send-message').isEnabled(), 'fixture send button is disabled; submission guard cannot be exercised');
    await page.locator('#send-message').click();
    await page.waitForFunction(reason => document.querySelector('#toast-region')?.textContent.includes(reason), expected.reason);
    await page.waitForTimeout(300);
    const afterSend = await page.evaluate(() => ({ value: document.querySelector('#message-input').value,
      attachments: document.querySelectorAll('#attachment-list .attachment-item').length,
      error: document.querySelector('#attachment-list .attachment-error')?.textContent,
      questions: document.querySelectorAll('.user-message').length,
      answers: document.querySelectorAll('.assistant-message').length, notice: document.querySelector('#toast-region').textContent }));
    check(afterSend.value === expected.content && afterSend.attachments === 1 && afterSend.error.includes(expected.reason), 'blocked send discarded the editable question or attachment');
    check(afterSend.questions === 0 && afterSend.answers === 0 && modelRequests.length === 0, 'missing-image send created a turn or issued a model request');
    check(errors.length === 0, `extension page errors: ${JSON.stringify(errors)}`);
    await page.screenshot({ path: 'output/playwright/image-attachment-unavailable-blocked-send.png' });
    return { passed: true, environment: 'Actual dist in isolated Chromium extension page; real storage/rewind/submission; local intercepted provider',
      bundle, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), history: { reason: historyError, noPixels: true },
      rewind: { draftRestored: true, attachmentPreserved: true, reasonVisible: true, errorWraps: true },
      send: { blocked: true, draftPreserved: true, attachmentPreserved: true, newTurns: 0, modelRequests: 0, notice: afterSend.notice }, pageErrors: errors };
  } finally { await context.unroute(modelPattern); }
}
