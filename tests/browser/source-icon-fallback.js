// Use only the local source-icon-fallback.html fixture; images are inline data.
async (page) => {
  const url = new URL(page.url());
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/tests/browser/source-icon-fallback.html') {
    throw new Error('Open the local source icon fixture first.');
  }
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-source-favicon]')].every(image => image.complete));
  const state = () => page.evaluate(() => [...document.querySelectorAll('.source-popover-icon')].map(icon => {
    const image = icon.querySelector('[data-source-favicon]');
    return { fallback: !icon.querySelector('[data-source-favicon-fallback]').hidden, image: Boolean(image && !image.hidden) };
  }));
  const initial = await state();
  check(initial[0].fallback && !initial[0].image, 'Missing icon did not show the default globe.');
  check(initial[1].fallback && !initial[1].image, 'Broken icon did not show the default globe.');
  check(!initial[2].fallback && initial[2].image, 'A valid website icon was hidden behind its default globe.');
  await page.locator('.sources-pill').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.sources-popover')).opacity === '1');
  await page.screenshot({ path: 'output/playwright/source-icon-fallback.png' });
  await page.evaluate(() => {
    document.querySelectorAll('.source-popover-icon [data-source-favicon]')[1].src = window.sourceIconFixture.invalid;
  });
  await page.waitForFunction(() => {
    const image = document.querySelectorAll('.source-popover-icon [data-source-favicon]')[1];
    return image.complete && !image.naturalWidth && image.hidden;
  });
  check((await state())[2].fallback, 'Changing the favicon to a broken URL did not restore its default icon.');
  await page.evaluate(() => window.sourceIconFixture.render());
  await page.waitForFunction(() => {
    const image = document.querySelectorAll('.source-popover-icon [data-source-favicon]')[1];
    return image.complete && image.naturalWidth > 0 && !image.hidden;
  });
  const recreated = await state();
  check(recreated[1].fallback && recreated[2].image && !recreated[2].fallback, 'Recreated/cached favicons lost their fallback behavior.');
  return { passed: true, missing: true, failed: true, valid: true, changedUrl: true, recreatedAndCached: true };
}
