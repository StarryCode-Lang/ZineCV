import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("command palette searches and runs actions, restores focus and respects disabled state", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/editorial-command.tsx"));
    const trigger = page.getByRole("button", { name: "打开指令面板" });
    await trigger.focus();
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索指令" });
    await search.fill("版型资料室");
    await page.getByRole("option", { name: /打开版型资料室/ }).waitFor();
    await search.press("Enter");
    assert.equal(await page.getByLabel("执行结果").textContent(), "templates");
    await trigger.click();
    await search.fill("ZineBot");
    await page.getByRole("option", { name: /打开 ZineBot/ }).waitFor();
    await search.press("Enter");
    assert.equal(await page.getByLabel("执行结果").textContent(), "agent");
    await trigger.click();
    await search.press("Escape");
    assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
    await page.getByRole("button", { name: "暂停操作" }).click();
    await page.keyboard.press("Control+k");
    assert.equal(await page.getByRole("dialog").count(), 0);

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/mount-command-app.tsx"));
    await page.getByRole("button", { name: "打开指令面板" }).click();
    await page.getByRole("combobox", { name: "搜索指令" }).fill("更换正文字体");
    await page.getByRole("option", { name: /更换正文字体/ }).click();
    await page.locator(".floating-host").waitFor({ state: "visible" });
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索指令" }).fill("ZineBot");
    await page.getByRole("option", { name: /打开 ZineBot/ }).click();
    await page.getByLabel("助手对话").waitFor({ state: "visible" });
  } finally { await browser.close(); await server.close(); }
});
