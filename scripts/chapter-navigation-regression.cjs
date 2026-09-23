const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const outputRoot = path.join(projectRoot, ".artifacts", "chapters");
const viewports = [1440, 1050];
const expectedTopbarHeight = 65;

fs.mkdirSync(outputRoot, { recursive: true });

function serve(root) {
  const resolvedRoot = path.resolve(root);
  const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".otf": "font/otf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
  };
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }
    let requestPath = "/";
    try {
      requestPath = decodeURIComponent(
        new URL(request.url || "/", "http://127.0.0.1").pathname,
      );
    } catch {
      response.statusCode = 400;
      response.end("Bad request");
      return;
    }
    let filePath = path.resolve(resolvedRoot, `.${requestPath}`);
    if (
      !filePath.startsWith(`${resolvedRoot}${path.sep}`) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      filePath = path.join(resolvedRoot, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      mimeTypes[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
    );
    response.end(
      request.method === "HEAD" ? undefined : fs.readFileSync(filePath),
    );
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function createPage(browser, viewportWidth) {
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: 1000 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pageErrors = [];
  const failedFontRequests = [];
  page.on("pageerror", (error) =>
    pageErrors.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      pageErrors.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/fonts/")) {
      failedFontRequests.push(
        `${request.url()} :: ${request.failure()?.errorText || "unknown"}`,
      );
    }
  });
  await page.addInitScript(() => {
    let nextUuid = 0;
    crypto.randomUUID = () =>
      `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, "0")}`;
  });
  return { context, page, pageErrors, failedFontRequests };
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".resume-pages .paper:not(.layout-measure)");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".paper:not(.layout-measure)")].every(
        (paper) => paper.getBoundingClientRect().width > 0,
      ),
    undefined,
    { timeout: 20000 },
  );
  await page.waitForTimeout(180);
}

async function readStorage(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .sort()
        .map((key) => [key, localStorage.getItem(key)]),
    ),
  );
}

async function readPreview(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
      };
    };
    const pane = document.querySelector(".preview-pane");
    return {
      pages: [...document.querySelectorAll(".paper:not(.layout-measure)")].map(
        (paper) => ({
          html: paper.innerHTML,
          style: paper.getAttribute("style"),
          rect: rect(paper),
        }),
      ),
      paneScrollTop: pane?.scrollTop ?? null,
      paneScrollLeft: pane?.scrollLeft ?? null,
    };
  });
}

async function readShellMetrics(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const topbar = document.querySelector(".topbar");
    const editor = document.querySelector(".editor-pane");
    const nav = document.querySelector("[data-editor-section-nav]");
    const navTrigger = nav?.querySelector("[data-editor-nav-trigger]");
    const navStyle = nav ? getComputedStyle(nav) : null;
    const title = document.querySelector(".resume-title");
    return {
      viewportWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      topbar: box(".topbar"),
      brand: box('[data-header-group="identity"]'),
      editor: box(".editor-pane"),
      preview: box(".preview-pane"),
      topbarScrollWidth: topbar?.scrollWidth ?? 0,
      topbarClientWidth: topbar?.clientWidth ?? 0,
      toolbarGroups: [...document.querySelectorAll("[data-toolbar-group]")].map(
        (group) => ({
          name: group.dataset.toolbarGroup,
          children: group.children.length,
        }),
      ),
      title: title
        ? {
            rect: box(".resume-title"),
            scrollWidth: title.scrollWidth,
            clientWidth: title.clientWidth,
          }
        : null,
      nav: nav
        ? {
            rect: box("[data-editor-section-nav]"),
            itemCount: Number(nav.dataset.editorNavCount || 0),
            itemOverflow: navTrigger
              ? navTrigger.scrollWidth > navTrigger.clientWidth + 1
              : true,
            position: navStyle?.position ?? null,
          }
        : null,
      operations: {
        smart: Boolean(
          document.querySelector('.toolbar-button[aria-label="智能一页"]'),
        ),
        font: Boolean(
          document.querySelector(
            '[data-toolbar-group="layout"] .toolbar-button[aria-label="宋体"]',
          ),
        ),
        fontSize: Boolean(
          document.querySelector(
            '[data-toolbar-group="layout"] .toolbar-button[aria-label="13px"]',
          ),
        ),
        spacing: Boolean(
          document.querySelector(
            '[data-toolbar-group="layout"] .toolbar-button[aria-label="间距"]',
          ),
        ),
        format: Boolean(
          document.querySelector(
            '[data-toolbar-group="layout"] .toolbar-button[aria-label="格式"]',
          ),
        ),
        modules: Boolean(
          document.querySelector(
            '[data-toolbar-group="modules"] .toolbar-button[aria-label="模块管理"]',
          ),
        ),
        export: Boolean(document.querySelector(".export-trigger")),
        versions: Boolean(
          document.querySelector('.rail-item[aria-label="版本管理"]'),
        ),
      },
      pageMode: editor?.className ?? "",
    };
  });
}

async function assertShell(page, viewportWidth) {
  const metrics = await readShellMetrics(page);
  assert.equal(metrics.viewportWidth, viewportWidth);
  assert.ok(metrics.topbar, `${viewportWidth}px topbar missing`);
  assert.ok(
    Math.abs(metrics.topbar.height - expectedTopbarHeight) < 0.5,
    `${viewportWidth}px topbar must be ${expectedTopbarHeight}px`,
  );
  assert.equal(
    metrics.toolbarGroups.length,
    2,
    `${viewportWidth}px toolbar groups missing`,
  );
  assert.equal(metrics.toolbarGroups[0].name, "layout");
  assert.equal(metrics.toolbarGroups[1].name, "modules");
  assert.equal(
    metrics.nav.itemCount,
    7,
    `${viewportWidth}px chapter count changed`,
  );
  assert.equal(
    metrics.nav.itemOverflow,
    false,
    `${viewportWidth}px chapter labels overflow`,
  );
  assert.equal(
    metrics.nav.position,
    "static",
    `${viewportWidth}px chapter nav became sticky`,
  );
  assert.ok(
    metrics.nav.rect.height <= 64,
    `${viewportWidth}px chapter nav became too tall`,
  );
  assert.ok(
    metrics.brand.right <= metrics.topbar.right + 0.5,
    `${viewportWidth}px brand escapes topbar`,
  );
  assert.ok(
    metrics.editor.right <= metrics.preview.left + 0.5,
    `${viewportWidth}px editor overlaps preview`,
  );
  assert.ok(
    metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1,
    `${viewportWidth}px body overflows`,
  );
  assert.ok(
    metrics.topbarScrollWidth <= metrics.topbarClientWidth + 1,
    `${viewportWidth}px topbar overflows`,
  );
  for (const [name, available] of Object.entries(metrics.operations)) {
    assert.equal(
      available,
      true,
      `${viewportWidth}px old operation missing: ${name}`,
    );
  }
  return metrics;
}

async function assertNavigationDoesNotChangePreview(
  page,
  viewportWidth,
  key,
  baselinePreview,
  baselineStorage,
) {
  const trigger = page.locator("[data-editor-nav-trigger]");
  await trigger.click();
  const menu = page.getByRole("listbox", { name: "选择章节", exact: true });
  await menu.waitFor();
  const menuStyle = await menu.evaluate((element) => {
    const style = getComputedStyle(
      element.closest(".floating-host") ?? element,
    );
    return {
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
    };
  });
  assert.notEqual(
    menuStyle.borderRadius,
    "0px",
    `${viewportWidth}px chapter menu lost rounded surface`,
  );
  assert.notEqual(
    menuStyle.boxShadow,
    "none",
    `${viewportWidth}px chapter menu lost elevation`,
  );
  assert.notEqual(
    menuStyle.backgroundColor,
    "rgba(0, 0, 0, 0)",
    `${viewportWidth}px chapter menu is transparent`,
  );
  if (viewportWidth === 1440 && key === "projects") {
    await page.screenshot({
      path: path.join(outputRoot, "chapter-menu-1440.png"),
    });
  }
  await menu.locator(`[data-editor-nav-key="${key}"]`).click();
  await page.waitForFunction(
    (targetKey) =>
      document.querySelector("[data-editor-nav-trigger]")?.dataset
        .editorNavValue === targetKey,
    key,
  );
  await page.waitForTimeout(220);
  const afterPreview = await readPreview(page);
  const afterStorage = await readStorage(page);
  assert.deepEqual(
    afterPreview,
    baselinePreview,
    `${viewportWidth}px ${key} moved or changed preview`,
  );
  assert.deepEqual(
    afterStorage,
    baselineStorage,
    `${viewportWidth}px ${key} changed browser snapshot storage`,
  );
  assert.match(
    await page.locator(".editor-pane").getAttribute("class"),
    /editor-workspace-pane/,
    `${viewportWidth}px ${key} switched out of editor mode`,
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const server = await serve(distRoot);
  const results = {
    status: "PASS",
    checks: [],
    viewports: [],
    pageErrors: [],
    failedFontRequests: [],
  };

  try {
    for (const viewportWidth of viewports) {
      const { context, page, pageErrors, failedFontRequests } =
        await createPage(browser, viewportWidth);
      try {
        await page.goto(`${serverUrl(server)}/`, {
          waitUntil: "domcontentloaded",
        });
        await settle(page);
        const metrics = await assertShell(page, viewportWidth);
        results.viewports.push({ viewportWidth, metrics });
        results.checks.push(
          `${viewportWidth}px header groups, old entrances, ${expectedTopbarHeight}px topbar and no overflow`,
        );

        const baselinePreview = await readPreview(page);
        const baselineStorage = await readStorage(page);
        for (const key of ["projects", "summary", "basic"]) {
          await assertNavigationDoesNotChangePreview(
            page,
            viewportWidth,
            key,
            baselinePreview,
            baselineStorage,
          );
        }
        results.checks.push(
          `${viewportWidth}px chapter navigation reuses B02 and does not write snapshot/version state`,
        );

        const longTitle =
          "一个用于验证窄窗口操作边界的非常长的简历文件名称示例";
        await page.evaluate(
          (value) => localStorage.setItem("resume-diy-title", value),
          longTitle,
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await settle(page);
        const longTitleMetrics = await assertShell(page, viewportWidth);
        assert.ok(
          longTitleMetrics.title,
          `${viewportWidth}px title button missing after long filename`,
        );
        assert.ok(
          longTitleMetrics.title.rect.right <=
            longTitleMetrics.brand.right + 0.5,
          `${viewportWidth}px long filename escapes brand group`,
        );
        results.checks.push(
          `${viewportWidth}px long filename remains operable`,
        );
      } finally {
        results.pageErrors.push(...pageErrors);
        results.failedFontRequests.push(...failedFontRequests);
        await context.close();
      }
    }

    assert.deepEqual(
      results.pageErrors,
      [],
      "chapter navigation page errors detected",
    );
    assert.deepEqual(
      results.failedFontRequests,
      [],
      "chapter navigation font failures detected",
    );
    fs.writeFileSync(
      path.join(outputRoot, "results.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    results.status = "FAIL";
    results.error = String(error?.stack ?? error);
    fs.writeFileSync(
      path.join(outputRoot, "results.json"),
      JSON.stringify(results, null, 2),
    );
    throw error;
  } finally {
    await browser.close();
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
