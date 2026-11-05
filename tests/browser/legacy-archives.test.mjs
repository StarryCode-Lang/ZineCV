import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("legacy archive recovery preserves text and raw data and reports errors", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/legacy-archives.tsx"));
    await page.getByRole("button", { name: "打开归档", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "旧版逐框编辑归档" });
    await dialog.getByText("first", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("（空文字）").count(), 1);
    await dialog.getByRole("button", { name: "复制原始 JSON" }).click();
    assert.equal(await page.evaluate(() => window.copied), '{"p1-b10":"first","p1-b2":"","unknown":{"keep":true}}');
    await dialog.getByRole("button", { name: "复制文字" }).click();
    assert.equal(await page.evaluate(() => window.copied), "first\n");
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    await page.getByRole("button", { name: "打开损坏归档" }).click();
    assert.match(await page.getByRole("alert").innerText(), /归档分块不完整/);
  } finally { await browser.close(); await server.close(); }
});
