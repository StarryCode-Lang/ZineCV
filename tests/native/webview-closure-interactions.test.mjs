import {spawn} from "node:child_process";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {startNativeHost,stopNativeHost} from "./host-fixture.mjs";
const directory=resolve(import.meta.dirname,"../../.artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-interactions");
const state=page=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("document_state"));

test("Windows WebView2 clipboard contention reports failure and recovers; keyboard dialogs and reduced-motion switches preserve document",{timeout:150_000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,"profile-"));const report={passed:false,checks:[],scope:"Actual WebView2 keyboard/mouse controls, actual Windows exclusive clipboard lock and reduced-motion preference; no simulated clipboard method failure"};let host;
 try{
  host=await startNativeHost(profile);const page=host.page;
  const minimize=page.getByRole("button",{name:"最小化到 Bot",exact:true});if(await minimize.isVisible())await minimize.click();
  await page.getByRole("button",{name:"展开基本信息",exact:true}).click();
  await page.getByLabel("姓名",{exact:true}).fill("交互保护合成姓名");await page.getByLabel("姓名",{exact:true}).press("Tab");
  await page.waitForFunction(async()=> (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name==="交互保护合成姓名");
  const baseline=await state(page);
  const ready=join(profile,"clipboard-lock.json"),release=join(profile,"clipboard-release");
  const script=`Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class ClipboardProbe { [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr owner); [DllImport("user32.dll")] public static extern bool CloseClipboard(); }
"@
$opened=$false
try { for($i=0;$i -lt 100;$i++){if([ClipboardProbe]::OpenClipboard([IntPtr]::Zero)){$opened=$true;break};Start-Sleep -Milliseconds 10};[IO.File]::WriteAllText($env:ZINECV_CLIP_READY,$opened.ToString());$deadline=[DateTime]::UtcNow.AddSeconds(30);while($opened -and -not(Test-Path -LiteralPath $env:ZINECV_CLIP_RELEASE)-and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 20}} finally {if($opened){[void][ClipboardProbe]::CloseClipboard()}}
`;
  const locker=spawn("powershell.exe",["-NoProfile","-Command",script],{windowsHide:true,stdio:"ignore",env:{...process.env,ZINECV_CLIP_READY:ready,ZINECV_CLIP_RELEASE:release}});
  try {
   const deadline=Date.now()+15000;let opened=false;
   while(Date.now()<deadline){const result=await readFile(ready,"utf8").catch(()=>"");if(result){opened=result==="True";break}if(locker.exitCode!==null)throw Error("Clipboard locker exited");await page.waitForTimeout(50)}
   assert.equal(opened,true,"Actual external OpenClipboard lock required");
   await page.getByRole("button",{name:"导出",exact:true}).click();
   await page.getByRole("menuitem",{name:"复制简历文本"}).click();
   await page.getByText("复制失败，剪贴板可能被占用或权限不足，请重试",{exact:true}).waitFor({timeout:15000});
   assert.deepEqual(await state(page),baseline);
   report.checks.push({mode:"clipboard-native-contention",exclusiveExternalLock:true,errorVisible:true,documentUnchanged:true});
  } finally {
   await writeFile(release,"release");
   if(locker.exitCode===null)await Promise.race([new Promise(r=>locker.once("exit",r)),new Promise(r=>setTimeout(r,2000))]);
   if(locker.exitCode===null){locker.kill();throw Error("Clipboard locker did not exit")}
  }
  // An actual OS write must now succeed with exactly the same document.
  await page.getByRole("button",{name:"导出",exact:true}).click();
  await page.getByRole("menuitem",{name:"复制简历文本"}).click();
  await page.getByText("简历文本已复制",{exact:true}).waitFor({timeout:15000});
  assert.deepEqual(await state(page),baseline);
  report.checks.push({mode:"clipboard-recovery",successVisible:true,documentUnchanged:true});
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
