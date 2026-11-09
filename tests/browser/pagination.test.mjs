/* 由 2 个同组测试文件合并；测试块自包含，行为与合并前一致。 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createBrowserTestServer,listenForBrowserTestServer,launchBrowserTestChromium} from "./fixtures/browser-test-server.mjs";

/* ==== 原 pagination-long-entry.test.mjs ==== */
test("all templates paginate oversized rich entries and single-paragraph summary without loss or clipping",{timeout:120000},async()=>{
 const root=resolve(import.meta.dirname,"../.."),directory=resolve(root,".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/browser-long-pages");
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

/* ==== 原 pagination-spacing.test.mjs ==== */

test("continued modules charge their heading and actual entry gaps without repeating every source margin", async () => {
  const server = await createBrowserTestServer(new URL("../..", import.meta.url).pathname.replace(/^\/D:/, "D:"));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls.local[0]}__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async () => {
      const { measureResumePages } = await import("/src/ui/services/resume-pagination.ts");
      const entries = Array.from({ length: 20 }, (_, index) => ({ id: "entry-" + index }));
      document.body.innerHTML = `<style>
        #measurement,.module { display:flow-root; width:733.688px }
        .header { height:88px }
        .heading { height:13px; margin-bottom:6.5px }
        .entry { height:92px }
        .entry + .entry { margin-top:2.5px }
      </style><div id="measurement"><div data-layout-block="header" class="header"></div>
        <div data-layout-block="work" class="module"><div class="heading"></div>
        ${entries.map(({ id }) => `<div class="entry" data-preview-entry-id="${id}"></div>`).join("")}
        </div></div>`;
      const measure = () => measureResumePages(document.querySelector("#measurement"), ["work"], { work: entries }, 1062.52)
        .map(page => ({ used: page.used, ids: page.blocks.flatMap(block => block.entryIds ?? []) }));
      const margins = measure();
      const style = document.createElement("style");
      style.textContent = ".module {display:grid;row-gap:2.5px} .heading{margin-bottom:4px} .entry + .entry{margin-top:0}";
      document.head.append(style);
      return { margins, grid: measure() };
    });
    for (const pages of Object.values(result)) {
      assert.equal(pages.length, 2, "margin and grid spacing both fit two pages with repeated heading");
      assert.deepEqual(pages.map(page => page.ids.length), [10, 10]);
      assert.ok(pages.every(page => page.used <= 1062.52));
      assert.deepEqual(pages.flatMap(page => page.ids), Array.from({ length: 20 }, (_, index) => "entry-" + index));
    }
  } finally {
    await browser.close();
    await server.close();
  }
});

test("pagination observes a measurement mounted after bootstrap and reconnects after replacement", async () => {
  const server = await createBrowserTestServer(new URL("../..", import.meta.url).pathname.replace(/^\/D:/, "D:"));
  let browser;
  try {
    await listenForBrowserTestServer(server);
    browser = await launchBrowserTestChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls.local[0]}__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      window.paginationHarness = await import("/tests/browser/fixtures/mount-pagination.tsx");
      window.paginationHarness.mountHarness();
    });
    await page.waitForFunction(() => document.querySelector("#page-count") !== null);
    await page.evaluate(() => window.paginationHarness.mountMeasurement());
    await page.waitForFunction(() => document.querySelector("#page-count").textContent === "3");
    await page.evaluate(() => document.head.insertAdjacentHTML("beforeend", "<style>.entry{height:93.5px}</style>"));
    await page.waitForFunction(() => document.querySelector("#page-count").textContent === "2");
    await page.evaluate(() => window.paginationHarness.replaceMeasurement());
    await page.evaluate(() => document.head.insertAdjacentHTML("beforeend", "<style>.entry{height:107px}</style>"));
    await page.waitForFunction(() => document.querySelector("#page-count").textContent === "3");
    await page.evaluate(() => window.paginationHarness.unmountHarness());
  } finally {
    await browser?.close();
    await server.close();
  }
});

