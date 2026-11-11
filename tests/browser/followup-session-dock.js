// Open the isolated loopback Vite fixture /tests/browser/followup-session-dock.html.
// playwright-cli -s=followup-session run-code --filename tests/browser/followup-session-dock.js
async (page) => {
  const fixtureUrl = new URL(page.url());
  if (!['127.0.0.1', 'localhost'].includes(fixtureUrl.hostname)
    || fixtureUrl.pathname !== '/tests/browser/followup-session-dock.html') {
    throw new Error('Open the isolated followup-session-dock loopback fixture first.');
  }
  const localOnly = route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort('blockedbyclient');
  await page.route('**/*', localOnly);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const metadata = 'metadata 是每个 chunk 附带的键值对';
  const embedding = 'embedding 是文本的向量表示';
  const snapshot = () => page.evaluate(() => window.followupSessionFixture.snapshot());
  const chatData = async id => (await snapshot()).chats.find(chat => chat.id === id);
  const dialog = id => page.locator(`.selection-chat-window[data-conversation-id="${id}"]`);
  const open = async text => {
    const result = await page.evaluate(text => window.followupSessionFixture.openText(text), text);
    check(result.accepted && result.conversationId, `Selection was rejected: ${JSON.stringify(result)}`);
    await dialog(result.conversationId).waitFor({ state: 'visible' });
    return result;
  };
  const settled = async id => {
    await page.waitForFunction(id => {
      const chat = window.followupSessionFixture.snapshot().chats.find(chat => chat.id === id);
      return chat && !chat.busy && chat.conversation.messages.at(-1)?.status === 'complete';
    }, id);
    await page.evaluate(() => window.followupSessionFixture.flushAll());
  };
  const send = async (id, text, { hold = false, thinking = false } = {}) => {
    if (hold) await page.evaluate(thinking => window.followupSessionFixture.holdNextAnswer({ thinking }), thinking);
    await dialog(id).getByRole('textbox', { name: '输入追问' }).fill(text);
    await dialog(id).getByRole('button', { name: '发送追问', exact: true }).click();
    if (hold) await page.waitForFunction(() => window.followupSessionFixture.snapshot().pendingAnswers === 1);
    else await settled(id);
  };
  const inside = (rect, width, height) => Boolean(rect && rect.left >= 0 && rect.top >= 0
    && rect.right <= width + 1 && rect.bottom <= height + 1);
  const docked = id => page.waitForFunction(id => {
    const chat = window.followupSessionFixture.snapshot().chats.find(chat => chat.id === id);
    return chat?.dockState === 'docked' && chat.launcher && !chat.rect;
  }, id);
  const expanded = id => page.waitForFunction(id => {
    const chat = window.followupSessionFixture.snapshot().chats.find(chat => chat.id === id);
    return chat?.dockState === 'expanded' && chat.rect && !chat.launcher;
  }, id);
  const clickLauncher = async id => {
    const launcher = (await chatData(id)).launcher;
    check(launcher, `${id}: launcher is not visible`);
    await page.mouse.click(launcher.left + launcher.width / 2, launcher.top + launcher.height / 2);
    await expanded(id);
  };
  const dragToRight = async id => {
    const header = await dialog(id).locator('header').boundingBox();
    check(header, `${id}: drag handle is missing`);
    const viewport = page.viewportSize();
    const x = header.x + 76, y = header.y + Math.min(18, header.height / 2);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(viewport.width - 14, y, { steps: 15 });
    check(!(await chatData(id)).docked, `${id}: window collapsed before pointer release`);
    await page.mouse.up();
    return chatData(id);
  };
  const reload = async (width = 960, height = 800) => {
    await page.setViewportSize({ width, height });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true');
  };
  const activityState = (id, activity, unread = false) => page.waitForFunction(({ id, activity, unread }) => {
    const chat = window.followupSessionFixture.snapshot().chats.find(chat => chat.id === id);
    return chat?.launcherActivity === activity && chat.launcherUnread === String(unread)
      && chat.launcherBusy === String(activity !== 'idle');
  }, { id, activity, unread });
  const launcherPaint = id => page.evaluate(id => {
    const launcher = window.followupSessionFixture.chat(id).launcher;
    const dot = getComputedStyle(launcher, '::after');
    const ring = getComputedStyle(launcher, '::before');
    const icon = launcher.querySelector('.icon');
    const dotVisible = !['none', 'normal'].includes(dot.content) && dot.display !== 'none'
      && dot.visibility !== 'hidden' && Number(dot.opacity) > 0
      && parseFloat(dot.width) > 0 && parseFloat(dot.height) > 0;
    return { dotVisible, ringAnimation: ring.animationName, ringDuration: ring.animationDuration,
      iconAnimation: icon ? getComputedStyle(icon).animationName : 'none',
      animations: launcher.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running')
        .map(animation => ({ name: animation.animationName || 'transition', duration: animation.effect?.getTiming().duration || 0 })) };
  }, id);
  const readableHeader = id => dialog(id).evaluate(element => {
    const window = element.getBoundingClientRect();
    const scope = element.querySelector('.selection-chat-scope');
    const reference = element.querySelector('.selection-chat-reference');
    const summary = reference.querySelector('summary');
    const scopeRect = scope.getBoundingClientRect(), summaryRect = summary.getBoundingClientRect(), referenceRect = reference.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(scope);
    const lines = [...range.getClientRects()];
    const summaryHit = document.elementFromPoint(summaryRect.left + 8, summaryRect.top + summaryRect.height / 2);
    return { scopeText: scope.textContent, scopeHeight: scopeRect.height, lineCount: lines.length,
      scopeFullyVisible: lines.length > 0 && scope.scrollHeight <= scope.clientHeight + 1
        && lines.every(line => line.top >= scopeRect.top && line.bottom <= scopeRect.bottom
          && line.left >= scopeRect.left && line.right <= scopeRect.right)
        && scopeRect.top >= window.top && scopeRect.bottom <= window.bottom,
      summaryFullyVisible: summaryRect.height >= 18 && summaryRect.top >= referenceRect.top
        && summaryRect.bottom <= referenceRect.bottom && summaryRect.top >= window.top && summaryRect.bottom <= window.bottom
        && (summaryHit === summary || summary.contains(summaryHit)),
      messageScrolls: element.querySelector('.selection-chat-messages').scrollHeight > element.querySelector('.selection-chat-messages').clientHeight };
  });
  const results = [];
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await reload();
    const first = await open(metadata);
    let data = await snapshot();
    check(!first.reused && data.answers.length === 0 && data.writes.length === 0, 'Opening an empty follow-up made a request or saved history');
    check((await chatData(first.conversationId)).conversation.groupId === undefined, 'First follow-up is not ungrouped');
    await send(first.conversationId, '结合上下文解释 metadata。');
    await dialog(first.conversationId).getByRole('textbox', { name: '输入追问' }).fill('选区更新前保留的草稿');
    const second = await open(embedding);
    data = await snapshot();
    check(second.reused && second.conversationId === first.conversationId, 'Second selection did not reuse the first follow-up');
    check(data.chats.filter(chat => !chat.closed).length === 1, 'A second floating chat was created in the same main conversation');
    check((await chatData(first.conversationId)).draft === '选区更新前保留的草稿', 'Selection update overwrote the current draft');
    await send(first.conversationId, '接着解释 embedding。');
    data = await snapshot();
    let branch = await chatData(first.conversationId);
    check(branch.conversation.messages.length === 4 && branch.conversation.messages[0].selection.text === metadata
      && branch.conversation.messages[2].selection.text === embedding, 'Reused branch lost history or per-turn references');
    check(JSON.stringify(data.answers[1].request.messages).includes('结合上下文解释 metadata'), 'Reused follow-up lost its earlier question');
    check(data.originalMainsUnchanged, 'Independent follow-up changed a source conversation');
    results.push({ reuse: true, singleUngroupedIdentity: true, independentDraftAndHistory: true });

    await open(metadata);
    await send(first.conversationId, '本轮先解释 metadata，保持生成。', { hold: true });
    data = await snapshot();
    const fixedRequest = JSON.stringify(data.answers[2].request);
    const fixedUser = JSON.stringify((await chatData(first.conversationId)).conversation.messages.at(-2));
    await dialog(first.conversationId).getByRole('textbox', { name: '输入追问' }).fill('下一轮解释新的 embedding 选区。');
    const during = await open(embedding);
    branch = await chatData(first.conversationId);
    check(during.reused && during.conversationId === first.conversationId && branch.busy, 'Selection during generation changed branch ownership or stopped its reply');
    check(branch.pendingSelection.text === embedding, 'Updated selection was not retained for the next turn');
    check(JSON.stringify(branch.conversation.messages.at(-2)) === fixedUser
      && JSON.stringify((await snapshot()).answers[2].request) === fixedRequest, 'Updated selection changed the active turn snapshot');
    check(branch.draft === '下一轮解释新的 embedding 选区。', 'Busy selection update replaced the next question draft');
    const transition = await dragToRight(first.conversationId);
    check(transition.dockState === 'collapsing' && transition.animations.some(animation => animation.duration > 0), 'Right-edge drag did not expose a real animated collapse');
    await docked(first.conversationId);
    branch = await chatData(first.conversationId);
    check(branch.busy && branch.launcherTitle.includes('正在回答'), 'Collapsing a busy follow-up stopped or concealed its running status');
    check(inside(branch.launcher, 960, 800), 'Docked launcher overflowed the viewport');
    const savedRect = branch.styleRect;
    await page.screenshot({ path: 'output/playwright/followup-session-docked-busy.png' });
    await clickLauncher(first.conversationId);
    branch = await chatData(first.conversationId);
    check(branch.busy && branch.draft === '下一轮解释新的 embedding 选区。', 'Expanding lost the running reply or draft');
    check(JSON.stringify(branch.styleRect) === JSON.stringify(savedRect), 'Expanding did not restore the saved window rectangle');
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers());
    await settled(first.conversationId);
    branch = await chatData(first.conversationId);
    check(branch.pendingSelection?.text === embedding, 'Old completion cleared the next selected reference');
    await send(first.conversationId, '下一轮解释新的 embedding 选区。');
    branch = await chatData(first.conversationId);
    check(branch.conversation.messages.length === 8 && branch.conversation.messages[4].selection.text === metadata
      && branch.conversation.messages[6].selection.text === embedding, 'New selection did not belong exclusively to the next turn');
    check(branch.pendingSelection === null, 'Submitted reference was not consumed');
    results.push({ busySnapshotStable: true, nextSelectionRetained: true, mouseEdgeDock: true, animatedCollapse: true,
      busyReplyContinues: true, restoredDraftAndRectangle: true });

    const sourceButton = dialog(first.conversationId).locator('[data-action="toggle-sources"]').last();
    await sourceButton.click();
    await dialog(first.conversationId).locator('.message-sources.is-open .sources-popover').waitFor({ state: 'visible' });
    await dialog(first.conversationId).getByRole('textbox', { name: '输入追问' }).click();
    check(await dialog(first.conversationId).locator('.message-sources.is-open').count() === 0, 'Outside pointer did not close the source popover');
    check(await dialog(first.conversationId).isVisible(), 'Outside pointer closed the floating chat');
    await sourceButton.click();
    await dialog(first.conversationId).locator('.message-sources.is-open .sources-popover').waitFor({ state: 'visible' });
    await dialog(first.conversationId).locator('.message-sources.is-open a').first()
      .evaluate(node => node.focus({ preventScroll: true }));
    check(await dialog(first.conversationId).locator('.message-sources.is-open').count() === 1,
      'Source popover closed before Escape; focus or scroll dismissed it');
    const escapesBefore = (await snapshot()).outsideEscapes;
    await page.keyboard.press('Escape');
    check(await dialog(first.conversationId).locator('.message-sources.is-open').count() === 0, 'Escape did not close the source popover');
    check(await dialog(first.conversationId).isVisible() && (await snapshot()).outsideEscapes === escapesBefore, 'Source Escape leaked to the floating window or unrelated listener');
    results.push({ sourceOutsideDismiss: true, sourceEscapeOnlyDismiss: true });

    const savedId = first.conversationId;
    await dialog(savedId).getByRole('button', { name: '关闭追问窗口' }).click();
    await dialog(savedId).waitFor({ state: 'detached' });
    const afterClose = await open(metadata);
    check(!afterClose.reused && afterClose.conversationId !== savedId, 'Closing did not permit a fresh follow-up identity');
    check((await snapshot()).records.some(record => record.id === savedId && record.messages.length === 8), 'Closing discarded the saved follow-up');
    const detachedId = afterClose.conversationId;
    await page.evaluate(() => window.followupSessionFixture.newMain());
    branch = await chatData(detachedId);
    check(!branch.tracking && !branch.closed && branch.trackingText.includes('新的选区将另开追问'), 'New main conversation did not detach the old follow-up with a visible notice');
    await page.evaluate(() => window.followupSessionFixture.switchMain('source-a'));
    check(!(await chatData(detachedId)).tracking, 'Returning to a source conversation revived old tracking');
    const fresh = await open(embedding);
    check(!fresh.reused && fresh.conversationId !== detachedId, 'A detached old window received a new selection after returning');
    await page.evaluate(async id => { await window.followupSessionFixture.chat(id).runtime.send('旧窗口仍可继续自己的追问。'); }, detachedId);
    await settled(detachedId);
    branch = await chatData(detachedId);
    check(!branch.tracking && branch.conversation.messages.length === 2 && branch.conversation.messages[0].selection.text === metadata,
      'Detached window could not continue its own branch or received the new main selection');
    results.push({ closeCreatesNewIdentity: true, newConversationDetaches: true, returnDoesNotRevive: true, detachedBranchCanContinue: true });

    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), detachedId); await docked(detachedId);
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), fresh.conversationId); await docked(fresh.conversationId);
    await page.evaluate(() => window.followupSessionFixture.switchMain('source-b'));
    check(!(await chatData(fresh.conversationId)).tracking, 'Switching main conversations did not detach the last tracking branch');
    const fromB = await open(metadata);
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), fromB.conversationId); await docked(fromB.conversationId);
    data = await snapshot();
    const launchers = data.chats.filter(chat => !chat.closed && chat.launcher);
    check(launchers.length === 3, 'Expected three independently recoverable docked windows');
    const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (let left = 0; left < launchers.length; left++) {
      check(inside(launchers[left].launcher, 960, 800), 'A multiple-window launcher overflowed');
      for (let right = left + 1; right < launchers.length; right++) {
        check(!overlap(launchers[left].launcher, launchers[right].launcher), 'Docked follow-up icons overlap and prevent recovery');
      }
    }
    await page.screenshot({ path: 'output/playwright/followup-session-multiple-launchers.png' });
    await clickLauncher(fresh.conversationId);
    check((await chatData(fresh.conversationId)).rect && (await chatData(detachedId)).docked && (await chatData(fromB.conversationId)).docked,
      'Clicking one launcher expanded or replaced another branch');
    await dialog(fresh.conversationId).getByRole('button', { name: '关闭追问窗口' }).click();
    check((await snapshot()).visibleLaunchers === 2, 'Closing an expanded detached branch removed another launcher');
    results.push({ switchingDetaches: true, threeLaunchersAvoidOverlap: true, launcherRestoresOnlyItsWindow: true });

    await reload(544, 700);
    const activityChat = await open(metadata);
    const activityId = activityChat.conversationId;
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    await activityState(activityId, 'idle');
    check(!(await launcherPaint(activityId)).dotVisible, 'An empty docked chat displayed an unread dot');
    await clickLauncher(activityId);
    await send(activityId, '先思考再逐步回答，验证收起按钮。', { hold: true, thinking: true });
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    await activityState(activityId, 'thinking');
    const thinkingPaint = await launcherPaint(activityId);
    check(!thinkingPaint.dotVisible && thinkingPaint.ringAnimation !== 'none' && thinkingPaint.animations.length > 0,
      `Thinking did not animate separately from the unread dot: ${JSON.stringify(thinkingPaint)}`);
    check((await chatData(activityId)).launcherTitle.includes('正在思考'), 'Thinking launcher did not expose its current phase');
    await page.screenshot({ path: 'output/playwright/followup-activity-thinking.png' });
    await page.evaluate(() => window.followupSessionFixture.advanceAnswers());
    await activityState(activityId, 'answering');
    const answeringPaint = await launcherPaint(activityId);
    check(!answeringPaint.dotVisible && answeringPaint.ringAnimation !== 'none' && answeringPaint.animations.length > 0,
      `Streaming did not preserve its busy animation without an unread dot: ${JSON.stringify(answeringPaint)}`);
    check((await chatData(activityId)).launcherTitle.includes('正在回答'), 'Streaming launcher retained the thinking label');
    await page.screenshot({ path: 'output/playwright/followup-activity-answering.png' });
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers());
    await settled(activityId); await activityState(activityId, 'idle', true);
    const completedPaint = await launcherPaint(activityId);
    check(completedPaint.dotVisible && completedPaint.ringAnimation === 'none' && completedPaint.iconAnimation === 'none',
      `Completed unread answer did not replace busy animation with a dot: ${JSON.stringify(completedPaint)}`);
    check((await chatData(activityId)).launcherTitle.includes('回答已完成'), 'Unread launcher did not describe completion');
    await page.screenshot({ path: 'output/playwright/followup-activity-unread.png' });
    await clickLauncher(activityId); await activityState(activityId, 'idle');
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    check(!(await launcherPaint(activityId)).dotVisible, 'Read completion became unread again after collapsing');
    await page.screenshot({ path: 'output/playwright/followup-activity-read.png' });
    await clickLauncher(activityId);
    await send(activityId, '展开时完成，不产生未读提示。');
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    await activityState(activityId, 'idle');
    check(!(await launcherPaint(activityId)).dotVisible, 'An answer completed while visible became unread after collapsing');

    await clickLauncher(activityId);
    await send(activityId, '窗口展开但页面隐藏时完成。', { hold: true });
    await page.evaluate(() => window.followupSessionFixture.setVisibility('hidden'));
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers());
    await settled(activityId); await activityState(activityId, 'idle', true);
    await page.evaluate(() => window.followupSessionFixture.setVisibility('visible'));
    await activityState(activityId, 'idle');
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    check(!(await launcherPaint(activityId)).dotVisible, 'Returning to an expanded answer did not acknowledge hidden-page completion');
    await clickLauncher(activityId);
    await send(activityId, '收起且页面隐藏时完成，恢复页面不等于已读。', { hold: true });
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    await page.evaluate(() => window.followupSessionFixture.setVisibility('hidden'));
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers());
    await settled(activityId); await activityState(activityId, 'idle', true);
    await page.evaluate(() => window.followupSessionFixture.setVisibility('visible'));
    await activityState(activityId, 'idle', true);
    check((await launcherPaint(activityId)).dotVisible, 'Returning to a page marked its still-collapsed answer as read');
    await page.evaluate(() => window.followupSessionFixture.setVisibility(null));

    await clickLauncher(activityId);
    await send(activityId, '部分输出后停止。', { hold: true });
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    await page.evaluate(id => window.followupSessionFixture.chat(id).runtime.stop(), activityId);
    await page.waitForFunction(id => {
      const chat = window.followupSessionFixture.snapshot().chats.find(chat => chat.id === id);
      return !chat.busy && chat.conversation.messages.at(-1)?.status === 'stopped';
    }, activityId);
    await activityState(activityId, 'idle');
    const stoppedContent = (await chatData(activityId)).conversation.messages.at(-1).content;
    check(!(await launcherPaint(activityId)).dotVisible, 'Stopped partial reply displayed a success unread dot');
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers({ late: true }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check((await chatData(activityId)).conversation.messages.at(-1).content === stoppedContent
      && !(await launcherPaint(activityId)).dotVisible, 'Late stopped response changed the answer or revived its unread dot');

    await clickLauncher(activityId);
    await send(activityId, '部分输出后模拟连接失败。', { hold: true });
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), activityId); await docked(activityId);
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers({ fail: true }));
    await page.waitForFunction(id => {
      const chat = window.followupSessionFixture.snapshot().chats.find(chat => chat.id === id);
      return !chat.busy && chat.conversation.messages.at(-1)?.status === 'error';
    }, activityId);
    await activityState(activityId, 'idle');
    check(!(await launcherPaint(activityId)).dotVisible, 'Failed partial reply displayed a success unread dot');
    check((await snapshot()).errors.length === 0, 'Activity regression reported an unexpected runtime or storage error');
    results.push({ thinkingAndAnsweringAnimateWithoutUnread: true, completionDotOnlyAfterSuccess: true,
      openingAcknowledgesUnread: true, recollapseKeepsRead: true, visibleCompletionIsRead: true,
      hiddenCompletionAcknowledgedOnlyWhenExpanded: true, controlledVisibilityProjection: true,
      stoppedAndFailedRepliesStayWithoutSuccessDot: true, lateStoppedResponseIgnored: true });

    await reload(759, 933);
    const longHistory = await open(metadata);
    await page.evaluate(id => window.followupSessionFixture.stressHeaderLayout(id), longHistory.conversationId);
    const collapsedHeader = await readableHeader(longHistory.conversationId);
    check(collapsedHeader.scopeFullyVisible && collapsedHeader.summaryFullyVisible && collapsedHeader.messageScrolls,
      `Long history clipped the follow-up scope or collapsed summary: ${JSON.stringify(collapsedHeader)}`);
    await page.screenshot({ path: 'output/playwright/followup-session-readable-header.png' });
    results.push({ longHistoryCollapsedHeader: collapsedHeader });

    await reload(320, 360);
    const compact = await open(metadata);
    await page.evaluate(id => window.followupSessionFixture.stressCompact(id), compact.conversationId);
    const controls = await dialog(compact.conversationId).evaluate(element => {
      const window = element.getBoundingClientRect();
      return [...element.querySelectorAll('.selection-chat-collapse, .selection-chat-close, .selection-chat-send, .selection-chat-replace, .selection-chat-resize, textarea')]
        .map(control => {
          const rect = control.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { name: control.getAttribute('aria-label') || control.textContent, visible: rect.width > 0 && rect.height > 0
            && rect.left >= window.left && rect.right <= window.right && rect.top >= window.top && rect.bottom <= window.bottom
            && (hit === control || control.contains(hit)) };
        });
    });
    check(controls.every(control => control.visible), `280x260 controls were clipped or covered: ${JSON.stringify(controls)}`);
    check(inside((await chatData(compact.conversationId)).rect, 320, 360), 'Compact floating chat overflowed the small viewport');
    const compactHeader = await readableHeader(compact.conversationId);
    check(compactHeader.scopeFullyVisible && compactHeader.summaryFullyVisible,
      `280x260 clipped its scope or reference summary: ${JSON.stringify(compactHeader)}`);
    await dialog(compact.conversationId).locator('.selection-chat-reference').evaluate(reference => { reference.scrollTop = reference.scrollHeight; });
    const compactScrolledHeader = await readableHeader(compact.conversationId);
    check(compactScrolledHeader.summaryFullyVisible, `Reference scrolling hid its compact summary: ${JSON.stringify(compactScrolledHeader)}`);
    await page.screenshot({ path: 'output/playwright/followup-session-compact.png' });
    results.push({ width: 280, height: 260, compactControls: controls, compactHeader, scrolledSummaryVisible: true, detachedNoticeWithinWindow: true });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await reload(544, 700);
    const reduced = await open(metadata);
    const motion = await page.evaluate(id => {
      const chat = window.followupSessionFixture.chat(id);
      chat.collapse();
      return window.followupSessionFixture.snapshot().chats.find(item => item.id === id);
    }, reduced.conversationId);
    check(motion.dockState === 'docked' && !motion.rect && motion.animations.length === 0, 'Reduced motion collapse did not settle synchronously without animation');
    await clickLauncher(reduced.conversationId);
    branch = await chatData(reduced.conversationId);
    check(branch.dockState === 'expanded' && branch.animations.length === 0 && inside(branch.rect, 544, 700), 'Reduced motion expansion left animation or invalid geometry');
    await send(reduced.conversationId, '减少动态效果时仍显示忙碌状态。', { hold: true, thinking: true });
    await page.evaluate(id => window.followupSessionFixture.chat(id).collapse(), reduced.conversationId); await docked(reduced.conversationId);
    await activityState(reduced.conversationId, 'thinking');
    const reducedThinking = await launcherPaint(reduced.conversationId);
    check(!reducedThinking.dotVisible && reducedThinking.animations.length === 0
      && reducedThinking.ringAnimation === 'none' && reducedThinking.iconAnimation === 'none',
      `Reduced motion still animated the thinking launcher: ${JSON.stringify(reducedThinking)}`);
    await page.evaluate(() => window.followupSessionFixture.advanceAnswers());
    await activityState(reduced.conversationId, 'answering');
    check((await launcherPaint(reduced.conversationId)).animations.length === 0, 'Reduced motion still animated the answering launcher');
    await page.evaluate(() => window.followupSessionFixture.releaseAnswers());
    await settled(reduced.conversationId); await activityState(reduced.conversationId, 'idle', true);
    check((await launcherPaint(reduced.conversationId)).dotVisible, 'Reduced motion removed the completed unread indicator');
    await clickLauncher(reduced.conversationId); await activityState(reduced.conversationId, 'idle');
    results.push({ reducedMotionImmediate: true, reducedMotionNoAnimations: true, reducedMotionPreservesActivityAndUnread: true });
    check((await snapshot()).errors.length === 0, 'Fixture reported a runtime error');
    const result = { passed: true, realRuntimeViewAndSessions: true, localOnly: true, results };
    await page.evaluate(value => {
      window.fixtureResult = value;
      document.querySelector('#result').textContent = '通过：连续追问、选区归属、解除跟随、拖动收起恢复、来源弹层、小窗与减少动画';
    }, result);
    return result;
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.unroute('**/*', localOnly);
  }
}
