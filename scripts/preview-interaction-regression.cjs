const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright");
const { PNG } = require("pngjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ARTIFACT_ROOT = path.join(
  PROJECT_ROOT,
  ".artifacts",
  "preview-interaction",
);
const CURRENT_DIST = path.join(PROJECT_ROOT, "dist");
const VIEWPORT = { width: 1440, height: 1000 };
const DEFAULT_ORDER = [
  "education",
  "skills",
  "work",
  "projects",
  "orgs",
  "summary",
];
const OUTPUT_ROOT = path.join(ARTIFACT_ROOT, "downloads");
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

async function createPage(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  const failedFontRequests = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
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
    if (localStorage.getItem("resume-diy-state")) return;
    const entry = (id, title) => ({
      id,
      title,
      role: "示例角色",
      department: "",
      city: "",
      start: "2024-01",
      end: "2024-12",
      html: "<p>虚构的回归测试内容。</p>",
    });
    localStorage.setItem("resume-diy-state", JSON.stringify({
      basic: {
        name: "测试用户",
        ageMode: "age",
        website: "https://example.com",
        linkedin: "https://github.com/example",
      },
      education: [entry("education-1", "测试大学")],
      skills: [entry("skills-1", "示例技能")],
      work: [entry("work-1", "示例单位")],
      projects: [entry("project-1", "测试项目")],
      orgs: [entry("org-1", "示例社团")],
      research: [], awards: [], other: [], portfolio: [], custom: [],
      summary: "<p>虚构的个人简介。</p>",
    }));
  });
  await page.addInitScript(() => {
    const fixtureKey = "__preview_interaction_storage__";
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
  return { context, page, errors, failedFontRequests };
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
  await page.waitForTimeout(120);
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

async function previewInvariant(page) {
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
    const papers = [
      ...document.querySelectorAll(".paper:not(.layout-measure)"),
    ];
    return {
      papers: papers.map((paper) => ({
        html: paper.innerHTML,
        rect: rect(paper),
        style: paper.getAttribute("style"),
      })),
      paneScrollTop: document.querySelector(".preview-pane")?.scrollTop ?? null,
      paneScrollLeft:
        document.querySelector(".preview-pane")?.scrollLeft ?? null,
      pageCount: papers.length,
    };
  });
}

async function leftState(page) {
  return page.evaluate(() => ({
    view: document.querySelector(".editor-pane")?.className || "",
    editorScrollTop:
      document.querySelector(".editor-workspace-pane .editor-scroll")
        ?.scrollTop ?? null,
    expandedEntries: [
      ...document.querySelectorAll(
        ".editor-workspace-pane [data-editor-entry-id].expanded",
      ),
    ].map((element) => element.dataset.editorEntryId),
    summaryExpanded: Boolean(
      document.querySelector(".summary-card .summary-editor"),
    ),
    basicExpanded: Boolean(
      document.querySelector("[data-editor-target=basic].expanded"),
    ),
    focused: document.activeElement
      ? {
          editorEntryId:
            document.activeElement.closest("[data-editor-entry-id]")?.dataset
              .editorEntryId || null,
          editorFocus: document.activeElement.getAttribute("data-editor-focus"),
        }
      : null,
  }));
}

function assertExclusiveState(state, expected, label) {
  assert.deepEqual(
    [...state.expandedEntries].sort(),
    [...expected.expandedEntries].sort(),
    `${label}: unrelated entries remained expanded`,
  );
  assert.equal(
    state.summaryExpanded,
    expected.summaryExpanded,
    `${label}: summary expansion state is not exclusive`,
  );
  assert.equal(
    state.basicExpanded,
    expected.basicExpanded,
    `${label}: basic expansion state is not exclusive`,
  );
}

async function loadState(
  page,
  url,
  storage,
  state,
  preferences,
  moduleOrder = DEFAULT_ORDER,
) {
  const nextStorage = {
    ...storage,
    "resume-diy-state": JSON.stringify(state),
    "resume-diy-preferences": JSON.stringify({
      ...preferences,
      smartFillV2: "false",
    }),
    "resume-diy-section-order-v2": JSON.stringify(moduleOrder),
    "resume-diy-modules": JSON.stringify(moduleOrder),
  };
  await page.evaluate((values) => {
    sessionStorage.setItem(
      "__preview_interaction_storage__",
      JSON.stringify(values),
    );
  }, nextStorage);
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page);
  await page.mouse.move(1, 1);
  await page.waitForFunction(
    () => !document.querySelector(".preview-interaction-outline"),
    undefined,
    { timeout: 5000 },
  );
}

function buildMultipage(seed) {
  const state = clone(seed);
  state.projects = Array.from({ length: 12 }, (_, index) => ({
    ...(seed.projects[index % Math.max(1, seed.projects.length)] ||
      seed.education[0]),
    id: `interaction-project-${index + 1}`,
    title: `跨页交互项目 ${index + 1}`,
    html: `<p><strong>跨页条目：</strong>用于验证第二页条目点击和键盘辅助按钮按 entry.id 定位。</p><p>${"跨页正文内容。".repeat(80)}</p>`,
  }));
  return state;
}

async function savePng(page, name) {
  await page.evaluate(() => document.querySelector(".export-trigger")?.click());
  await page.waitForSelector(".download-menu");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "高清 PNG" })
    .evaluate((element) => element.click());
  const download = await downloadPromise;
  const filePath = path.join(OUTPUT_ROOT, `${name}.png`);
  await download.saveAs(filePath);
  assert.ok(
    fs.statSync(filePath).size > 1000,
    `${name} PNG is unexpectedly small`,
  );
  return filePath;
}

async function savePdf(page, name) {
  await page.evaluate(() => document.querySelector(".export-trigger")?.click());
  await page.waitForSelector(".download-menu");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "PDF 文档" })
    .evaluate((element) => element.click());
  const download = await downloadPromise;
  const filePath = path.join(OUTPUT_ROOT, `${name}.pdf`);
  await download.saveAs(filePath);
  assert.ok(
    fs.statSync(filePath).size > 1000,
    `${name} PDF is unexpectedly small`,
  );
  return filePath;
}

function rasterizePdf(filePath, name) {
  const prefix = path.join(OUTPUT_ROOT, `${name}-page`);
  for (const file of fs.readdirSync(OUTPUT_ROOT)) {
    if (file.startsWith(`${name}-page-`) && file.endsWith(".png")) {
      fs.unlinkSync(path.join(OUTPUT_ROOT, file));
    }
  }
  const result = spawnSync(
    "pdftoppm",
    ["-png", "-r", "144", filePath, prefix],
    {
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `pdftoppm failed for ${filePath}: ${result.stderr || result.stdout}`,
  );
  return fs
    .readdirSync(OUTPUT_ROOT)
    .filter((file) => file.startsWith(`${name}-page-`) && file.endsWith(".png"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .map((file) => path.join(OUTPUT_ROOT, file));
}

function comparePdfRasters(baselinePdf, candidatePdf) {
  const baselinePages = rasterizePdf(baselinePdf, "pdf-baseline");
  const candidatePages = rasterizePdf(candidatePdf, "pdf-hover");
  assert.equal(
    candidatePages.length,
    baselinePages.length,
    "PDF page count changed",
  );
  assert.ok(baselinePages.length > 0, "PDF rasterizer produced no pages");
  return baselinePages.map((baselinePage, index) => {
    const candidatePage = candidatePages[index];
    const comparison = comparePngFiles([baselinePage, candidatePage])[0];
    return { page: index + 1, ...comparison };
  });
}

function comparePngFiles(paths) {
  const baseline = PNG.sync.read(fs.readFileSync(paths[0]));
  return paths.slice(1).map((filePath) => {
    const candidate = PNG.sync.read(fs.readFileSync(filePath));
    assert.equal(
      candidate.width,
      baseline.width,
      `${filePath} PNG width changed`,
    );
    assert.equal(
      candidate.height,
      baseline.height,
      `${filePath} PNG height changed`,
    );
    assert.ok(
      candidate.data.equals(baseline.data),
      `${filePath} export differs while interaction layer is active`,
    );
    return {
      filePath,
      width: candidate.width,
      height: candidate.height,
      byteEqual: true,
    };
  });
}

async function main() {
  assert.ok(
    fs.existsSync(CURRENT_DIST),
    `Missing current dist: ${CURRENT_DIST}`,
  );
  const server = await serve(CURRENT_DIST);
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu"],
  });
  const target = await createPage(browser);
  let seed;
  let storage;
  let preferences;
  let initialInvariant;
  const result = {
    status: "PASS",
    checks: {},
    exports: {},
  };
  try {
    const url = serverUrl(server);
    await target.page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(target.page);
    await target.page.waitForTimeout(250);
    storage = await readStorage(target.page);
    seed = JSON.parse(storage["resume-diy-state"]);
    preferences = JSON.parse(storage["resume-diy-preferences"] || "{}");
    initialInvariant = await previewInvariant(target.page);
    const initialStorage = await readStorage(target.page);
    const blockCount = await target.page
      .locator(".paper:not(.layout-measure) .preview-block")
      .count();
    assert.equal(
      await target.page.locator(".preview-interaction-button").count(),
      blockCount,
      "keyboard fragment list does not match visible preview blocks",
    );
    result.checks.keyboardFragmentCount = blockCount;

    await target.page
      .locator('.paper:not(.layout-measure) [data-layout-block="work"]')
      .first()
      .hover({ position: { x: 2, y: 2 } });
    await target.page.waitForSelector(".preview-interaction-outline");
    const hoverInvariant = await previewInvariant(target.page);
    assert.deepEqual(
      hoverInvariant,
      initialInvariant,
      "hover changed right preview content or geometry",
    );
    const hoverOutline = await target.page.evaluate(() => {
      const outline = document.querySelector(".preview-interaction-outline");
      const work = document.querySelector(
        '.paper:not(.layout-measure) [data-layout-block="work"]',
      );
      const paper = work?.closest(".paper:not(.layout-measure)");
      const pane = document.querySelector(".preview-pane");
      if (!outline || !work || !paper || !pane) return null;
      const outlineRect = outline.getBoundingClientRect();
      const workVisual =
        work.querySelector(":scope > .preview-section") ?? work;
      const title = workVisual.querySelector(":scope > .preview-title");
      const contentElements = [...workVisual.children].filter(
        (child) => child !== title,
      );
      const contentRects = contentElements.map((child) =>
        child.getBoundingClientRect(),
      );
      const contentRect = {
        left: Math.min(...contentRects.map((rect) => rect.left)),
        top: Math.min(...contentRects.map((rect) => rect.top)),
        right: Math.max(...contentRects.map((rect) => rect.right)),
        bottom: Math.max(...contentRects.map((rect) => rect.bottom)),
      };
      const blocks = [
        ...paper.querySelectorAll(".paper-content > .preview-block"),
      ];
      const workIndex = blocks.indexOf(work);
      const visualRect = (block) =>
        (
          block?.querySelector(":scope > .preview-section") ?? block
        )?.getBoundingClientRect();
      const previousRect = visualRect(blocks[workIndex - 1]);
      const nextRect = visualRect(blocks[workIndex + 1]);
      const paperRect = paper.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const textRects = [];
      const walker = document.createTreeWalker(
        workVisual,
        NodeFilter.SHOW_TEXT,
      );
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        textRects.push(...range.getClientRects());
      }
      const railWidth = 1;
      const capLength = 4;
      const paintedRects = [
        {
          left: outlineRect.left,
          top: outlineRect.top,
          right: outlineRect.left + railWidth,
          bottom: outlineRect.bottom,
        },
        {
          left: outlineRect.right - railWidth,
          top: outlineRect.top,
          right: outlineRect.right,
          bottom: outlineRect.bottom,
        },
        {
          left: outlineRect.left,
          top: outlineRect.top,
          right: outlineRect.left + capLength,
          bottom: outlineRect.top + railWidth,
        },
        {
          left: outlineRect.right - capLength,
          top: outlineRect.top,
          right: outlineRect.right,
          bottom: outlineRect.top + railWidth,
        },
        {
          left: outlineRect.left,
          top: outlineRect.bottom - railWidth,
          right: outlineRect.left + capLength,
          bottom: outlineRect.bottom,
        },
        {
          left: outlineRect.right - capLength,
          top: outlineRect.bottom - railWidth,
          right: outlineRect.right,
          bottom: outlineRect.bottom,
        },
      ];
      const overlaps = (left, right) =>
        left.left < right.right - 0.1 &&
        left.right > right.left + 0.1 &&
        left.top < right.bottom - 0.1 &&
        left.bottom > right.top + 0.1;
      return {
        wrapsModuleBody:
          outlineRect.left <= contentRect.left &&
          outlineRect.top <= contentRect.top &&
          outlineRect.right >= contentRect.right &&
          outlineRect.bottom >= contentRect.bottom - 1.1 &&
          (!title || outlineRect.top >= title.getBoundingClientRect().bottom),
        doesNotCrossText: !paintedRects.some((paintedRect) =>
          textRects.some((textRect) => overlaps(paintedRect, textRect)),
        ),
        doesNotOverlapAdjacentModules:
          (!previousRect || outlineRect.top >= previousRect.bottom - 0.5) &&
          (!nextRect || outlineRect.bottom <= nextRect.top + 0.5),
        clippedToPaperAndPane:
          outlineRect.left >= Math.max(paperRect.left, paneRect.left) &&
          outlineRect.top >= Math.max(paperRect.top, paneRect.top) &&
          outlineRect.right <= Math.min(paperRect.right, paneRect.right) &&
          outlineRect.bottom <= Math.min(paperRect.bottom, paneRect.bottom),
      };
    });
    assert.deepEqual(
      hoverOutline,
      {
        wrapsModuleBody: true,
        doesNotCrossText: true,
        doesNotOverlapAdjacentModules: true,
        clippedToPaperAndPane: true,
      },
      "hover outline does not wrap the module body cleanly",
    );
    await target.page.screenshot({
      path: path.join(ARTIFACT_ROOT, "hover-outline-1440.png"),
    });
    const detailClip = await target.page.evaluate(() => {
      const work = document.querySelector(
        '.paper:not(.layout-measure) [data-layout-block="work"]',
      );
      if (!work) return null;
      const rect = work.getBoundingClientRect();
      return {
        x: Math.max(0, rect.left - 16),
        y: Math.max(0, rect.top - 16),
        width:
          Math.min(window.innerWidth, rect.right + 16) -
          Math.max(0, rect.left - 16),
        height:
          Math.min(window.innerHeight, rect.bottom + 40) -
          Math.max(0, rect.top - 16),
      };
    });
    assert.ok(detailClip, "missing work module detail clip");
    await target.page.screenshot({
      path: path.join(ARTIFACT_ROOT, "hover-outline-detail-1440.png"),
      clip: detailClip,
    });
    assert.deepEqual(
      await readStorage(target.page),
      initialStorage,
      "hover changed localStorage",
    );
    await target.page.mouse.move(0, 0);
    await target.page.waitForFunction(
      () => !document.querySelector(".preview-interaction-outline"),
    );
    result.checks.hoverLeave = "PASS";
    result.checks.hoverOutline = "PASS";

    await target.page
      .locator(
        '.paper:not(.layout-measure) [data-preview-entry-id="education-1"]',
      )
      .first()
      .click({ position: { x: 2, y: 2 } });
    await target.page.waitForFunction(() =>
      document
        .querySelector(
          '.editor-workspace-pane [data-editor-entry-id="education-1"]',
        )
        ?.classList.contains("expanded"),
    );
    await target.page.waitForFunction(() =>
      document
        .querySelector(
          '.editor-workspace-pane [data-editor-entry-id="education-1"]',
        )
        ?.classList.contains("editor-navigation-target-active"),
    );
    await target.page.waitForFunction(
      () =>
        !document
          .querySelector(
            '.editor-workspace-pane [data-editor-entry-id="education-1"]',
          )
          ?.classList.contains("editor-navigation-target-active"),
      undefined,
      { timeout: 3000 },
    );
    await target.page.waitForFunction(() =>
      document.activeElement?.closest?.('[data-editor-entry-id="education-1"]'),
    );
    const afterEntryClick = await previewInvariant(target.page);
    assert.deepEqual(
      afterEntryClick,
      initialInvariant,
      "entry click changed the right preview or scroll position",
    );
    assertExclusiveState(
      await leftState(target.page),
      {
        expandedEntries: ["education-1"],
        summaryExpanded: false,
        basicExpanded: false,
      },
      "entry click",
    );
    result.checks.entryClick = "PASS";
    result.checks.navigationHighlightLifecycle = "PASS";

    await target.page
      .locator(
        '.paper:not(.layout-measure) [data-layout-block="work"] .preview-title',
      )
      .first()
      .click();
    await target.page.waitForFunction(() =>
      [
        ...document.querySelectorAll(
          '.editor-workspace-pane [data-editor-module="work"] [data-editor-entry-id]',
        ),
      ].every((entry) => entry.classList.contains("expanded")),
    );
    const workIds = await target.page
      .locator(
        '.editor-workspace-pane [data-editor-module="work"] [data-editor-entry-id]',
      )
      .evaluateAll((entries) =>
        entries.map((entry) => entry.dataset.editorEntryId),
      );
    assertExclusiveState(
      await leftState(target.page),
      {
        expandedEntries: workIds,
        summaryExpanded: false,
        basicExpanded: false,
      },
      "module click",
    );
    result.checks.moduleClick = "PASS";

    await target.page
      .locator(
        '.paper:not(.layout-measure) [data-layout-block="summary"] .preview-title',
      )
      .first()
      .click();
    await target.page.waitForFunction(() =>
      Boolean(
        document.querySelector(
          ".editor-workspace-pane .summary-card .summary-editor",
        ),
      ),
    );
    await target.page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("data-editor-focus") === "summary",
    );
    const summaryState = await leftState(target.page);
    assert.equal(
      summaryState.focused.editorFocus,
      "summary",
      "summary heading did not receive focus",
    );
    assertExclusiveState(
      summaryState,
      { expandedEntries: [], summaryExpanded: true, basicExpanded: false },
      "summary click",
    );
    assert.equal(
      await target.page
        .locator("[data-editor-nav-trigger]")
        .getAttribute("data-editor-nav-value"),
      "summary",
      "chapter menu did not sync to summary preview navigation",
    );
    result.checks.summaryClick = "PASS";

    await target.page
      .locator('.paper:not(.layout-measure) [data-layout-block="header"] h1')
      .first()
      .click();
    await target.page.waitForFunction(() =>
      Boolean(document.querySelector("[data-editor-target=basic].expanded")),
    );
    await target.page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("data-editor-focus") === "basic",
    );
    const basicState = await leftState(target.page);
    assert.equal(
      basicState.focused.editorFocus,
      "basic",
      "basic heading did not receive focus",
    );
    assertExclusiveState(
      basicState,
      { expandedEntries: [], summaryExpanded: false, basicExpanded: true },
      "basic click",
    );
    assert.equal(
      await target.page
        .locator("[data-editor-nav-trigger]")
        .getAttribute("data-editor-nav-value"),
      "basic",
      "chapter menu did not sync to basic preview navigation",
    );
    result.checks.basicClick = "PASS";

    const linkProbe = await target.page
      .locator(".preview-sites a")
      .first()
      .evaluate((element) => {
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        });
        const dispatchResult = element.dispatchEvent(event);
        return { dispatchResult, defaultPrevented: event.defaultPrevented };
      });
    assert.deepEqual(
      linkProbe,
      { dispatchResult: true, defaultPrevented: false },
      "preview link was intercepted",
    );
    const selectionProbe = await target.page
      .locator(".preview-rich")
      .first()
      .evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        });
        const dispatchResult = element.dispatchEvent(event);
        selection?.removeAllRanges();
        return { dispatchResult, defaultPrevented: event.defaultPrevented };
      });
    assert.deepEqual(
      selectionProbe,
      { dispatchResult: true, defaultPrevented: false },
      "text selection click was intercepted",
    );
    const modifierBefore = await leftState(target.page);
    await target.page
      .locator(
        '.paper:not(.layout-measure) [data-preview-entry-id="education-1"]',
      )
      .first()
      .evaluate((element) =>
        element.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
            ctrlKey: true,
          }),
        ),
      );
    await target.page.waitForTimeout(100);
    assert.deepEqual(
      await leftState(target.page),
      modifierBefore,
      "modified preview click was intercepted",
    );
    result.checks.linkSelectionModifiers = "PASS";

    const versionStorageBefore = await readStorage(target.page);
    await target.page
      .getByRole("button", { name: "版本管理", exact: true })
      .click();
    await target.page.waitForSelector(".versions-workspace-pane");
    const versionPreviewButton = target.page.getByRole("button", {
      name: "编辑第 1 页实习经历",
      exact: true,
    });
    await versionPreviewButton.focus();
    await target.page.keyboard.press("Enter");
    await target.page.waitForSelector(".editor-workspace-pane");
    await target.page.waitForFunction(() =>
      document
        .querySelector(
          '.editor-workspace-pane [data-editor-module="work"] [data-editor-entry-id]',
        )
        ?.classList.contains("expanded"),
    );
    const versionStorageAfter = await readStorage(target.page);
    for (const key of [
      "resume-diy-version-store-v1",
      "resume-diy-state",
      "resume-diy-title",
    ]) {
      assert.equal(
        versionStorageAfter[key],
        versionStorageBefore[key],
        `${key} changed while navigating from versions`,
      );
    }
    result.checks.versionViewNavigation = "PASS";

    const spaciousPreferences = {
      ...preferences,
      fontSize: "13",
      lineHeight: "19",
      moduleSpacing: "8",
      pageMargin: "35",
    };
    await loadState(target.page, url, storage, seed, spaciousPreferences);
    await target.page.waitForTimeout(300);
    await target.page.evaluate(() => {
      const resume = JSON.parse(localStorage.getItem("resume-diy-state"));
      const moduleOrder = JSON.parse(
        localStorage.getItem("resume-diy-section-order-v2"),
      );
      const moduleNames = JSON.parse(
        localStorage.getItem("resume-diy-module-names"),
      );
      const preferences = JSON.parse(
        localStorage.getItem("resume-diy-preferences"),
      );
      const signature = JSON.stringify({
        resume,
        moduleOrder,
        moduleNames,
        summaryTitle:
          localStorage.getItem("resume-diy-summary-title") || "自我评价",
        font: preferences.font,
        fontSize: preferences.fontSize,
        lineHeight: preferences.lineHeight,
        moduleSpacing: preferences.moduleSpacing,
        pageMargin: preferences.pageMargin,
        dateFormat: preferences.dateFormat,
        titleFormat: preferences.titleFormat,
        separator: preferences.separator,
        textAlign: preferences.textAlign,
      });
      localStorage.setItem("resume-diy-smart-fit-signature-v3", signature);
    });
    await target.page.reload({ waitUntil: "domcontentloaded" });
    await settle(target.page);
    await target.page.waitForFunction(
      () => document.querySelector(".smart-fill-toggle.active"),
      undefined,
      { timeout: 30000 },
    );
    await target.page.waitForFunction(
      () =>
        document.querySelectorAll(".paper:not(.layout-measure)").length === 1,
    );
    result.checks.staleSmartFitRecovery = "PASS (refresh auto-run)";

    const multipage = buildMultipage(seed);
    await loadState(target.page, url, storage, multipage, preferences);
    assert.ok(
      (await target.page.locator(".paper:not(.layout-measure)").count()) > 1,
      "multipage fixture did not create a second page",
    );
    assert.equal(
      await target.page.locator(".page-number").count(),
      0,
      "retired page number is still rendered on multipage preview",
    );
    result.checks.pageNumberRemoved = "PASS";
    const secondPageEntryIds = await target.page
      .locator(".paper:not(.layout-measure)")
      .nth(1)
      .locator("[data-preview-entry-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.previewEntryId),
      );
    assert.ok(secondPageEntryIds.length, "second preview page has no entry");
    const secondPageEntryId = secondPageEntryIds[0];
    await target.page
      .locator(".paper:not(.layout-measure)")
      .nth(1)
      .locator(`[data-preview-entry-id="${secondPageEntryId}"]`)
      .click({ position: { x: 2, y: 2 } });
    await target.page.waitForFunction(
      (entryId) =>
        document
          .querySelector(
            `.editor-workspace-pane [data-editor-entry-id="${entryId}"]`,
          )
          ?.classList.contains("expanded"),
      secondPageEntryId,
    );
    await target.page.waitForFunction(
      (entryId) =>
        document.activeElement?.closest?.(
          `[data-editor-entry-id="${entryId}"]`,
        ),
      secondPageEntryId,
    );
    result.checks.secondPageEntryClick = secondPageEntryId;

    await loadState(target.page, url, storage, multipage, preferences);
    const secondPageProjectButton = target.page.getByRole("button", {
      name: "编辑第 2 页项目经历",
      exact: true,
    });
    assert.equal(
      await secondPageProjectButton.count(),
      1,
      "second-page keyboard fragment button is missing",
    );
    await secondPageProjectButton.focus();
    await target.page.waitForSelector(".preview-interaction-outline");
    await target.page.waitForFunction(
      () => (document.querySelector(".preview-pane")?.scrollTop || 0) > 0,
    );
    const keyboardTargetIds = await target.page
      .locator(".paper:not(.layout-measure)")
      .nth(1)
      .locator("[data-preview-entry-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.previewEntryId),
      );
    await target.page.keyboard.press("Enter");
    await target.page.waitForFunction(
      (entryId) =>
        document
          .querySelector(
            `.editor-workspace-pane [data-editor-entry-id="${entryId}"]`,
          )
          ?.classList.contains("expanded"),
      keyboardTargetIds[0],
    );
    result.checks.keyboardSecondPage = {
      targetIds: keyboardTargetIds,
      rightScrollTop: await target.page
        .locator(".preview-pane")
        .evaluate((element) => element.scrollTop),
    };

    await loadState(target.page, url, storage, seed, preferences);
    await target.page
      .locator(
        '.editor-workspace-pane [data-editor-entry-id="education-1"] .entry-actions button[aria-label="删除经历"]',
      )
      .click();
    await target.page.waitForSelector('[role="alertdialog"]');
    const dialogScrollBefore = await target.page
      .locator(".editor-workspace-pane .editor-scroll")
      .evaluate((element) => element.scrollTop);
    const workBox = await target.page
      .locator('.paper:not(.layout-measure) [data-layout-block="work"]')
      .first()
      .boundingBox();
    assert.ok(workBox, "work preview block has no box while dialog is open");
    await target.page.mouse.click(workBox.x + 3, workBox.y + 3);
    assert.equal(
      await target.page.locator('[role="alertdialog"]').count(),
      1,
      "preview click passed through confirmation dialog",
    );
    assert.equal(
      await target.page
        .locator(".editor-workspace-pane .editor-scroll")
        .evaluate((element) => element.scrollTop),
      dialogScrollBefore,
      "background preview click moved editor during confirmation",
    );
    await target.page
      .getByRole("button", { name: "取消", exact: true })
      .click();
    result.checks.confirmDialogIsolation = "PASS";

    await loadState(target.page, url, storage, seed, preferences);
    await target.page.mouse.move(0, 0);
    const noInteractionExport = await savePng(target.page, "no-interaction");
    await loadState(target.page, url, storage, seed, preferences);
    await target.page.evaluate(() =>
      document.querySelector(".export-trigger")?.click(),
    );
    await target.page.waitForSelector(".download-menu");
    await target.page
      .locator('.paper:not(.layout-measure) [data-layout-block="work"]')
      .first()
      .hover({ position: { x: 2, y: 2 } });
    await target.page.waitForSelector(".preview-interaction-outline");
    const hoverExportPromise = target.page.waitForEvent("download");
    await target.page
      .getByRole("menuitem", { name: "高清 PNG" })
      .evaluate((element) => element.click());
    const hoverExportDownload = await hoverExportPromise;
    const hoverInteractionExport = path.join(
      OUTPUT_ROOT,
      "hover-interaction.png",
    );
    await hoverExportDownload.saveAs(hoverInteractionExport);
    await loadState(target.page, url, storage, seed, preferences);
    const keyboardButton = target.page.getByRole("button", {
      name: "编辑第 1 页实习经历",
      exact: true,
    });
    await keyboardButton.focus();
    await target.page.waitForSelector(".preview-interaction-outline");
    await target.page.evaluate(() =>
      document.querySelector(".export-trigger")?.click(),
    );
    await target.page.waitForSelector(".download-menu");
    await keyboardButton.focus();
    const focusExportPromise = target.page.waitForEvent("download");
    await target.page
      .getByRole("menuitem", { name: "高清 PNG" })
      .evaluate((element) => element.click());
    const focusExportDownload = await focusExportPromise;
    const focusInteractionExport = path.join(
      OUTPUT_ROOT,
      "keyboard-focus-interaction.png",
    );
    await focusExportDownload.saveAs(focusInteractionExport);
    result.exports.png = comparePngFiles([
      noInteractionExport,
      hoverInteractionExport,
      focusInteractionExport,
    ]);
    await loadState(target.page, url, storage, seed, preferences);
    await target.page.mouse.move(0, 0);
    const noInteractionPdf = await savePdf(target.page, "no-interaction");
    await loadState(target.page, url, storage, seed, preferences);
    await target.page.evaluate(() =>
      document.querySelector(".export-trigger")?.click(),
    );
    await target.page.waitForSelector(".download-menu");
    await target.page
      .locator('.paper:not(.layout-measure) [data-layout-block="work"]')
      .first()
      .hover({ position: { x: 2, y: 2 } });
    await target.page.waitForSelector(".preview-interaction-outline");
    const hoverPdfPromise = target.page.waitForEvent("download");
    await target.page
      .getByRole("menuitem", { name: "PDF 文档" })
      .evaluate((element) => element.click());
    const hoverPdfDownload = await hoverPdfPromise;
    const hoverPdf = path.join(OUTPUT_ROOT, "hover-interaction.pdf");
    await hoverPdfDownload.saveAs(hoverPdf);
    result.exports.pdfRaster = comparePdfRasters(noInteractionPdf, hoverPdf);
    await target.page.emulateMedia({ media: "print" });
    const printState = await target.page.evaluate(() => ({
      layer: getComputedStyle(
        document.querySelector(".preview-interaction-layer"),
      ).display,
      outline: document.querySelector(".preview-interaction-outline")
        ? getComputedStyle(
            document.querySelector(".preview-interaction-outline"),
          ).display
        : "none",
      paperCount: document.querySelectorAll(".paper:not(.layout-measure)")
        .length,
    }));
    assert.deepEqual(
      printState,
      { layer: "none", outline: "none", paperCount: 1 },
      "interaction layer is visible in print media",
    );
    await target.page.emulateMedia({ media: "screen" });
    result.checks.printIsolation = "PASS";

    if (target.errors.length || target.failedFontRequests.length)
      throw new Error(
        JSON.stringify({
          pageErrors: target.errors,
          failedFontRequests: target.failedFontRequests,
        }),
      );
    result.browserErrors = {
      pageErrors: target.errors,
      failedFontRequests: target.failedFontRequests,
    };
    fs.writeFileSync(
      path.join(ARTIFACT_ROOT, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
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
    await target.context.close();
    await browser.close();
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
