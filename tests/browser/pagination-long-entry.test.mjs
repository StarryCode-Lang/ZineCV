import {test} from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createBrowserTestServer,listenForBrowserTestServer,launchBrowserTestChromium} from "./fixtures/browser-test-server.mjs";
test("all templates paginate oversized rich entries and single-paragraph summary without loss or clipping",{timeout:120000},async()=>{
 const root=resolve(import.meta.dirname,"../.."),directory=resolve(root,".artifacts/remaining/closure-optimization-20261008/browser-long-pages");
 await mkdir(directory,{recursive:true});const server=await createBrowserTestServer(root);let browser;const report={passed:false,rows:[]};
 try{await listenForBrowserTestServer(server);browser=await launchBrowserTestChromium({headless:true});
  for(const template of ["legacy-v1","clear-single-v1","compact-single-v1"]){const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]+"__zinecv_browser_test_page.html");
   const row=await page.evaluate(async template=>(await import("/tests/browser/fixtures/long-pagination.tsx")).checkLongPages(template),template);report.rows.push(row);
   const sha=text=>createHash("sha256").update(text).digest("hex");
   assert.ok(row.pageCount>=5);assert.equal(sha(row.actualText),sha(row.sourceText),"complete rich entry text");assert.equal(sha(row.summaryText),sha(row.expectedSummary),"complete single-paragraph summary");assert.equal(row.sourceUnchanged,true);assert.equal(row.linksRetained,true);
   assert.ok(row.overflows.every(value=>value<=1.5),JSON.stringify(row.overflows));assert.ok(row.entryIds.includes("work-2"));
   const guard = await page.evaluate(async ()=>(await import("/tests/browser/fixtures/long-pagination.tsx")).checkOverflowTransition());
   assert.equal(guard.initialOverflow,true);assert.equal(guard.finalOverflow,false,"overflow clears after actual content height transition inside fixed A4");
   await page.close();
   assert.equal(row.emptyParagraphs,2,"original empty paragraphs survive fragmentation");assert.equal(row.emptyListItems,1,"original empty list item survives fragmentation");
   assert.equal(row.freshSummary.freshPage,true);assert.ok(row.freshSummary.firstHeight<=1062.62);assert.ok(row.freshSummary.maxContinuedHeight<=1062.62);
  }report.passed=true;
 }catch(error){report.error=String(error.stack);throw error;}finally{await browser?.close();await server.close();await writeFile(resolve(directory,"report.json"),JSON.stringify(report,null,2));}
});
