import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("chapter menu reports completion and navigates without changing resume data", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/editorial-navigation.tsx"));
    await page.getByRole("button", { name: "跳转到章节" }).click();
    const menu = page.getByRole("listbox", { name: "选择章节" });
    await menu.waitFor();
    assert.match(await menu.innerText(), /待撰写/);
    await menu.getByRole("option", { name: /自我评价/ }).click();
    assert.deepEqual(JSON.parse(await page.getByLabel("定位目标").textContent()), { kind: "summary" });
    await page.getByRole("button", { name: "跳转到章节" }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "跳转到章节" }).getAttribute("aria-expanded"), "false");
  } finally { await browser.close(); await server.close(); }
});
