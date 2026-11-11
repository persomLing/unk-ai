// Serve with Vite, open /tests/browser/agent-visual-crop.html in an isolated
// Chromium context with deviceScaleFactor 1, then repeat at 2.
// playwright-cli -s=agent-crop run-code --filename tests/browser/agent-visual-crop.js
async (page) => {
  const current=new URL(page.url());
  if(current.hostname!=='127.0.0.1'||!current.pathname.endsWith('/tests/browser/agent-visual-crop.html')) throw new Error('Use the isolated loopback crop fixture.');
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort('blockedbyclient'));
  await page.waitForFunction(()=>document.documentElement.dataset.fixtureReady==='true',undefined,{timeout:10000});
  const result=await page.evaluate(()=>window.runAgentVisualCrop());
  if(!result.passed||result.results.length!==4) throw new Error('Incomplete crop result.');
  for(const scenario of result.results) {
    const [download]=await Promise.all([page.waitForEvent('download',{timeout:10000}),page.locator(`#download-${scenario.id}`).click()]);
    await download.saveAs(`output/playwright/agent-visual-crop-${result.dpi}-${scenario.id}.jpg`);
  }
  const [source]=await Promise.all([page.waitForEvent('download',{timeout:10000}),page.locator('#download-source').click()]);
  await source.saveAs(`output/playwright/agent-visual-crop-source-${result.dpi}.png`);
  await page.screenshot({path:`output/playwright/agent-visual-crop-qa-${result.dpi}.png`,fullPage:true});
  return result;
}
