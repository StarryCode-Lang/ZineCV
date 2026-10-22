import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";
import { resolve } from "node:path";

test("isolated browser opens the React desktop workspace shell", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    // React 工作区外壳按旧版结构渲染，浏览器模式明确降级且不写入任何数据。
    await page.locator(".app-shell").waitFor({ timeout: 20000 });
    await page.getByText("请在桌面应用中运行").waitFor({ timeout: 20000 });
    assert.equal(errors.length, 0, `Unexpected page errors: ${errors.join("; ")}`);
    await page.goto(`http://127.0.0.1:${address.port}/__zinecv_browser_test_page.html`);
    const pane = await page.evaluate(async () => (await import("/tests/browser/fixtures/pane-restore.tsx")).checkPaneRestore());
    assert.equal(pane.restored, 520, "restore saved width without bouncing to startup default");
    assert.deepEqual(pane.restoreWrites, [], "hydration never writes stale widths back");
    assert.equal(pane.keyboard, 536);
    assert.equal(pane.bounded, pane.max, "restored oversized preference obeys current viewport bounds");
    assert.equal(pane.reset, 560);
    assert.deepEqual(pane.writes, [536, 560], "only explicit resize actions persist preferences");
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
