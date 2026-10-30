import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {chromium} from 'playwright-core';

const bundle=fs.readFileSync(new URL('../dist/discussionbridge-rich-content.js',import.meta.url),'utf8');
test('actual Hugo rich renderer keeps strict diagrams, local math and unsuccessful math source',async()=>{
  const executablePath=process.env.DISCUSSIONBRIDGE_BROWSER_EXECUTABLE;
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{channel:'chrome'})});
  try {
    const context=await browser.newContext({serviceWorkers:'block'}),requests=[];
    await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
    const page=await context.newPage();
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><article></article></body></html>');
    await page.evaluate(()=>{
      window.__bridgeXss=0;
      for(const source of ['flowchart LR\n A[Source] --> B[Destination]','flowchart TD\n A["<img src=x onerror=window.__bridgeXss=1>"] --> B[Safe]','flowchart LR\n A["$$x^2$$"] --> B[Done]']) {
        const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-mermaid';code.textContent=source;pre.append(code);document.querySelector('article').append(pre);
      }
      for(const source of ['\\int_0^1 x^2\\,dx=\\frac{1}{3}','\\href{javascript:window.__bridgeXss=1}{unsafe}','\\notARealMathCommand{']) {
        const math=document.createElement('div');math.className='math';math.textContent=source;document.querySelector('article').append(math);
      }
    });
    await page.addScriptTag({content:bundle});
    await page.waitForFunction(()=>document.querySelectorAll('.discussionbridge-mermaid svg').length===3&&document.querySelectorAll('article .katex-mathml').length>=2,undefined,{timeout:20000});
    const result=await page.evaluate(()=>({diagrams:document.querySelectorAll('.discussionbridge-mermaid svg').length,mathml:document.querySelectorAll('article .katex-mathml').length,
      xss:window.__bridgeXss,active:document.querySelectorAll('article script, article [onerror], article [onclick], article a[href^="javascript:"]').length,
      failedSource:[...document.querySelectorAll('article .katex-error')].some(node=>node.textContent==='\\notARealMathCommand{'),styles:[...document.head.querySelectorAll('style')].map(node=>node.textContent).join('\n')}));
    assert.equal(result.diagrams,3);assert.ok(result.mathml>=2);assert.equal(result.xss,0);assert.equal(result.active,0);assert.equal(result.failedSource,true);assert.match(result.styles,/data:font\//);assert.deepEqual(requests,[]);
    console.log(JSON.stringify({diagrams:result.diagrams,mathml:result.mathml,unsafeExecution:result.xss,networkRequests:requests.length,failedSourcePreserved:result.failedSource}));
  } finally {await browser.close();}
});
