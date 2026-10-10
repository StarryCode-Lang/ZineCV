import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {startNativeHost,stopNativeHost} from "./host-fixture.mjs";
const directory=resolve(import.meta.dirname,"../../.artifacts/remaining/closure-optimization-20261008/native-interactions");
const state=page=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("document_state"));

test("Windows WebView2 clipboard permission denial reports failure; keyboard dialogs and reduced-motion switches preserve document",{timeout:150_000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,"profile-"));const report={passed:false,checks:[],scope:"Actual WebView2 keyboard/mouse controls, CDP browser permission denial and reduced-motion preference; no simulated clipboard method failure"};let host;
 try{
  host=await startNativeHost(profile);const page=host.page;
  const minimize=page.getByRole("button",{name:"最小化到 Bot",exact:true});if(await minimize.isVisible())await minimize.click();
  await page.getByRole("button",{name:"展开基本信息",exact:true}).click();
  await page.getByLabel("姓名",{exact:true}).fill("交互保护合成姓名");await page.getByLabel("姓名",{exact:true}).press("Tab");
  await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name==="交互保护合成姓名");
  const baseline=await state(page);
  await page.evaluate(()=>{
   window.__clipboardObservation={secure:isSecureContext,api:typeof navigator.clipboard?.writeText,calls:[]};
   const original=document.execCommand.bind(document);
   document.execCommand=(...args)=>{const result=original(...args);if(args[0]==="copy")window.__clipboardObservation.calls.push({method:"execCommand",result});return result;};
   if(navigator.clipboard?.writeText){const write=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{try{const result=await write(text);window.__clipboardObservation.calls.push({method:"writeText",result:"resolved"});return result;}catch(error){window.__clipboardObservation.calls.push({method:"writeText",error:String(error)});throw error;}};}
  });
  const permissions=await host.browser.newBrowserCDPSession();
  await permissions.send("Browser.setPermission",{permission:{name:"clipboard-write"},setting:"denied",origin:new URL(page.url()).origin});
  await page.getByRole("button",{name:"导出",exact:true}).click();
  await page.getByRole("menuitem",{name:"复制简历文本"}).click();
  await page.getByText("复制失败，请检查浏览器权限",{exact:true}).waitFor({timeout:15_000});
  assert.deepEqual(await state(page),baseline);
  await permissions.send("Browser.resetPermissions");await permissions.detach();
  report.checks.push({mode:"clipboard-permission-denial",browserPermissionDenied:true,errorVisible:true,documentUnchanged:true});
  const openClear=async()=>{
   if(!await page.getByRole("menuitem",{name:"清空简历"}).isVisible())await page.getByRole("button",{name:"导出",exact:true}).click();
   await page.getByRole("menuitem",{name:"清空简历"}).click();
   const dialog=page.getByRole("alertdialog",{name:"清空当前简历？"});await dialog.waitFor();return dialog;
  };
  let dialog=await openClear();
  await dialog.getByRole("button",{name:"取消",exact:true}).focus();await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.getByRole("button",{name:"确认清空",exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press("Tab");
  assert.equal(await dialog.getByRole("button",{name:"取消",exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press("Escape");await dialog.waitFor({state:"detached"});
  assert.match(await page.evaluate(()=>document.activeElement?.textContent ?? ""),/清空简历|导出/);
  dialog=await openClear();await page.locator(".dialog-backdrop").click({position:{x:2,y:2}});await dialog.waitFor({state:"detached"});
  assert.deepEqual(await state(page),baseline);
  await page.keyboard.press("Escape");
  const trigger=page.locator('button[title="调整正文基准字号"]');
  await trigger.click();await page.getByRole("dialog",{name:"正文字号",exact:true}).waitFor();await page.keyboard.press("Escape");
  assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
  report.checks.push({mode:"keyboard-focus",tabLoop:true,escapeAndOutsideCancel:true,triggerFocusRestored:true,documentUnchanged:true});
  for(const reducedMotion of ["reduce","no-preference","reduce"]){
   await page.emulateMedia({reducedMotion});
   assert.equal(await page.evaluate(()=>matchMedia("(prefers-reduced-motion: reduce)").matches),reducedMotion==="reduce");
   for(let index=0;index<4;index++){
    await page.getByRole("button",{name:"展开 Re:me 助手",exact:true}).click();
    await page.getByRole("button",{name:"展开聊天",exact:true}).click();
    await page.getByRole("button",{name:"收起聊天",exact:true}).click();
    await page.getByRole("button",{name:"最小化到 Bot",exact:true}).click();
   }
   assert.deepEqual(await state(page),baseline);
   report.checks.push({mode:"motion-switch",reducedMotion,rapidModes:4,documentUnchanged:true});
  }
  await page.screenshot({path:join(directory,"interactions.png"),animations:"disabled"});report.passed=true;
 }catch(error){report.error=String(error.stack);if(host){report.visibleText=await host.page.locator("body").innerText().catch(()=>"");report.clipboardObservation=await host.page.evaluate(()=>window.__clipboardObservation).catch(()=>null);}throw error;}
 finally{if(host)await stopNativeHost(host);await writeFile(join(directory,"interactions.json"),JSON.stringify(report,null,2));if(report.passed)await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});}
});
