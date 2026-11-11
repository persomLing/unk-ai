// Open the isolated loopback Vite fixture /tests/browser/scrollbar-appearance.html.
// Set launchOptions.ignoreDefaultArgs to ['--hide-scrollbars'] in the CLI browser
// config, so headless Chromium actually paints native scrollbars for visual/drag QA.
// playwright-cli -s=scrollbars run-code --filename tests/browser/scrollbar-appearance.js
async (page) => {
  const fixtureUrl = new URL(page.url());
  if (!['127.0.0.1', 'localhost'].includes(fixtureUrl.hostname)
    || fixtureUrl.pathname !== '/tests/browser/scrollbar-appearance.html') {
    throw new Error('Open the local scrollbar-appearance fixture first.');
  }
  const localOnly = route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort('blockedbyclient');
  await page.route('**/*', localOnly);
  const check = (value, message) => { if (!value) throw new Error(message); };
  const transparent = color => color === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(color);
  const snap = (name, target = page) => target.evaluate(name => window.scrollbarFixture.snapshot(name), name);
  const show = (name, target = page) => target.evaluate(name => window.scrollbarFixture.show(name), name);
  const park = async (target = page) => {
    await target.evaluate(() => document.activeElement?.blur());
    await target.locator('#keyboard-start').hover();
  };
  const load = async (surface, theme = 'light', target = page) => {
    await target.goto(`${fixtureUrl.origin}${fixtureUrl.pathname}?surface=${surface}`);
    await target.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
    await target.evaluate(theme => window.scrollbarFixture.theme(theme), theme);
    await park(target);
  };
  const stable = (left, right) => left.clientWidth === right.clientWidth && left.clientHeight === right.clientHeight
    && Math.abs(left.rect.width - right.rect.width) < .01 && Math.abs(left.rect.height - right.rect.height) < .01
    && left.width === right.width && left.height === right.height;
  const probe = name => page.locator(`[data-probe="${name}"]`);
  const colors = {}, results = [];
  let touchContext;
  try {
    await page.setViewportSize({ width: 640, height: 720 });
    for (const theme of ['light', 'dark']) {
      await load('sidepanel', theme);
      const cases = ['conversation', 'history', 'thinking', 'error', 'code', 'table', 'input', 'floating', 'reference', 'export'];
      for (const name of cases) {
        await show(name); await park();
        const idle = await snap(name);
        const horizontal = ['code', 'table'].includes(name);
        check(horizontal ? idle.scrollWidth > idle.clientWidth : idle.scrollHeight > idle.clientHeight,
          `${theme}/${name}: the real container did not overflow: ${JSON.stringify(idle)}`);
        check(transparent(idle.thumb), `${theme}/${name}: a thumb was visible before entering its region: ${idle.thumb}`);
        // The reference body has an independent nested scrollbar. Wheel over its
        // summary to exercise the outer details scroller without consuming the wheel inside.
        if (name === 'reference') await probe(name).locator('summary').hover();
        else await probe(name).hover();
        const hovered = await snap(name);
        check(hovered.hover && !transparent(hovered.thumb), `${theme}/${name}: hovering did not reveal the thumb`);
        colors[theme] ||= hovered.thumb;
        check(hovered.thumb === colors[theme], `${theme}/${name}: inconsistent thumb color ${hovered.thumb} / ${colors[theme]}`);
        check(transparent(hovered.track), `${theme}/${name}: visible scrollbar track`);
        check(stable(idle, hovered), `${theme}/${name}: hover changed scrollbar width or content geometry: ${JSON.stringify({ idle, hovered })}`);
        await page.mouse.wheel(horizontal ? 320 : 0, horizontal ? 0 : 250);
        await page.waitForFunction(({ name, horizontal }) => {
          const node = document.querySelector(`[data-probe="${name}"]`);
          return horizontal ? node.scrollLeft > 0 : node.scrollTop > 0;
        }, { name, horizontal }, { timeout: 5000 }).catch(() => { throw new Error(`${theme}/${name}: wheel did not scroll its native region`); });
        await park();
        const left = await snap(name);
        check(!left.hover && transparent(left.thumb), `${theme}/${name}: leaving did not hide the thumb`);
        check(stable(hovered, left), `${theme}/${name}: leaving changed layout`);
        if (name === 'thinking') check(hovered.width === '6px', `${theme}/thinking: expected compact 6px width`);
        if (name === 'table') check(hovered.height === '4px', `${theme}/table: expected compact 4px horizontal height`);
      }
      await show('short'); await probe('short').hover();
      const short = await snap('short');
      check(short.scrollWidth <= short.clientWidth && short.scrollHeight <= short.clientHeight,
        `${theme}: short content unexpectedly acquired a scrollable range`);
      check(['auto', 'visible'].includes(short.overflowY), 'Short content uses a forced scrollbar');
      await show('nested'); await park();
      await page.locator('#parent-hover-zone').hover();
      const parent = await snap('parent'), child = await snap('child');
      check(parent.hover && !transparent(parent.thumb) && !child.hover && transparent(child.thumb),
        `${theme}: parent hover revealed a scrollbar in an untouched nested region`);
      await probe('child').hover();
      check((await snap('child')).thumb === colors[theme], `${theme}: nested scrollbar did not use the shared color`);
      await park();
      await page.screenshot({ path: `output/playwright/scrollbars-${theme}-idle.png` });
      await probe('child').hover();
      await page.screenshot({ path: `output/playwright/scrollbars-${theme}-hover.png` });
      results.push({ surface: 'sidepanel', theme, containers: cases, idleHidden: true, hoverOnly: true,
        sharedColor: colors[theme], wheelWorks: true, stableGeometry: true, shortContentNoOverflow: true, nestedHoverIsolated: true });

      await load('options', theme);
      await show('navigation'); await park();
      const navIdle = await snap('navigation');
      check(navIdle.scrollWidth > navIdle.clientWidth && transparent(navIdle.thumb), `${theme}: settings navigation does not hide its overflow thumb at rest`);
      await probe('navigation').hover();
      const navHover = await snap('navigation');
      check(navHover.thumb === colors[theme] && stable(navIdle, navHover), `${theme}: settings navigation color or geometry differs`);
      await page.mouse.wheel(240, 0);
      await page.waitForFunction(() => document.querySelector('[data-probe="navigation"]').scrollLeft > 0);
      await show('viewport');
      await page.mouse.move(-20, -20);
      const viewportIdle = await snap('viewport');
      check(viewportIdle.scrollHeight > viewportIdle.clientHeight && transparent(viewportIdle.thumb),
        `${theme}: the long settings page scrollbar did not hide after the pointer left the page: ${JSON.stringify(viewportIdle)}`);
      await page.locator('#keyboard-start').hover();
      const viewportHover = await snap('viewport');
      check(viewportHover.thumb === colors[theme] && stable(viewportIdle, viewportHover), `${theme}: settings page thumb color or geometry differs`);
      check(viewportHover.width === '7px', `${theme}: settings page lost its 7px width`);
      await page.mouse.wheel(0, 260);
      await page.waitForFunction(() => document.scrollingElement.scrollTop > 0);
      results.push({ surface: 'options', theme, navigationAndViewport: true, sharedColor: colors[theme], pageEnterLeave: true, wheelWorks: true, stableGeometry: true });
    }
    check(colors.light !== colors.dark, 'The dark theme did not adapt the shared thumb color');
    await load('sidepanel'); await show('conversation');
    await probe('conversation').hover();
    const dragStart = await snap('conversation');
    if (dragStart.verticalGutter > 0) {
      const x = dragStart.rect.x + dragStart.rect.width - dragStart.borderRight - dragStart.verticalGutter / 2;
      const thumbHeight = Math.max(18, dragStart.clientHeight * dragStart.clientHeight / dragStart.scrollHeight);
      const y = dragStart.rect.y + dragStart.borderTop + thumbHeight / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      try {
        check((await snap('conversation')).scrollTop === dragStart.scrollTop,
          'Native thumb hit missed and paged the scrollbar track before dragging');
        await page.mouse.move(x, y + 70, { steps: 12 });
      } finally {
        await page.mouse.up();
      }
      await page.waitForFunction(() => document.querySelector('[data-probe="conversation"]').scrollTop > 0);
      check((await snap('conversation')).scrollTop > dragStart.scrollTop, 'Dragging the visible native thumb did not scroll its content');
      results.push({ nativeThumbDrag: 'passed', gutter: dragStart.verticalGutter });
    } else {
      results.push({ nativeThumbDrag: 'unavailable', reason: 'Browser exposes no native scrollbar gutter; wheel and keyboard were checked separately.' });
    }
    await show('conversation');
    await page.locator('#keyboard-start').click();
    await page.keyboard.press('Tab');
    const keyboard = await snap('conversation');
    check(keyboard.focusVisible && !keyboard.hover && keyboard.thumb === colors.light, 'Keyboard focus did not reveal the unhovered scrollbar');
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('[data-probe="conversation"]').scrollTop > 0);
    results.push({ keyboardFocusReveals: true, keyboardScrollWorks: true });

    const browser = page.context().browser();
    check(browser, 'Touch regression requires the isolated Chromium browser context');
    touchContext = await browser.newContext({ viewport: { width: 640, height: 720 }, hasTouch: true, isMobile: true });
    await touchContext.route('**/*', localOnly);
    const touchPage = await touchContext.newPage();
    await load('sidepanel', 'light', touchPage);
    await show('conversation', touchPage);
    await touchPage.mouse.move(-20, -20);
    const touch = await snap('conversation', touchPage);
    const media = await touchPage.evaluate(() => ({ hoverNone: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches }));
    check((media.hoverNone || media.coarse) && !transparent(touch.thumb) && touch.thumb === colors.light,
      `Touch layout hid its only scrollbar hint: ${JSON.stringify({ touch, media })}`);
    check(touch.scrollHeight > touch.clientHeight && touch.overflowY === 'auto', 'Touch layout lost its normal scroll range');
    results.push({ touchNoHoverFallback: true, sharedColor: touch.thumb });
    const result = { passed: true, productionCss: true, noModelOrStorage: true, results };
    await page.evaluate(value => { window.fixtureResult = value; document.querySelector('#fixture-result').textContent = '通过：滚动条按需显隐、主题统一、滚动与键盘/触屏保持可用。'; }, result);
    return result;
  } finally {
    await touchContext?.close();
    await page.unroute('**/*', localOnly);
  }
}
