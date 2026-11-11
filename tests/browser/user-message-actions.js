// Start Vite: npx vite --host 127.0.0.1 --port 5184
// playwright-cli -s=user-actions open http://127.0.0.1:5184/tests/browser/user-message-actions.html
// playwright-cli -s=user-actions run-code --filename tests/browser/user-message-actions.js
// Repeat with another session opened using --device "Pixel 7" for touch checks.
// This fixture checks isolated message layout. Also run
// user-message-copy-extension.js against an isolated dist extension profile
// to cover the production click handler, native clipboard, and navigator rail.
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const near = (actual, expected) => Math.abs(actual - expected) <= 0.75;
  const ids = ['long', 'image', 'narrow'];
  const expectedEvents = [];
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  const touch = await page.evaluate(() => matchMedia('(hover: none)').matches && matchMedia('(pointer: coarse)').matches);
  await page.evaluate(() => { window.userMessageActionEvents = []; });

  const geometry = async id => page.evaluate(id => {
    const article = document.querySelector(`.user-message[data-message-id="${id}"]`);
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const actions = article.querySelector('.user-message-actions');
    const style = getComputedStyle(actions);
    return {
      article: rect(article), next: rect(article.nextElementSibling), actions: rect(actions),
      copy: rect(article.querySelector('[data-action="copy-user"]')),
      rewind: rect(article.querySelector('[data-action="rewind"]')),
      hovered: article.matches(':hover'), focused: article.matches(':focus-within'),
      opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    };
  }, id);
  const assertLayout = (initial, current, label) => {
    for (const element of ['article', 'next']) {
      for (const property of ['x', 'y', 'width', 'height']) {
        assert(near(initial[element][property], current[element][property]), `${label}: ${element}.${property} moved`);
      }
    }
  };
  const assertReachable = async (id, label) => {
    const value = await geometry(id);
    assert(value.hovered, `${id} ${label}: message lost :hover before reaching its button`);
    assert(value.pointerEvents === 'auto', `${id} ${label}: actions became ${value.pointerEvents}`);
    assert(value.opacity >= 0.98, `${id} ${label}: actions disappeared (opacity ${value.opacity})`);
    return value;
  };
  const move = async (id, from, to, steps, label) => {
    for (let step = 1; step <= steps; step++) {
      await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps);
      // Slow enough to expose hiding; a final locator.click must not repair hover.
      await page.waitForTimeout(45);
      await assertReachable(id, `${label} step ${step}/${steps}`);
    }
  };
  const center = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  const clickAtCurrentPointer = async (id, action) => {
    await page.mouse.down();
    await page.mouse.up();
    expectedEvents.push({ action, messageId: id });
    const actual = await page.evaluate(() => window.userMessageActionEvents);
    assert(JSON.stringify(actual) === JSON.stringify(expectedEvents), `${id}: expected exactly one ${action} activation, got ${JSON.stringify(actual)}`);
  };
  const prepare = async id => {
    await page.mouse.move(1, 1);
    await page.evaluate(id => {
      document.activeElement?.blur();
      const article = document.querySelector(`.user-message[data-message-id="${id}"]`);
      window.scrollTo({ top: Math.max(0, scrollY + article.getBoundingClientRect().top - 40), behavior: 'instant' });
    }, id);
    await page.waitForTimeout(200);
    const value = await geometry(id);
    assert(value.copy.bottom <= value.viewportHeight, `${id}: copy button must be inside the viewport`);
    const size = touch ? 44 : 28;
    for (const action of ['copy', 'rewind']) {
      assert(near(value[action].width, size) && near(value[action].height, size), `${id}: ${action} hit target was compressed below ${size}px`);
      assert(value[action].left >= 0 && value[action].right <= value.viewportWidth, `${id}: ${action} overflows the viewport`);
    }
    return value;
  };

  for (const id of ids) {
    const initial = await prepare(id);
    if (touch) {
      assert(initial.opacity >= 0.98 && initial.pointerEvents === 'auto', `${id}: touch actions must be visible without hovering`);
      for (const action of ['copy-user', 'rewind']) {
        const value = await geometry(id);
        const target = center(action === 'copy-user' ? value.copy : value.rewind);
        await page.touchscreen.tap(target.x, target.y);
        expectedEvents.push({ action, messageId: id });
        const actual = await page.evaluate(() => window.userMessageActionEvents);
        assert(JSON.stringify(actual) === JSON.stringify(expectedEvents), `${id}: touch activation must fire once with the original message ID`);
      }
      assertLayout(initial, await geometry(id), `${id} touch`);
      continue;
    }

    assert(initial.opacity <= 0.02 && initial.pointerEvents === 'none', `${id}: idle actions must be hidden`);
    const start = { x: initial.article.left + Math.min(20, initial.article.width / 2), y: initial.article.bottom - 12 };
    await page.mouse.move(start.x, start.y);
    await page.waitForTimeout(200);
    const visible = await assertReachable(id, 'initial hover');
    assertLayout(initial, visible, `${id} reveal`);
    await move(id, start, center(visible.copy), 20, 'diagonal toward copy');
    await clickAtCurrentPointer(id, 'copy-user');

    // Move down outside the bubble away from the narrow button column, then
    // horizontally through the blank operation area to the rewind button.
    await page.mouse.move(start.x, start.y);
    await page.waitForTimeout(200);
    const active = await geometry(id);
    const lower = { x: start.x, y: center(active.rewind).y };
    await move(id, start, lower, 12, 'down through the gap');
    await move(id, lower, center(active.rewind), 20, 'horizontal toward rewind');
    await clickAtCurrentPointer(id, 'rewind');
    await move(id, center(active.rewind), center(active.copy), 8, 'between buttons');
    assertLayout(initial, await geometry(id), `${id} activation`);

    // Mouse activation leaves focus on the button: moving away must preserve
    // keyboard accessibility until that focus also leaves the question.
    await page.mouse.move(initial.next.left + 8, initial.next.top + 8);
    await page.waitForTimeout(200);
    const focused = await geometry(id);
    assert(!focused.hovered && focused.focused && focused.opacity >= 0.98 && focused.pointerEvents === 'auto', `${id}: focused actions must remain visible after the mouse leaves`);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    const hidden = await geometry(id);
    assert(!hidden.hovered && hidden.opacity <= 0.02 && hidden.pointerEvents === 'none', `${id}: actions did not hide after leaving for the next answer`);
    assertLayout(initial, hidden, `${id} hide`);
  }

  // Keyboard reveal and activation must work independently of the mouse path.
  await page.mouse.move(1, 1);
  await page.evaluate(() => { window.userMessageActionEvents = []; document.querySelector('#keyboard-start').focus(); });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  let keyboard = await geometry('long');
  assert(keyboard.focused && keyboard.opacity >= 0.98 && keyboard.pointerEvents === 'auto', 'Tab into rewind must reveal question actions');
  assert(await page.evaluate(() => document.activeElement?.dataset.action === 'rewind' && document.activeElement?.dataset.messageId === 'long'), 'first question keyboard target must be rewind');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.dataset.action === 'copy-user' && document.activeElement?.dataset.messageId === 'long'), 'next Tab must reach copy');
  await page.keyboard.press('Enter');
  assert(JSON.stringify(await page.evaluate(() => window.userMessageActionEvents)) === JSON.stringify([{ action: 'copy-user', messageId: 'long' }]), 'keyboard copy must activate once');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  assert(JSON.stringify(await page.evaluate(() => window.userMessageActionEvents)) === JSON.stringify([{ action: 'copy-user', messageId: 'long' }, { action: 'rewind', messageId: 'long' }]), 'keyboard rewind must activate once');
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(200);
  keyboard = await geometry('long');
  if (!touch) assert(keyboard.opacity <= 0.02 && keyboard.pointerEvents === 'none', 'actions must hide after keyboard focus leaves');
  const result = { passed: true, mode: touch ? 'touch' : 'desktop', questions: ids, pointerActivations: expectedEvents.length, keyboardActivations: 2 };
  await page.evaluate(result => {
    document.querySelector('#result').textContent = `通过：${result.mode}；${result.pointerActivations} 次指针操作，${result.keyboardActivations} 次键盘操作`;
    document.documentElement.dataset.regressionPassed = 'true';
  }, result);
  return result;
}
