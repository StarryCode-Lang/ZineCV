const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, ".artifacts", "module-management");
const SUPPORTED_MODULES = [
  "education",
  "skills",
  "work",
  "projects",
  "orgs",
  "research",
  "awards",
  "other",
  "portfolio",
  "custom",
];
const DEFAULT_VISIBLE = ["education", "skills", "work", "projects", "orgs", "summary"];
const LABELS = {
  education: "教育经历",
  skills: "专业技能",
  work: "实习经历",
  projects: "项目经历",
  orgs: "社团和组织经历",
  research: "研究经历",
  awards: "荣誉奖项",
  other: "其他经历",
  portfolio: "作品集",
  custom: "自定义模块",
  summary: "自我评价",
};

fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".otf": "font/otf",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

function startServer() {
  const root = path.resolve(DIST_ROOT);
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
    let filePath = path.resolve(root, `.${requestPath}`);
    if (
      !filePath.startsWith(`${root}${path.sep}`) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    )
      filePath = path.join(root, "index.html");
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
    response.end(request.method === "HEAD" ? undefined : fs.readFileSync(filePath));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

async function waitForSaved(page) {
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent?.includes("浏览器草稿已保存"),
    null,
    { timeout: 3000 },
  );
}

async function editorOrder(page) {
  return page.locator(".editor-workspace-pane [data-editor-module]").evaluateAll(
    (elements) => elements.map((element) => element.getAttribute("data-editor-module")),
  );
}

async function openManager(page) {
  if (!(await page.locator('[role="dialog"][aria-label="模块管理"]').count()))
    await page.getByRole("button", { name: "模块管理", exact: true }).click();
  await page.locator('[role="dialog"][aria-label="模块管理"]').waitFor();
}

async function closeManager(page) {
  if (await page.locator('[role="dialog"][aria-label="模块管理"]').count())
    await page.getByRole("button", { name: "关闭模块管理", exact: true }).click();
}

async function hideAndRestore(page, section) {
  const label = LABELS[section];
  await openManager(page);
  await page.getByRole("button", { name: `隐藏${label}`, exact: true }).click();
  await page
    .locator(".confirm-dialog")
    .getByRole("button", { name: "删除模块", exact: true })
    .click();
  await page.waitForFunction(
    (module) => !document.querySelector(`[data-editor-module="${module}"]`),
    section,
  );
  await openManager(page);
  assert.equal(
    await page
      .locator(`[data-manager-section="${section}"][data-manager-state="hidden"]`)
      .count(),
    1,
  );
  await page.getByRole("button", { name: `恢复${label}`, exact: true }).click();
  await page.waitForSelector(`[data-editor-module="${section}"]`);
}

async function main() {
  const { server, url } = await startServer();
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

    await openManager(page);
    const visibleRows = await page
      .locator('[data-manager-state="visible"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-manager-section")));
    const hiddenRows = await page
      .locator('[data-manager-state="hidden"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-manager-section")));
    assert.deepEqual(visibleRows, DEFAULT_VISIBLE);
    assert.deepEqual(hiddenRows.sort(), ["awards", "custom", "other", "portfolio", "research"]);
    assert.deepEqual(
      [...visibleRows, ...hiddenRows].filter((section) => section !== null).sort(),
      [...SUPPORTED_MODULES, "summary"].sort(),
    );
    checks.push("manager exposes every supported module and summary as visible or recoverable");
    await closeManager(page);

    const originalWorkIds = await page
      .locator('[data-editor-module="work"] [data-editor-entry-id]')
      .evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-editor-entry-id")));
    await hideAndRestore(page, "work");
    const restoredWorkIds = await page
      .locator('[data-editor-module="work"] [data-editor-entry-id]')
      .evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-editor-entry-id")));
    assert.deepEqual(restoredWorkIds, originalWorkIds);
    checks.push("hiding and restoring a populated module preserves its entry IDs and content");

    await openManager(page);
    await page.getByRole("button", { name: "恢复研究经历", exact: true }).click();
    await page.waitForSelector('[data-editor-module="research"]');
    assert.equal(
      await page.locator('[data-editor-module="research"] [data-editor-entry-id]').count(),
      0,
    );
    await page.getByRole("button", { name: "添加一段研究经历", exact: true }).click();
    const researchEntryId = await page
      .locator('[data-editor-module="research"] [data-editor-entry-id]')
      .first()
      .getAttribute("data-editor-entry-id");
    assert.ok(researchEntryId);
    await hideAndRestore(page, "research");
    assert.deepEqual(
      await page
        .locator('[data-editor-module="research"] [data-editor-entry-id]')
        .evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-editor-entry-id"))),
      [researchEntryId],
    );
    checks.push("restoring an empty module creates no sample entry; adding an entry remains independent");

    await hideAndRestore(page, "summary");
    const restoredOrder = await editorOrder(page);
    assert.equal(restoredOrder.at(-1), "summary");
    checks.push("restored ordinary modules insert before summary and restored summary goes to the end");

    await openManager(page);
    const beforeMove = await editorOrder(page);
    await page.getByRole("button", { name: "将项目经历上移", exact: true }).click();
    const movedUp = await editorOrder(page);
    assert.equal(movedUp.indexOf("projects"), beforeMove.indexOf("projects") - 1);
    await page.getByRole("button", { name: "将项目经历下移", exact: true }).click();
    const movedDown = await editorOrder(page);
    assert.equal(movedDown.indexOf("projects"), beforeMove.indexOf("projects"));
    await page.getByRole("button", { name: "将自我评价上移", exact: true }).click();
    const userOrdered = await editorOrder(page);
    assert.notEqual(userOrdered.at(-1), "summary");
    await closeManager(page);
    await page.waitForFunction(
      (expected) => localStorage.getItem("resume-diy-section-order-v2") === JSON.stringify(expected),
      userOrdered,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready);
    await waitForSaved(page);
    assert.deepEqual(await editorOrder(page), userOrdered);
    checks.push("keyboard-accessible up/down ordering persists the user-selected order after reload");

    assert.deepEqual(pageErrors, []);
    const result = { status: "PASS", checks, pageErrors };
    fs.writeFileSync(
      path.join(ARTIFACT_ROOT, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeManager(page).catch(() => {});
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
