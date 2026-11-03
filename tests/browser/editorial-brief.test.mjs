import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("editorial brief edits the supplied title and reflects export overflow", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/editorial-brief.tsx"));
    await page.getByRole("button", { name: "原始标题" }).click();
    await page.getByLabel("简历名称").fill("新的标题");
    await page.getByLabel("简历名称").press("Enter");
    assert.equal(await page.getByLabel("当前标题").textContent(), "新的标题");
    await page.getByRole("button", { name: "模拟溢出" }).click();
    assert.match(await page.locator(".workspace-heading-deck").textContent(), /调整后再导出/);
  } finally { await browser.close(); await server.close(); }
});
