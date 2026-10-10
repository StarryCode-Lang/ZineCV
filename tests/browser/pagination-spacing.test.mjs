import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

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

