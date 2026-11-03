import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("source editing updates the correct preview page and pagination", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/source-layout-workspace.tsx"));
    const input = page.locator('[data-imported-layout-field="p1-b1"] input'); await input.waitFor();
    assert.equal(await page.locator(".resume-pages .imported-layout-paper").count(), 2);
    assert.match(await page.locator(".preview-pagination").getAttribute("aria-label"), /共 2 页/);
    await input.fill("Updated");
    assert.equal(await page.locator('[data-page-number="1"] [data-imported-layout-patch="p1-b1"]').innerText(), "Updated");
    assert.equal(await page.locator('[data-page-number="2"] .imported-layout-patch').count(), 0);
    await page.getByRole("button", { name: "下一页" }).click();
    await page.waitForFunction(() => document.querySelector(".preview-pagination")?.getAttribute("aria-label")?.includes("第 2 页"));
  } finally { await browser.close(); await server.close(); }
});
