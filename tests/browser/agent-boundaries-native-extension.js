// Run with playwright-cli against an isolated profile loading current dist.
// Uses the native side panel as sender, the actual worker and content scanner.
// All tested websites are locally fulfilled fixtures; no model or real site is used.
async (page) => {
  const context = page.context();
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const panelUrl = `chrome-extension://${worker.url().split('/')[2]}/src/sidepanel/index.html`;
  const origin = 'https://boundary-fixture.test';
  const childOrigin = 'https://boundary-child.test';
  const results = [];
  const fixture = `<!doctype html><meta charset="utf-8"><title>Browser boundary regression</title>
  <style>body{font:16px sans-serif;margin:16px}test-box{display:block;margin:12px 0;height:52px;width:460px;position:relative}
  iframe{width:500px;height:90px;border:1px solid #999}.grid{display:grid;grid-template-columns:repeat(10,75px);gap:3px}.grid button{height:24px}</style>
  <h1>Browser boundary regression</h1><test-box id="single"></test-box><test-box id="nested"></test-box><test-box id="covered"></test-box><test-box id="input-host"></test-box><test-box id="choice-host"></test-box>
  <div id="many" class="grid"></div><iframe title="Authorized frame" src="${childOrigin}/frame"></iframe>
  <script>
  window.counts={single:0,nested:0,covered:0};
  for(const id of ['single','nested','covered']){
    const host=document.getElementById(id);const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML='<style>button{height:36px;width:170px}</style>';
    let target=shadow;
    if(id==='nested'){const inner=document.createElement('inner-box');inner.style.display='block';shadow.append(inner);target=inner.attachShadow({mode:'open'});}
    const button=document.createElement('button');button.type='button';button.textContent=id+' action';button.style.cssText='height:36px;width:170px';
    button.addEventListener('click',()=>counts[id]++);target.append(button);
    if(id==='covered'){const overlay=document.createElement('div');overlay.id='cover';overlay.style.cssText='position:absolute;inset:0;background:#ddd;z-index:10';overlay.textContent='Real covering layer';shadow.append(overlay);}
  }
  document.getElementById('input-host').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow query" style="width:220px;height:30px">';
  document.getElementById('choice-host').attachShadow({mode:'open'}).innerHTML='<label style="display:block;width:220px;height:32px;position:relative"><input type="checkbox" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px">Enable animation</label>';
  document.getElementById('many').innerHTML=Array.from({length:90},(_,i)=>'<button type="button">Item '+i+'</button>').join('');
  </script>`;
  await context.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await context.route(childOrigin + '/**', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><button id="child" type="button">Child action</button><script>window.clicks=0;document.querySelector("button").onclick=()=>clicks++</script>' }));
  const targetPage = await context.newPage();
  await targetPage.goto(origin + '/app');
  await targetPage.frameLocator('iframe').locator('#child').waitFor();
  const target = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), origin + '/app');
  check(target?.id, 'Target tab missing');
  await page.goto(panelUrl);
  await page.evaluate(tabId => {
    const button = document.createElement('button'); button.id = 'open-native-boundary-test'; button.textContent = 'Open native boundary test';
    button.style.cssText = 'position:fixed;top:0;left:0;z-index:10000;width:240px;height:40px';
    button.onclick = () => chrome.sidePanel.open({ tabId }).then(() => window.boundaryOpened = true, error => window.boundaryError = error.message);
    document.body.append(button);
  }, target.id);
  await page.locator('#open-native-boundary-test').click();
  await page.waitForFunction(() => window.boundaryOpened || window.boundaryError);
  check(await page.evaluate(() => window.boundaryOpened), 'Could not open native side panel');
  const cdp = await context.newCDPSession(page);
  const current = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  const native = (await cdp.send('Target.getTargets')).targetInfos.find(info => info.url === panelUrl && info.targetId !== current);
  check(native, 'Native side panel target missing');
  const sessionId = (await cdp.send('Target.attachToTarget', { targetId: native.targetId, flatten: false })).sessionId;
  const pending = new Map(); let sequence = 0;
  const onMessage = event => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message);
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    if (response.error) item.reject(new Error(response.error.message)); else item.resolve(response.result);
  };
  cdp.on('Target.receivedMessageFromTarget', onMessage);
  const evaluate = async expression => {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, timeout: 25000 } }) });
    const response = await result;
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  };
  const taskId = 'native-boundary-' + Date.now();
  const send = message => evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ taskId, tabId: target.id, ...message })})`);
  const authorize = async () => worker.evaluate(async ({ origin, childOrigin }) => {
    await chrome.storage.local.set({ agentSettings: { enabled: true, strictMode: false, maxSteps: 20, maxMinutes: 5 },
      agentOriginGrants: { [origin]: { scope: 'always' }, [childOrigin]: { scope: 'always' } } });
  }, { origin, childOrigin });
  try {
    await authorize();
    await targetPage.bringToFront();
    check((await send({ type: 'AGENT_START' })).ok, 'Agent start failed');
    let observation = await send({ type: 'AGENT_OBSERVE' });
    check(!observation.error, JSON.stringify(observation));
    results.push({ case: 'bounded coverage includes authorized child frame',
      passed: observation.elements.length <= 80 && observation.elements.some(item => item.frameId !== 0)
        && observation.metrics.scanTruncated === true && observation.metrics.candidateTruncated === true && observation.metrics.omittedCount > 0,
      returned: observation.elements.length, childCount: observation.elements.filter(item => item.frameId !== 0).length, metrics: observation.metrics });
    for (const id of ['single', 'nested', 'covered']) {
      observation = await send({ type: 'AGENT_OBSERVE' });
      const element = observation.elements.find(item => item.name === id + ' action');
      if (!element) { results.push({ case: id + ' shadow control', passed: false, error: 'not observed' }); continue; }
      const result = await send({ type: 'AGENT_ACT', actionId: id + '-click', expectedUrl: observation.url,
        snapshotId: observation.snapshotId, action: 'click_element', args: { elementId: element.id } });
      const count = await targetPage.evaluate(id => window.counts[id], id);
      results.push({ case: id + ' shadow control', passed: id === 'covered'
        ? result.error === 'ERR_ELEMENT_OCCLUDED' && count === 0 : result.ok === true && count === 1,
      clicks: count, error: result.error || null });
    }
    for (const [name, action, args, hostId] of [
      ['Shadow query', 'type_text', { text: 'local query', submit: false }, 'input-host'],
      ['Enable animation', 'click_element', {}, 'choice-host'],
    ]) {
      observation = await send({ type: 'AGENT_OBSERVE' });
      const element = observation.elements.find(item => item.name === name);
      if (!element) { results.push({ case: name, passed: false, error: 'not observed' }); continue; }
      const result = await send({ type: 'AGENT_ACT', actionId: hostId + '-action', expectedUrl: observation.url,
        snapshotId: observation.snapshotId, action, args: { ...args, elementId: element.id } });
      const state = await targetPage.evaluate(id => {
        const input = document.getElementById(id).shadowRoot.querySelector('input');
        return { valueMatches: input.value === 'local query', checked: input.checked };
      }, hostId);
      results.push({ case: name, passed: result.ok === true && (action === 'type_text' ? state.valueMatches : state.checked), error: result.error || null });
    }
    observation = await send({ type: 'AGENT_OBSERVE' });
    const child = observation.elements.find(item => item.name === 'Child action');
    if (!child) results.push({ case: 'actual storage revocation prevents child action', passed: false, error: 'child not observed' });
    else {
      await worker.evaluate(async origin => { await chrome.storage.local.set({ agentOriginGrants: { [origin]: { scope: 'always' } } }); }, origin);
      const revoked = await send({ type: 'AGENT_ACT', actionId: 'revoked-child-click', expectedUrl: observation.url,
        snapshotId: observation.snapshotId, action: 'click_element', args: { elementId: child.id } });
      const childClicks = await targetPage.frames().find(frame => frame.url().startsWith(childOrigin)).evaluate(() => window.clicks);
      results.push({ case: 'actual storage revocation prevents child action', passed: Boolean(revoked.error) && childClicks === 0,
        error: revoked.error, clicks: childClicks });
    }
    const cancelled = await send({ type: 'AGENT_CANCEL' });
    const late = await send({ type: 'AGENT_OBSERVE' });
    results.push({ case: 'cancelled task cannot observe again', passed: cancelled.ok === true && Boolean(late.error), error: late.error });
    await targetPage.screenshot({ path: 'output/playwright/agent-boundaries-native-extension.png' });
    check(results.every(item => item.passed), JSON.stringify({ passed: false, results }));
    return { passed: results.every(item => item.passed),
      environment: 'Isolated Chromium, actual dist/native side panel/background/scanner; locally fulfilled HTML; no model requests', results };
  } finally {
    await send({ type: 'AGENT_CANCEL' }).catch(() => {});
    for (const item of pending.values()) item.reject(new Error('Test ended'));
    cdp.off('Target.receivedMessageFromTarget', onMessage);
    await cdp.send('Target.detachFromTarget', { sessionId }); await cdp.detach();
    await targetPage.close();
    await context.unroute(origin + '/**'); await context.unroute(childOrigin + '/**');
  }
}
