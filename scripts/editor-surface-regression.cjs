const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const outputRoot = path.join(projectRoot, ".artifacts", "editor-surface");
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
  await page.addInitScript(() => {
    // The public default is intentionally empty; this isolated UI test needs
    // one fictional entry to exercise the expanded/collapsed entry surface.
    localStorage.setItem("resume-diy-state", JSON.stringify({
      basic: { name: "测试用户", ageMode: "age" },
      education: [{
        id: "education-test",
        title: "测试大学",
        role: "示例专业",
        department: "",
        city: "",
        start: "",
        end: "",
        html: "<p>虚构的回归测试内容。</p>",
      }],
      skills: [], work: [], projects: [], orgs: [], research: [],
      awards: [], other: [], portfolio: [], custom: [], summary: "",
    }));
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

async function assertMatchedModuleIcons(page, viewportWidth) {
  const expected = {
    education: "iconcv-title-icon-edus",
    skills: "iconcv-title-icon-custom",
    work: "iconcv-title-icon-works",
    projects: "iconcv-title-icon-project_experience",
    orgs: "iconcv-title-icon-orgs",
    summary: "iconcv-title-icon-personal_summary",
  };
  for (const [module, iconClass] of Object.entries(expected)) {
    const editorIcon = page.locator(
      `[data-editor-module="${module}"] .module-mark .${iconClass}`,
    );
    assert.equal(
      await editorIcon.count(),
      1,
      `${viewportWidth}px ${module} editor icon does not match preview glyph`,
    );
  }
  return expected;
}

async function readSurfaceMetrics(page) {
  return page.evaluate(() => {
    const numberValues = [
      ...document.querySelectorAll(".editor-section-number"),
    ].map((element) => element.textContent?.trim());
    const section = document.querySelector(".section-card");
    const sectionStyle = section ? getComputedStyle(section) : null;
    const formTitle = document.querySelector(".editor-form-title");
    const formTitleStyle = formTitle ? getComputedStyle(formTitle) : null;
    return {
      rootDark: document
        .querySelector(".app-shell")
        ?.classList.contains("dark-mode"),
      navigationCount: Number(
        document.querySelector("[data-editor-section-nav]")?.dataset
          .editorNavCount || 0,
      ),
      cardCount: document.querySelectorAll("[data-editor-section-index]")
        .length,
      numberValues,
      sectionBorder: sectionStyle?.borderColor ?? null,
      sectionBackground: sectionStyle?.backgroundColor ?? null,
      formTitleBorder: formTitleStyle?.borderBottomColor ?? null,
      formTitleDisplay: formTitleStyle?.display ?? null,
      topbarHeight:
        document.querySelector(".topbar")?.getBoundingClientRect().height ??
        null,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    };
  });
}

async function readVersionMetrics(page) {
  return page.evaluate(() => {
    const versionWorkspace = document.querySelector("[data-version-workspace]");
    const section = document.querySelector('[data-version-section="branch"]');
    const sectionStyle = section ? getComputedStyle(section) : null;
    const heading = document.querySelector(".version-heading");
    const headingStyle = heading ? getComputedStyle(heading) : null;
    return {
      versionWorkspace: Boolean(versionWorkspace),
      sections: [...document.querySelectorAll("[data-version-section]")].map(
        (element) => element.dataset.versionSection,
      ),
      graphVisible: Boolean(document.querySelector(".branch-tree-scroll")),
      sectionBorder: sectionStyle?.borderBottomColor ?? null,
      headingBorder: headingStyle?.borderBottomColor ?? null,
      compareControls: document.querySelectorAll('[aria-label*="比较"]').length,
      timelineCount: document.querySelectorAll("[data-version-commit-id]")
        .length,
    };
  });
}

async function readSummarySurfaceMetrics(page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".summary-card .summary-editor");
    const body = document.querySelector(
      ".summary-card .summary-editor .rich-body",
    );
    const editorStyle = editor ? getComputedStyle(editor) : null;
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      editorBorder: editorStyle?.borderStyle ?? null,
      editorBackground: editorStyle?.backgroundColor ?? null,
      bodyOverflowWrap: bodyStyle?.overflowWrap ?? null,
      bodyWordBreak: bodyStyle?.wordBreak ?? null,
      bodyWhiteSpace: bodyStyle?.whiteSpace ?? null,
    };
  });
}

async function assertEditorSurface(page, viewportWidth) {
  const metrics = await readSurfaceMetrics(page);
  assert.equal(
    metrics.navigationCount,
    7,
    `${viewportWidth}px navigation count changed`,
  );
  assert.equal(
    metrics.cardCount,
    7,
    `${viewportWidth}px numbered card count changed`,
  );
  assert.deepEqual(
    metrics.numberValues,
    ["01", "02", "03", "04", "05", "06", "07"],
    `${viewportWidth}px chapter numbers changed`,
  );
  assert.notEqual(
    metrics.sectionBorder,
    "rgba(0, 0, 0, 0)",
    `${viewportWidth}px section boundary disappeared`,
  );
  assert.equal(
    metrics.topbarHeight,
    expectedTopbarHeight,
    `${viewportWidth}px topbar height changed`,
  );
  assert.ok(
    metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1,
    `${viewportWidth}px editor surface overflows`,
  );
  return metrics;
}

async function runEditorInteractions(page, viewportWidth) {
  const chooseChapter = async (key) => {
    await page.locator("[data-editor-nav-trigger]").click();
    await page
      .getByRole("listbox", { name: "选择章节", exact: true })
      .locator(`[data-editor-nav-key="${key}"]`)
      .click();
  };
  const collapsedSummary = page.locator(".summary-card .summary-preview");
  const collapsedSummaryContent = collapsedSummary.locator(
    ".summary-preview-content",
  );
  const collapsedSummaryMetrics = await collapsedSummary.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderStyle: style.borderStyle,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      maxHeight: style.maxHeight,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  const collapsedSummaryContentMetrics = await collapsedSummaryContent.evaluate(
    (element) => {
      const style = getComputedStyle(element);
      return {
        maxHeight: style.maxHeight,
        clientHeight: element.clientHeight,
      };
    },
  );
  assert.equal(
    collapsedSummaryMetrics.borderStyle,
    "solid",
    `${viewportWidth}px collapsed summary lost its shared border`,
  );
  assert.equal(
    collapsedSummaryMetrics.borderRadius,
    "5px",
    `${viewportWidth}px collapsed summary lost its shared radius`,
  );
  assert.equal(
    collapsedSummaryMetrics.backgroundColor,
    "rgb(255, 253, 249)",
    `${viewportWidth}px collapsed summary lost its shared surface`,
  );
  assert.equal(
    collapsedSummaryContentMetrics.maxHeight,
    "42px",
    `${viewportWidth}px collapsed summary is not limited to two lines`,
  );
  assert.ok(
    collapsedSummaryContentMetrics.clientHeight <= 42,
    `${viewportWidth}px collapsed summary exceeds two lines`,
  );
  await page.locator('[data-editor-module="summary"]').screenshot({
    path: path.join(outputRoot, `summary-collapsed-${viewportWidth}.png`),
  });

  await chooseChapter("summary");
  await page.locator(".summary-card .summary-editor .rich-body").waitFor();
  const summaryMetrics = await readSummarySurfaceMetrics(page);
  assert.equal(
    summaryMetrics.editorBorder,
    "none",
    `${viewportWidth}px summary editor kept a nested border`,
  );
  assert.equal(
    summaryMetrics.editorBackground,
    "rgba(0, 0, 0, 0)",
    `${viewportWidth}px summary editor kept a nested background`,
  );
  assert.equal(
    summaryMetrics.bodyOverflowWrap,
    "anywhere",
    `${viewportWidth}px summary text does not wrap long content`,
  );
  assert.equal(
    summaryMetrics.bodyWordBreak,
    "break-word",
    `${viewportWidth}px summary text word breaking changed`,
  );
  assert.equal(
    summaryMetrics.bodyWhiteSpace,
    "pre-wrap",
    `${viewportWidth}px summary editor whitespace mode changed`,
  );
  await page.locator('[data-editor-module="summary"]').screenshot({
    path: path.join(outputRoot, `summary-${viewportWidth}.png`),
  });
  await chooseChapter("basic");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-editor-focus") === "basic",
  );
  const nameInput = page.getByRole("textbox", { name: "姓名", exact: true });
  await nameInput.focus();
  await page.keyboard.insertText("中文连续输入");
  assert.match(
    await nameInput.inputValue(),
    /中文连续输入$/,
    `${viewportWidth}px continuous Chinese input was not retained`,
  );
  assert.equal(
    await nameInput.evaluate((element) => document.activeElement === element),
    true,
    `${viewportWidth}px input was remounted during continuous input`,
  );

  await page.locator(".entry-card .entry-header").first().click();
  assert.equal(
    await page
      .locator(".entry-form .editor-form-title")
      .first()
      .evaluate((element) => getComputedStyle(element).display),
    "flex",
    `${viewportWidth}px field groups lost layout`,
  );
  await page
    .getByRole("button", { name: "插入链接", exact: true })
    .first()
    .click();
  await page.getByRole("dialog", { name: "插入或编辑链接" }).waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "插入或编辑链接" })
    .waitFor({ state: "detached" });

  await page.getByRole("button", { name: /^导出/ }).click();
  assert.equal(
    await page.getByRole("menuitem", { name: /暗夜模式|浅色模式/ }).count(),
    0,
  );
  assert.equal(await page.locator(".dark-mode").count(), 0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "版本管理" }).click();
  await page.locator("[data-version-workspace]").waitFor();
  const versionMetrics = await readVersionMetrics(page);
  assert.deepEqual(
    versionMetrics.sections.sort(),
    ["backup", "branch", "commit", "history", "tree"].sort(),
    `${viewportWidth}px version sections changed`,
  );
  assert.equal(
    versionMetrics.graphVisible,
    true,
    `${viewportWidth}px unified history graph is missing`,
  );
  assert.equal(
    versionMetrics.compareControls,
    0,
    `${viewportWidth}px unexpected compare controls appeared`,
  );
  assert.notEqual(
    versionMetrics.sectionBorder,
    "rgba(0, 0, 0, 0)",
    `${viewportWidth}px version boundary disappeared`,
  );

  assert.equal(await page.getByRole("tab").count(), 0);
  return versionMetrics;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const server = await serve(distRoot);
  const results = {
    status: "PASS",
    viewports: [],
    checks: [],
    pageErrors: [],
    failedFontRequests: [],
  };

  try {
    for (const viewportWidth of viewports) {
      const { context, page, pageErrors, failedFontRequests } =
        await createPage(browser, viewportWidth);
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/`, {
          waitUntil: "domcontentloaded",
        });
        await settle(page);
        const matchedModuleIcons = await assertMatchedModuleIcons(
          page,
          viewportWidth,
        );
        const editorMetrics = await assertEditorSurface(page, viewportWidth);
        const versionMetrics = await runEditorInteractions(page, viewportWidth);
        results.viewports.push({
          viewportWidth,
          matchedModuleIcons,
          editorMetrics,
          versionMetrics,
        });
        results.checks.push(
          `${viewportWidth}px matched module icons, numbered editor surfaces, continuous input, link dialog, theme and version tabs`,
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
      "editor surface page errors detected",
    );
    assert.deepEqual(
      results.failedFontRequests,
      [],
      "editor surface font failures detected",
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
