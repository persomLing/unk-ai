// Run only in an isolated persistent Chromium profile with dist loaded as an
// unpacked extension. This seeds that profile's temporary conversation.
// playwright-cli -s=user-copy-extension run-code --filename tests/browser/user-message-copy-extension.js
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const clipboardText = async () => (await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n');
  const context = page.context();
  let worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  const origin = `chrome-extension://${extensionId}`;
  // CDP cannot grant to a chrome-extension origin explicitly; this isolated
  // profile grants readback permission across its test context instead.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await worker.evaluate(async () => {
    const now = new Date().toISOString();
    const canvas = new OffscreenCanvas(160, 180);
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = '#dbe9e1'; drawing.fillRect(0, 0, 160, 180);
    drawing.fillStyle = '#20685d'; drawing.fillRect(40, 40, 80, 100);
    const blob = await canvas.convertToBlob({type:'image/png'});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    const questions = [
      {id:'copy-long',role:'user',content:'模型上下文里的资料，不应混入复制的原始问题。',displayContent:'复制提问回归：请说明页面配置。\n第二行保留换行、标点和中文。'.repeat(3)},
      {id:'copy-image',role:'user',content:'请参考附件图片，并说明配置。\n复制只包含提问文字。',attachments:[{id:'ref',type:'image',mime:'image/png',name:'reference.png',width:160,height:180,dataUrl}]},
      {id:'copy-narrow',role:'user',content:'嗯'},
      {id:'copy-extra-1',role:'user',content:'第四轮用于保持真实轮次导航和消息滚动区域。'},
      {id:'copy-extra-2',role:'user',content:'第五轮用于保持真实轮次导航和消息滚动区域。'},
    ];
    const messages = questions.flatMap(question => [{...question,createdAt:now}, {id:`${question.id}-answer`,role:'assistant',content:'这是相邻回答，用于确认复制按钮不改变消息布局。',status:'complete',createdAt:now}]);
    await chrome.storage.local.set({temporaryConversation:{version:2,id:'copy-extension-regression',storage:'temporary',title:'实际扩展复制与轮次导航回归',messages,createdAt:now,updatedAt:now}});
  });
  await page.goto(`${origin}/src/sidepanel/index.html`);
  await page.waitForFunction(() => !document.querySelector('#message-input')?.readOnly && document.querySelector('[data-message-id="copy-long"].user-message'));
  await page.evaluate(async () => {
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.userCopyWrites = [];
    window.userCopyCompletions = [];
    window.userCopyFailures = [];
    window.userCopyGestures = [];
    navigator.clipboard.writeText = text => {
      window.userCopyWrites.push(text);
      window.userCopyGestures.push(navigator.userActivation.isActive);
      return nativeWrite(text).then(() => window.userCopyCompletions.push(text), error => { window.userCopyFailures.push(error.message); throw error; });
    };
    // Readback is safe to report only after replacing any prior clipboard data.
    await nativeWrite('UNK AI copy regression sentinel');
  });
  const expected = await worker.evaluate(async () => (await chrome.storage.local.get('temporaryConversation')).temporaryConversation.messages.filter(message => message.role === 'user').map(message => ({id:message.id,text:message.displayContent ?? message.content})));
  const rect = async id => page.evaluate(id => {
    const article = document.querySelector(`.user-message[data-message-id="${id}"]`);
    const button = article.querySelector('[data-action="copy-user"]');
    const actions = article.querySelector('.user-message-actions');
    const box = element => element.getBoundingClientRect().toJSON();
    const buttonRect = box(button);
    const x=buttonRect.left+buttonRect.width/2,y=buttonRect.top+buttonRect.height/2;
    const hit=document.elementFromPoint(x,y);
    return {article:box(article),next:box(article.nextElementSibling),button:buttonRect,x,y,hovered:article.matches(':hover'),opacity:Number(getComputedStyle(actions).opacity),pointer:getComputedStyle(actions).pointerEvents,hitAction:hit?.closest('[data-action]')?.dataset.action,hitId:hit?.id,hitClass:hit?.getAttribute('class')};
  },id);
  const layoutMatches = (before,after,id) => {
    for (const key of ['article','next']) for (const field of ['x','y','width','height']) check(Math.abs(before[key][field]-after[key][field])<0.75,`${id}: ${key}.${field} shifted during copying`);
  };
  const copied = [];
  for (const question of expected.slice(0,3)) {
    await page.mouse.move(1,1);
    await page.evaluate(id => {
      document.activeElement?.blur();
      const view=document.querySelector('#conversation-view'),article=document.querySelector(`.user-message[data-message-id="${id}"]`);
      view.scrollTop += article.getBoundingClientRect().top-view.getBoundingClientRect().top-36;
    },question.id);
    await page.waitForTimeout(200);
    const before = await rect(question.id);
    const start={x:before.article.left+before.article.width/2,y:before.article.bottom-12};
    await page.mouse.move(start.x,start.y);
    await page.waitForTimeout(200);
    let current=await rect(question.id);
    check(current.hitAction==='copy-user',`${question.id}: copy button intercepted by ${current.hitId||current.hitClass}`);
    check(current.button.width===28&&current.button.height===28,`${question.id}: copy target was compressed`);
    // Every slow movement step checks the real production rail and toolbar.
    for(let step=1;step<=20;step++) {
      await page.mouse.move(start.x+(current.x-start.x)*step/20,start.y+(current.y-start.y)*step/20);
      await page.waitForTimeout(45);
      const point=await rect(question.id);
      check(point.hovered&&point.opacity>=.98&&point.pointer==='auto',`${question.id}: disappeared at movement step ${step}`);
    }
    // Test production writes with the real user gesture and no test permission.
    // Permission is added afterward only for native clipboard readback.
    await context.clearPermissions();
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(count=>window.userCopyWrites.length===count,copied.length+1);
    await page.waitForFunction(count=>window.userCopyCompletions.length===count||window.userCopyFailures.length,copied.length+1);
    check((await page.evaluate(()=>window.userCopyFailures)).length===0,`${question.id}: native clipboard write failed`);
    await context.grantPermissions(['clipboard-read']);
    // Windows' native clipboard stores line endings as CRLF.
    const text=await clipboardText();
    check(text===question.text.replaceAll('\r\n','\n'),`${question.id}: native clipboard did not contain the original question`);
    copied.push(question.text);
    check(JSON.stringify(await page.evaluate(()=>window.userCopyWrites))===JSON.stringify(copied),`${question.id}: clipboard write was duplicated or attributed to another message`);
    check(await page.getByText('提问内容已复制',{exact:true}).count()>=1,`${question.id}: successful copy feedback missing`);
    layoutMatches(before,await rect(question.id),question.id);
  }
  // Align a copy target with a rail item to expose an oversized item hit box.
  await page.mouse.move(1,1);
  await page.evaluate(() => {
    document.activeElement?.blur();
    const view=document.querySelector('#conversation-view');
    const button=document.querySelector('[data-message-id="copy-image"] [data-action="copy-user"]');
    const item=document.querySelector('.turn-navigator-item');
    const copy=button.getBoundingClientRect(),rail=item.getBoundingClientRect();
    view.scrollTop += copy.top+copy.height/2-rail.top-rail.height/2;
  });
  await page.waitForTimeout(200);
  const aligned=await rect('copy-image');
  await page.mouse.move(aligned.article.left+aligned.article.width/2,aligned.article.bottom-12);
  await page.waitForTimeout(200);
  const alignedHit=await rect('copy-image');
  check(alignedHit.hitAction==='copy-user',`rail item still intercepts copy at the same vertical position: ${alignedHit.hitClass}`);
  // The visible gutter mark itself must still respond to hover and navigation.
  const railPoint=await page.evaluate(()=>{const r=document.querySelector('.turn-navigator-item').getBoundingClientRect();return{x:r.right-3,y:r.top+r.height/2};});
  await page.mouse.move(railPoint.x,railPoint.y);
  await page.waitForFunction(()=>!document.querySelector('#turn-preview').hidden);
  await page.mouse.down();await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#turn-preview').hidden);
  await page.waitForTimeout(600);
  const navigation=await page.evaluate(()=>{const view=document.querySelector('#conversation-view'),article=document.querySelector('.user-message');return{offset:article.getBoundingClientRect().top-view.getBoundingClientRect().top,railPointer:getComputedStyle(document.querySelector('#turn-navigator')).pointerEvents};});
  check(Math.abs(navigation.offset-12)<2,'rail mark did not navigate to its original question');
  // Copy after a hovered (visually expanded) mark must still hit the button.
  const afterNavigation=await rect('copy-long');
  await page.mouse.move(afterNavigation.article.left+afterNavigation.article.width/2,afterNavigation.article.bottom-12);
  await page.waitForTimeout(200);
  check((await rect('copy-long')).hitAction==='copy-user','expanded rail mark left a hit region over copy');
  await page.mouse.move(1,1);
  await page.locator('[data-message-id="copy-long"] [data-action="copy-user"]').focus();
  await context.clearPermissions();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.userCopyCompletions.length===4);
  await context.grantPermissions(['clipboard-read']);
  check(await clipboardText()===expected[0].text.replaceAll('\r\n','\n'),'keyboard copy failed');
  check(JSON.stringify(await page.evaluate(()=>window.userCopyWrites))===JSON.stringify([...copied,expected[0].text]),'keyboard activation duplicated the write');
  check((await page.evaluate(()=>window.userCopyGestures)).every(Boolean),'clipboard writes must start inside the actual user gesture');
  const viewport=page.viewportSize();
  await page.screenshot({path:`output/playwright/user-copy-extension-after-${viewport.width}.png`});
  return {passed:true,extensionId,viewport,actualClipboardCopies:4,questions:['long','image','narrow'],checks:['production click delegation','native clipboard readback','one write per activation','slow pointer path','rail background hit testing','rail item overlap','rail hover/click navigation','keyboard copy','stable message layout']};
}
