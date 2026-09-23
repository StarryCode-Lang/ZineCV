const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, ".artifacts", "persistence");
const REQUIRED_KEYS = [
  "resume-diy-state",
  "resume-diy-modules",
  "resume-diy-section-order-v2",
  "resume-diy-module-names",
  "resume-diy-title",
  "resume-diy-summary-title",
  "resume-diy-preferences",
  "resume-diy-layout-consistency-v1",
];

fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

function startStaticServer() {
  const resolvedRoot = path.resolve(DIST_ROOT);
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
    let filePath = path.resolve(resolvedRoot, `.${requestPath}`);
    if (
      !filePath.startsWith(`${resolvedRoot}${path.sep}`) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      filePath = path.join(resolvedRoot, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type":
        mimeTypes[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(
      request.method === "HEAD" ? undefined : fs.readFileSync(filePath),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
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

async function waitForSaved(page) {
  await page.waitForFunction(
    () =>
      document
        .querySelector(".save-state")
        ?.textContent?.includes("浏览器草稿已保存"),
    null,
    { timeout: 3000 },
  );
}

async function waitForFailure(page) {
  await page.waitForFunction(
    () =>
      document
        .querySelector(".save-state")
        ?.textContent?.includes("浏览器草稿保存失败"),
    null,
    { timeout: 3000 },
  );
}

async function stored(page, key) {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function installFailure(page, blockedKey) {
  await page.evaluate((key) => {
    const storage = Storage.prototype;
    if (!window.__resumeDraftOriginalSetItem) {
      Object.defineProperty(window, "__resumeDraftOriginalSetItem", {
        configurable: true,
        value: storage.setItem,
      });
    }
    const original = window.__resumeDraftOriginalSetItem;
    storage.setItem = function setItemWithFailure(name, value) {
      if (name === key) throw new DOMException("blocked", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, blockedKey);
}

async function restoreStorage(page) {
  await page.evaluate(() => {
    if (window.__resumeDraftOriginalSetItem)
      Storage.prototype.setItem = window.__resumeDraftOriginalSetItem;
  });
}

async function main() {
  const { server, url } = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const checks = [];

  try {
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    await waitForSaved(page);

    const keys = await page.evaluate(() => Object.keys(localStorage).sort());
    for (const key of REQUIRED_KEYS)
      assert.ok(keys.includes(key), `${key} missing`);
    const initialPreferences = JSON.parse(
      await stored(page, "resume-diy-preferences"),
    );
    assert.equal(initialPreferences.smartFillV2, "false");
    checks.push(
      "one debounced flush writes body, order, names, titles and preferences",
    );

    await chooseChapter(page, "basic");
    const nameInput = page.getByLabel("姓名", { exact: true });
    await installFailure(page, "resume-diy-state");
    await nameInput.fill("正文失败后的新值");
    await waitForFailure(page);
    assert.notEqual(
      JSON.parse(await stored(page, "resume-diy-state")).basic.name,
      "正文失败后的新值",
    );
    checks.push(
      "body write failure is visible and does not claim all data was saved",
    );

    await restoreStorage(page);
    await page
      .getByRole("button", { name: "重试保存浏览器草稿", exact: true })
      .click();
    await waitForSaved(page);
    assert.equal(
      JSON.parse(await stored(page, "resume-diy-state")).basic.name,
      "正文失败后的新值",
    );
    checks.push("restored storage succeeds through the explicit retry action");

    await installFailure(page, "resume-diy-preferences");
    await page
      .getByRole("button", { name: "宋体", exact: true })
      .first()
      .click();
    await page
      .locator(".font-settings-panel")
      .getByRole("button", { name: "雅黑", exact: true })
      .click();
    await waitForFailure(page);
    assert.equal(
      JSON.parse(await stored(page, "resume-diy-preferences")).font,
      initialPreferences.font,
    );
    checks.push(
      "preference write failure keeps the prior stored preference and reports failure",
    );

    await restoreStorage(page);
    await page
      .getByRole("button", { name: "重试保存浏览器草稿", exact: true })
      .click();
    await waitForSaved(page);
    assert.equal(
      JSON.parse(await stored(page, "resume-diy-preferences")).font,
      "雅黑",
    );

    await page.getByRole("button", { name: "模块管理", exact: true }).click();
    await installFailure(page, "resume-diy-module-names");
    await page
      .getByRole("button", { name: "编辑实习经历", exact: true })
      .click();
    const moduleNameInput = page.locator(".manager-row input").first();
    await moduleNameInput.fill("失败后恢复的工作经历");
    await waitForFailure(page);
    assert.notEqual(
      JSON.parse(await stored(page, "resume-diy-module-names")).work,
      "失败后恢复的工作经历",
    );
    checks.push(
      "module-name write failure is reported without clearing the old value",
    );

    await restoreStorage(page);
    await page
      .getByRole("button", { name: "重试保存浏览器草稿", exact: true })
      .click();
    await waitForSaved(page);
    assert.equal(
      JSON.parse(await stored(page, "resume-diy-module-names")).work,
      "失败后恢复的工作经历",
    );

    // Retrying from the top bar is an outside click and closes the popover.
    assert.equal(
      await page.getByRole("dialog", { name: "模块管理", exact: true }).count(),
      0,
    );
    await nameInput.fill("快速编辑一");
    await nameInput.fill("快速编辑二");
    await nameInput.fill("快速编辑最终值");
    await waitForSaved(page);
    assert.equal(
      JSON.parse(await stored(page, "resume-diy-state")).basic.name,
      "快速编辑最终值",
    );
    checks.push("rapid edits are debounced to the latest draft value");

    await nameInput.fill("pagehide 立即写入");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.equal(
      JSON.parse(await stored(page, "resume-diy-state")).basic.name,
      "pagehide 立即写入",
    );
    checks.push("pagehide flush uses the latest in-memory draft");

    assert.deepEqual(pageErrors, []);
    const result = {
      status: "PASS",
      checks,
      requiredKeys: REQUIRED_KEYS,
      pageErrors,
    };
    fs.writeFileSync(
      path.join(ARTIFACT_ROOT, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await restoreStorage(page).catch(() => {});
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  fs.writeFileSync(
    path.join(ARTIFACT_ROOT, "failure.json"),
    JSON.stringify(
      { status: "FAIL", error: String(error), stack: error.stack },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
});
