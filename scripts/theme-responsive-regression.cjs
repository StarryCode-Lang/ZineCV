const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve("dist");
const output = path.resolve(".artifacts/theme-audit");
const server = http.createServer((req, res) => {
  const target = path.resolve(
    root,
    "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
  );
  const file =
    target.startsWith(root + path.sep) &&
    fs.existsSync(target) &&
    fs.statSync(target).isFile()
      ? target
      : path.join(root, "index.html");
  res.setHeader(
    "Content-Type",
    {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".otf": "font/otf",
      ".ttf": "font/ttf",
      ".woff2": "font/woff2",
    }[path.extname(file)] || "application/octet-stream",
  );
  res.end(fs.readFileSync(file));
});
async function checkSurface(page, label) {
  await page.locator(".floating-host").waitFor();
  await page.waitForTimeout(100);
  const data = await page.locator(".floating-host").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      vw: innerWidth,
      vh: innerHeight,
      bg: s.backgroundColor,
      text: s.color,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
  assert(
    data.x >= 7 &&
      data.y >= 7 &&
      data.x + data.width <= data.vw - 7 &&
      data.y + data.height <= data.vh - 7,
    `${label}: popup outside viewport ${JSON.stringify(data)}`,
  );
  assert(
    data.scrollWidth <= data.clientWidth + 1,
    `${label}: popup horizontal overflow`,
  );
  assert.equal(data.bg, "rgb(255, 253, 249)", `${label}: theme`);
  return data;
}
async function checkPane(page, label) {
  const issues = await page.locator(".editor-pane").evaluate((pane) => {
    const bounds = pane.getBoundingClientRect();
    const failures = [];
    const scroll = pane.querySelector(".editor-scroll");
    if (scroll.scrollWidth > scroll.clientWidth + 1)
      failures.push({
        kind: "editor horizontal overflow",
        width: scroll.clientWidth,
        scrollWidth: scroll.scrollWidth,
      });
    for (const row of pane.querySelectorAll(".section-heading,.entry-header")) {
      const left = row.firstElementChild?.getBoundingClientRect();
      const right = row.lastElementChild?.getBoundingClientRect();
      if (
        left &&
        right &&
        left !== right &&
        row.children.length > 1 &&
        left.right > right.left + 1
      )
        failures.push({ kind: "heading overlap", className: row.className });
    }
    for (const el of pane.querySelectorAll(
      "input:not([type=file]),select,textarea,.rich-editor,.module-heading,.section-heading,.branch-create-row,.version-view-tabs",
    )) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (!r.width || !r.height || s.visibility === "hidden") continue;
      if (r.left < bounds.left - 1 || r.right > bounds.right + 1)
        failures.push({
          tag: el.tagName,
          cls: el.className,
          label: el.getAttribute("aria-label"),
          x: r.x,
          w: r.width,
          paneWidth: bounds.width,
        });
    }
    return failures;
  });
  assert.deepEqual(issues, [], `${label}: controls outside pane`);
  const overlaps = await page.locator(".topbar").evaluate((el) => {
    const boxes = [
      ...el.querySelectorAll(
        ":scope > .brand-side,:scope > .toolbar,:scope > .top-actions",
      ),
    ]
      .map((x) => x.getBoundingClientRect())
      .filter((r) => r.width && r.height);
    return boxes.some((r, i) =>
      boxes
        .slice(i + 1)
        .some((b) => r.right > b.left + 1 && b.right > r.left + 1),
    )
      ? boxes.map((r) => ({ left: r.left, right: r.right, width: r.width }))
      : false;
  });
  assert.equal(overlaps, false, `${label}: header overlap`);
}
async function checkRailIndicator(page, label) {
  await page.waitForFunction(() => {
    const navigation = document.querySelector(".rail-navigation");
    const activeItem = navigation?.querySelector(".rail-item.active");
    const indicator = navigation?.querySelector(".rail-active-indicator");
    if (!navigation || !activeItem || !indicator) return false;
    const transform = getComputedStyle(indicator).transform;
    const y = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
    const expected =
      activeItem.getBoundingClientRect().top -
      navigation.getBoundingClientRect().top;
    return Math.abs(y - expected) <= 1;
  });
  const activeLabel = await page
    .locator(".rail-navigation .rail-item.active")
    .getAttribute("aria-label");
  assert.ok(activeLabel, `${label}: active rail item missing`);
  return activeLabel;
}
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch();
  const results = [];
  const errors = [];
  let activePage;
  let activeLabel = "startup";
  try {
    for (const [width, height, scale] of [
      [1448, 1086, 1],
      [1920, 1080, 1],
      [1050, 800, 1],
      [900, 700, 1],
      [800, 600, 1],
      [720, 500, 1],
      [600, 400, 1],
      [960, 640, 1.5],
      [1920, 1280, 0.75],
      [1152, 864, 1.25],
      [720, 540, 2],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: scale,
      });
      const page = await context.newPage();
      activePage = page;
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() =>
        localStorage.setItem(
          "resume-diy-preferences",
          JSON.stringify({ darkMode: "true" }),
        ),
      );
      await page.addInitScript(() => {
        localStorage.setItem(
          "resume-diy-state",
          JSON.stringify({
            basic: { name: "测试用户", ageMode: "age" },
            education: [
              {
                id: "education-test",
                title: "测试大学",
                role: "示例专业",
                department: "",
                city: "",
                start: "",
                end: "",
                html: "<p>虚构的回归测试内容。</p>",
              },
            ],
            skills: [],
            work: [],
            projects: [],
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
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const label = `${width}x${height}-dpr${scale}`;
      activeLabel = label;
      assert.equal(
        await checkRailIndicator(page, label + " editor"),
        "简历编辑",
      );
      assert.equal(await page.locator(".dark-mode").count(), 0);
      await checkPane(page, label);

      await page.locator(".basic-heading").click();
      await checkPane(page, label + " basic");
      await page.getByRole("button", { name: /^导出/ }).click();
      await checkSurface(page, label + " export-actions");
      assert.equal(
        await page.getByRole("menuitem", { name: /暗夜模式|浅色模式/ }).count(),
        0,
      );
      await page.keyboard.press("Escape");
      for (const name of ["宋体", "13px", "间距", "格式", "模块管理", "导出"]) {
        const trigger = page.getByRole("button", { name, exact: true });
        await trigger.click();
        const box = await checkSurface(page, label + " " + name);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".floating-host").count(), 0);
        results.push({ label, popup: name, ...box });
      }
      await page.getByRole("button", { name: "跳转到章节" }).click();
      await checkSurface(page, label + " chapters");
      await page.keyboard.press("Escape");
      if (width >= 798) {
        const splitter = page.getByRole("separator");
        await splitter.focus();
        await page.keyboard.press("Home");
        await checkPane(page, label + " min pane");
        await page.locator(".basic-heading").click();
        await page
          .getByRole("button", { name: "展开经历", exact: true })
          .first()
          .click();
        await checkPane(page, label + " entry");
        await page
          .getByRole("button", { name: "插入链接", exact: true })
          .first()
          .click();
        await checkSurface(page, label + " link");
        await page.keyboard.press("Escape");
        await splitter.dblclick();
      }
      await page.getByRole("button", { name: "版本管理", exact: true }).click();
      assert.equal(
        await checkRailIndicator(page, label + " versions"),
        "版本管理",
      );
      await checkPane(page, label + " versions");
      if (width >= 798) {
        await page.getByRole("separator").focus();
        await page.keyboard.press("Home");
        await checkPane(page, label + " versions min");
      }

      if (width >= 798) {
        await page
          .getByLabel("新分支名称")
          .fill("面向研发岗位的长名称分支布局检查");
        await page
          .getByRole("button", { name: "新建分支", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(
                '[data-version-section="branch"] .version-section-title > span',
              )
              ?.textContent?.trim() === "2 个分支",
        );
        await page.locator(".branch-tree-scroll").waitFor();
        await page.getByRole("button", { name: "放大分支可视化" }).click();
        await page.getByRole("button", { name: "适应分支可视化" }).click();
        await checkPane(page, label + " tree");
        await page.getByRole("separator").focus();
        await page.keyboard.press("End");
        await checkPane(page, label + " versions max");
        await page.getByRole("separator").dblclick();
      }
      await page.getByRole("button", { name: "简历编辑", exact: true }).click();
      assert.equal(
        await checkRailIndicator(page, label + " editor return"),
        "简历编辑",
      );
      await page.getByRole("separator").dblclick();
      if (width === 1448) {
        await page.getByRole("button", { name: "宋体", exact: true }).click();
        await page.setViewportSize({ width: 900, height: 500 });
        await checkSurface(page, "open popup after resize");
        await page.keyboard.press("Escape");
        assert.equal(
          await page
            .getByRole("button", { name: "宋体", exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await page.setViewportSize({ width, height });
        await page.getByRole("button", { name: "宋体", exact: true }).click();
        await page.locator(".editorial-kicker").click();
        assert.equal(await page.locator(".floating-host").count(), 0);
        const divider = await page.getByRole("separator").boundingBox();
        await page.mouse.move(divider.x + divider.width / 2, 200);
        await page.mouse.down();
        await page.mouse.move(divider.x + 180, 200, { steps: 10 });
        await page.mouse.up();
        await checkPane(page, "actual splitter drag");
        await page.getByRole("separator").dblclick();
      }
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector(".app-shell").scrollLeft = 0;
      });
      await context.close();
      activePage = undefined;
    }
    assert.deepEqual(errors, []);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "responsive-results.json"),
      JSON.stringify({ status: "PASS", cases: results, errors }, null, 2),
    );
    console.log(
      `PASS: ${results.length} anchored popovers, 11 viewports/scales, editor and version panes; no page errors`,
    );
  } catch (error) {
    fs.mkdirSync(output, { recursive: true });
    if (activePage && !activePage.isClosed()) {
      try {
        await activePage.screenshot({
          path: path.join(output, "responsive-failure.png"),
        });
      } catch (screenshotError) {
        console.error("Failure screenshot unavailable:", screenshotError);
      }
    }
    fs.writeFileSync(
      path.join(output, "responsive-failure.json"),
      JSON.stringify(
        { label: activeLabel, error: String(error), errors },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
