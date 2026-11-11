// playwright-cli -s=image-preview run-code --filename tests/browser/image-preview.js
// Open the isolated loopback Vite fixture tests/browser/image-preview.html first.
async (page) => {
  const url = new URL(page.url());
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/tests/browser/image-preview.html') throw new Error('Open the isolated loopback image-preview fixture first.');
  const routeLocal = route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient');
  await page.route('**/*', routeLocal);
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const near = (actual, expected, message, tolerance = 1) => check(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
  const snapshot = () => page.evaluate(() => window.imagePreviewFixture.snapshot());
  const dialog = page.getByRole('dialog');
  const viewport = dialog.locator('.image-preview-viewport');
  const waitOpen = () => page.waitForFunction(() => document.querySelector('dialog[open] .image-preview-viewport.is-ready'));
  const waitClosed = () => page.waitForFunction(() => !window.imagePreviewFixture.snapshot().opened);
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const checks = [];
  try {
    for (const width of [320, 544, 960]) {
      await page.setViewportSize({ width, height: 900 });
      const trigger = page.locator('[data-message-id="long-message"] img[data-image-preview]');
      await trigger.click();
      await waitOpen();
      const opened = await snapshot();
      check(opened.imageSourceMatches && opened.naturalWidth === 720 && opened.naturalHeight === 3400, `${width}: opened wrong image`);
      check(opened.dialog.x >= 0 && opened.dialog.x + opened.dialog.width <= width + 1, `${width}: dialog overflowed viewport`);
      near(opened.image.width, Math.min(720, opened.viewport.clientWidth - 24), `${width}: initial width`);
      near(opened.image.y, opened.viewport.y + 12, `${width}: long image begins at its top`);
      check(opened.image.height > opened.viewport.clientHeight && opened.viewport.overflow === 'hidden', `${width}: expected a pannable long-image canvas`);
      check(opened.controls.every(control => control.x >= 0 && control.x + control.width <= width && control.y >= 0 && control.y + control.height <= 900), `${width}: a toolbar control is clipped`);
      const point = { x: opened.viewport.x + opened.viewport.width * 0.6, y: opened.viewport.y + 180 };
      const pixel = { x: (point.x - opened.image.x) / opened.scale, y: (point.y - opened.image.y) / opened.scale };
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, -160);
      await page.waitForFunction(scale => window.imagePreviewFixture.snapshot().scale > scale, opened.scale);
      const zoomed = await snapshot();
      near((point.x - zoomed.image.x) / zoomed.scale, pixel.x, `${width}: wheel x anchor`, 2);
      near((point.y - zoomed.image.y) / zoomed.scale, pixel.y, `${width}: wheel y anchor`, 2);
      const zoomBeforeOut = zoomed.scale;
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(scale => window.imagePreviewFixture.snapshot().scale < scale, zoomBeforeOut);
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
      const beforeDrag = await snapshot();
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      check((await snapshot()).viewport.dragging, `${width}: drag did not start`);
      await page.mouse.move(point.x - 45, point.y - 80, { steps: 5 });
      const dragged = await snapshot();
      near(dragged.image.x, beforeDrag.image.x - 45, `${width}: horizontal drag`);
      near(dragged.image.y, beforeDrag.image.y - 80, `${width}: vertical drag`);
      await page.mouse.up();
      check((await snapshot()).opened && !(await snapshot()).viewport.dragging, `${width}: release closed preview or retained dragging`);
      await viewport.focus();
      const beforeKey = await snapshot();
      await page.keyboard.press('ArrowDown');
      near((await snapshot()).image.y, beforeKey.image.y - 40, `${width}: keyboard navigation`);
      await page.keyboard.press('0');
      const fit = await snapshot();
      near(fit.scale, opened.scale, `${width}: reset fit scale`, 0.001);
      near(fit.image.y, opened.image.y, `${width}: reset long image position`);
      await dialog.getByRole('button', { name: '原始尺寸', exact: true }).click();
      const original = await snapshot();
      near(original.image.width, 720, `${width}: original pixel width`);
      if (width === 544) await page.screenshot({ path: 'output/playwright/image-preview-zoom-long.png' });
      // Capture must retain the drag until release even outside the dialog.
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(1, 1);
      await page.mouse.up();
      check((await snapshot()).opened && !(await snapshot()).viewport.dragging, `${width}: outside release dismissed or stuck the viewer`);
      await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).click();
      await waitClosed();
      check((await snapshot()).activeElement.previewTrigger, `${width}: close did not restore trigger focus`);
      checks.push({ width, fitImage: opened.image, viewport: opened.viewport, wheelScale: zoomed.scale, draggedImage: dragged.image, originalImage: original.image, closeRestoredFocus: true });
    }

    await page.setViewportSize({ width: 599, height: 901 });
    const wide = page.locator('[data-message-id="wide-message"] img[data-image-preview]');
    await wide.click();
    await waitOpen();
    const centered = await snapshot();
    near(centered.image.x + centered.image.width / 2, centered.viewport.x + centered.viewport.width / 2, 'wide image horizontally centered');
    near(centered.image.y + centered.image.height / 2, centered.viewport.y + centered.viewport.height / 2, 'wide image vertically centered');
    await page.screenshot({ path: 'output/playwright/image-preview-zoom-wide-fit.png' });
    await viewport.dblclick({ position: { x: 220, y: 220 } });
    near((await snapshot()).scale, 1, 'double click native pixel view', 0.001);
    const beforeResize = await snapshot();
    const centerPixel = { x: (beforeResize.viewport.x + beforeResize.viewport.width / 2 - beforeResize.image.x) / beforeResize.scale, y: (beforeResize.viewport.y + beforeResize.viewport.height / 2 - beforeResize.image.y) / beforeResize.scale };
    await page.setViewportSize({ width: 650, height: 780 });
    await page.waitForFunction(oldWidth => window.imagePreviewFixture.snapshot().viewport.width !== oldWidth, beforeResize.viewport.width);
    // Layout changes before ResizeObserver finishes re-centering the canvas.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const resized = await snapshot();
    near(resized.scale, 1, 'manual zoom survives resizing', 0.001);
    near((resized.viewport.x + resized.viewport.width / 2 - resized.image.x) / resized.scale, centerPixel.x, 'resized center x');
    near((resized.viewport.y + resized.viewport.height / 2 - resized.image.y) / resized.scale, centerPixel.y, 'resized center y');
    await page.screenshot({ path: 'output/playwright/image-preview-zoom-wide-detail.png' });
    // Many wheel ticks reach the limits without allocating new image pixels.
    await viewport.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      for (let i = 0; i < 60; i++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, bubbles: true, cancelable: true }));
    });
    near((await snapshot()).scale, 8, 'maximum scale', 0.001);
    check(await dialog.getByRole('button', { name: '放大图片', exact: true }).isDisabled(), 'maximum zoom button is not disabled');
    await viewport.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      for (let i = 0; i < 80; i++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, bubbles: true, cancelable: true }));
    });
    near((await snapshot()).scale, 0.1, 'minimum scale', 0.001);
    check(await dialog.getByRole('button', { name: '缩小图片', exact: true }).isDisabled(), 'minimum zoom button is not disabled');
    await page.keyboard.press('Escape');
    await waitClosed();

    const small = page.locator('[data-message-id="small-message"] img[data-image-preview]');
    await small.focus();
    await small.press('Enter');
    await waitOpen();
    const smallOpened = await snapshot();
    check(smallOpened.naturalWidth === 160, 'Enter opened wrong image');
    near(smallOpened.scale, 1, 'small image starts at native pixels', 0.001);
    near(smallOpened.image.y + smallOpened.image.height / 2, smallOpened.viewport.y + smallOpened.viewport.height / 2, 'small image vertically centered');
    const escapedBefore = smallOpened.escapedOutside.length;
    await page.keyboard.press('Escape');
    await waitClosed();
    check((await snapshot()).escapedOutside.length === escapedBefore, 'Escape reached the unrelated global listener');
    await small.focus();
    await small.press('Space');
    await waitOpen();
    await page.mouse.click(1, 1);
    await waitClosed();

    await page.locator('#attachment-list img[data-image-preview]').first().click();
    await waitOpen();
    await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
    const beforeRedraw = await snapshot();
    await page.evaluate(() => window.imagePreviewFixture.redraw());
    const afterRedraw = await snapshot();
    check(afterRedraw.opened, 'Same conversation redraw closed preview');
    near(afterRedraw.scale, beforeRedraw.scale, 'Redraw changed zoom', 0.001);
    near(afterRedraw.image.y, beforeRedraw.image.y, 'Redraw changed image position');
    await page.evaluate(() => window.imagePreviewFixture.switchConversation());
    await waitClosed();
    const beforeRemove = await snapshot();
    check(beforeRemove.messageDataUnchanged && beforeRemove.attachmentDataUnchanged, 'Preview changed original message or attachment data');
    await page.locator('#attachment-list .attachment-remove').first().click();
    check(!(await snapshot()).opened && (await snapshot()).removedIds.length === 1, 'Removing attachment opened preview');

    await page.locator('#theme').click();
    await wide.click();
    await waitOpen();
    await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
    await page.screenshot({ path: 'output/playwright/image-preview-zoom-dark.png' });
    await page.evaluate(() => window.imagePreviewFixture.controller.dispose());
    await waitClosed();
    await wide.click();
    const final = await snapshot();
    check(!final.opened, 'Disposed preview reopened');
    check(final.errors.length === 0 && errors.length === 0 && final.messageDataUnchanged, 'Preview produced errors or changed message data');
    const result = { passed: true, checks, wheelAnchor: true, zoomBounds: true, primaryDrag: true, outsideRelease: true, centeredWideAndSmall: true, resizeCenter: true, keyboard: true, escapeIsolated: true, backdropClose: true, attachmentPreview: true, sameConversationViewPreserved: true, switchedConversationClosed: true, removeIndependent: true, disposeStoppedOpening: true, messageDataUnchanged: true, pageErrors: errors };
    await page.evaluate(result => { window.fixtureResult = result; document.querySelector('#result').textContent = '通过：鼠标锚点缩放、拖动、边界、尺寸切换、键盘、会话隔离与释放'; }, result);
    return result;
  } finally {
    page.off('pageerror', onError);
    await page.unroute('**/*', routeLocal);
  }
}
