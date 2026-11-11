// Generate with npm run docs:build, serve docs/USER-GUIDE.html unchanged locally,
// then run with playwright-cli run-code --filename tests/browser/user-guide.js.
// Uses only the standalone manual; no extension profile or model service.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const documentUrl = page.url().split('#')[0];
  const html = await page.content();
  check(await page.evaluate(() => document.scripts.length === 0), 'Serve the static HTML without injected development scripts.');
  const errors = [], network = [];
  const onError = error => errors.push(error.message);
  const onRequest = request => {
    if (/^https?:/.test(request.url()) && (!request.isNavigationRequest() || request.url() !== documentUrl)) network.push(request.url());
  };
  page.on('pageerror', onError);
  page.on('request', onRequest);
  // Deliver only the already-loaded document from memory, then render all
  // assets with networking offline. No file-access permissions are required.
  const serveDocument = route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  await page.route(documentUrl, serveDocument);
  await page.context().setOffline(true);
  try {
    await page.reload();
    await page.locator('figure img').first().waitFor();
    await page.evaluate(async () => Promise.all([...document.images].map(img => img.decode())));
    const structure = await page.evaluate(() => ({
      title: document.title,
      scripts: document.scripts.length,
      images: [...document.images].map(img => ({ embedded: img.src.startsWith('data:image/'), loaded: img.complete && img.naturalWidth > 0 })),
      figures: [...document.querySelectorAll('figure')].map(figure => ({
        id: figure.id, number: Number(figure.querySelector('figcaption')?.textContent.match(/^图\s*(\d+)/)?.[1]),
      })),
      toc: [...document.querySelectorAll('.toc nav a')].map(a => a.hash),
      brokenAnchors: [...document.querySelectorAll('a[href^="#"]')].filter(a => !document.getElementById(decodeURIComponent(a.hash.slice(1)))).map(a => a.hash),
    }));
    check(structure.scripts === 0 && structure.images.length === 16, 'Expected a static guide with 16 images.');
    check(structure.images.every(img => img.embedded && img.loaded), 'Every image must load offline from embedded data.');
    check(structure.figures.every(figure => figure.id === `figure-${figure.number}`), 'Figure captions and anchors differ.');
    check(new Set(structure.figures.map(figure => figure.number)).size === 16, 'Figure numbers must be unique.');
    check(structure.toc.length === 13 && structure.brokenAnchors.length === 0, 'Every chapter and figure link must resolve.');
    const layouts = [];
    for (const width of [1440, 850, 650, 420, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const layout = await page.evaluate(() => ({
        width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        articleWidth: document.querySelector('article').getBoundingClientRect().width,
        figureScroll: document.querySelector('#figure-14 .figure-scroll').scrollWidth > document.querySelector('#figure-14 .figure-scroll').clientWidth,
      }));
      check(layout.documentWidth <= width + 1, `Page overflow at ${width}px.`);
      if (width <= 650) check(layout.figureScroll, 'Narrow diagrams should scroll inside their frame.');
      layouts.push(layout);
      if ([1440, 390].includes(width)) await page.screenshot({ path: `output/playwright/user-guide-v0182-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    for (const number of [14, 15, 16]) {
      await page.locator('.figure-index').evaluate(element => { element.open = true; });
      await page.locator(`.figure-index a[href="#figure-${number}"]`).click();
      check(page.url().endsWith(`#figure-${number}`), `Figure ${number} index navigation failed.`);
      await page.locator(`#figure-${number}`).screenshot({ path: `output/playwright/user-guide-v0182-figure-${number}.png` });
    }
    await page.setViewportSize({ width: 390, height: 900 });
    const scroller = page.locator('#figure-14 .figure-scroll');
    await scroller.focus();
    await page.keyboard.press('End');
    // Test native horizontal keyboard scroll without moving the whole document.
    await scroller.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#figure-14 .figure-scroll').scrollLeft > 0);
    check(await page.evaluate(() => window.scrollX === 0), 'Diagram scroll moved the whole document.');
    await page.locator('#figure-14').screenshot({ path: 'output/playwright/user-guide-v0182-mobile-figure.png' });
    check(network.length === 0 && errors.length === 0, 'Offline guide requested the network or raised page errors.');
    return { title: structure.title, embeddedImages: structure.images.length, chapters: structure.toc.length, layouts, offline: true, networkRequests: network.length, pageErrors: errors.length };
  } finally {
    await page.context().setOffline(false);
    await page.unroute(documentUrl, serveDocument);
    page.off('pageerror', onError);
    page.off('request', onRequest);
  }
}
