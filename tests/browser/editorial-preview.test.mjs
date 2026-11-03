import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("preview fit resets zoom and centers the unchanged A4 paper", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/editorial-preview.tsx"));
    const input = page.getByLabel("预览缩放百分比");
    await input.waitFor();
    const initial = Number(await input.inputValue());
    assert.ok(initial > 20 && initial < 200);
    await input.fill("150"); await input.press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-label="预览缩放百分比"]').value === "150");
    await page.getByRole("button", { name: "恢复默认缩放" }).click();
    await page.waitForFunction(value => Number(document.querySelector('[aria-label="预览缩放百分比"]').value) === value, initial);
    const geometry = await page.locator(".paper-frame").first().evaluate(frame => {
      const pane = frame.closest(".preview-pane").getBoundingClientRect();
      const rect = frame.getBoundingClientRect();
      const paper = frame.querySelector(".paper");
      const style = getComputedStyle(paper);
      return { left: rect.left - pane.left, right: pane.right - rect.right, width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    assert.ok(Math.abs(geometry.left - geometry.right) < 4, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.width - 794) < 1 && Math.abs(geometry.height - 1123) < 1, JSON.stringify(geometry));
    assert.equal(Number(await page.getByLabel("保存的缩放").textContent()), initial);
  } finally { await browser.close(); await server.close(); }
});
