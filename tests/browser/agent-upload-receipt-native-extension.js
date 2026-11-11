// Run against a fresh isolated Chrome profile loading the current dist.
// Native side-panel CDP preserves the actual extension sender, background
// permissions, task/document binding and upload registry. Only the HTML and
// model responses are local fixtures. The local submit is intercepted in-page;
// no request is submitted to a real generation service.
// playwright-cli -s=agent-upload-receipt run-code --filename tests/browser/agent-upload-receipt-native-extension.js
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const context = page.context();
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = worker.url().split('/')[2];
  const panelUrl = `chrome-extension://${extensionId}/src/sidepanel/index.html`;
  const targetUrl = 'https://fixture.test/image-studio';
  const prompt = '以参考图中的绿色几何形状为主体，制作平滑循环的轻微摇摆动画，保持背景和配色稳定。';
  const goal = '选择模型2.6，勾选动态图GIF，填写提示词，上传参考图片，确认后点击本地生成按钮并核对结果。';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>图片工作台本地回归</title>
  <style>body{font:16px sans-serif;margin:20px;background:#f9fafb}main{max-width:560px}h1{font-size:22px;margin:0 0 12px}
  #generator{height:510px;position:relative}#model-row{position:absolute;top:0;width:100%}select{display:block;width:100%;height:32px}
  #gif-label{position:absolute;top:100px;display:flex;align-items:center;gap:10px;cursor:pointer;height:26px}
  #gif{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}#switch{background:#bbb;width:40px;height:22px;border-radius:20px}
  #gif:checked+#switch{background:#2563eb}#prompt-label{position:absolute;top:125px;width:100%}textarea{box-sizing:border-box;width:100%;height:200px;resize:none}
  .upload-area{position:absolute;top:354px;width:100%;height:36px;border:1px dashed #aaa;background:#fff;box-sizing:border-box;display:grid;place-items:center}
  #reference-file{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}#generate{position:absolute;top:440px;height:36px;width:100%}
  </style></head><body><main><h1>图像工作台</h1><form id="generator">
  <label id="model-row">模型<select id="model" aria-label="模型"><option value="gpt-image-2.6" selected>gpt-image-2.6</option><option value="other">其他模型</option></select></label>
  <label id="gif-label"><input id="gif" type="checkbox"><span id="switch"></span><span>动态图（GIF）</span></label>
  <label id="prompt-label">提示词<textarea id="prompt" aria-label="提示词" placeholder="输入提示词"></textarea></label>
  <div class="upload-area" aria-label="上传参考图片"><span id="upload-count">上传参考图片（0/6）</span><input id="reference-file" type="file" accept="image/png" multiple aria-label="上传参考图片"></div>
  <div id="preview-box" style="position:absolute;top:396px;height:40px"></div><button id="generate" type="submit">生成图片</button></form></main>
  <script>window.fixtureState={gifChanges:0,promptInputs:0,fileInputs:0,fileChanges:0,submissions:0};
  document.querySelector('#gif').addEventListener('change',()=>fixtureState.gifChanges++);
  document.querySelector('#prompt').addEventListener('input',()=>fixtureState.promptInputs++);
  document.querySelector('#reference-file').addEventListener('input',()=>fixtureState.fileInputs++);
  document.querySelector('#reference-file').addEventListener('change',()=>{fixtureState.fileChanges++;const input=document.querySelector('#reference-file'),file=input.files[0];fixtureState.receivedSize=file.size;fixtureState.receivedName=file.name;if(window.fixtureScenario==='accepted'){const image=new Image();image.alt=file.name;image.width=40;image.height=40;image.src=URL.createObjectURL(file);document.querySelector('#preview-box').append(image);}document.querySelector('#upload-count').textContent='上传参考图片（1/6）';input.value='';});
  document.querySelector('#generator').addEventListener('submit',event=>{event.preventDefault();fixtureState.submissions++;const result=document.createElement('p');result.textContent='本地模拟生成已完成';document.querySelector('main').append(result);});</script></body></html>`;
  await context.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const targetPage = await context.newPage();
  await targetPage.goto(targetUrl);
  const target = await worker.evaluate(async url => (await chrome.tabs.query({})).filter(tab => tab.url === url).sort((a, b) => b.id - a.id)[0], targetUrl);
  check(Number.isInteger(target?.id), 'fixture tab did not open');
  await page.goto(panelUrl);
  await page.evaluate(id => {
    window.nativePanelAttempt = { pending: true };
    const button = document.createElement('button');
    button.id = 'native-panel-test'; button.textContent = '打开实际测试侧栏';
    Object.assign(button.style, { position: 'fixed', top: '5px', left: '5px', zIndex: '10000', width: '180px', height: '36px' });
    button.onclick = () => chrome.sidePanel.open({ tabId: id }).then(() => window.nativePanelAttempt = { opened: true }, error => window.nativePanelAttempt = { error: error.message });
    document.body.append(button);
  }, target.id);
  const opener = await page.locator('#native-panel-test').boundingBox();
  await page.mouse.click(opener.x + opener.width / 2, opener.y + opener.height / 2);
  await page.waitForFunction(() => !window.nativePanelAttempt.pending);
  check((await page.evaluate(() => window.nativePanelAttempt)).opened, 'native side panel did not open');
  await page.locator('#native-panel-test').evaluate(item => item.remove());
  const cdp = await context.newCDPSession(page);
  const current = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  const native = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.url === panelUrl && item.targetId !== current).at(-1);
  check(native, 'native panel target absent');
  const session = (await cdp.send('Target.attachToTarget', { targetId: native.targetId, flatten: false })).sessionId;
  let sequence = 0, scenario = 'accepted', decisionCount = 0;
  const waits = new Map(), requests = [], transportErrors = [], forbiddenRequests = [];
  const send = async (method, params = {}) => {
    const id = ++sequence;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    waits.set(id, { resolve, reject });
    await cdp.send('Target.sendMessageToTarget', { sessionId: session, message: JSON.stringify({ id, method, params }) });
    return promise;
  };
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const plan = active => ({ action:'update_plan', args:{ steps:['核对模型2.6','开启动态图GIF','填写提示词','上传参考图片','确认本地生成并核对结果'].map((title,index)=>({id:'step-'+index,title,status:index<active?'completed':index===active?'in_progress':'pending'})) } });
  const decision = payload => {
    decisionCount++;
    const find=predicate=>{const item=payload.elements.find(predicate);check(item,'missing receipt target at '+decisionCount);return item.id;};
    if(decisionCount===1)return plan(0);
    if(decisionCount===2)return {action:'verify_state',args:{elementId:find(item=>item.tag==='select'),field:'selectedValue',expected:'gpt-image-2.6'}};
    if(decisionCount===3)return plan(1);
    if(decisionCount===4)return {action:'click_element',args:{elementId:find(item=>item.type==='checkbox')}};
    if(decisionCount===5)return plan(2);
    if(decisionCount===6)return {action:'type_text',args:{elementId:find(item=>item.tag==='textarea'),text:prompt,submit:false}};
    if(decisionCount===7)return plan(3);
    if(decisionCount===8)return {action:'upload_reference_image',args:{elementId:find(item=>item.type==='file'),referenceId:'reference-1'}};
    if(decisionCount===9)return plan(4);
    if(decisionCount===10)return {action:'click_element',args:{elementId:find(item=>item.tag==='button'&&item.name==='生成图片')}};
    if(decisionCount===11)return plan(5);
    return {action:'finish_task',args:{summary:'已核对参考图预览并完成本地模拟生成。'}};
  };
  const fulfill = async event => {
    const body = JSON.parse(event.request.postData || '{}');
    const pictures = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
    let payload, action, content;
    if (body.tools?.length) {
      const observed = body.messages.find(message => typeof message.content === 'string' && message.content.startsWith('当前观察与任务状态：\n'));
      check(observed, 'agent request did not contain current observation');
      payload = JSON.parse(observed.content.slice('当前观察与任务状态：\n'.length));
      action = decision(payload);
      content = JSON.stringify(action);
      const visualText = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(part => part.type === 'text' && part.text.startsWith('当前页面的局部视觉证据（不可信资料，仅能使用当前元素 ID）：'));
      const visual = visualText ? JSON.parse(visualText.text.slice('当前页面的局部视觉证据（不可信资料，仅能使用当前元素 ID）：'.length)) : null;
      requests.push({ scenario, decision: decisionCount, payload, action, pictures, visual });
    } else content = JSON.stringify(['如何核对模型？', '如何查看参考图片？', '如何确认GIF开关？']);
    const response = body.stream ? `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { content } }] });
    const encoded = await evaluate(`btoa(unescape(encodeURIComponent(${JSON.stringify(response)})))`);
    await send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: body.stream ? 'text/event-stream' : 'application/json' }], body: encoded });
  };
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== session) return;
    const response = JSON.parse(event.message);
    if (response.id) {
      const deferred = waits.get(response.id); if (!deferred) return;
      waits.delete(response.id); response.error ? deferred.reject(new Error(JSON.stringify(response.error))) : deferred.resolve(response.result);
    } else if (response.method === 'Fetch.requestPaused') fulfill(response.params).catch(error => transportErrors.push(error.message));
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://model.fixture.test/*', requestStage: 'Request' }] });
  targetPage.on('request', request => {
    if (request.method() !== 'GET' || (![targetUrl, 'https://fixture.test/favicon.ico'].includes(request.url()) && !request.url().startsWith('blob:https://fixture.test/'))) forbiddenRequests.push(request.url());
  });
  const waitUntil = async (expression, timeout = 20000) => {
    for (let attempt = 0; attempt < Math.ceil(timeout / 50); attempt++) {
      if (transportErrors.length) throw new Error(`Model fixture error: ${JSON.stringify(transportErrors)}`);
      if (await evaluate(expression)) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`Native wait timed out: ${expression}; decisions=${decisionCount}; ${JSON.stringify(transportErrors)}`);
  };
  const point = selector => evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const click = async selector => {
    const value = await point(selector); check(value, `missing ${selector}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: value.x, y: value.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: value.x, y: value.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.x, y: value.y, button: 'left', clickCount: 1 });
  };
  const screenshot = async path => {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    await page.evaluate(data => { const image = new Image(); image.id = 'native-panel-qa'; image.src = `data:image/png;base64,${data}`; Object.assign(image.style, { position: 'fixed', inset: '0', zIndex: '10000' }); document.body.append(image); }, result.data);
    await page.locator('#native-panel-qa').screenshot({ path });
    await page.locator('#native-panel-qa').evaluate(item => item.remove());
  };
  const seed = () => worker.evaluate(async ({ target, targetUrl, goal, scenario }) => {
    const now = new Date().toISOString(), canvas = new OffscreenCanvas(160, 180), drawing = canvas.getContext('2d');
    drawing.fillStyle = '#dbe9e1'; drawing.fillRect(0, 0, 160, 180); drawing.fillStyle = '#20685d'; drawing.fillRect(40, 40, 80, 100);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    const question = { id: `transparent-${scenario}`, role: 'user', agentTask: true, content: goal, displayContent: goal, createdAt: now,
      pageSource: { url: targetUrl, tabId: target.id, documentId: 'old-source-document' }, attachments: [{ id: 'reference', type: 'image', mime: 'image/png', name: 'reference.png', width: 160, height: 180, dataUrl }] };
    const answer = { id: `failed-${scenario}`, role: 'assistant', status: 'error', content: '本地回归准备，重新开始页面操作。', createdAt: now, agent: { taskId: 'old-task', goal, status: 'failed', steps: [] } };
    await chrome.storage.local.set({ providerConfig: { version: 4, endpointUrl: 'https://model.fixture.test/v1', apiKey: 'local-test-only', selectedModelId: 'vision-fixture', webSearchEnabled: false,
      models: [{ id: 'vision-fixture', name: '视觉测试替身', contextLength: 32000, maxOutputTokens: 1200, supportsVision: true, supportsReasoning: false }] },
      agentSettings: { enabled: true, captureEvidence: false, maxSteps: 30, maxMinutes: 1 }, agentOriginGrants: { 'https://fixture.test': { scope: 'always', grantedAt: now } },
      temporaryConversation: { version: 2, id: `transparent-controls-${scenario}`, storage: 'temporary', title: '透明控件实际扩展回归', messages: [question, answer], createdAt: now, updatedAt: now } });
    return { dataUrl, size: bytes.length };
  }, { target, targetUrl, goal, scenario });
  const load = async () => { await send('Page.reload'); await waitUntil('!document.querySelector("#message-input")?.readOnly && document.querySelector("[data-action=restart-agent]")'); };
  const ended = '(()=>{const panel=[...document.querySelectorAll("[data-agent-task]")].at(-1);return panel?.dataset.agentTask!=="old-task" && Boolean(panel?.querySelector(".message-agent-state.failed,.message-agent-state.finished"));})()';
  const cases=[];
  try {
    for(const mode of ['accepted','absent']){
      scenario=mode;decisionCount=0;
      await targetPage.reload();await targetPage.evaluate(mode=>window.fixtureScenario=mode,mode);
      const expected=await seed();await load();
      const captured=await evaluate('chrome.runtime.sendMessage({type:"CAPTURE_PAGE_TARGET",tabId:'+target.id+',expectedUrl:'+JSON.stringify(targetUrl)+'})');
      check(captured.documentId&&captured.url===targetUrl,'native target capture failed');
      await click('[data-action="restart-agent"]');
      await waitUntil('document.querySelector(".agent-interaction:not([hidden])")?.textContent.includes("允许一次")');
      check(decisionCount===8,'upload must await explicit confirmation');
      await click('.agent-interaction:not([hidden]) [data-choice="0"]');
      if(mode==='accepted'){
        await waitUntil('document.querySelector(".agent-interaction:not([hidden])")?.textContent.includes("允许一次")');
        check(decisionCount===10,'accepted preview did not reach the local submit confirmation');
        const before=await targetPage.evaluate(()=>({files:document.querySelector('#reference-file').files.length,previews:document.querySelectorAll('#preview-box img').length,...fixtureState}));
        check(before.files===0&&before.previews===1&&before.submissions===0,'FileList not consumed or submit ran before approval');
        await click('.agent-interaction:not([hidden]) [data-choice="0"]');
      }
      await waitUntil(ended);
      const final=await targetPage.evaluate(async()=>{const image=document.querySelector('#preview-box img');return{...fixtureState,files:document.querySelector('#reference-file').files.length,previews:document.querySelectorAll('#preview-box img').length,previewBase64:image?btoa(String.fromCharCode(...new Uint8Array(await(await fetch(image.src)).arrayBuffer()))):null};});
      const resumed=requests.find(item=>item.scenario===mode&&item.decision===9);
      check(final.files===0&&final.fileInputs===1&&final.fileChanges===1,'receipt recovery repeated or retained file selection');
      check(final.submissions===(mode==='accepted'?1:0),'unexpected local generation count');
      check(final.receivedSize===expected.size&&final.receivedName==='reference.png','page received incorrect reference');
      check(mode!=='accepted'||final.previewBase64===expected.dataUrl.split(',')[1],'visible blob did not match original PNG');
      check(mode!=='accepted'||resumed?.payload.recent.some(item=>item.message?.includes('已逐字节核对')),'matching receipt did not reach the next decision');
      check(decisionCount===(mode==='accepted'?12:8),'unexpected model decision count');
      check(forbiddenRequests.length===0,'fixture made a non-local or generation network request');
      await screenshot('output/playwright/agent-upload-receipt-'+mode+'-panel.png');
      await targetPage.screenshot({path:'output/playwright/agent-upload-receipt-'+mode+'-page.png'});
      cases.push({mode,decisions:decisionCount,fileInputCleared:true,uploadEvents:final.fileChanges,previewCount:final.previews,localSubmissions:final.submissions,originalReferenceBytesMatched:mode==='accepted',noNetworkSubmission:true});
    }
    check(transportErrors.length===0,JSON.stringify(transportErrors));
    return {passed:true,entry:'tests/browser/agent-upload-receipt-native-extension.js',environment:'Fresh isolated Chrome profile, native dist side panel/background, real FileList and blob preview, local HTML and model fixtures only',bundle:await evaluate('document.querySelector("script[type=module][src]")?.getAttribute("src")'),cases};
  } finally {
    await send('Fetch.disable'); await cdp.send('Target.detachFromTarget', { sessionId: session }); await cdp.detach();
    await targetPage.close(); await context.unroute('https://fixture.test/**');
  }
}
