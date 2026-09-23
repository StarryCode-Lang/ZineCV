import assert from "node:assert/strict";
import { preview } from "vite";
import { chromium } from "playwright";

const templateKey = "resume-diy-imported-templates-v1";
const activityKey = "resume-diy-template-library-v1";
const server = await preview({
  configFile: false,
  preview: { host: "127.0.0.1", port: 0, open: false },
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const errors = [];
const checks = [];
try {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.evaluate(
    ({ templateKey, activityKey }) => {
      localStorage.setItem(
        "resume-diy-state",
        JSON.stringify({
          basic: { name: "模板库隔离测试" },
          summary: "<p>测试内容</p>",
        }),
      );
      localStorage.setItem("resume-diy-active-imported-template", "fixture-0");
      localStorage.removeItem("resume-diy-version-store-v1");
      localStorage.removeItem("resume-diy-version-store-v1-backup");
      localStorage.setItem(
        templateKey,
        JSON.stringify(
          ["甲", "乙"].map((name, index) => ({
            id: `fixture-${index}`,
            name: `测试模板${name}`,
            sourceName: "fixture.pdf",
            sourceType: "pdf",
            createdAt: "2026-09-22T00:00:00.000Z",
            accent: "#000000",
            formatId: "legacy-v1",
            layout: "single-column",
            analysis: "隔离测试模板",
          })),
        ),
      );
      localStorage.removeItem(activityKey);
    },
    { templateKey, activityKey },
  );
  await page.reload();
  await page.waitForFunction(() => {
    const store = JSON.parse(
      localStorage.getItem("resume-diy-version-store-v1") ?? "null",
    );
    return store?.commits?.length === 1;
  });
  await page.getByRole("button", { name: "模板", exact: true }).click();
  const chooseFilter = async (label) => {
    await page.getByRole("button", { name: "查看模板" }).click();
    await page.getByRole("menuitemradio", { name: label }).click();
  };
  const imported = page.locator(".template-library-card.imported");
  await imported.first().waitFor();
  assert.equal(await imported.count(), 2);
  await chooseFilter("最近使用");
  assert.equal(await imported.count(), 0);
  await chooseFilter("全部模板");
  await page.waitForTimeout(500);
  const beforeFavorite = await page.evaluate(() =>
    localStorage.getItem("resume-diy-state"),
  );
  await page
    .getByRole("button", { name: "收藏模板 测试模板甲", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("resume-diy-state")),
    beforeFavorite,
  );
  await chooseFilter("已收藏");
  assert.equal(await imported.count(), 1);
  assert.match(await imported.innerText(), /测试模板甲/);
  checks.push(
    "legacy imports remain compatible; favorites do not alter resume content",
  );

  await page.reload();
  await page.getByRole("button", { name: "模板", exact: true }).click();
  await page.getByRole("button", { name: "重命名模板 测试模板甲" }).click();
  await page.getByRole("textbox", { name: "模板名称" }).fill("命名后的模板甲");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key))[0].name,
      templateKey,
    ),
    "命名后的模板甲",
  );
  checks.push("template rename persists in the imported template record");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.locator(".branch-tree-node").first().waitFor();
  assert.equal(
    await page
      .locator(".branch-tree-node .version-template-badge")
      .first()
      .innerText(),
    "命名后的模板甲",
  );
  checks.push("historical graph nodes resolve the current template name");
  await page.getByRole("button", { name: "模板", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "取消收藏 命名后的模板甲", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await imported
    .filter({ hasText: "命名后的模板甲" })
    .locator(".template-library-select")
    .click();
  await imported
    .filter({ hasText: "测试模板乙" })
    .locator(".template-library-select")
    .click();
  await chooseFilter("最近使用");
  assert.equal(await imported.count(), 2);
  assert.match(await imported.first().innerText(), /测试模板乙/);
  await page.reload();
  await page.getByRole("button", { name: "模板", exact: true }).click();
  await chooseFilter("最近使用");
  assert.match(await imported.first().innerText(), /测试模板乙/);
  await page.getByRole("button", { name: "重命名模板 命名后的模板甲" }).click();
  await page
    .getByRole("textbox", { name: "模板名称" })
    .fill("全局重命名模板甲");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.locator(".branch-tree-node").first().waitFor();
  assert.equal(
    await page
      .locator(".branch-tree-node .version-template-badge")
      .first()
      .innerText(),
    "全局重命名模板甲",
  );
  checks.push("inactive template rename updates its saved version history");
  await page.getByRole("button", { name: "模板", exact: true }).click();
  checks.push(
    "favorites and actual use timestamps survive reload; recent use sorts newest first",
  );

  await page
    .getByRole("button", { name: "删除模板 测试模板乙", exact: true })
    .click();
  assert.equal(await imported.count(), 1);
  assert.equal(
    await page.evaluate(
      (key) =>
        Object.hasOwn(JSON.parse(localStorage.getItem(key)), "fixture-1"),
      activityKey,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "取消收藏 全局重命名模板甲", exact: true })
    .click();
  await chooseFilter("已收藏");
  assert.equal(await imported.count(), 0);
  checks.push(
    "delete removes usage metadata; unfavorite updates filtered results",
  );

  await chooseFilter("全部模板");
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key)
        throw new DOMException("Test quota", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, activityKey);
  await page
    .getByRole("button", { name: "收藏模板 全局重命名模板甲", exact: true })
    .click();
  assert.match(await page.getByRole("alert").innerText(), /收藏保存失败/);
  assert.equal(
    await page
      .getByRole("button", { name: "收藏模板 全局重命名模板甲", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  checks.push(
    "storage failure is visible and does not report a saved favorite",
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "PASS", checks, errors }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
