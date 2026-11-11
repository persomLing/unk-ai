// Separate isolated headed Chromium profile. Only fixture storage/document title
// is changed. Read the OS-native sidebar header before and after with Computer Use.
// playwright-cli -s=native-sidepanel-title-probe run-code --filename tests/browser/native-sidepanel-title-probe.js
async (page) => {
  const context = page.context(), check = (value, message) => { if (!value) throw new Error(message); };
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2], panelUrl = `chrome-extension://${extensionId}/src/sidepanel/index.html`;
  const fixtureUrl = 'https://native-title.fixture.test/probe';
  await context.route('https://native-title.fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><meta charset="utf-8"><title>UNK AI Native Title Probe</title></head><body><h1>UNK AI 原生侧栏标题独立实验</h1><p>此页面仅供原生标题检查，不发送模型请求。</p></body></html>' }));
  const fixturePage = await context.newPage(); await fixturePage.goto(fixtureUrl);
  const target = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), fixtureUrl);
  check(target?.id, 'fixture tab missing');
  await worker.evaluate(async () => {
    const now = new Date().toISOString();
    await chrome.storage.local.set({ temporaryConversation: { version: 2, id: 'native-sidepanel-title-probe', storage: 'temporary',
      title: '会话标题：局部页面与原生标题实验', createdAt: now, updatedAt: now,
      messages: [{ id: 'q', role: 'user', content: '这是一条测试提问。', createdAt: now },
        { id: 'a', role: 'assistant', content: '本地测试内容。', status: 'complete', createdAt: now }] } });
  });
  await page.goto(panelUrl);
  await page.evaluate(tabId => {
    const button = document.createElement('button'); button.id = 'native-title-open'; button.textContent = '打开独立测试侧栏';
    Object.assign(button.style, { position: 'fixed', top: '5px', left: '5px', zIndex: '10000', width: '180px', height: '36px' });
    button.onclick = () => chrome.sidePanel.open({ tabId }).then(() => window.nativeTitleOpened = true);
    document.body.append(button);
  }, target.id);
  await page.locator('#native-title-open').click(); await page.waitForFunction(() => window.nativeTitleOpened === true);
  await page.locator('#native-title-open').evaluate(item => item.remove());
  await fixturePage.bringToFront();
  const cdp = await context.newCDPSession(page), current = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  const native = targets.filter(item => item.url === panelUrl && item.targetId !== current).at(-1);
  check(native, 'native sidepanel target absent');
  const session = (await cdp.send('Target.attachToTarget', { targetId: native.targetId, flatten: false })).sessionId;
  let sequence = 0; const waits = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== session) return; const response = JSON.parse(event.message), pending = waits.get(response.id);
    if (!pending) return; waits.delete(response.id); response.error ? pending.reject(new Error(JSON.stringify(response.error))) : pending.resolve(response.result);
  });
  const evaluate = async expression => {
    const id = ++sequence; let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    waits.set(id, { resolve, reject });
    await cdp.send('Target.sendMessageToTarget', { sessionId: session, message: JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }) });
    const response = await pending; if (response.exceptionDetails) throw new Error(response.exceptionDetails.text); return response.result.value;
  };
  const document = await evaluate('({title:document.title,heading:document.querySelector("#conversation-title")?.textContent,manifestName:chrome.runtime.getManifest().name,sidePanelMethods:Object.keys(chrome.sidePanel)})');
  await cdp.send('Target.detachFromTarget', { sessionId: session }); await cdp.detach();
  return { stage: 'before', extensionId, fixtureTab: target.id, fixtureUrl, nativeTarget: native.targetId,
    targetTitle: native.title, document, browserVersion: context.browser()?.version(), windowHint: 'UNK AI Native Title Probe - Chromium' };
}
