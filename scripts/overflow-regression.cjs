const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, ".artifacts", "overflow");
const OUTPUT_ROOT = path.join(ARTIFACT_ROOT, "downloads");
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

async function loadStorageFixture(page, values) {
  await page.evaluate((nextStorage) => {
    sessionStorage.setItem(
      "__preview_overflow_storage__",
      JSON.stringify(nextStorage),
    );
  }, values);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".resume-pages .paper:not(.layout-measure)");
  await waitForSaved(page);
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const fixtureKey = "__preview_overflow_storage__";
    const fixture = sessionStorage.getItem(fixtureKey);
    if (!fixture) return;
    sessionStorage.removeItem(fixtureKey);
    const nextStorage = JSON.parse(fixture);
    localStorage.clear();
    for (const [key, value] of Object.entries(nextStorage))
      if (typeof value === "string") localStorage.setItem(key, value);
  });
  const pageErrors = [];
  const downloads = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const checks = [];

  try {
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    await waitForSaved(page);
    assert.equal(await page.locator(".editor-overflow-warning").count(), 0);
    checks.push("normal initial layout has no false overflow warning");

    const seedStorage = await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
      ),
    );
    const seedState = JSON.parse(seedStorage["resume-diy-state"]);
    const overflowState = clone(seedState);
    const sourceEntry = overflowState.education[0] || {
      id: "overflow-source",
      title: "超长教育经历",
      role: "",
      department: "",
      city: "",
      start: "",
      end: "",
      html: "<p><br></p>",
    };
    overflowState.education = [
      {
        ...sourceEntry,
        id: "overflow-4075",
        title: "超长教育经历",
        html: `<p>${"已知超长段落，用于验证导出前告警和定位。".repeat(1800)}</p>`,
      },
    ];
    const overflowStorage = {
      ...seedStorage,
      "resume-diy-state": JSON.stringify(overflowState),
      "resume-diy-preferences": JSON.stringify({
        ...JSON.parse(seedStorage["resume-diy-preferences"] || "{}"),
        smartFillV2: "false",
      }),
      "resume-diy-section-order-v2": JSON.stringify([
        "education",
        "skills",
        "work",
        "projects",
        "orgs",
        "summary",
      ]),
      "resume-diy-modules": JSON.stringify([
        "education",
        "skills",
        "work",
        "projects",
        "orgs",
        "summary",
      ]),
    };
    await loadStorageFixture(page, overflowStorage);
    await page.waitForSelector('.editor-overflow-warning[role="alert"]');
    const warningText = await page.locator(".editor-overflow-warning").textContent();
    assert.match(warningText || "", /第 \d+ 页/);
    assert.match(warningText || "", /超出 A4 可用区域/);
    assert.ok(await page.locator(".paper:not(.layout-measure)").count() > 1);
    checks.push("known 4075px-class single-entry overflow is reported without changing pagination rules");

    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByRole("menuitem", { name: "高清 PNG" }).click();
    await page.waitForFunction(
      () => document.querySelector(".notice-toast")?.textContent?.includes("导出已暂停"),
      null,
    );
    assert.equal(downloads.length, 0);
    checks.push("PNG export is blocked while the overflow warning is active");

    await loadStorageFixture(page, seedStorage);
    assert.equal(await page.locator(".editor-overflow-warning").count(), 0);
    await page
      .locator("[data-editor-entry-id]")
      .first()
      .locator(".entry-header")
      .click();
    assert.equal(await page.getByLabel("左对齐", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("居中对齐", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("右对齐", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("两端对齐", { exact: true }).count(), 0);
    assert.ok(await page.getByText("正文按当前简历排版规则显示", { exact: true }).count() > 0);
    checks.push("non-persistent per-entry alignment controls are removed and the global rule is explained");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByRole("menuitem", { name: "高清 PNG" }).click();
    const download = await downloadPromise;
    const outputPath = path.join(OUTPUT_ROOT, "normal-boundary.png");
    await download.saveAs(outputPath);
    assert.ok(fs.statSync(outputPath).size > 1000);
    checks.push("normal boundary remains exportable after the guard and editor-control change");

    assert.deepEqual(pageErrors, []);
    const result = { status: "PASS", checks, downloads, pageErrors };
    fs.writeFileSync(
      path.join(ARTIFACT_ROOT, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
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
