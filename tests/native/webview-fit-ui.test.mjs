import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startNativeHost,stopNativeHost} from './host-fixture.mjs';
import {installIpcInterceptor} from './ipc-interceptor.mjs';

const directory=resolve(import.meta.dirname,'../..',process.env.ZINECV_NATIVE_EVIDENCE_OUT_DIR??'.artifacts/remaining/closure-optimization-20261008/native-current','fit-ui');
const invoke=(page,command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
test('formal smart-one-page button uses the shared frozen solver and retains complete content',{timeout:180000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,'profile-'));let host;
 const report={passed:false,scope:'Real release WebView2 button; finite core compression followed by existing measured spacing fill'};
 try{
  host=await startNativeHost(profile);const page=host.page;
  await page.evaluate(async()=>{
   const edit=async payload=>{
    const current=await window.__TAURI_INTERNALS__.invoke('document_state');
    return window.__TAURI_INTERNALS__.invoke('apply_document_command',{envelope:{protocolVersion:1,commandId:crypto.randomUUID(),documentId:current.cursor.documentId,contextId:current.cursor.contextId,expectedRevision:current.cursor.revision,expectedBranchId:current.cursor.branchId,expectedHeadId:current.cursor.headId,payload}});
   };
   const state=await window.__TAURI_INTERNALS__.invoke('document_state');
   for(const section of state.document.sections){
    for(const entry of section.entries??[])await edit({type:'deleteEntry',entry_id:entry.id});
    await edit({type:'setSectionVisibility',section_id:section.id,visible:section.kind==='summary'});
   }
   const summary=state.document.sections.find(section=>section.kind==='summary');
   await edit({type:'setSummaryBody',section_id:summary.id,body:[{type:'paragraph',children:[{type:'link',href:'https://example.invalid/frozen-fit',children:[{type:'text',text:'有限候选不改变正文顺序。'.repeat(190),marks:[]}]}]}]});
   await edit({type:'setLayout',presentation:{...state.document.presentation,fontSizePt:14,lineHeightPt:18,headingSizePt:16,pageMarginPt:30,moduleGapPt:4,paragraphGapPt:2,listGapPt:2}});
  });
  await page.reload({waitUntil:'commit'});await page.locator('.save-state').getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
  await installIpcInterceptor(page);
  await page.evaluate(()=>{
   window.fitObservations=[];
   window.__zinecvTestInvoke=async(command,args,forward)=>{
    const result=await forward();
    if(command==='fit_document_one_page')window.fitObservations.push({cursor:args.cursor,status:result.plan.status,attempts:result.plan.attempts.length});
    return result;
   };
  });
  const source=await invoke(page,'document_state');
  const before=await invoke(page,'render_document_preview',{cursor:source.cursor});assert.ok(before.data.pages.length>1);
  await page.getByRole('button',{name:'智能一页',exact:true}).click();
  await page.getByText('智能一页已完成：四边页距一致，内容已适配一张 A4',{exact:true}).waitFor({timeout:90000});
  await page.locator('.save-state').getByText('草稿已保存',{exact:true}).waitFor();
  const fitted=await invoke(page,'document_state');const preview=await invoke(page,'render_document_preview',{cursor:fitted.cursor});
  assert.equal(preview.data.pages.length,1);assert.equal(await page.locator('.paper-frame .paper').count(),1);
  assert.deepEqual(fitted.document.basic,source.document.basic);assert.deepEqual(fitted.document.sections,source.document.sections);
  const first=await page.evaluate(()=>window.fitObservations);assert.ok(first.length>=1);assert.equal(first[0].status,'fitted');assert.ok(first[0].attempts<=16);
  await page.getByRole('button',{name:'智能一页',exact:true}).click();
  await page.waitForFunction(count=>window.fitObservations.length>count,first.length);await page.getByText('智能一页已完成：四边页距一致，内容已适配一张 A4',{exact:true}).waitFor();
  await page.locator('.save-state').getByText('草稿已保存',{exact:true}).waitFor();
  const repeated=await invoke(page,'document_state');assert.deepEqual(repeated,fitted,'repeated successful fit does not create a new revision');
  report.passed=true;report.originalPages=before.data.pages.length;report.fittedPages=preview.data.pages.length;report.observations=await page.evaluate(()=>window.fitObservations);report.contentUnchanged=true;report.repeatedCursorUnchanged=true;
 }catch(error){report.error=String(error.stack);if(host){report.saveState=await host.page.locator('.save-state').innerText().catch(()=>null);report.observations=await host.page.evaluate(()=>window.fitObservations??[]).catch(()=>[]);report.finalState=await invoke(host.page,'document_state').catch(()=>null);}throw error;}
 finally{if(host)await stopNativeHost(host);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));if(report.passed)await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});}
});

test('a late unmodified fit reply cannot overwrite a manual layout change in the formal UI',{timeout:90000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,'cancel-profile-'));let host;const report={passed:false,scope:'Real native read-only planning; delivery of its unmodified reply held until a real toolbar edit completes'};
 try{
  host=await startNativeHost(profile);const page=host.page;
  await installIpcInterceptor(page);
  await page.evaluate(()=>{
   window.__zinecvTestInvoke=async(command,args,forward)=>{
    const result=await forward();
    if(command==='fit_document_one_page'){
     window.fitReplyObserved={cursor:args.cursor,status:result.plan.status};
     await new Promise(resolve=>{window.releaseFitReply=resolve;});
     window.fitDeliveryDone=true;
    }
    return result;
   };
  });
  await page.getByRole('button',{name:'智能一页',exact:true}).click();await page.waitForFunction(()=>Boolean(window.fitReplyObserved));
  await page.locator('button[title="调整正文基准字号"]').click();const dialog=page.getByRole('dialog',{name:'正文字号',exact:true});
  await dialog.getByRole('button',{name:'17px',exact:true}).click();await dialog.getByRole('button',{name:'关闭设置'}).click();
  await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke('document_state')).document.presentation.fontSizePt===12.75);
  await page.locator('.save-state').getByText('草稿已保存',{exact:true}).waitFor();const manual=await invoke(page,'document_state');
  await page.evaluate(()=>window.releaseFitReply());await page.waitForFunction(()=>window.fitDeliveryDone);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.deepEqual(await invoke(page,'document_state'),manual);assert.equal(await page.locator('button[title="调整正文基准字号"]').innerText(),'17px');
  report.passed=true;report.reply=await page.evaluate(()=>window.fitReplyObserved);report.manualCursor=manual.cursor;report.manualLayoutUnchanged=true;
 }catch(error){report.error=String(error.stack);throw error;}
 finally{if(host)await stopNativeHost(host);await writeFile(join(directory,'cancel.json'),JSON.stringify(report,null,2));if(report.passed)await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});}
});

test('a real worker timeout during final one-page verification restores the original layout',{timeout:90000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,'final-timeout-profile-'));
 const reset=join(profile,'disable-fault.txt');await writeFile(reset,'planning begins without injected delay');
 let host;const report={passed:false,scope:'Real hooks worker; second Fit request delay 11500ms exceeds the unchanged 10s hard timeout; original presentation and content restored'};
 try{
  host=await startNativeHost(profile,{buildProfile:'hooks',env:{ZINECV_TEST_WORKER_RESET_FILE:reset,ZINECV_TEST_WORKER_DELAY_MS:'11500'}});
  const page=host.page;
  await page.evaluate(async()=>{
   const current=()=>window.__TAURI_INTERNALS__.invoke('document_state');
   const edit=async payload=>{const state=await current();return window.__TAURI_INTERNALS__.invoke('apply_document_command',{envelope:{protocolVersion:1,commandId:crypto.randomUUID(),documentId:state.cursor.documentId,contextId:state.cursor.contextId,expectedRevision:state.cursor.revision,expectedBranchId:state.cursor.branchId,expectedHeadId:state.cursor.headId,payload}});};
   const state=await current();
   for(const section of state.document.sections){for(const entry of section.entries??[])await edit({type:'deleteEntry',entry_id:entry.id});await edit({type:'setSectionVisibility',section_id:section.id,visible:section.kind==='summary'});}
   await edit({type:'setSummaryBody',section_id:state.document.sections.find(section=>section.kind==='summary').id,body:[{type:'paragraph',children:[{type:'text',text:'有限候选不改变正文顺序。'.repeat(190),marks:[]}]}]});
   await edit({type:'setLayout',presentation:{...state.document.presentation,fontSizePt:14,lineHeightPt:18,headingSizePt:16,pageMarginPt:30,moduleGapPt:4,paragraphGapPt:2,listGapPt:2}});
  });
  await page.reload({waitUntil:'commit'});await page.locator('.save-state').getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
  const before=await invoke(page,'document_state');
  report.originalPresentation=before.document.presentation;
  await page.exposeFunction('activateFinalFitFault',()=>rm(reset));
  await installIpcInterceptor(page);
  await page.evaluate(()=>{
   window.fitRequestCount=0;
   window.fitObservations=[];
   window.__zinecvTestInvoke=async(command,args,forward)=>{
    if(command!=='fit_document_one_page')return forward();
    const observation={requestNumber:++window.fitRequestCount,startedAtMs:performance.now()};
    window.fitObservations.push(observation);
    if(observation.requestNumber===2)await window.activateFinalFitFault();
    try{const reply=await forward();observation.status=reply.plan.status;observation.attempts=reply.plan.attempts.length;return reply;}
    catch(error){observation.error={code:error?.code??null,message:error?.message??String(error)};throw error;}
    finally{observation.elapsedMs=performance.now()-observation.startedAtMs;}
   };
  });
  await page.getByRole('button',{name:'智能一页',exact:true}).click();
  await page.getByText(/智能一页未完成/).waitFor({timeout:60000});
  await page.locator('.save-state').getByText('草稿已保存',{exact:true}).waitFor();
  const after=await invoke(page,'document_state');
  assert.equal(await page.evaluate(()=>window.fitRequestCount),2);
  report.observations=await page.evaluate(()=>window.fitObservations);
  assert.equal(report.observations[1].error?.code,'ENGINE_FAILURE');
  assert.match(report.observations[1].error?.message??'',/timeout/i);
  assert.ok(report.observations[1].elapsedMs>=9500&&report.observations[1].elapsedMs<=15000,'Final Fit failure must exercise the unchanged 10s hard timeout');
  assert.deepEqual(after.document.presentation,before.document.presentation);
  assert.deepEqual(after.document.sections,before.document.sections);assert.deepEqual(after.document.basic,before.document.basic);
  assert.equal(after.cursor.headId,before.cursor.headId);assert.equal(after.cursor.branchId,before.cursor.branchId);
  report.passed=true;report.originalPresentation=before.document.presentation;report.restoredPresentation=after.document.presentation;report.frozenContentPreserved=true;
 }catch(error){report.error=String(error.stack);if(host){report.finalState=await invoke(host.page,'document_state').catch(()=>null);report.observations=await host.page.evaluate(()=>window.fitObservations??[]).catch(()=>[]);}throw error;}
 finally{if(host)await stopNativeHost(host);await writeFile(join(directory,'final-timeout.json'),JSON.stringify(report,null,2));if(report.passed)await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});}
});
