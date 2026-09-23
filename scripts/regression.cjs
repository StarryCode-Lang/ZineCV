const fs = require("fs"),
  http = require("http"),
  path = require("path"),
  assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { PNG } = require("pngjs");
function serve(root, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory())
        p = path.join(root, "index.html");
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
        }[path.extname(p)] || "application/octet-stream",
      );
      res.end(fs.readFileSync(p));
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
process.chdir(path.resolve(__dirname, ".."));
fs.mkdirSync(".artifacts/regression", { recursive: true });
const results = {};
async function run(browser, name, port) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.setFixedTime(new Date("2026-09-10T10:00:00Z"));
  await page.addInitScript(() => {
    let next = 0;
    crypto.randomUUID = () =>
      `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
  });
  await page.addInitScript(() => {
    if (localStorage.getItem("resume-diy-state")) return;
    const entry = (id, title) => ({
      id,
      title,
      role: "",
      department: "",
      city: "",
      start: "",
      end: "",
      html: "<p>用于界面回归的虚构内容。</p>",
    });
    localStorage.setItem(
      "resume-diy-state",
      JSON.stringify({
        basic: { name: "测试用户", ageMode: "age" },
        education: [entry("education-1", "测试大学")],
        skills: [],
        work: [],
        projects: [entry("project-1", "测试项目")],
        orgs: [],
        research: [],
        awards: [],
        other: [],
        portfolio: [],
        custom: [],
        summary: "",
      }),
    );
  });
  await page.addInitScript(() => {
    const fixtureKey = "__browser_regression_storage__";
    const fixture = sessionStorage.getItem(fixtureKey);
    if (!fixture) return;
    sessionStorage.removeItem(fixtureKey);
    try {
      const nextStorage = JSON.parse(fixture);
      localStorage.clear();
      for (const [key, value] of Object.entries(nextStorage))
        if (typeof value === "string") localStorage.setItem(key, value);
    } catch {
      // The test reports the resulting page state if a fixture is invalid.
    }
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.evaluate(() => document.fonts.ready);
  async function chooseChapter(key) {
    const trigger = page.locator("[data-editor-nav-trigger]");
    if ((await trigger.count()) === 0) {
      const legacyLabels = { basic: "基本信息" };
      await page
        .getByRole("button", {
          name: legacyLabels[key] || key,
          exact: true,
        })
        .click();
      return;
    }
    await trigger.click();
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
  async function capture(label) {
    const captureStyle = await page.addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }",
    });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `.artifacts/regression/${name}-${label}.png`,
      animations: "disabled",
      mask: [page.locator(".notice-toast")],
    });
    const snapshot = await page.evaluate(() => ({
      papers: [...document.querySelectorAll(".paper:not(.layout-measure)")].map(
        (p) => ({
          html: p.innerHTML,
          style: p.getAttribute("style"),
          rect: JSON.parse(JSON.stringify(p.getBoundingClientRect())),
        }),
      ),
      // Keep layout controls in the baseline contract. Personal-data fields are
      // validated by the interaction assertions below and have changed across
      // historical baselines as the editor gained optional fields.
      controls: [...document.querySelectorAll("select,input[type=range]")].map(
        (e) => ({
          tag: e.tagName,
          label: e.getAttribute("aria-label"),
          name: e.getAttribute("name"),
          value: e.value,
        }),
      ),
      width: document
        .querySelector(".workspace-splitter")
        .getAttribute("aria-valuenow"),
      shellGeometry: Object.fromEntries(
        [
          ".workspace",
          ".topbar",
          ".rail",
          ".editor-pane",
          ".workspace-splitter",
          ".preview-pane",
          ".resume-pages",
        ].map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return [selector, null];
          const rect = element.getBoundingClientRect();
          return [
            selector,
            {
              x: rect.x,
              y: rect.y,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            },
          ];
        }),
      ),
    }));
    await captureStyle.evaluate((element) => element.remove());
    results[name][label] = snapshot;
  }
  results[name] = {};
  if (name === "after") {
    assert.equal(
      await page
        .locator(".editor-pane")
        .evaluate((el) => getComputedStyle(el).paddingTop),
      "0px",
    );
    await page.getByRole("button", { name: /^导出/ }).click();
    await page.locator(".download-option").first().hover();
    assert.equal(await page.locator(".download-menu").count(), 1);
    await page.locator(".topbar").click({ position: { x: 2, y: 2 } });
    assert.equal(await page.locator(".download-menu").count(), 0);
    await page.getByRole("button", { name: "版本管理", exact: true }).click();
    await page.locator(".branch-tree-scroll").waitFor();
    await page.getByRole("separator").focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
    assert.ok(
      await page
        .locator(".branch-tree-toolbar")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.ok(
      await page
        .locator(".branch-tree-fit-button")
        .evaluate((el) => el.scrollHeight <= el.clientHeight),
    );
    await page.getByRole("separator").dblclick();
    await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  }
  await capture("initial");
  for (const width of [1050, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await capture(`width-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chooseChapter("basic");
  await page.getByLabel("姓名", { exact: true }).fill("排版回归测试");
  await capture("basic");
  assert.match(await page.locator(".resume-pages").innerText(), /排版回归测试/);
  await chooseChapter("basic");
  await page
    .getByRole("button", { name: "展开经历", exact: true })
    .first()
    .click();
  await page.getByPlaceholder("请输入学校名称").fill("测试大学");
  const rich = page.locator(".rich-body").first();
  await rich.fill("可编辑的项目成果");
  await rich.press("Control+A");
  await page.getByRole("button", { name: "粗体", exact: true }).click();
  await capture("entry-rich");
  assert.match(await page.locator(".resume-pages").innerText(), /测试大学/);
  await page.getByRole("button", { name: "插入链接", exact: true }).click();
  await page
    .getByRole("dialog", { name: "插入或编辑链接" })
    .getByRole("textbox")
    .fill("https://example.com");
  await page.getByRole("button", { name: "保存链接" }).click();
  await capture("rich-link");
  await page.getByRole("button", { name: "间距", exact: true }).click();
  await page.getByLabel("正文行距").selectOption("16");
  await page.getByLabel("四边页距").selectOption("35");
  await capture("spacing");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "格式", exact: true }).click();
  await page.getByRole("button", { name: "单行标题", exact: true }).click();
  await page.getByRole("button", { name: "2021年1月", exact: true }).click();
  await page
    .getByRole("button", { name: "两端对齐", exact: true })
    .first()
    .click();
  await page.getByLabel("使用颜色 #ca3832", { exact: true }).click();
  await capture("format");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "模块管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑教育经历", exact: true }).click();
  await page.locator(".manager-row input").fill("教育背景");
  await page.keyboard.press("Enter");
  // B06 将“添加模块”统一为“可恢复模块”；保留原有恢复断言。
  await page.getByRole("button", { name: /^(恢复荣誉奖项|荣誉奖项)$/ }).click();
  await capture("module-added");
  const headers = page.locator(".section-heading");
  await headers.first().dragTo(headers.nth(1));
  await capture("module-reordered");
  await page.keyboard.press("Escape");
  await page.getByRole("separator").press("ArrowRight");
  await capture("resized");
  await page.getByRole("separator").dblclick();
  await page.getByRole("button", { name: /^导出/ }).click();
  assert.equal(
    await page.getByRole("menuitem", { name: /暗夜模式|浅色模式/ }).count(),
    0,
  );
  assert.equal(await page.locator(".dark-mode").count(), 0);
  await capture("fixed-theme");
  await page.getByRole("menuitem", { name: "复制简历文本" }).click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /测试大学/,
  );
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.getByLabel("版本说明").fill("排版验证版本");
  await page.getByRole("button", { name: "提交到当前分支" }).click();
  await page.getByLabel("新分支名称").fill("测试分支");
  await page.getByRole("button", { name: "新建分支" }).click();
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("分支版本改动");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.getByLabel("版本说明").fill("分支版本");
  await page.getByRole("button", { name: "提交到当前分支" }).click();
  await capture("versions");
  await page.getByLabel("切换简历分支").click();
  await page.getByRole("option", { name: "默认版本", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="切换简历分支"] span')
        ?.textContent?.trim() === "默认版本",
  );
  await capture("switched");
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("恢复前的临时改动");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.locator(".branch-tree-scroll").waitFor();
  await page
    .locator(".branch-tree-node")
    .first()
    .evaluate((node) => node.click());
  await page.locator(".branch-node-detail").waitFor();
  await page
    .locator(".branch-node-detail .restore-button:not([disabled])")
    .first()
    .click();
  await page.getByRole("button", { name: "恢复此版本" }).click();
  await capture("restored");
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await page.getByRole("button", { name: "智能一页", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".notice-toast")
        ?.textContent?.includes("智能一页已完成"),
    {},
    { timeout: 20000 },
  );
  await capture("smart-fit");
  const paperCount = await page.locator(".resume-pages .paper").count();
  assert.equal(paperCount, 1);
  await page.getByRole("button", { name: "智能一页", exact: true }).click();
  await page.getByRole("button", { name: "智能一页", exact: true }).click();
  await capture("smart-reuse");
  for (const [format, label] of [
    ["pdf", "PDF 文档"],
    ["png", "高清 PNG"],
  ]) {
    await page.getByRole("button", { name: /^导出/ }).click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: new RegExp(label) }).click();
    const download = await downloading;
    await download.saveAs(`.artifacts/regression/${name}-export.${format}`);
    assert.ok(
      fs.statSync(`.artifacts/regression/${name}-export.${format}`).size > 1000,
    );
  }
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await capture("reload");
  assert.match(await page.locator("body").innerText(), /测试大学/);
  // Fresh isolated fixtures exercise migration and pagination boundaries.
  const seed = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("resume-diy-state")),
  );
  async function fixtureStorage(nextStorage) {
    await page.evaluate((storage) => {
      sessionStorage.setItem(
        "__browser_regression_storage__",
        JSON.stringify(storage),
      );
    }, nextStorage);
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
  }
  async function fixture(state, preferences = {}) {
    await fixtureStorage({
      "resume-diy-state": JSON.stringify(state),
      "resume-diy-preferences": JSON.stringify(preferences),
    });
  }
  await fixture(seed);
  for (const font of ["雅黑", "黑体", "楷体", "仿宋", "宋体"]) {
    await page.locator(".toolbar-button").nth(1).click();
    await page
      .locator(".font-choice-grid")
      .getByRole("button", { name: font, exact: true })
      .click();
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.fonts.ready);
    await capture(`font-${font}`);
  }
  await chooseChapter("basic");
  // Both builds receive identical input, independent of screenshot raster noise.
  const avatarFixture = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < avatarFixture.data.length; i += 4) {
    avatarFixture.data[i] = 174;
    avatarFixture.data[i + 1] = 60;
    avatarFixture.data[i + 2] = 32;
    avatarFixture.data[i + 3] = 255;
  }
  await page.locator("input[type=file]").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: PNG.sync.write(avatarFixture),
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".preview-avatar")
      ?.getAttribute("src")
      ?.startsWith("data:"),
  );
  await capture("avatar");
  await chooseChapter("basic");
  await page
    .getByRole("button", { name: "删除经历", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await capture("delete-cancelled");
  await page
    .getByRole("button", { name: "删除经历", exact: true })
    .first()
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除经历", exact: true })
    .click();
  await capture("entry-deleted");
  await page
    .getByRole("button", { name: "添加一段教育经历", exact: false })
    .click();
  await page.getByPlaceholder("请输入学校名称").fill("新建学校");
  await capture("entry-added");
  await page.getByRole("button", { name: /^导出/ }).click();
  await page.getByRole("menuitem", { name: "清空简历" }).click();
  await page.getByRole("button", { name: "确认清空" }).click();
  await capture("empty");
  const long = structuredClone(seed);
  long.projects = Array.from({ length: 12 }, (_, i) => ({
    id: `long-${i}`,
    title: `长简历项目 ${i}`,
    role: "示例项目",
    department: "",
    city: "",
    start: "2024.01",
    end: "2024.12",
    html: `<p>${"用于分页回归的虚构项目成果。".repeat(80)}</p>`,
  }));
  await fixture(long);
  await capture("long-multipage");
  await page.waitForFunction(
    () => document.querySelectorAll(".resume-pages .paper").length > 1,
    {},
    { timeout: 30000 },
  );
  assert.ok((await page.locator(".resume-pages .paper").count()) > 1);
  const beforeFit = await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getAttribute("style");
  await page.getByRole("button", { name: "智能一页", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".notice-toast")
        ?.textContent?.includes("内容过多"),
    {},
    { timeout: 30000 },
  );
  assert.equal(
    await page
      .locator(".paper:not(.layout-measure)")
      .first()
      .getAttribute("style"),
    beforeFit,
  );
  await capture("fit-overflow-restored");
  const legacy = structuredClone(seed);
  legacy.basic.website = "";
  legacy.basic.linkedin = "";
  legacy.summary =
    '<p><a href="https://github.com/example">GitHub</a></p><p>保留内容</p>';
  await fixture(legacy, { pageMargin: "5", font: "微软雅黑" });
  await capture("legacy-migration");
  await fixtureStorage({
    "resume-diy-state": "{",
    "resume-diy-preferences": "{",
    "resume-diy-version-store-v1": "{",
  });
  await capture("corrupt-storage");
  assert.equal((await page.locator(".resume-pages").innerText()).trim(), "");
  assert.deepEqual(errors, []);
  results[name].errors = errors;
  await context.close();
}

async function main() {
  const baseline = process.env.BASELINE_DIST;
  const servers = [],
    targets = [];
  if (baseline) {
    const server = await serve(baseline, 0);
    servers.push(server);
    targets.push(["before", server.address().port]);
  }
  const current = await serve("dist", 0);
  servers.push(current);
  targets.push(["after", current.address().port]);
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu"],
  });
  try {
    for (const [name, port] of targets) {
      console.log("Testing", name);
      await run(browser, name, port);
    }
    const comparisons = [];
    if (baseline)
      for (const label of Object.keys(results.before)) {
        if (label === "errors") continue;
        assert.deepEqual(
          results.after[label].papers,
          results.before[label].papers,
          label + " A4 DOM/layout changed",
        );
        assert.deepEqual(
          results.after[label].shellGeometry,
          results.before[label].shellGeometry,
          label + " protected shell geometry changed",
        );
        assert.deepEqual(
          results.after[label].controls,
          results.before[label].controls,
          label + " control values changed",
        );
        assert.equal(
          results.after[label].width,
          results.before[label].width,
          label + " splitter width changed",
        );
        const a = PNG.sync.read(
          fs.readFileSync(".artifacts/regression/before-" + label + ".png"),
        );
        const b = PNG.sync.read(
          fs.readFileSync(".artifacts/regression/after-" + label + ".png"),
        );
        assert.equal(a.width, b.width);
        assert.equal(a.height, b.height);
        let changedPixels = 0,
          significantPixels = 0,
          paperPixels = 0,
          maxChannelDelta = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          let delta = 0;
          for (let c = 0; c < 4; c++)
            delta = Math.max(delta, Math.abs(a.data[i + c] - b.data[i + c]));
          if (!delta) continue;
          changedPixels++;
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          const x = (i / 4) % a.width,
            y = Math.floor(i / 4 / a.width);
          const inPaper = results.before[label].papers.some(
            ({ rect: r }) =>
              x >= r.left && x < r.right && y >= r.top && y < r.bottom,
          );
          if (inPaper) {
            paperPixels++;
            if (delta > 32) significantPixels++;
          }
        }
        comparisons.push({
          label,
          changedPixels,
          significantPixels,
          paperPixels,
          maxChannelDelta,
        });
        // Left-shell theme changes are expected. A4 pixels and protected geometry remain strict;
        // a sparse, sub-0.1% edge-raster tolerance covers repeated baseline rasterization noise.
        const paperArea = results.before[label].papers.reduce(
          (total, paper) => total + paper.rect.width * paper.rect.height,
          0,
        );
        assert.ok(
          paperPixels <= Math.max(1, Math.floor(paperArea * 0.001)),
          label + " excessive A4 raster difference",
        );
        assert.equal(
          significantPixels,
          0,
          label + " significant A4 visual change",
        );
      }
    if (baseline) {
      const a = PNG.sync.read(
        fs.readFileSync(".artifacts/regression/before-export.png"),
      );
      const b = PNG.sync.read(
        fs.readFileSync(".artifacts/regression/after-export.png"),
      );
      assert.equal(a.width, b.width);
      assert.equal(a.height, b.height);
      assert.ok(a.data.equals(b.data), "Exported PNG changed");
    }
    const report = {
      status: "PASS",
      validation: {
        functionalRegression: "passed",
        baselineEquivalence: baseline ? "passed" : "not-run",
        animationBehavior:
          "not-run; capture disables animations only during screenshot and snapshot capture",
      },
      scenarios: Object.keys(results.after).filter((k) => k !== "errors"),
      comparisons,
      pageErrors: results.after.errors,
      exportChecks:
        "PDF and PNG downloaded; PNG pixels compared when baseline supplied",
    };
    fs.writeFileSync(
      ".artifacts/regression/results.json",
      JSON.stringify(report, null, 2),
    );
    fs.rmSync(".artifacts/regression/failure.json", { force: true });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    servers.forEach((s) => s.close());
  }
}
main().catch((error) => {
  console.error(error);
  fs.writeFileSync(
    ".artifacts/regression/failure.json",
    JSON.stringify({ error: String(error) }, null, 2),
  );
  process.exitCode = 1;
});
