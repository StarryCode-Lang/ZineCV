import { preview } from "vite";
import { chromium } from "playwright";
import { versionStoragePlugin } from "../server/version-storage.mjs";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { request } from "node:http";

const output = resolve(".artifacts/versioning");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "data-"));
const checks = [];
let server;

async function start() {
  server = await preview({
    configFile: false,
    plugins: [versionStoragePlugin({ directory })],
    preview: { host: "127.0.0.1", port: 0, open: false },
  });
  return `http://127.0.0.1:${server.httpServer.address().port}`;
}
const browser = await chromium.launch({ headless: true });
const errors = [];
async function open(url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.getByText("已保存到本机项目", { exact: true }).waitFor();
  return { page, context };
}
async function chooseChapter(page, key) {
  await page.locator("[data-editor-nav-trigger]").click();
  const menu = page.getByRole("listbox", {
    name: "选择章节",
    exact: true,
  });
  await menu.locator(`[data-editor-nav-key="${key}"]`).click();
  await page.waitForFunction(
    (targetKey) =>
      document.querySelector("[data-editor-nav-trigger]")?.dataset
        .editorNavValue === targetKey,
    key,
  );
}
async function store() {
  return JSON.parse(await readFile(join(directory, "versions.json"), "utf8"));
}
async function waitBranches(page, count) {
  await page.waitForFunction(
    (count) =>
      document
        .querySelector(
          '[data-version-section="branch"] .version-section-title > span',
        )
        ?.textContent?.trim() === `${count} 个分支`,
    count,
  );
}
async function switchBranch(page, name) {
  await page.getByLabel("切换简历分支").click();
  await page.getByRole("option", { name, exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[aria-label="切换简历分支"] span')
        ?.textContent?.trim() === expected,
    name,
  );
}
try {
  const first = await start();
  const { page, context } = await open(first);
  await page.getByLabel("新分支名称").fill("产品方向");
  await page.getByRole("button", { name: "新建分支" }).click();
  await waitBranches(page, 2);
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await chooseChapter(page, "basic");
  await page.getByLabel("姓名", { exact: true }).fill("持久化测试");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page
    .getByRole("button", { name: "有未提交修改，前往保存当前版本" })
    .click();
  assert.equal(
    await page
      .getByLabel("版本说明")
      .evaluate((input) => document.activeElement === input),
    true,
  );
  await page.getByLabel("切换简历分支").click();
  assert.equal(
    await page.getByRole("listbox", { name: "简历分支" }).isVisible(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.locator(".themed-select-menu").waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("listbox", { name: "简历分支" }).count(),
    0,
  );
  await page.getByLabel("版本说明").fill("完善个人信息");
  await page.locator(".commit-button").evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // The success notice can precede the graph render under concurrent load.
  await page
    .locator(".branch-tree-node")
    .filter({ hasText: "完善个人信息" })
    .waitFor();
  assert.equal(
    await page
      .locator(".branch-tree-node")
      .filter({ hasText: "完善个人信息" })
      .count(),
    1,
  );
  await page.getByLabel("新分支名称").fill("研发方向");
  await page.getByRole("button", { name: "新建分支" }).click();
  await waitBranches(page, 3);
  const saved = await store();
  assert.equal(saved.branches.length, 3);
  assert.equal(saved.commits.length, 4);
  checks.push("two branches and four commits persisted to project");
  checks.push(
    "dirty badge opens commit input and themed branch menu closes with Escape",
  );
  await switchBranch(page, "产品方向");
  await page.getByLabel("删除当前分支").click();
  await page.getByRole("button", { name: "删除分支", exact: true }).click();
  await waitBranches(page, 2);
  assert.equal((await store()).branches.length, 2);
  assert.equal((await store()).commits.length, 4);
  assert.equal(await page.locator(".branch-tree-node").count(), 4);
  assert.equal(await page.getByText("历史来源", { exact: true }).count(), 1);
  checks.push(
    "deleting a parent branch preserves descendants and marks its ancestor history as deleted source",
  );
  assert.equal(await page.getByRole("tab").count(), 0);
  assert.equal(await page.getByText("版本历史 · 分支图").count(), 1);
  assert.equal(await page.locator(".branch-tree-node").count(), 4);
  assert.equal(await page.locator(".branch-tree-edges path").count(), 3);
  assert.equal(await page.locator(".branch-tree-lane").count(), 3);
  assert.equal(await page.getByText("历史来源", { exact: true }).count(), 1);
  await page.getByLabel("切换简历分支").click();
  await page.getByRole("option", { name: "研发方向", exact: true }).click();
  const switchResult = await Promise.race([
    page
      .waitForFunction(
        () =>
          document
            .querySelector('[aria-label="切换简历分支"] span')
            ?.textContent?.trim() === "研发方向",
        { timeout: 3000 },
      )
      .then(() => "switched"),
    page
      .getByRole("alertdialog")
      .waitFor({ timeout: 3000 })
      .then(() => "confirm"),
  ]);
  if (switchResult === "confirm")
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "放弃修改并切换", exact: true })
      .click();
  if (switchResult === "confirm")
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="切换简历分支"] span')
          ?.textContent?.trim() === "研发方向",
    );
  const zoomValue = page.locator(".branch-tree-zoom-value");
  assert.equal(await zoomValue.textContent(), "100%");
  await page
    .getByRole("button", { name: "放大分支可视化", exact: true })
    .click();
  assert.equal(await zoomValue.textContent(), "110%");
  await page
    .locator(".branch-tree-scroll")
    .click({ position: { x: 24, y: 72 } });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await page.waitForTimeout(50);
  assert.equal(await zoomValue.textContent(), "120%");
  const canceledWheel = await page
    .locator(".branch-tree-scroll")
    .evaluate((element) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -120,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
  assert.equal(canceledWheel, true);
  assert.equal(await zoomValue.textContent(), "130%");
  checks.push("Ctrl+wheel zoom cancels the browser default action");
  await page.keyboard.press("Equal");
  assert.equal(await zoomValue.textContent(), "140%");
  await page.keyboard.press("Minus");
  assert.equal(await zoomValue.textContent(), "130%");
  await page
    .getByRole("button", { name: "适应分支可视化", exact: true })
    .click();
  assert.match(await zoomValue.textContent(), /^\d+%$/);
  assert.notEqual(await zoomValue.textContent(), "130%");
  for (let index = 0; index < 5; index += 1)
    await page
      .getByRole("button", { name: "放大分支可视化", exact: true })
      .click();
  const treeScroll = page.locator(".branch-tree-scroll");
  const treeBox = await treeScroll.boundingBox();
  assert.ok(treeBox);
  const panPoint = { x: treeBox.x + 250, y: treeBox.y + 72 };
  await treeScroll.evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  });
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(panPoint.x - 90, panPoint.y);
  await page.mouse.up({ button: "right" });
  const rightPan = await treeScroll.evaluate((element) => element.scrollLeft);
  assert.ok(rightPan > 0);
  await treeScroll.evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  });
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(panPoint.x - 70, panPoint.y + 20);
  await page.mouse.up({ button: "middle" });
  const middlePan = await treeScroll.evaluate((element) => element.scrollLeft);
  assert.ok(middlePan > 0);
  await treeScroll.evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  });
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(panPoint.x - 55, panPoint.y);
  await page.mouse.up({ button: "left" });
  const leftPan = await treeScroll.evaluate((element) => element.scrollLeft);
  assert.ok(leftPan > 0);
  await treeScroll.evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = 0;
  });
  const readFirstNodePosition = () =>
    page
      .locator(".branch-tree-node")
      .first()
      .evaluate((node) => {
        const canvas = node.closest(".branch-tree-canvas");
        if (!canvas) throw new Error("branch tree canvas not found");
        const nodeRect = node.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        return {
          x: nodeRect.left - canvasRect.left,
          y: nodeRect.top - canvasRect.top,
        };
      });
  const beforeBranchNode = await readFirstNodePosition();
  assert.ok(beforeBranchNode);
  await page.getByLabel("新分支名称").fill("长期项目方向与复杂版本名称");
  await page.getByRole("button", { name: "新建分支" }).click();
  await waitBranches(page, 3);
  const afterBranchNode = await readFirstNodePosition();
  assert.ok(afterBranchNode);
  assert.ok(Math.abs(afterBranchNode.x - beforeBranchNode.x) <= 1);
  assert.ok(Math.abs(afterBranchNode.y - beforeBranchNode.y) <= 1);
  await page
    .getByRole("button", { name: "适应分支可视化", exact: true })
    .click();
  await page.locator(".branch-tree-node").last().click();
  await page.getByText("分支最新", { exact: false }).first().waitFor();
  await page.locator(".version-history").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "branch-tree.png") });
  checks.push(
    "unified history graph, parent edges, zoom and mouse pan controls",
  );
  checks.push(
    "adding a long-named branch keeps existing node coordinates stable",
  );
  await context.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  const second = await start();
  const recovered = await open(second);
  assert.equal((await store()).commits.length, 5);
  assert.equal((await store()).branches.length, 3);
  assert.equal(await recovered.page.locator(".branch-tree-node").count(), 5);
  assert.match(
    await recovered.page.locator(".resume-pages").innerText(),
    /持久化测试/,
  );
  checks.push(
    "new server, new port and empty browser profile recover branches, commits and selected snapshot",
  );
  const stale = await open(second);
  await recovered.page.getByLabel("新分支名称").fill("最新分支");
  await recovered.page.getByRole("button", { name: "新建分支" }).click();
  await waitBranches(recovered.page, 4);
  await stale.page
    .getByRole("button", { name: "简历编辑", exact: true })
    .click();
  await chooseChapter(stale.page, "basic");
  await stale.page.getByLabel("姓名", { exact: true }).fill("过期提交内容");
  await stale.page
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await stale.page.getByLabel("版本说明").fill("过期提交说明");
  await stale.page.getByRole("button", { name: "提交到当前分支" }).click();
  await stale.page
    .getByText("另一个窗口已更新版本库，请刷新后再操作", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await stale.page.getByLabel("版本说明").inputValue(),
    "过期提交说明",
  );
  await stale.page.getByLabel("新分支名称").fill("过期窗口");
  await stale.page.getByRole("button", { name: "新建分支" }).click();
  await stale.page
    .getByText("另一个窗口已更新版本库，请刷新后再操作", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await stale.page.getByLabel("新分支名称").inputValue(),
    "过期窗口",
  );
  assert.equal((await store()).branches.length, 4);
  checks.push(
    "stale commit and branch cannot overwrite newer history and retain failed inputs",
  );
  const backup = JSON.parse(
    await readFile(join(directory, "versions.backup.json"), "utf8"),
  );
  assert.equal(backup.branches.length, 3);
  checks.push("previous file remains as backup");
  await recovered.page.getByLabel("删除当前分支").click();
  await recovered.page
    .getByRole("button", { name: "删除分支", exact: true })
    .click();
  await waitBranches(recovered.page, 3);
  await recovered.page.reload();
  await recovered.page
    .getByRole("button", { name: "版本管理", exact: true })
    .click();
  await recovered.page
    .getByText("已保存到本机项目", { exact: false })
    .waitFor();
  assert.equal((await store()).branches.length, 3);
  checks.push("deleted branch does not reappear after reload");
  const intact = await readFile(join(directory, "versions.json"), "utf8");
  await writeFile(join(directory, "versions.json"), "{broken");
  const failed = await fetch(second + "/api/resume-versions");
  assert.equal(failed.status, 500);
  assert.equal(
    await readFile(join(directory, "versions.json"), "utf8"),
    "{broken",
  );
  await writeFile(join(directory, "versions.json"), intact);
  checks.push(
    "corrupt project data fails closed without creating empty history",
  );
  const latest = await (await fetch(second + "/api/resume-versions")).json();
  latest.store.commits[0].message = "跨分片中文测试";
  const payload = Buffer.from(JSON.stringify(latest));
  const split = payload.indexOf(Buffer.from("跨")) + 1;
  await new Promise((resolve, reject) => {
    const req = request(
      second + "/api/resume-versions",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode === 200
            ? resolve()
            : reject(new Error(`HTTP ${res.statusCode}`)),
        );
      },
    );
    req.on("error", reject);
    req.write(payload.subarray(0, split));
    setTimeout(() => req.end(payload.subarray(split)), 20);
  });
  assert.equal((await store()).commits[0].message, "跨分片中文测试");
  checks.push("UTF-8 text remains intact across request chunks");
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ status: "PASS", checks, pageErrors: errors }, null, 2),
  );
  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  await browser.close();
  if (server?.httpServer.listening)
    await new Promise((resolve) => server.httpServer.close(resolve));
}
