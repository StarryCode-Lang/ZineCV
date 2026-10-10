import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { launchBrowserTestChromium } from "../tests/browser/fixtures/browser-test-server.mjs";
const root=resolve(import.meta.dirname,".."), dist=resolve(root,"dist");
const evidence=resolve(root,process.env.ZINECV_WEB_EVIDENCE_OUT_DIR??".artifacts/remaining/closure-optimization-20261008/web");
await mkdir(evidence,{recursive:true});
const mime={ ".js":"text/javascript", ".mjs":"text/javascript", ".wasm":"application/wasm", ".html":"text/html", ".css":"text/css", ".json":"application/json" };
test("production browser workspace persists, protects secrets, rejects concurrent writer, and starts offline", {timeout:180000}, async()=>{
 const server=createServer(async(req,res)=>{const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/")return res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html><title>Workspace contract</title>");
  if(url.pathname==='/test-secrets.mjs')return res.writeHead(200,{'Content-Type':'text/javascript'}).end(await readFile(resolve(root,'crates/zinecv-wasm/js/web-secrets.mjs')));
  if(url.pathname==='/v1/models')return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data:[{id:'contract',name:'Contract model'}]}));
  if(url.pathname==='/v1/chat/completions'){
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    if(!body.stream){const nonce=body.tools[0].function.parameters.properties.nonce.enum[0];return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',id:'probe',function:{name:'zinecv_capability_probe',arguments:JSON.stringify({nonce})}}]}}]}));}
    return res.writeHead(200,{'Content-Type':'text/event-stream'}).end('data: '+JSON.stringify({model:'contract',choices:[{delta:{content:'Browser Agent OK'}}]})+'\n\ndata: [DONE]\n\n');
  }
  const path=resolve(dist,"."+decodeURIComponent(url.pathname));if(!path.startsWith(dist+sep))return res.writeHead(403).end();
  try{res.writeHead(200,{"Content-Type":mime[extname(path)]||"application/octet-stream"}).end(await readFile(path));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));const origin="http://127.0.0.1:"+server.address().port;
 const browser=await launchBrowserTestChromium({headless:true});const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();
 const workerFile=(await readdir(resolve(dist,"assets"))).find(name=>name.startsWith("core-worker-")&&name.endsWith(".js"));
 const open=async p=>{await p.goto(origin);await p.evaluate(file=>{let id=0;const pending=new Map();window.core=new Worker("/assets/"+file,{type:"module"});window.core.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};window.core.onerror=e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(e.message));}pending.clear();};window.rpc=(command,args={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error("RPC timeout: "+command));},60000);pending.set(n,{resolve,reject,timer});window.core.postMessage({id:n,command,args});});},workerFile);return p.evaluate(()=>window.rpc("initialize"));};
 const call=(command,args)=>page.evaluate(({command,args})=>window.rpc(command,args),{command,args});
 try{
  await page.goto(origin);
  const cryptoChecks=await page.evaluate(async()=>{const secrets=await import('/test-secrets.mjs');const bytes=new TextEncoder().encode('ephemeral-test-secret');
    await secrets.init_secrets('contract-secret');await secrets.prepare_secret('ephemeral-test-secret');const cipher=secrets.protect_sync(bytes);const nonexportable=await secrets.key_is_nonexportable();secrets.clear_plaintext();
    await secrets.init_secrets('contract-secret');await secrets.prepare_ciphertexts([Array.from(cipher)]);const reopened=new TextDecoder().decode(secrets.unprotect_sync(cipher));secrets.clear_plaintext();
    await secrets.init_secrets('foreign-secret');await secrets.prepare_ciphertexts([Array.from(cipher)]);let foreignRejected=false;try{secrets.unprotect_sync(cipher);}catch{foreignRejected=true;}
    return {nonexportable,reopened,foreignRejected};});assert.deepEqual(cryptoChecks,{nonexportable:true,reopened:'ephemeral-test-secret',foreignRejected:true});
  const caps=await open(page);assert.equal(caps.core,"wasm");assert.equal(caps.secureSecrets,true);
  const state=await call("document_state");assert.equal(state.document.documentId,"workspace-default-document");
  const cursor=state.cursor; const envelope={protocolVersion:1,commandId:'browser-production-edit',documentId:cursor.documentId,contextId:cursor.contextId,expectedRevision:cursor.revision,expectedBranchId:cursor.branchId,expectedHeadId:cursor.headId,payload:{type:'setDocumentTitle',title:'Browser saved 中文'}};
  await call('apply_document_command',{envelope});const edited=await call('document_state');assert.equal(edited.document.title,'Browser saved 中文');
  await assert.rejects(call('apply_document_command',{envelope:{...envelope,commandId:'stale'}}),/CONFLICT/);
  const preview=await call('render_document_preview',{cursor:edited.cursor});assert.ok(preview.data.pages.length>0);
  const exported=await call('render_document_export',{cursor:edited.cursor,product:'pdf'});assert.equal(Buffer.from(exported.data.pdfBase64,'base64').subarray(0,4).toString(),'%PDF');
  await call('commit_version',{cursor:edited.cursor,message:'Browser contract commit'});assert.ok((await call('version_graph_detailed')).commits.length>0);
  const credentials={email:"browser-contract@example.test",password:"Test-password-42!"};await call("register_account",credentials);await call("login_account",credentials);
  const secret="private-browser-contract-key";await call("store_provider_key",{name:"Contract",baseUrl:origin+"/v1",model:"contract",key:secret});
  const profile=await call("provider_profile");assert.equal(profile.apiKeyNeedsReentry,false);
  const config={baseUrl:origin+'/v1',model:'contract',key:''};assert.equal((await call('provider_models',config)).models[0].id,'contract');assert.equal((await call('provider_test',config)).structuredOutput,true);
  assert.equal((await call('provider_profile')).capability,'structured');
  const sessions={activeId:'browser-session',sessions:[{id:'browser-session',title:'Browser Agent',createdAt:1,updatedAt:1,messages:[{id:'browser-user',role:'user',text:'Say OK'}]}]};await call('bootstrap_agent_sessions',{legacyJson:JSON.stringify(sessions)});
  const agentCursor=(await call('document_state')).cursor;
  const reply=await call('agent_chat',{runId:'browser-agent-contract',sessionId:'browser-session',targetCursor:agentCursor,referenceIds:[],userText:'Say OK',skillId:null});assert.equal(reply.content,'Browser Agent OK');
  const runs=await call('list_agent_runs');assert.equal(runs[0].status,'completed');assert.ok(runs[0].partialText.includes('Browser Agent OK'));
  const backup=await call("export_database_backup");assert.ok(!Buffer.from(backup.databaseBase64,"base64").includes(Buffer.from(secret)));
  const second=await context.newPage();await assert.rejects(open(second),/另一个标签页/);await second.close();
  await page.evaluate(()=>window.core.terminate());await open(page);await call("login_account",credentials);assert.equal((await call("document_state")).document.title,"Browser saved 中文");assert.equal((await call("provider_profile")).apiKeyNeedsReentry,false);
  const restored=await call("restore_database_backup",{payload:backup});assert.equal(restored.unavailableSecretCount,0);assert.equal(restored.requiresRelogin,true);await call("login_account",credentials);assert.equal((await call("provider_profile")).apiKeyNeedsReentry,false);
  for(let index=0;index<20;index++){const restored=await call('restore_database_backup',{payload:backup});assert.equal(restored.unavailableSecretCount,0);}
  await page.evaluate(()=>window.core.terminate());const errors=[];page.on("pageerror",error=>errors.push(error.message));await page.goto(origin+"/web.html");await page.locator(".app-shell").waitFor({timeout:60000});await page.getByText("草稿已保存",{exact:true}).waitFor({timeout:30000});
  await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;const worker=registration.active;if(worker?.state!=="activated")await new Promise(resolve=>worker.addEventListener("statechange",()=>worker.state==="activated"&&resolve()));});
  await page.getByRole('button',{name:'版本管理',exact:true}).click();
  await page.getByLabel('选择完整数据库备份文件').setInputFiles({name:'browser-full-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  const preRestoreDownload=page.waitForEvent('download');
  const restoredNavigation=page.waitForNavigation({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'恢复完整数据库',exact:true}).click();
  const downloaded=await preRestoreDownload;assert.match(downloaded.suggestedFilename(),/恢复前备份/);const downloadedPath=await downloaded.path();assert.equal(JSON.parse(await readFile(downloadedPath,'utf8')).format,'zinecv-sqlite-full-backup');
  await restoredNavigation;await page.locator('.app-shell').waitFor({timeout:60000});await page.getByText('草稿已保存',{exact:true}).waitFor({timeout:30000});
  await context.setOffline(true);await page.reload();await page.locator(".app-shell").waitFor({timeout:60000});await context.setOffline(false);assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'简历编辑',exact:true}).click();
  await page.locator('button[title="选择简历字体"]').click();
  const fontDialog=page.getByRole('dialog',{name:'简历字体'});
  await fontDialog.getByText('浏览器预览与导出使用内置宋体；已保存的其他字体设置保留，Windows 可使用本机字体',{exact:true}).waitFor();
  for(const name of ['雅黑','黑体','楷体','仿宋'])assert.equal(await fontDialog.getByRole('button',{name,exact:true}).isDisabled(),true);
  assert.equal(await fontDialog.getByRole('button',{name:'宋体',exact:true}).isEnabled(),true);
  await fontDialog.getByRole('button',{name:'关闭设置'}).click();
  const hebrewFace=await page.evaluate(async()=>{const faces=await document.fonts.load('400 16px "Noto Sans Hebrew"','אבג');return faces.length>0&&document.fonts.check('400 16px "Noto Sans Hebrew"','אבג');});
  assert.equal(hebrewFace,true);
  await writeFile(resolve(evidence,"web-product.json"),JSON.stringify({checkedAt:new Date().toISOString(),capabilities:caps,cryptoChecks,productionWorkspace:true,bundledFontCapabilityUi:true,hebrewFontLoaded:true,restoreViaUiWithPreRestoreDownload:true,secretCiphertextOnly:true,secretReopen:true,sameOriginBackupSecretRestore:true,multiTabWriterRejected:true,repeatedRestoreBeyondInitialPool:true,offlineWorkspace:true,providerModels:true,structuredCapabilityProbe:true,durableAgentRun:true},null,2));
 }finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
});
