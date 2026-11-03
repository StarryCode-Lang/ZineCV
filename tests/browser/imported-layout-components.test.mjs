import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("source layout edits only changed boxes and can restore the original", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => (await import("/tests/browser/fixtures/imported-layout.tsx")).mountImportedLayout());
    const name = page.locator('[data-imported-layout-field="name"] input');
    await name.waitFor();
    assert.equal(await page.locator(".imported-layout-patch").count(), 0);
    await name.fill("Changed name");
    assert.equal(await page.locator('[data-imported-layout-patch="name"]').innerText(), "Changed name");
    assert.equal(await page.locator('[data-imported-layout-patch="role"]').count(), 0);
    await name.fill("");
    assert.equal(await page.locator('[data-imported-layout-cover="name"]').count(), 1);
    const coverBottom = await page.locator('[data-imported-layout-cover="name"]').evaluate((element) => element.offsetTop + element.offsetHeight);
    assert.ok(coverBottom < 92, "cover must not obscure the next line");
    await page.getByRole("button", { name: "恢复原文" }).click();
    assert.equal(await name.inputValue(), "Original name");
    assert.equal(await page.locator(".imported-layout-patch").count(), 0);
  } finally { await browser.close(); await server.close(); }
});
