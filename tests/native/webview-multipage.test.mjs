import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {join,resolve,sep} from "node:path";
import {createHash} from "node:crypto";
import {startNativeHost,stopNativeHost} from "./host-fixture.mjs";
const root=resolve(import.meta.dirname,"../..");
const directory=resolve(root,process.env.ZINECV_MULTIPAGE_OUT_DIR??".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-multipage");
assert.ok(directory.startsWith(root+sep));
const invoke=(page,name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");

test("all three Windows templates preserve complete exact one/two/five pages and oversized entry/summary content between DOM and native PDF",{timeout:600_000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,"profile-"));let host;const report={passed:false,rows:[],executableSha256:sha(await readFile(join(root,"src-tauri/target/release/zinecv-desktop.exe"))),scope:"Owned source fixtures; bounded trailing-entry subsets yield actual 1/2/5 pages for each template. Every exact input is saved and hashed. Oversized entry and summary also require equal actual page counts, complete text and no clipping. Standard density; density/control matrix has separate gates."};
 try{
  host=await startNativeHost(profile);const page=host.page;
  for(const name of ["one-page","two-pages","five-pages","long-content"]){
   const bytes=await readFile(join(root,"fixtures/remaining/documents",(name==="long-content"?"one-page":name)+".json"));const fixture=JSON.parse(bytes);
   if(name==="long-content"){
    const paragraph=text=>({type:"paragraph",children:[{type:"text",text,marks:[]}]});
    fixture.sections.find(section=>section.kind==="work").entries[0].body=[paragraph("完整跨页经历正文。".repeat(850)),...Array.from({length:55},(_,i)=>paragraph(`独立段落${i}：跨页内容必须完整。`))];
    fixture.sections.find(section=>section.kind==="summary").body=[paragraph("自我评价长段落。".repeat(800))];
   }
   await page.evaluate(async fixture=>{
    const invoke=(name,args={})=>window.__TAURI_INTERNALS__.invoke(name,args);
    const edit=async payload=>{
     const current=await invoke("document_state");
     return invoke("apply_document_command",{envelope:{protocolVersion:1,commandId:crypto.randomUUID(),documentId:current.cursor.documentId,contextId:current.cursor.contextId,expectedRevision:current.cursor.revision,expectedBranchId:current.cursor.branchId,expectedHeadId:current.cursor.headId,payload}});
    };
    let current=await invoke("document_state");
    for(const section of current.document.sections) {
     for(const entry of section.entries??[])await edit({type:"deleteEntry",entry_id:entry.id});
     await edit({type:"setSectionVisibility",section_id:section.id,visible:false});
     if(section.kind==="summary")await edit({type:"setSummaryBody",section_id:section.id,body:[]});
    }
    await edit({type:"updateBasic",patch:fixture.basic});await edit({type:"setDocumentTitle",title:fixture.title});
    current=await invoke("document_state");
    for(const source of fixture.sections){
     const target=current.document.sections.find(section=>section.kind===source.kind);
     if(!target)throw new Error("No module for "+source.kind);
     await edit({type:"renameSection",section_id:target.id,title:source.title});
     await edit({type:"setSectionVisibility",section_id:target.id,visible:source.visible});
     if(source.kind==="summary")await edit({type:"setSummaryBody",section_id:target.id,body:source.body});
     else for(const entry of source.entries)await edit({type:"addEntry",section_id:target.id,entry});
    }
   },fixture);
   for(const templateId of ["legacy-v1","clear-single-v1","compact-single-v1"]){
    const input=structuredClone(fixture);input.presentation.templateId=templateId;
    // Restore trailing entries removed for the previous template's exact-page
    // fixture. Source fixtures and their hashes remain unchanged.
    let state=await invoke(page,"document_state");
    for(const source of input.sections){
     const target=state.document.sections.find(section=>section.kind===source.kind);
     const ids=new Set((target.entries??[]).map(entry=>entry.id));
     for(const entry of source.entries??[]){
      if(ids.has(entry.id))continue;
      const current=await invoke(page,"document_state");
      await invoke(page,"apply_document_command",{envelope:{protocolVersion:1,commandId:crypto.randomUUID(),documentId:current.cursor.documentId,contextId:current.cursor.contextId,expectedRevision:current.cursor.revision,expectedBranchId:current.cursor.branchId,expectedHeadId:current.cursor.headId,payload:{type:"addEntry",section_id:target.id,entry}}});
     }
    }
    await page.evaluate(async presentation=>{
     const current=await window.__TAURI_INTERNALS__.invoke("document_state");
     await window.__TAURI_INTERNALS__.invoke("apply_document_command",{envelope:{protocolVersion:1,commandId:crypto.randomUUID(),documentId:current.cursor.documentId,contextId:current.cursor.contextId,expectedRevision:current.cursor.revision,expectedBranchId:current.cursor.branchId,expectedHeadId:current.cursor.headId,payload:{type:"setLayout",presentation}}});
    },{...fixture.presentation,templateId});
    const expectedPages={"one-page":1,"two-pages":2,"five-pages":5}[name];
    let cursor=(await invoke(page,"document_state")).cursor;
    let measured=await invoke(page,"render_document_preview",{cursor});
    for(let removed=0;measured.data.pages.length>expectedPages&&removed<30;removed++){
     const section=[...input.sections].reverse().find(section=>(section.entries?.length??0)>1);
     assert.ok(section,"page fixture cannot lose its only entry");
     const entry=section.entries.pop();const current=await invoke(page,"document_state");
     await invoke(page,"apply_document_command",{envelope:{protocolVersion:1,commandId:crypto.randomUUID(),documentId:current.cursor.documentId,contextId:current.cursor.contextId,expectedRevision:current.cursor.revision,expectedBranchId:current.cursor.branchId,expectedHeadId:current.cursor.headId,payload:{type:"deleteEntry",entry_id:entry.id}}});
     cursor=(await invoke(page,"document_state")).cursor;
     measured=await invoke(page,"render_document_preview",{cursor});
    }
    if(expectedPages)assert.equal(measured.data.pages.length,expectedPages,"actual exact-page fixture / "+templateId);
    else assert.ok(measured.data.pages.length>=2,"actual long-content fixture must span pages");
    const inputBytes=Buffer.from(JSON.stringify(input,null,2)+"\n");
    await writeFile(join(directory,name+"-"+templateId+"-input.json"),inputBytes);
    await page.reload({waitUntil:"commit"});await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
    const minimize=page.getByRole("button",{name:"最小化到 Bot",exact:true});if(await minimize.isVisible())await minimize.click();
    await page.getByRole("button",{name:"简历编辑",exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll(".paper-frame .paper").length>0);
    await page.waitForFunction(()=>[...document.querySelectorAll(".paper-frame .paper")].every(node=>getComputedStyle(node).width!=="0px"));
    await page.evaluate(async()=>{
     await document.fonts.ready;
     await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    const frozen=await invoke(page,"document_state");
    const preview=await invoke(page,"render_document_preview",{cursor:frozen.cursor});
    const exported=await invoke(page,"render_document_export",{cursor:frozen.cursor,product:"pdf"});
    const geometry=await page.locator(".paper-frame .paper").evaluateAll(nodes=>nodes.map(node=>{const style=getComputedStyle(node);return{width:parseFloat(style.width),height:parseFloat(style.height),text:node.innerText};}));
    assert.equal(exported.data.pageCount,preview.data.pages.length);
    if(expectedPages)assert.equal(preview.data.pages.length,expectedPages);
    assert.equal(geometry.length,preview.data.pages.length,name+" / "+templateId+": DOM/PDF page count");
    for(const paper of geometry){assert.ok(Math.abs(paper.width-794)<=1);assert.ok(Math.abs(paper.height-1123)<=1);}
    for(const native of preview.data.pages){assert.ok(Math.abs(native.widthPt-595.276)<.02);assert.ok(Math.abs(native.heightPt-841.89)<.02);}
    const exportedText=exported.data.textMap.logicalText.replace(/\s/g,""),domText=geometry.map(page=>page.text).join("").replace(/\s/g,"");
    const bodyText=await page.locator(".paper-frame .paper").evaluateAll(papers=>{
     const entries={};let summary="";
     for(const paper of papers){
      for(const entry of paper.querySelectorAll("[data-preview-entry-id]")){const id=entry.dataset.previewEntryId;entries[id]=(entries[id]??"")+(entry.querySelector(".preview-rich")?.textContent??"");}
      for(const rich of paper.querySelectorAll('[data-layout-block="summary"] .preview-rich'))summary+=rich.textContent;
     }return{entries,summary};
    });
    for(const section of input.sections){
     if(!section.visible)continue;
     for(const entry of section.entries??[]){
      assert.ok(exportedText.includes(entry.title.replace(/\s/g,"")));assert.ok(domText.includes(entry.title.replace(/\s/g,"")));
      const textOf=node=>node.type==="text"?node.text:(node.children??node.content??[]).map(textOf).join("");
      for(const paragraph of entry.body??[]){const text=textOf(paragraph).replace(/\s/g,"");if(!text)continue;assert.ok(exportedText.includes(text),"complete PDF paragraph / "+entry.id);assert.ok(bodyText.entries[entry.id]?.replace(/\s/g,"").includes(text),"complete DOM paragraph / "+entry.id);}
     }
     if(section.kind==="summary"){
      const textOf=node=>node.type==="text"?node.text:(node.children??node.content??[]).map(textOf).join("");
      const expected=section.body.map(textOf).join("").replace(/\s/g,"");
      assert.equal(sha(bodyText.summary.replace(/\s/g,"")),sha(expected),"complete DOM summary");assert.ok(exportedText.includes(expected),"complete PDF summary");
     }
    }
    const pageOverflow=await page.locator(".paper-frame .paper").evaluateAll(nodes=>nodes.map(paper=>{
     const bounds=paper.getBoundingClientRect(),scale=bounds.height/paper.offsetHeight;
     return paper.querySelector(".paper-content").getBoundingClientRect().bottom-bounds.bottom+parseFloat(getComputedStyle(paper).paddingBottom)*scale;
    }));
    for(const overflow of pageOverflow)assert.ok(overflow<=1.5,"actual visible A4 content exceeds its page: "+overflow);
    assert.deepEqual(await invoke(page,"document_state"),frozen);
    await page.screenshot({path:join(directory,name+"-"+templateId+".png"),animations:"disabled"});
    report.rows.push({name,templateId,fixtureSha256:sha(bytes),inputSha256:sha(inputBytes),expectedPages,pageCount:preview.data.pages.length,domPages:geometry.length,entryCount:input.sections.reduce((sum,section)=>sum+(section.entries?.length??0),0),pageOverflow,geometry:geometry.map(({text,...bounds})=>bounds),pdfSha256:exported.data.pdfSha256,completeParagraphsRetained:true,contentTitlesRetained:true,cursorUnchanged:true});
   }
  }
  report.passed=true;
 }catch(error){report.error=String(error.stack);if(host){report.visibleText=await host.page.locator("body").innerText().catch(()=>"");report.loadedScriptUrls=await host.page.evaluate(()=>[...document.scripts].map(script=>script.src)).catch(()=>[]);report.paginationDiagnostic=await host.page.evaluate(()=>window.__paginationDiagnostic??null).catch(()=>null);}throw error;}
 finally{if(host)await stopNativeHost(host);await writeFile(join(directory,"multipage.json"),JSON.stringify(report,null,2));if(report.passed)await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});}
});
