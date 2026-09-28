import { test } from "node:test";
import { strict as assert } from "node:assert";
import { preview } from "vite";
import { chromium } from "playwright";
import { resolve } from "node:path";

test("Svelte interaction sample covers rich text, drag, keyboard, pane and agent mode", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await preview({ configFile: false, root, preview: { host: "127.0.0.1", port: 0, strictPort: true } });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/?sample=interaction`);
    await page.getByLabel("Svelte 等价交互样片").waitFor();

    const firstEditor = page.getByLabel("前端工程师 内容");
    await firstEditor.click();
    await firstEditor.fill("本地输入普通加粗");
    await page.locator('[data-module="work-1"]').getByRole("button", { name: "折叠" }).click();
    await firstEditor.waitFor({ state: "detached" });
    await page.locator('[data-module="work-1"]').getByRole("button", { name: "展开" }).click();
    await firstEditor.waitFor();
    assert.match(await firstEditor.innerHTML(), /本地输入普通加粗/);
    await page.keyboard.press("End");
    await firstEditor.evaluate((node) => {
      node.focus();
      const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).lastChild();
      const range = document.createRange();
      range.setStart(text, text.data.length - 2);
      range.setEnd(text, text.data.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.locator('[data-module="work-1"]').getByLabel("粗体").click();
    assert.match(await firstEditor.innerHTML(), /<b>加粗<\/b>/);

    await page.locator('[data-module="work-1"]').getByRole("button", { name: "插入链接" }).click();
    await page.getByLabel("链接地址").fill("example.com/resume");
    await page.getByRole("button", { name: "保存链接" }).click();
    assert.match(await firstEditor.innerHTML(), /<a href="https:\/\/example\.com\/resume">/);

    const ids = () => page.$$eval("[data-module]", (nodes) => nodes.map((node) => node.getAttribute("data-module")));
    assert.deepEqual(await ids(), ["work-1", "project-1", "skill-1"]);
    const firstGrip = page.getByLabel("拖拽 前端工程师");
    const secondModule = page.locator('[data-module="project-1"]');
    await firstGrip.click();
    assert.deepEqual(await ids(), ["work-1", "project-1", "skill-1"]);
    assert.equal(await page.locator(".module.dragging").count(), 0);
    const from = await firstGrip.boundingBox();
    const to = await secondModule.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await ids(), ["project-1", "work-1", "skill-1"]);
    await page.getByRole("button", { name: "上移 前端工程师" }).click();
    assert.deepEqual(await ids(), ["work-1", "project-1", "skill-1"]);

    await page.locator(`[data-module="work-1"]`).getByRole("button", { name: "折叠" }).click();
    await page.waitForTimeout(250);
    assert.equal(await page.getByLabel("前端工程师 内容").count(), 0);
    await page.locator(`[data-module="work-1"]`).getByRole("button", { name: "展开" }).click();
    await page.getByLabel("前端工程师 内容").waitFor();

    const splitter = page.getByRole("slider", { name: "分栏宽度" });
    await splitter.focus();
    const beforeWidth = await splitter.getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowRight");
    const afterWidth = await splitter.getAttribute("aria-valuenow");
    assert.equal(Number(afterWidth), Number(beforeWidth) + 16);
    const splitterBox = await splitter.boundingBox();
    assert.ok(splitterBox);
    await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 20, splitterBox.y + splitterBox.height / 2, { steps: 4 });
    await page.mouse.up();
    assert.equal(Number(await splitter.getAttribute("aria-valuenow")), Number(afterWidth) + 20);
    const widthBeforeCancel = Number(await splitter.getAttribute("aria-valuenow"));
    const movedBox = await splitter.boundingBox();
    assert.ok(movedBox);
    await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(movedBox.x + movedBox.width / 2 + 12, movedBox.y + movedBox.height / 2);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel")));
    await page.mouse.up();
    assert.equal(Number(await splitter.getAttribute("aria-valuenow")), widthBeforeCancel);

    await page.getByRole("button", { name: "会话" }).click();
    assert.equal(await page.getByRole("button", { name: "会话" }).getAttribute("aria-pressed"), "true");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((closeDone, reject) => server.httpServer.close((error) => error ? reject(error) : closeDone()));
  }
});
