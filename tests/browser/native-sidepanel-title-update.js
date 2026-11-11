// Run after native-sidepanel-title-probe.js in its isolated session.
// Only the native content document.title changes; Chrome native UI is read separately.
async (page) => {
  const context = page.context(), worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  const panelUrl = `chrome-extension://${worker.url().split('/')[2]}/src/sidepanel/index.html`;
  const cdp = await context.newCDPSession(page), current = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  const native = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.url === panelUrl && item.targetId !== current).at(-1);
  if (!native) throw new Error('Native sidepanel is not open');
  const session = (await cdp.send('Target.attachToTarget', { targetId: native.targetId, flatten: false })).sessionId;
  let sequence = 0; const waits = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== session) return; const response = JSON.parse(event.message), pending = waits.get(response.id);
    if (!pending) return; waits.delete(response.id); response.error ? pending.reject(new Error(JSON.stringify(response.error))) : pending.resolve(response.result);
  });
  const evaluate = async expression => {
    const id = ++sequence; let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; }); waits.set(id, { resolve, reject });
    await cdp.send('Target.sendMessageToTarget', { sessionId: session, message: JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true } }) });
    const response = await pending; if (response.exceptionDetails) throw new Error(response.exceptionDetails.text); return response.result.value;
  };
  try {
    const document = await evaluate('(()=>{const before=document.title;document.title="动态会话标题：仅内容文档更改";return {before,after:document.title,heading:document.querySelector("#conversation-title")?.textContent,manifestName:chrome.runtime.getManifest().name};})()');
    await page.waitForTimeout(150);
    const targetInfo = (await cdp.send('Target.getTargetInfo', { targetId: native.targetId })).targetInfo;
    const options = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
    return { stage: 'after-document-title', nativeTarget: native.targetId, targetTitleBefore: native.title, targetTitleAfter: targetInfo.title,
      document, sidePanelOptions: options, note: 'Target/document titles are content metadata; native Chrome header requires OS UI/source verification.' };
  } finally { await cdp.send('Target.detachFromTarget', { sessionId: session }); await cdp.detach(); }
}
