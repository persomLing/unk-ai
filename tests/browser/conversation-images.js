// playwright-cli -s=conversation-images run-code --filename tests/browser/conversation-images.js
async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:5184/tests/browser/conversation-images.html')) throw new Error('Open the isolated loopback fixture first.');
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient'));
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  await page.locator('#run').click();
  await page.waitForFunction(() => Boolean(window.fixtureResult));
  const result = await page.evaluate(() => window.fixtureResult);
  if (!result.passed) throw new Error(result.error);
  await page.screenshot({ path: 'output/playwright/conversation-images-browser.png', fullPage: true });
  return result;
}
