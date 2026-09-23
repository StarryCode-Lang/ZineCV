const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { PNG } = require("pngjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BASELINE_ID =
  process.env.PREVIEW_BASELINE_ID ||
  (process.env.PREVIEW_BASELINE_DIST
    ? "explicit-comparison-snapshot"
    : "20260912-b00-214640");
const BASELINE_DIST = path.resolve(
  process.env.PREVIEW_BASELINE_DIST ||
    path.join(".audit", "preview-baseline", BASELINE_ID, "dist"),
);
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, ".artifacts", "preview-contract");
const SCREENSHOT_ROOT = path.join(ARTIFACT_ROOT, "screenshots");
const VIEWPORT_HEIGHT = 1000;
const CAPTURE_STYLE =
  "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }";
const STYLE_PROPERTIES = [
  "display",
  "position",
  "boxSizing",
  "width",
  "height",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "backgroundImage",
  "padding",
  "margin",
  "gap",
  "textAlign",
  "verticalAlign",
  "border",
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
  "borderRadius",
  "boxShadow",
  "transform",
  "opacity",
  "visibility",
  "overflow",
  "whiteSpace",
];

fs.mkdirSync(SCREENSHOT_ROOT, { recursive: true });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function serve(root) {
  const resolvedRoot = path.resolve(root);
  const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".otf": "font/otf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
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
    )
      filePath = path.join(resolvedRoot, "index.html");
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
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function createContext(browser, label) {
  const errors = [];
  const failedFontRequests = [];
  return browser
    .newContext({
      viewport: { width: 1440, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
      permissions: ["clipboard-read", "clipboard-write"],
    })
    .then(async (context) => {
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        errors.push(`pageerror: ${error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error")
          errors.push(`console: ${message.text()}`);
      });
      page.on("requestfailed", (request) => {
        if (request.url().includes("/fonts/"))
          failedFontRequests.push(
            `${request.url()} :: ${request.failure()?.errorText || "unknown"}`,
          );
      });
      await page.clock.setFixedTime(new Date("2026-09-10T10:00:00Z"));
      await page.addInitScript(() => {
        let nextUuid = 0;
        crypto.randomUUID = () =>
          `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, "0")}`;
      });
      await page.addInitScript(() => {
        const fixtureKey = "__preview_contract_storage__";
        const fixture = sessionStorage.getItem(fixtureKey);
        if (!fixture) return;
        sessionStorage.removeItem(fixtureKey);
        try {
          const nextStorage = JSON.parse(fixture);
          localStorage.clear();
          for (const [key, value] of Object.entries(nextStorage))
            if (typeof value === "string") localStorage.setItem(key, value);
        } catch {
          // The test harness reports the resulting page state if a fixture is invalid.
        }
      });
      return { context, page, label, errors, failedFontRequests };
    });
}

async function settlePage(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".resume-pages .paper:not(.layout-measure)");
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll(
          ".resume-pages .paper:not(.layout-measure)",
        ),
      ].every((paper) => paper.getBoundingClientRect().width > 0),
    undefined,
    { timeout: 20000 },
  );
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map((image) =>
        image.complete
          ? undefined
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            }),
      ),
    );
  });
  let previous = "";
  let stableCount = 0;
  for (let attempt = 0; attempt < 40 && stableCount < 4; attempt += 1) {
    await page.waitForTimeout(50);
    const current = await page.evaluate(() =>
      JSON.stringify(
        [...document.querySelectorAll(".paper:not(.layout-measure)")].map(
          (paper) => {
            const rect = paper.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height, paper.innerHTML];
          },
        ),
      ),
    );
    stableCount = current === previous ? stableCount + 1 : 0;
    previous = current;
  }
  assert.ok(stableCount >= 4, "Preview layout did not settle before capture");
  await page.evaluate(() => {
    document
      .querySelector(".preview-pane")
      ?.scrollTo({ top: 0, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  if (
    await page.evaluate(
      () =>
        document.fonts.status !== "loaded" ||
        [...document.fonts].some((font) => font.status === "error"),
    )
  )
    throw new Error("Font loading did not reach a loaded, error-free state");
  await page.addStyleTag({
    content: CAPTURE_STYLE,
    attributes: { "data-preview-contract": "true" },
  });
}

async function initialStorage(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu"],
  });
  const target = await createContext(browser, "seed");
  try {
    await target.page.goto(url, { waitUntil: "domcontentloaded" });
    await settlePage(target.page);
    await target.page.waitForTimeout(250);
    const storage = await target.page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    );
    const state = parseJson(storage["resume-diy-state"], null);
    if (!state)
      throw new Error("The isolated seed page did not produce resume state");
    return {
      storage,
      state,
      preferences: parseJson(storage["resume-diy-preferences"], {}),
    };
  } finally {
    await target.context.close();
    await browser.close();
  }
}

function newEntry(template, module, index, html) {
  const entry = {
    id: `preview-contract-${module}-${index}`,
    title: `${module} 契约测试经历 ${index}`,
    role: "验证角色",
    department: "验证部门",
    city: "长春",
    start: "2024-01",
    end: "2025-01",
    html:
      html ||
      `<p><strong>契约测试：</strong>用于验证模块顺序、分页和右侧预览内容的稳定性。</p>`,
  };
  return { ...(template || {}), ...entry };
}

function buildScenarios(seed, seedStorage, seedPreferences) {
  const moduleKeys = [
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
  const defaultOrder = parseJson(
    seedStorage["resume-diy-section-order-v2"] ||
      seedStorage["resume-diy-modules"],
    ["education", "skills", "work", "projects", "orgs", "summary"],
  );
  const complete = clone(seed);
  for (const module of moduleKeys) {
    if (!complete[module]?.length)
      complete[module] = [newEntry(seed.education?.[0], module, 1)];
  }
  const completeOrder = [...moduleKeys, "summary"];
  const empty = clone(seed);
  empty.basic = Object.fromEntries(
    Object.entries(empty.basic).map(([key, value]) => [
      key,
      key === "ageMode" ? "age" : typeof value === "string" ? "" : value,
    ]),
  );
  for (const module of moduleKeys) empty[module] = [];
  empty.summary = "";
  const longTitle = clone(seed);
  longTitle.basic.name = "用于右侧预览契约验证的超长姓名与标题组合";
  longTitle.basic.website = `https://example.com/${"long-url-segment-".repeat(9)}`;
  longTitle.basic.linkedin = `https://github.com/${"preview-contract-".repeat(7)}`;
  longTitle.education[0].title =
    "一个用于验证长标题不会改变基线规则的教育经历名称";
  longTitle.projects[0].title =
    "一个用于验证长标题与超长网址在右侧预览中保持原规则的项目";
  const multipage = clone(seed);
  multipage.projects = Array.from({ length: 12 }, (_, index) =>
    newEntry(
      seed.projects?.[index % Math.max(1, seed.projects.length)] ||
        seed.education?.[0],
      "projects",
      index + 1,
      `<p><strong>多页测试项目 ${index + 1}：</strong>这段内容用于确认分页边界、模块片段和条目顺序在基线与当前版本之间一致。包含足够的重复正文以稳定地产生多页结果。</p><p>${"多页正文内容。".repeat(75)}</p>`,
    ),
  );
  const overflow = clone(seed);
  overflow.education = [
    newEntry(
      seed.education?.[0],
      "education",
      1,
      `<p>${"已知超长单段内容，用于预览契约检测，不应在测试中被静默删改。".repeat(1800)}</p>`,
    ),
  ];
  const longSummary = clone(seed);
  longSummary.summary = `<p>${"长自我评价内容，用于验证分页和正文 DOM 的稳定性。".repeat(1200)}</p>`;
  const reordered = clone(complete);
  const reorderedOrder = [
    "orgs",
    "projects",
    "work",
    "skills",
    "education",
    "summary",
  ];
  const hidden = clone(complete);
  const avatar = clone(seed);
  avatar.basic.avatar =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const baseOptions = {
    preferences: { ...seedPreferences, smartFillV2: "false" },
    moduleOrder: defaultOrder,
    paneWidth: undefined,
  };
  const withOptions = (id, state, options = {}) => ({
    id,
    state,
    widths: options.widths || [1440],
    preferences: { ...baseOptions.preferences, ...(options.preferences || {}) },
    moduleOrder: options.moduleOrder || baseOptions.moduleOrder,
    paneWidth: options.paneWidth,
    action: options.action,
    expect: options.expect,
  });
  const smartCompleteAction = async (page) => {
    await page.getByRole("button", { name: "智能一页", exact: true }).click();
    await page.waitForFunction(
      () =>
        /智能一页已完成|当前排版已经过智能一页验证/.test(
          document.querySelector(".notice-toast")?.textContent ?? "",
        ),
      undefined,
      { timeout: 20000 },
    );
    await page.waitForTimeout(100);
  };
  const smartFailureAction = async (page) => {
    await page.getByRole("button", { name: "智能一页", exact: true }).click();
    await page.waitForFunction(
      (message) =>
        document.querySelector(".notice-toast")?.textContent?.includes(message),
      "内容过多",
      { timeout: 30000 },
    );
    await page.waitForTimeout(100);
  };
  return [
    withOptions("initial", seed, { widths: [1050, 1280, 1440, 1920] }),
    withOptions("empty", empty, { widths: [1280] }),
    withOptions("complete-modules", complete, {
      widths: [1440],
      moduleOrder: completeOrder,
    }),
    withOptions("long-title-url", longTitle, { widths: [1050, 1920] }),
    withOptions("multipage", multipage, {
      widths: [1050, 1440],
      expect: (snapshot) =>
        assert.ok(
          snapshot.paperCount > 1,
          "multipage fixture did not paginate",
        ),
    }),
    withOptions("known-overflow", overflow, { widths: [1440] }),
    withOptions("avatar", avatar, { widths: [1440] }),
    withOptions("reordered-modules", reordered, {
      widths: [1280],
      moduleOrder: reorderedOrder,
    }),
    withOptions("hidden-modules", hidden, {
      widths: [1440],
      moduleOrder: ["education", "work", "summary"],
    }),
    withOptions("long-summary", longSummary, { widths: [1440] }),
    ...["宋体", "雅黑", "黑体", "楷体", "仿宋"].map((font) =>
      withOptions(`font-${font}`, seed, {
        widths: [1280],
        preferences: { font },
      }),
    ),
    withOptions("layout-combination", seed, {
      widths: [1280],
      preferences: {
        font: "黑体",
        fontSize: "15",
        lineHeight: "20",
        moduleSpacing: "10",
        pageMargin: "35",
        dateFormat: "2021.01",
        titleFormat: "双行标题",
        separator: "不使用分隔符号",
        textAlign: "系统默认",
        theme: "#ca3832",
      },
    }),
    withOptions("theme-light", seed, {
      widths: [1440],
      preferences: { darkMode: "false", theme: "#246A58" },
    }),
    withOptions("theme-dark", seed, {
      widths: [1440],
      preferences: { darkMode: "true", theme: "#246A58" },
    }),
    withOptions("smart-off", seed, {
      widths: [1280],
      preferences: { smartFillV2: "false" },
    }),
    withOptions("smart-completion", seed, {
      widths: [1440],
      action: smartCompleteAction,
      expect: (snapshot) =>
        assert.equal(
          snapshot.paperCount,
          1,
          "successful smart fit must produce one page",
        ),
    }),
    withOptions("smart-failure-recovery", multipage, {
      widths: [1440],
      action: smartFailureAction,
      expect: (snapshot) =>
        assert.ok(
          snapshot.paperCount > 1,
          "failed smart-fit fixture lost its pages",
        ),
    }),
    withOptions("pane-default", seed, { widths: [1440], paneWidth: "550" }),
    withOptions("pane-min", seed, { widths: [1050], paneWidth: "360" }),
    withOptions("pane-max-clamped", seed, {
      widths: [1440],
      paneWidth: "9999",
    }),
  ];
}

function storageForScenario(seedStorage, scenario) {
  const storage = { ...seedStorage };
  storage["resume-diy-state"] = JSON.stringify(scenario.state);
  storage["resume-diy-preferences"] = JSON.stringify(scenario.preferences);
  storage["resume-diy-section-order-v2"] = JSON.stringify(scenario.moduleOrder);
  storage["resume-diy-modules"] = JSON.stringify(scenario.moduleOrder);
  if (scenario.paneWidth !== undefined)
    storage["resume-diy-editor-pane-width"] = String(scenario.paneWidth);
  return storage;
}

async function loadScenario(page, url, seedStorage, scenario) {
  const storage = storageForScenario(seedStorage, scenario);
  await page.evaluate((nextStorage) => {
    sessionStorage.setItem(
      "__preview_contract_storage__",
      JSON.stringify(nextStorage),
    );
  }, storage);
  await page.reload({ waitUntil: "domcontentloaded" });
  await settlePage(page);
  await page.mouse.move(1, 1);
  return url;
}

async function previewSnapshot(page) {
  return page.evaluate((styleProperties) => {
    const rectOfElement = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    };
    const styleOf = (element) => {
      const computed = getComputedStyle(element);
      return Object.fromEntries(
        styleProperties.map((property) => [property, computed[property]]),
      );
    };
    const papers = [
      ...document.querySelectorAll(".paper:not(.layout-measure)"),
    ];
    const selectors = [
      ".paper-content",
      ".preview-block",
      ".preview-section",
      ".preview-title",
      ".preview-title-icon",
      ".preview-entry",
      ".preview-entry-head",
      ".preview-entry-left",
      ".preview-meta",
      ".preview-meta-inline",
      ".preview-rich",
      ".preview-rich > *",
      ".preview-header",
      ".preview-header-main",
      ".preview-header-side",
      ".preview-avatar-slot",
      ".preview-avatar",
      ".preview-sites a",
      ".preview-contact-icon",
    ];
    const paperSnapshots = papers.map((paper, pageIndex) => {
      const content = paper.querySelector(".paper-content");
      const normalizedPaper = paper.cloneNode(true);
      normalizedPaper
        .querySelectorAll(".page-number")
        .forEach((element) => element.remove());
      const blocks = [
        ...paper.querySelectorAll(".paper-content > .preview-block"),
      ].map((block) => ({
        layoutBlock: block.getAttribute("data-layout-block"),
        entryIds: [...block.querySelectorAll("[data-preview-entry-id]")].map(
          (entry) => entry.getAttribute("data-preview-entry-id"),
        ),
      }));
      const elements = [
        { selector: ".paper", index: 0, element: paper },
        ...selectors.flatMap((selector) =>
          [...paper.querySelectorAll(selector)].map((element, index) => ({
            selector,
            index,
            element,
          })),
        ),
      ].map(({ selector, index, element }) => ({
        selector,
        index,
        tag: element.tagName,
        className: element.getAttribute("class"),
        rect: rectOfElement(element),
        style: styleOf(element),
      }));
      return {
        pageIndex,
        html: normalizedPaper.innerHTML,
        text: normalizedPaper.textContent,
        rect: rectOfElement(paper),
        style: styleOf(paper),
        blocks,
        icons: [
          ...paper.querySelectorAll(".iconfont, .preview-title-icon svg"),
        ].map((icon) => ({
          tag: icon.tagName,
          className: icon.getAttribute("class"),
          html: icon.outerHTML,
        })),
        elements,
        contentRect: content ? rectOfElement(content) : null,
      };
    });
    const previewPane = document.querySelector(".preview-pane");
    const pages = document.querySelector(".resume-pages");
    return {
      paperCount: papers.length,
      fonts: {
        status: document.fonts.status,
        faces: [...document.fonts].map((font) => ({
          family: font.family,
          style: font.style,
          weight: font.weight,
          status: font.status,
        })),
      },
      rightGeometry: {
        pane: previewPane ? rectOfElement(previewPane) : null,
        pages: pages ? rectOfElement(pages) : null,
        paneScrollTop: previewPane?.scrollTop ?? null,
        paneScrollLeft: previewPane?.scrollLeft ?? null,
      },
      papers: paperSnapshots,
    };
  }, STYLE_PROPERTIES);
}

async function capturePaperPng(page, target, scenarioId, width) {
  const paths = [];
  const papers = page.locator(".paper:not(.layout-measure)");
  // Element screenshots can include fixed shell layers when a later paper is
  // scrolled into view. Scope this contract to A4 pixels by hiding those
  // outside-document layers while retaining the paper shadow in the capture.
  const chromeStyle = await page.addStyleTag({
    content:
      ".topbar, .notice-toast, .dialog-backdrop, .floating-menu { visibility: hidden !important; }",
  });
  const originalViewport = page.viewportSize();
  if (originalViewport) {
    await page.setViewportSize({
      width: originalViewport.width,
      height: Math.max(originalViewport.height, 1300),
    });
  }
  const retiredPageNumberStyle = await page.addStyleTag({
    content: ".page-number { visibility: hidden !important; }",
  });
  // Resizing can schedule pagination and replace paper nodes. Capture only
  // after that layout has settled, rather than using the pre-resize count.
  await settlePage(page);
  const count = await papers.count();
  for (let pageIndex = 0; pageIndex < count; pageIndex += 1) {
    const filePath = path.join(
      SCREENSHOT_ROOT,
      `${target}-${scenarioId}-${width}-page-${pageIndex + 1}.png`,
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        await papers
          .nth(pageIndex)
          .screenshot({ path: filePath, animations: "disabled" });
        break;
      } catch (error) {
        if (attempt >= 2 || !String(error).includes("Element is not attached"))
          throw error;
        await settlePage(page);
        assert.equal(
          await papers.count(),
          count,
          "Page count changed during capture",
        );
      }
    }
    paths.push(filePath);
  }
  await retiredPageNumberStyle.evaluate((element) => element.remove());
  await chromeStyle.evaluate((element) => element.remove());
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.evaluate(() => {
    document
      .querySelector(".preview-pane")
      ?.scrollTo({ top: 0, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  return paths;
}

async function runTarget(
  browser,
  target,
  url,
  seedStorage,
  scenarios,
  artifactLabel,
) {
  const targetContext = await createContext(browser, target);
  const records = [];
  try {
    await targetContext.page.goto(url, { waitUntil: "domcontentloaded" });
    await settlePage(targetContext.page);
    for (const scenario of scenarios) {
      for (const width of scenario.widths) {
        await targetContext.page.setViewportSize({
          width,
          height: VIEWPORT_HEIGHT,
        });
        await loadScenario(targetContext.page, url, seedStorage, scenario);
        if (scenario.action) {
          await scenario.action(targetContext.page);
          await settlePage(targetContext.page);
        }
        const snapshot = await previewSnapshot(targetContext.page);
        if (scenario.expect) scenario.expect(snapshot);
        const screenshotPaths = await capturePaperPng(
          targetContext.page,
          `${artifactLabel}-${target}`,
          scenario.id,
          width,
        );
        records.push({
          key: `${scenario.id}::${width}`,
          scenario: scenario.id,
          width,
          target,
          snapshot,
          screenshotPaths,
        });
        process.stdout.write(`  ${target} ${scenario.id} @ ${width}px\n`);
      }
    }
    if (targetContext.errors.length || targetContext.failedFontRequests.length)
      throw new Error(
        `${target} browser errors: ${JSON.stringify({
          pageErrors: targetContext.errors,
          failedFontRequests: targetContext.failedFontRequests,
        })}`,
      );
    return {
      records,
      errors: targetContext.errors,
      failedFontRequests: targetContext.failedFontRequests,
    };
  } finally {
    await targetContext.context.close();
  }
}

function comparePng(beforePath, afterPath) {
  const before = PNG.sync.read(fs.readFileSync(beforePath));
  const after = PNG.sync.read(fs.readFileSync(afterPath));
  assert.equal(before.width, after.width, `${beforePath} width changed`);
  assert.equal(before.height, after.height, `${beforePath} height changed`);
  let changedPixels = 0;
  let significantPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel += 1)
      delta = Math.max(
        delta,
        Math.abs(before.data[index + channel] - after.data[index + channel]),
      );
    if (!delta) continue;
    changedPixels += 1;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
    if (delta > 32) significantPixels += 1;
  }
  const pixelCount = before.width * before.height;
  assert.equal(
    significantPixels,
    0,
    `${afterPath} has significant A4 raster changes`,
  );
  assert.ok(
    changedPixels <= Math.max(1, Math.floor(pixelCount * 0.001)),
    `${afterPath} has excessive A4 raster changes: ${changedPixels}/${pixelCount}`,
  );
  return {
    beforePath,
    afterPath,
    width: before.width,
    height: before.height,
    changedPixels,
    significantPixels,
    maxChannelDelta,
  };
}

function compareRecords(beforeRun, afterRun) {
  const beforeByKey = new Map(
    beforeRun.records.map((record) => [record.key, record]),
  );
  const afterByKey = new Map(
    afterRun.records.map((record) => [record.key, record]),
  );
  assert.deepEqual(
    [...beforeByKey.keys()].sort(),
    [...afterByKey.keys()].sort(),
    "Preview scenario matrix changed",
  );
  return [...beforeByKey.keys()].sort().map((key) => {
    const before = beforeByKey.get(key);
    const after = afterByKey.get(key);
    assert.deepEqual(
      after.snapshot,
      before.snapshot,
      `${key} right preview DOM/layout changed`,
    );
    assert.equal(after.screenshotPaths.length, before.screenshotPaths.length);
    const pngComparisons = after.screenshotPaths.map((afterPath, index) =>
      comparePng(before.screenshotPaths[index], afterPath),
    );
    return {
      key,
      pageCount: before.snapshot.paperCount,
      pngComparisons,
    };
  });
}

async function selfTest(browser, baselineUrl, seedStorage) {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "resume-preview-contract-"),
  );
  let mutatedServer;
  try {
    fs.cpSync(BASELINE_DIST, tempRoot, { recursive: true });
    const cssFile = fs
      .readdirSync(path.join(tempRoot, "assets"))
      .filter((file) => file.endsWith(".css"))
      .map((file) => path.join(tempRoot, "assets", file))[0];
    assert.ok(cssFile, "Could not find a built CSS asset for the self-test");
    fs.appendFileSync(
      cssFile,
      "\n.paper { background-color: rgb(255, 0, 0) !important; }\n",
    );
    mutatedServer = await serve(tempRoot);
    const before = await runTarget(
      browser,
      "self-before",
      baselineUrl,
      seedStorage,
      [
        {
          id: "self-test-initial",
          state: parseJson(seedStorage["resume-diy-state"], null),
          widths: [1440],
          preferences: parseJson(seedStorage["resume-diy-preferences"], {}),
          moduleOrder: parseJson(
            seedStorage["resume-diy-section-order-v2"],
            [],
          ),
        },
      ],
      "self-test",
    );
    const after = await runTarget(
      browser,
      "self-mutated",
      serverUrl(mutatedServer),
      seedStorage,
      [
        {
          id: "self-test-initial",
          state: parseJson(seedStorage["resume-diy-state"], null),
          widths: [1440],
          preferences: parseJson(seedStorage["resume-diy-preferences"], {}),
          moduleOrder: parseJson(
            seedStorage["resume-diy-section-order-v2"],
            [],
          ),
        },
      ],
      "self-test",
    );
    let mutationDetected = false;
    try {
      compareRecords(before, after);
    } catch (error) {
      mutationDetected = true;
      process.stdout.write(
        `  self-test detected intentional preview mutation: ${error.message}\n`,
      );
    }
    assert.equal(
      mutationDetected,
      true,
      "Preview contract self-test failed to detect a visual mutation",
    );
    return { status: "PASS", mutationDetected: true };
  } finally {
    if (mutatedServer) await closeServer(mutatedServer);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  assert.ok(
    fs.existsSync(BASELINE_DIST),
    `Missing baseline dist: ${BASELINE_DIST}`,
  );
  assert.ok(
    fs.existsSync(path.join(PROJECT_ROOT, "dist")),
    "Missing current dist; run npm run build first",
  );
  const baselineServer = await serve(BASELINE_DIST);
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu"],
  });
  let currentServer;
  try {
    const baselineUrl = serverUrl(baselineServer);
    const seed = await initialStorage(baselineUrl);
    const selfTestResult = await selfTest(browser, baselineUrl, seed.storage);
    const scenarios = buildScenarios(
      seed.state,
      seed.storage,
      seed.preferences,
    );
    currentServer = await serve(path.join(PROJECT_ROOT, "dist"));
    process.stdout.write(
      `B01 baseline/current matrix: ${scenarios.length} scenario definitions\n`,
    );
    const beforeRun = await runTarget(
      browser,
      "before",
      baselineUrl,
      seed.storage,
      scenarios,
      "matrix",
    );
    const afterRun = await runTarget(
      browser,
      "after",
      serverUrl(currentServer),
      seed.storage,
      scenarios,
      "matrix",
    );
    const comparisons = compareRecords(beforeRun, afterRun);
    const report = {
      status: "PASS",
      baselineId: BASELINE_ID,
      validation: {
        baselineAgainstItself: "passed by intentional mutation self-test",
        baselineAgainstCurrent: "passed",
        comparisonScope:
          "right preview only; left editor UI is intentionally excluded",
        fontAndImagePolicy:
          "fonts must load; significant A4 raster changes fail; sparse <=0.1% raster noise is reported and bounded",
      },
      matrix: {
        scenarioDefinitions: scenarios.length,
        cases: beforeRun.records.length,
        viewports: [1050, 1280, 1440, 1920],
        covered: scenarios.map((scenario) => scenario.id),
      },
      selfTest: selfTestResult,
      comparisons,
      browserErrors: {
        before: beforeRun.errors,
        after: afterRun.errors,
        failedFontRequestsBefore: beforeRun.failedFontRequests,
        failedFontRequestsAfter: afterRun.failedFontRequests,
      },
      artifacts: {
        screenshotRoot: path
          .relative(PROJECT_ROOT, SCREENSHOT_ROOT)
          .replaceAll("\\", "/"),
        report: path
          .relative(PROJECT_ROOT, path.join(ARTIFACT_ROOT, "results.json"))
          .replaceAll("\\", "/"),
      },
    };
    fs.writeFileSync(
      path.join(ARTIFACT_ROOT, "results.json"),
      JSON.stringify(report, null, 2),
    );
    fs.rmSync(path.join(ARTIFACT_ROOT, "failure.json"), { force: true });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    fs.writeFileSync(
      path.join(ARTIFACT_ROOT, "failure.json"),
      JSON.stringify(
        { status: "FAIL", error: String(error), stack: error.stack },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (currentServer) await closeServer(currentServer);
    await closeServer(baselineServer);
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
