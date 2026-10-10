import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { launchBrowserTestChromium } from "../tests/browser/fixtures/browser-test-server.mjs";
const root=resolve(import.meta.dirname,".."), output=resolve(root,process.env.ZINECV_PLATFORM_PARITY_OUT_DIR??".artifacts/remaining/closure-optimization-20261008/platform-parity");
const cases=['blank-profile','one-page','two-pages','five-pages','near-page-bottom','just-over-one-page','richtext-cjk-latin-emoji-link-lists','cross-page-long-entry','same-title-different-ids','fit-fitted','fit-unreadable','hebrew-glyph-fallback'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function compare(a,b,path='preview') {
 if(typeof a==='number'&&typeof b==='number'){assert.ok(Math.abs(a-b)<=0.001,path+': '+a+' vs '+b);return;}
 if(Array.isArray(a)){assert.ok(Array.isArray(b),path);assert.equal(a.length,b.length,path);a.forEach((value,index)=>compare(value,b[index],path+'.'+index));return;}
 if(a&&typeof a==='object'){assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),path);for(const key of Object.keys(a))compare(a[key],b[key],path+'.'+key);return;}
 assert.equal(a,b,path);
}
test('Native and WASM shared engine: structural/raster parity, fit, and same-platform PDF reproducibility',{timeout:300000},async()=>{
 await mkdir(output,{recursive:true});
 const server=createServer(async(req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/')return res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html>');
 if(pathname==='/parity-worker.mjs')return res.writeHead(200,{'Content-Type':'text/javascript'}).end('import init,{preview,raster,export_pdf,fit} from "/.artifacts/wasm-bindings/zinecv_wasm.js";const ready=init();self.onmessage=async({data})=>{try{await ready;const p=JSON.parse(preview(data.json));const pages=p.pages.map((_,index)=>Array.from(raster(data.json,index,4/3)));const pdf=export_pdf(data.json);self.postMessage({preview:p,pages,pdf:Array.from(pdf),secondPdf:Array.from(export_pdf(data.json)),fit:data.fit?JSON.parse(fit(data.json)):null});}catch(e){self.postMessage({error:String(e)});}};');
 if(!pathname.startsWith('/.artifacts/wasm-bindings/'))return res.writeHead(404).end();const path=resolve(root,'.'+decodeURIComponent(pathname));if(!path.startsWith(root+sep))return res.writeHead(403).end();
 try{res.writeHead(200,{'Content-Type':extname(path)==='.wasm'?'application/wasm':'text/javascript'}).end(await readFile(path));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await launchBrowserTestChromium({headless:true});const page=await browser.newPage();const rows=[];
 try{await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>{window.worker=new Worker('/parity-worker.mjs',{type:'module'});});
 for(const name of cases){const fixture=resolve(root,'fixtures/remaining/documents/'+(name.startsWith('fit-')||name==='hebrew-glyph-fallback'?'one-page':name)+'.json'),prefix=resolve(output,name),input=prefix+'.input.json';const fixtureBytes=await readFile(fixture);const doc=JSON.parse(fixtureBytes);const normalizedTitle=!doc.title?.trim();if(normalizedTitle)doc.title='Parity blank profile';
 if(name==='hebrew-glyph-fallback'){doc.basic.name='字体核对 אבג';doc.sections=[];}
 if(name.startsWith('fit-')){
  doc.basic.name='';doc.basic.phone='';doc.basic.email='';
  doc.sections=[{id:'parity-fit-summary',kind:'summary',title:'自我评价',visible:true,body:[{type:'paragraph',children:[{type:'link',href:'https://example.invalid/frozen-fit',children:[{type:'text',text:'有限候选不改变正文顺序。'.repeat(190),marks:[]}]}]}]}];
  Object.assign(doc.presentation,{fontSizePt:name==='fit-unreadable'?8:14,lineHeightPt:18,headingSizePt:16,pageMarginPt:30,moduleGapPt:4,paragraphGapPt:2,listGapPt:2});
 }
 const json=JSON.stringify(doc);await writeFile(input,json);const fitting=name==='one-page'||name==='just-over-one-page'||name.startsWith('fit-');
 const run=spawnSync(resolve(root,'src-tauri/target/release/examples/platform_reference.exe'),[input,prefix,...(fitting?['--fit']:[])],{windowsHide:true,encoding:'utf8'});assert.equal(run.status,0,run.stderr||run.error?.message);
 const nativePdfHash=sha(await readFile(prefix+'.pdf'));
 const repeat=spawnSync(resolve(root,'src-tauri/target/release/examples/platform_reference.exe'),[input,prefix],{windowsHide:true,encoding:'utf8'});assert.equal(repeat.status,0,repeat.stderr||repeat.error?.message);
 assert.equal(sha(await readFile(prefix+'.pdf')),nativePdfHash,name+': same-native PDF reproducibility');
 const web=await page.evaluate(({json,fit})=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WASM parity timeout')),90000);window.worker.onmessage=({data})=>{clearTimeout(timer);data.error?reject(new Error(data.error)):resolve(data);};window.worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};window.worker.postMessage({json,fit});}),{json,fit:fitting});
 const native=JSON.parse(await readFile(prefix+'.json','utf8'));compare(native,web.preview);if(fitting){compare(JSON.parse(await readFile(prefix+'.fit.json','utf8')),web.fit,'fit');if(name==='fit-fitted')assert.equal(web.fit.status,'fitted');if(name==='fit-unreadable')assert.equal(web.fit.status,'unreadable');}
 let maxDiff=0;const pageRows=[];for(let index=0;index<web.pages.length;index++){const nativeBytes=await readFile(prefix+'-'+index+'.png'),webBytes=Buffer.from(web.pages[index]);const a=PNG.sync.read(nativeBytes),b=PNG.sync.read(webBytes);assert.equal(a.width,b.width);assert.equal(a.height,b.height);const changed=pixelmatch(a.data,b.data,null,a.width,a.height,{threshold:0.1}),ratio=changed/(a.width*a.height);assert.ok(ratio<=0.001,name+': raster difference '+ratio);maxDiff=Math.max(maxDiff,ratio);pageRows.push({page:index,nativeSha256:sha(nativeBytes),wasmSha256:sha(webBytes),changedPixels:changed,ratio});}
 const pdf=Buffer.from(web.pdf);assert.equal(sha(pdf),sha(Buffer.from(web.secondPdf)),name+': same-WASM PDF reproducibility');rows.push({name,fixtureSha256:sha(fixtureBytes),inputSha256:sha(Buffer.from(json)),normalizedTitle,nativeBinaryReproducible:true,structural:true,pageCount:web.pages.length,maxRasterDiff:maxDiff,pages:pageRows,nativePdfSha256:sha(await readFile(prefix+'.pdf')),wasmPdfSha256:sha(pdf),wasmBinaryReproducible:true,fitCompared:fitting});}
 await writeFile(resolve(output,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),host:process.platform,reference:'native bundled-font engine',comparison:'WASM bundled-font engine',geometryTolerance:0.001,rasterThreshold:0.001,crossPlatformBinaryHashIsDiagnostic:true,rows},null,2));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
