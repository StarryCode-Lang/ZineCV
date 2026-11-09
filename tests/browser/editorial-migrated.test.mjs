/* 由 7 个同组测试文件合并；测试块自包含，行为与合并前一致。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

/* ==== 原 branch-magazine.test.mjs ==== */

test("magazine graph keeps lazy history, protects the main branch and anchors actions", async () => {
  const detailModule = `export async function loadCommitDetail(id) {
    if (id === "head") await new Promise(resolve => setTimeout(resolve, 150));
    return { importedTemplate: null, presentation: { templateId: id === "head" ? "legacy-v1" : "clear-single-v1" } };
  }`;
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."), {
    sourceOverrides: new Map([["src/platform/versionDetails.ts", detailModule]]),
  });
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/branch-magazine.tsx"));
    await page.getByText("空分支").waitFor();
    assert.equal(await page.locator("[data-version-commit-id]").count(), 2);
    assert.equal(await page.locator(".branch-fork-path").count(), 1);
    await page.locator('[data-version-commit-id="head"]').click();
    let popover = page.locator(".branch-node-popover");
    await popover.waitFor();
    assert.equal(await popover.getByRole("button", { name: "载入" }).isDisabled(), true);
    assert.equal(await popover.getByRole("button", { name: "删除分支" }).count(), 0);
    await page.locator('[data-version-commit-id="fork-head"]').click();
    await popover.getByText("清晰单栏", { exact: false }).waitFor();
    await popover.getByRole("button", { name: "删除分支" }).click();
    assert.deepEqual(await page.evaluate(() => window.branchActions), ["branch:fork"]);
    await page.getByRole("button", { name: "分支图全屏" }).click();
    assert.equal(await page.locator(".branch-tree-expanded").count(), 1);
    await page.getByRole("button", { name: "退出分支图全屏" }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 editorial-brief.test.mjs ==== */

test("editorial brief edits the supplied title and reflects export overflow", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/editorial-brief.tsx"));
    await page.getByRole("button", { name: "原始标题" }).click();
    await page.getByLabel("简历名称").fill("新的标题");
    await page.getByLabel("简历名称").press("Enter");
    assert.equal(await page.getByLabel("当前标题").textContent(), "新的标题");
    await page.getByRole("button", { name: "模拟溢出" }).click();
    assert.match(await page.locator(".workspace-heading-deck").textContent(), /调整后再导出/);
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 editorial-command.test.mjs ==== */

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

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/mount-command-app.tsx"));
    await page.getByRole("button", { name: "打开指令面板" }).click();
    await page.getByRole("combobox", { name: "搜索指令" }).fill("逐框编辑归档");
    await page.getByRole("option", { name: /查看旧版逐框编辑归档/ }).click();
    const archive = page.getByRole("dialog", { name: "旧版逐框编辑归档" });
    await archive.waitFor({ state: "visible" });
    assert.match(await archive.getByRole("alert").innerText(), /unavailable/);
    await archive.getByRole("button", { name: "关闭" }).click();
    assert.equal(await archive.count(), 0);
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 editorial-navigation.test.mjs ==== */

test("chapter menu reports completion and navigates without changing resume data", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/editorial-navigation.tsx"));
    await page.getByRole("button", { name: "跳转到章节" }).click();
    const menu = page.getByRole("listbox", { name: "选择章节" });
    await menu.waitFor();
    assert.match(await menu.innerText(), /待撰写/);
    await menu.getByRole("option", { name: /自我评价/ }).click();
    assert.deepEqual(JSON.parse(await page.getByLabel("定位目标").textContent()), { kind: "summary" });
    await page.getByRole("button", { name: "跳转到章节" }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "跳转到章节" }).getAttribute("aria-expanded"), "false");
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 editorial-preview.test.mjs ==== */

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

/* ==== 原 editorial-rail.test.mjs ==== */

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

/* ==== 原 zinebot-mark.test.mjs ==== */

test("ZineBot marks have isolated gradients and respect reduced motion", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/zinebot-mark.tsx"));
    await page.locator(".agent-mark").first().waitFor();
    const evidence = await page.evaluate(() => {
      const ids = [...document.querySelectorAll(".agent-mark defs [id]")].map(node => node.id);
      return { count: document.querySelectorAll(".agent-mark").length, ids, animation: getComputedStyle(document.querySelector(".agent-mark.is-running .agent-mark-body")).animationName };
    });
    assert.equal(evidence.count, 2);
    assert.equal(new Set(evidence.ids).size, evidence.ids.length);
    assert.equal(evidence.animation, "none");
  } finally { await browser.close(); await server.close(); }
});

