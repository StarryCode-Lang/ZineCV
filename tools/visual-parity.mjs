// 新旧版本预览视觉对照：同一 Chromium、同一虚构夹具数据、同一视口，
// 分别渲染旧版 dist 与桌面版 dist，对右侧 A4 纸面区域逐像素比较。
// 该比较证明"同一输入在两套构建里的排版输出一致"；WebView2 的原生滚动条
// 差异属于宿主层，另行在真实 exe 验收中覆盖。
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { preview } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { resolve } from "node:path";
import { visualFixture } from "./visual-parity-fixture.mjs";

const oldRoot = "D:/Desktop/resume DIY";
const newRoot = resolve(import.meta.dirname, "..");

async function servePreview(root) {
  const server = await preview({
    configFile: false,
    root,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function capturePaper(context, url, storage, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  // 在应用脚本执行前注入夹具：旧版 pagehide 的 flushDraft 会用当前状态覆盖
  // localStorage，必须在首帧之前就位，避免 reload 时被空白状态冲掉。
  await page.addInitScript((entries) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(url, { waitUntil: "networkidle" });
  const paper = page.locator(".paper-frame").first();
  await paper.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600); // 字体加载与动效余量
  const shot = await paper.screenshot({ animations: "disabled" });
  await page.close();
  return shot;
}

test("old and desktop builds render identical A4 preview pixels from the same fixture", { timeout: 120_000 }, async () => {
  const oldServer = await servePreview(oldRoot);
  const newServer = await servePreview(newRoot);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const storage = visualFixture();
    const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
    const results = [];
    for (const viewport of viewports) {
      const oldShot = await capturePaper(context, oldServer.url, storage, viewport);
      const newShot = await capturePaper(context, newServer.url, storage, viewport);
      const oldPng = PNG.sync.read(oldShot);
      const newPng = PNG.sync.read(newShot);
      assert.equal(oldPng.width, newPng.width, `paper width mismatch at ${viewport.width}`);
      assert.equal(oldPng.height, newPng.height, `paper height mismatch at ${viewport.width}`);
      const diff = new PNG({ width: oldPng.width, height: oldPng.height });
      const mismatched = pixelmatch(oldPng.data, newPng.data, diff.data, oldPng.width, oldPng.height, { threshold: 0.1 });
      const ratio = mismatched / (oldPng.width * oldPng.height);
      results.push({ viewport: `${viewport.width}x${viewport.height}`, width: oldPng.width, height: oldPng.height, mismatchedPixels: mismatched, diffRatio: Number(ratio.toFixed(5)) });
    }
    console.log("VISUAL_PARITY:", JSON.stringify(results));
    for (const result of results) {
      // 完全相同的组件树、样式与字体下，差异应几乎为零；0.2% 作为报警阈值。
      assert.ok(result.diffRatio <= 0.002, `preview diff ${result.diffRatio} exceeds 0.2% at ${result.viewport}`);
    }
  } finally {
    await context.close();
    await browser.close();
    await new Promise((done, reject) => oldServer.server.httpServer.close((error) => error ? reject(error) : done()));
    await new Promise((done, reject) => newServer.server.httpServer.close((error) => error ? reject(error) : done()));
  }
});
