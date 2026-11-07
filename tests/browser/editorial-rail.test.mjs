import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("magazine rail retains desktop controls and changes the active workspace", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => (await import("/tests/browser/fixtures/editorial-rail.tsx")).mountRail());
    await page.getByRole("button", { name: "简历编辑" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "简历编辑" }).getAttribute("aria-current"), "page");
    for (const label of ["模板", "版本管理"]) assert.equal(await page.getByRole("button", { name: label }).isVisible(), true);
    assert.equal(await page.locator(".document-switcher").count(), 0);
    assert.equal(await page.getByText("岗位定制").count(), 0);
    await page.getByRole("button", { name: "模板" }).click();
    assert.equal(await page.getByRole("button", { name: "模板" }).getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".rail-watermark").textContent(), "02");
    await page.getByRole("button", { name: "版本管理" }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("button", { name: "版本管理" }).getAttribute("aria-current"), "page");
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator(".rail").isVisible(), false);
  } finally {
    await browser.close();
    await server.close();
  }
});
