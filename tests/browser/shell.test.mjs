import { test } from "node:test";
import { strict as assert } from "node:assert";
import { preview } from "vite";
import { chromium } from "playwright";
import { resolve } from "node:path";

test("isolated browser opens the React desktop workspace shell", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await preview({
    configFile: false,
    root,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const browser = await chromium.launch({ headless: true });
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
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolveClose, reject) => server.httpServer.close((error) => error ? reject(error) : resolveClose()));
  }
});
