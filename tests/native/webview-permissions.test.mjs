import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {startNativeHost,stopNativeHost} from "./host-fixture.mjs";
const directory=resolve(import.meta.dirname,"../../.artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-permissions");

test("a real unauthorized hidden WebView cannot access business IPC",{timeout:90_000},async()=>{
 await mkdir(directory,{recursive:true});const profile=await mkdtemp(join(directory,"profile-"));const report={passed:false,scope:"Test-hooks creates a real second window with no granted business capabilities; release contains no probe"};let host;
 try{
  host=await startNativeHost(profile,{buildProfile:"hooks",env:{ZINECV_TEST_UNAUTHORIZED_WINDOW:"1"}});
  const before=await host.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("document_state"));
  let probe;
  for(let attempt=0;attempt<100&&!probe;attempt++){
   probe=host.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes("unauthorized-probe"));
   if(!probe)await new Promise(done=>setTimeout(done,50));
  }
  assert.ok(probe,"native hidden probe window exists");await probe.waitForFunction(()=>Boolean(window.__TAURI_INTERNALS__?.invoke));
  const results=await probe.evaluate(async()=>{
   const results=[];
   for(const [command,args] of [["document_state",{}],["read_setting",{key:"permission-probe"}],["write_setting",{key:"permission-probe",value:"must-not-write"}],["version_graph_detailed",{}],["provider_profile",{}]]){
    try{await window.__TAURI_INTERNALS__.invoke(command,args);results.push({command,allowed:true});}
    catch(error){results.push({command,allowed:false,error:String(typeof error==="string"?error:JSON.stringify(error))});}
   }return results;
  });
  assert.ok(results.every(result=>!result.allowed));assert.ok(results.every(result=>/not allowed|denied|permission|not available/i.test(result.error)));
  assert.deepEqual(await host.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("document_state")),before);
  assert.equal(await host.page.evaluate(()=>window.__TAURI_INTERNALS__.invoke("read_setting",{key:"permission-probe"})),null);
  report.results=results;report.mainDocumentUnchanged=true;report.settingUnchanged=true;report.passed=true;
 }catch(error){report.error=String(error.stack);throw error;}
 finally{if(host)await stopNativeHost(host);await writeFile(join(directory,"permissions.json"),JSON.stringify(report,null,2));if(report.passed)await rm(profile,{recursive:true,maxRetries:15,retryDelay:200});}
});

