import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("engine preview rejects stale or unsafe output and reuses leased pages within LRU bounds", async () => {
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    // A secure local origin supplies Web Crypto without a dev-server dependency.
    await page.route("http://localhost/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
    await page.goto("http://localhost");
    const source = await readFile(resolve(import.meta.dirname, "../../src/preview/enginePreview.ts"), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      .replace('import { nativeInvoke } from "../platform/ipc";', 'const nativeInvoke = () => { throw new Error("test requires explicit invoke"); };');
    const result = await page.evaluate(async (code) => {
      const { verifyPreview, EnginePreviewClient, EnginePageCache } = await import(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      const cursor = { documentId: "synthetic", contextId: "test", revision: "1", branchId: "main", headId: null };
      const hash = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2,"0")).join("");
      const makePage = async (content) => { const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${content}</svg>`; return { svg, pageHash: await hash(svg), widthPt: 100, heightPt: 100 }; };
      const first = await makePage('<path d="M0 0L10 10"/>');
      const frame = { cursor, renderKey: "a".repeat(64), data: { pages: [first], textMap: { version: 1, logicalText: "", clusters: [], hitRegions: [] } } };
      await verifyPreview(frame, cursor);
      await verifyPreview({...frame,data:{...frame.data,pages:[await makePage('<a href="mailto:synthetic@example.invalid"><path d="M0 0L10 10"/></a>')]}},cursor);
      const rejected = [];
      for (const mutate of [
        value => {value.cursor.revision = "0";},
        value => {value.data.pages[0].pageHash = "b".repeat(64);},
        async value => {value.data.pages[0] = await makePage('<script>alert(1)</script>');},
        async value => {value.data.pages[0] = await makePage('<image href="https://example.invalid/private"/>');},
        async value => {value.data.pages[0] = await makePage('<path onclick="alert(1)"/>');},
        value => {value.data.textMap.version = 2;},
        value => {value.data.textMap.hitRegions = [{sourceNodeId:"bad",semanticOrder:0,fragments:[{page:1,startUtf16:0,endUtf16:1,xPt:0,yPt:0,widthPt:10,heightPt:10}]}];},
        value => {value.data.textMap.logicalText="A";value.data.textMap.clusters=[{sourceNodeId:"link",startUtf16:0,endUtf16:1,logicalOrder:0,page:1,xPt:0,yPt:0,widthPt:10,heightPt:10}];value.data.textMap.links=[{sourceNodeId:"link",startUtf16:0,endUtf16:1,href:"javascript:alert(1)"}];},
        value => {value.data.textMap.logicalText="A";value.data.textMap.clusters=[{sourceNodeId:"link",startUtf16:0,endUtf16:1,logicalOrder:0,page:1,xPt:0,yPt:0,widthPt:10,heightPt:10}];value.data.textMap.links=[{sourceNodeId:"link",startUtf16:0,endUtf16:1,href:"https://user:password@example.invalid"}];},
      ]) { const value=structuredClone(frame); await mutate(value); try {await verifyPreview(value,cursor); rejected.push(false);} catch {rejected.push(true);} }
      const pending=[];
      const client=new EnginePreviewClient((command,args)=>new Promise(resolve=>pending.push({command,args,resolve})));
      const old=client.request(cursor); const superseded=client.request({...cursor,revision:"intermediate"});
      const nextCursor={...cursor,revision:"2"}; const fresh=client.request(nextCursor);
      const oneActive=pending.length===1;
      const replaced=await superseded;
      pending[0].resolve(frame); const obsolete=await old;
      pending[1].resolve({...frame,cursor:nextCursor}); const newest=await fresh;
      const cache=new EnginePageCache(100000,1);
      const a=cache.acquire(first); const b=cache.acquire(first); const reused=a.url===b.url;
      a.release(); const stillPinned=await fetch(b.url).then(r=>r.ok);
      const second=await makePage('<path d="M1 1L9 9"/>'); const c=cache.acquire(second);
      const activeSurvives=await fetch(b.url).then(r=>r.ok); b.release();
      const evicted=await fetch(b.url).then(()=>false,()=>true); c.release(); cache.dispose();
      const disposed=await fetch(c.url).then(()=>false,()=>true);
      return {rejected,obsolete,replaced,oneActive,nativeCalls:pending.length,newestCursor:newest.cursor,command:pending[0].command,reused,stillPinned,activeSurvives,evicted,disposed};
    }, code);
    assert.deepEqual(result.rejected, [true,true,true,true,true,true,true,true,true]);
    assert.equal(result.obsolete,null);
    assert.equal(result.replaced,null);
    assert.equal(result.oneActive,true);
    assert.equal(result.nativeCalls,2);
    assert.equal(result.newestCursor.revision,"2");
    assert.equal(result.command,"render_document_preview");
    for (const key of ["reused","stillPinned","activeSurvives","evicted","disposed"]) assert.equal(result[key],true,key);
  } finally { await browser.close(); }
});

test("SVG page consumer keeps physical scaling and unchanged page URLs across updates", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const address = server.httpServer.address();
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(`http://127.0.0.1:${address.port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,"0")).join("");
      const pages=[];
      for(let i=0;i<5;i++) {const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="595.276pt" height="841.89pt"><path d="M${i} 0L10 10"/></svg>`;pages.push({svg,pageHash:await hash(svg),widthPt:595.276,heightPt:841.89});}
      window.engineFixture={cursor:{documentId:"synthetic",contextId:"preview-test",revision:"1",branchId:"main",headId:null},renderKey:"a".repeat(64),data:{pages,textMap:{version:1,logicalText:"",clusters:[],hitRegions:[]}}};
      window.mountEnginePreview=(await import("/tests/browser/fixtures/mount-engine-preview.tsx")).mountEnginePreview;
      await window.mountEnginePreview(window.engineFixture,100);
    });
    await page.getByRole("img", { name: "简历第 5 页", exact: true }).waitFor();
    const initialUrls=await page.locator(".engine-preview-pages img").evaluateAll(nodes=>nodes.map(node=>node.src));
    await page.evaluate(()=>{window.initialEngineImages=[...document.querySelectorAll('.engine-preview-pages img')];});
    for(const viewport of [{width:640,height:480},{width:1440,height:900},{width:1920,height:1080}]) {
      await page.setViewportSize(viewport);
      for(const zoom of [20,100,200]) {
        await page.evaluate(async zoom=>window.mountEnginePreview(window.engineFixture,zoom),zoom);
        await page.waitForFunction(zoom=>Math.abs(document.querySelector('[data-page-number="1"]').getBoundingClientRect().width-595.276*4/3*zoom/100)<0.1,zoom);
        const first=await page.locator('[data-page-number="1"]').boundingBox();
        assert.ok(Math.abs(first.height-841.89*4/3*zoom/100)<0.1);
        assert.deepEqual(await page.locator(".engine-preview-pages img").evaluateAll(nodes=>nodes.map(node=>node.src)),initialUrls);
      }
    }
    await page.evaluate(async()=>{
      const next=structuredClone(window.engineFixture);next.cursor.revision="2";next.renderKey="b".repeat(64);
      const svg=next.data.pages[0].svg.replace('M0 0','M7 0');next.data.pages[0].svg=svg;
      next.data.pages[0].pageHash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(svg)))).map(b=>b.toString(16).padStart(2,"0")).join("");
      await window.mountEnginePreview(next,100);
    });
    await page.waitForFunction(old=>{const image=document.querySelector(".engine-preview-pages img");return !!image && image.src!==old;},initialUrls[0]);
    const nextUrls=await page.locator(".engine-preview-pages img").evaluateAll(nodes=>nodes.map(node=>node.src));
    assert.deepEqual(nextUrls.slice(1),initialUrls.slice(1),"unchanged pages reuse their existing URLs");
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.engine-preview-pages img')].slice(1).every((node,index)=>node===window.initialEngineImages[index+1])),true,'unchanged pages retain their actual DOM image nodes');
    await page.evaluate(async()=>{
      const frame=structuredClone(window.engineFixture);frame.renderKey='d'.repeat(64);frame.data.pages=[];
      for(let i=0;i<40;i++) {const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="100pt"><path d="M${i} 0L10 10"/></svg>`;const pageHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(svg)))).map(b=>b.toString(16).padStart(2,'0')).join('');frame.data.pages.push({svg,pageHash,widthPt:100,heightPt:100});}
      window.largeEngineFrame=frame;await window.mountEnginePreview(frame,100);
    });
    await page.getByRole('img',{name:'简历第 40 页',exact:true}).waitFor();
    const largeUrls=await page.locator('.engine-preview-pages img').evaluateAll(nodes=>nodes.map(node=>node.src));
    await page.evaluate(async()=>{
      const frame=structuredClone(window.largeEngineFrame);frame.renderKey='e'.repeat(64);frame.data.pages[39].svg=frame.data.pages[39].svg.replace('M39 0','M99 0');frame.data.pages[39].pageHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(frame.data.pages[39].svg)))).map(b=>b.toString(16).padStart(2,'0')).join('');await window.mountEnginePreview(frame,100);
    });
    await page.waitForFunction(()=>document.querySelector('.engine-preview-pages').dataset.renderKey==='e'.repeat(64));
    assert.deepEqual((await page.locator('.engine-preview-pages img').evaluateAll(nodes=>nodes.map(node=>node.src))).slice(0,39),largeUrls.slice(0,39),'active frames above the 32-page cache budget retain unchanged leases while swapping');
  } finally { await browser.close(); await server.close(); }
});

test("engine selection copies exact UTF-16 text across pages in both directions and restores focus", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      const button = document.createElement('button'); button.id = 'previous-focus'; button.textContent = '返回编辑'; document.body.prepend(button);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="100pt"><path d="M0 0L10 10"/></svg>';
      const pageHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(svg)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const box = (page,startUtf16,endUtf16,xPt,widthPt,logicalOrder) => ({page,startUtf16,endUtf16,xPt,widthPt,yPt:20,heightPt:12,logicalOrder,sourceNodeId:page===1?'entry:one:title':'entry:two:title'});
      const clusters=[box(1,0,1,20,12,0),box(1,1,3,32,24,1),box(2,4,5,20,12,2),box(2,5,6,32,12,3)];
      window.selectionFixture={cursor:{documentId:'synthetic',contextId:'selection',revision:'1',branchId:'main',headId:null},renderKey:'c'.repeat(64),data:{pages:[1,2].map(()=>({svg,pageHash,widthPt:100,heightPt:100})),textMap:{version:1,logicalText:'A😀\n第二',clusters,hitRegions:[{sourceNodeId:'entry:one',semanticOrder:0,fragments:[clusters[0],clusters[1]]},{sourceNodeId:'entry:two',semanticOrder:1,fragments:[clusters[2],clusters[3]]}],links:[{sourceNodeId:'entry:two:title',startUtf16:4,endUtf16:6,href:'https://example.invalid/synthetic'}]}}};
      window.mountEnginePreview=(await import('/tests/browser/fixtures/mount-engine-preview.tsx')).mountEnginePreview;
      await window.mountEnginePreview(window.selectionFixture,100);
    });
    await page.getByRole('img',{name:'简历第 2 页',exact:true}).waitFor();
    for(const zoom of [100,200,20]) {
      await page.evaluate(zoom=>window.mountEnginePreview(window.selectionFixture,zoom),zoom);
      await page.waitForFunction(zoom=>Math.abs(document.querySelector('[data-page-number="1"]').getBoundingClientRect().width-100*4/3*zoom/100)<.1,zoom);
      const boxes=await page.locator('[data-page-number]').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y};}));
      const scale=4/3*zoom/100;
      const start={x:boxes[0].x+20*scale,y:boxes[0].y+26*scale};
      const end={x:boxes[1].x+44*scale,y:boxes[1].y+26*scale};
      for(const [a,b] of [[start,end],[end,start]]) {
        await page.locator('#previous-focus').focus();
        await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();
        await page.waitForFunction(()=>document.querySelectorAll('[data-selection-fragment]').length===4);
        const copied=await page.locator('.engine-preview-pages').evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('text/plain');});
        assert.equal(copied,'A😀\n第二');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#previous-focus').evaluate(node=>node===document.activeElement),true);
        assert.equal(await page.locator('[data-selection-fragment]').count(),0);
      }
    }
    await page.getByText('按内容定位',{exact:true}).click();
    await page.locator('[data-source-node-id="entry:one"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('[data-source-node-id="entry:two"]').evaluate(node=>node===document.activeElement),true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#root').getAttribute('data-located-node'),'entry:two');
    assert.equal(await page.locator('[data-hit-source="entry:two"]').count(),2);
    await page.getByRole('link',{name:'第二',exact:true}).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#root').getAttribute('data-opened-link'),'https://example.invalid/synthetic');
    await page.evaluate(async()=>{delete document.getElementById('root').dataset.openedLink;delete document.getElementById('root').dataset.locatedNode;await window.mountEnginePreview(window.selectionFixture,100);});
    await page.waitForFunction(()=>Math.abs(document.querySelector('[data-page-number="2"]').getBoundingClientRect().width-100*4/3)<.1);
    const paper=await page.locator('[data-page-number="2"]').boundingBox();
    await page.mouse.move(paper.x+25*4/3,paper.y+26*4/3);
    await page.waitForFunction(()=>document.querySelectorAll('[data-hit-source="entry:two"]').length===2);
    await page.mouse.move(paper.x+25*4/3,paper.y+45*4/3);
    await page.waitForFunction(()=>document.querySelectorAll('[data-hit-source]').length===0);
    await page.mouse.click(paper.x+25*4/3,paper.y+45*4/3);
    assert.equal(await page.locator('#root').getAttribute('data-located-node'),null,'blank paper does not locate a neighbouring region');
    assert.equal(await page.locator('#root').getAttribute('data-opened-link'),null,'blank paper does not open a neighbouring link');
    await page.mouse.click(paper.x+25*4/3,paper.y+26*4/3);
    assert.equal(await page.locator('#root').getAttribute('data-opened-link'),'https://example.invalid/synthetic','paper link resolves the complete domain destination');
    await page.evaluate(async()=>{
      const viewport=document.createElement('div');viewport.id='selection-scrollport';viewport.style.cssText='width:260px;height:220px;overflow:auto';const root=document.getElementById('root');root.before(viewport);viewport.append(root);
      const frame=structuredClone(window.selectionFixture);frame.renderKey='f'.repeat(64);
      for(const page of frame.data.pages){page.heightPt=600;page.svg=page.svg.replace('height="100pt"','height="600pt"');page.pageHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(page.svg)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
      await window.mountEnginePreview(frame,100);
    });
    await page.waitForFunction(()=>document.querySelector('.engine-preview-pages').dataset.renderKey==='f'.repeat(64));
    const firstPaper=await page.locator('[data-page-number="1"]').boundingBox();
    await page.mouse.move(firstPaper.x+20*4/3,firstPaper.y+26*4/3);await page.mouse.down();
    await page.mouse.move(firstPaper.x+44*4/3,firstPaper.y+26*4/3);
    await page.mouse.wheel(0,816);
    await page.waitForFunction(()=>document.querySelector('#selection-scrollport').scrollTop>=800 && document.querySelectorAll('[data-selection-fragment]').length===4);
    const scrolledCopy=await page.locator('.engine-preview-pages').evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('text/plain');});
    assert.equal(scrolledCopy,'A😀\n第二','stationary captured pointer extends the selection when its scroll container moves');
    await page.mouse.up();
  } finally { await browser.close(); await server.close(); }
});

test("mixed-direction preview maps RTL caret edges while preserving logical clipboard order", async () => {
  const server=await createBrowserTestServer(resolve(import.meta.dirname,'../..'));await listenForBrowserTestServer(server);
  const browser=await launchBrowserTestChromium({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:640,height:480}});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async()=>{
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="150pt" height="100pt"><path d="M0 0L10 10"/></svg>';
      const pageHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(svg)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const logicalText='Aאבג 123Z';const positions=[8,44,32,20,56,68,80,92,104];
      const clusters=positions.map((xPt,index)=>({sourceNodeId:'section:bidi:b0:l0',startUtf16:index,endUtf16:index+1,logicalOrder:index,page:1,xPt,yPt:20,widthPt:12,heightPt:12,rtl:index>=1&&index<=3}));
      const frame={cursor:{documentId:'synthetic',contextId:'bidi',revision:'1',branchId:'main',headId:null},renderKey:'7'.repeat(64),data:{pages:[{svg,pageHash,widthPt:150,heightPt:100}],textMap:{version:1,logicalText,clusters,hitRegions:[{sourceNodeId:'section:bidi',semanticOrder:0,fragments:clusters}],links:[]}}};
      window.mountBidi=(await import('/tests/browser/fixtures/mount-engine-preview.tsx')).mountEnginePreview;window.bidiFrame=frame;
      await window.mountBidi(frame,100);
    });
    await page.getByRole('img',{name:'简历第 1 页',exact:true}).waitFor();
    for(const zoom of [20,100,200]) {
      await page.evaluate(zoom=>window.mountBidi(window.bidiFrame,zoom),zoom);
      await page.waitForFunction(zoom=>Math.abs(document.querySelector('[data-page-number="1"]').getBoundingClientRect().width-150*4/3*zoom/100)<.1,zoom);
      const rect=await page.locator('[data-page-number="1"]').boundingBox();const scale=4/3*zoom/100;
      for(const [start,end] of [[55,21],[21,55]]) {
        await page.mouse.move(rect.x+start*scale,rect.y+26*scale);await page.mouse.down();await page.mouse.move(rect.x+end*scale,rect.y+26*scale,{steps:10});await page.mouse.up();
        const copied=await page.locator('.engine-preview-pages').evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('text/plain');});
        assert.equal(copied,'אבג');
        assert.equal(await page.locator('[data-selection-fragment]').count(),3);
        await page.keyboard.press('Escape');
      }
    }
  } finally {await browser.close();await server.close();}
});
