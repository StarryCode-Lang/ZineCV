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

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  const checks = [];
  const errors = [];
  let activePage;
  try {
    const context = await browser.newContext({
      viewport: { width: 1448, height: 1086 },
    });
    await context.addInitScript(() => {
      const modules = ["education", "skills", "work", "projects", "orgs"];
      localStorage.setItem(
        "resume-diy-state",
        JSON.stringify({
          basic: { name: "测试用户", ageMode: "age" },
          summary: "<p>虚构的模块测试内容。</p>",
          ...Object.fromEntries(
            modules.map((module) => [
              module,
              [
                {
                  id: `test-${module}`,
                  title: `测试${module}`,
                  role: "示例",
                  department: "",
                  city: "",
                  start: "",
                  end: "",
                  html: "<p>虚构的回归测试内容。</p>",
                },
              ],
            ]),
          ),
        }),
      );
    });
    const page = await context.newPage();
    activePage = page;
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => document.fonts.ready);
    for (const paneWidth of [550, 360, 700]) {
      await page.getByRole("separator").focus();
      await page.keyboard.press("Home");
      for (let n = 360; n < paneWidth; n += 20)
        await page.keyboard.press("ArrowRight");
      for (const module of [
        "education",
        "skills",
        "work",
        "projects",
        "orgs",
      ]) {
        const card = page.locator(`[data-editor-module="${module}"]`);
        const entry = card.locator(".entry-card").first();
        if (
          await entry
            .getByRole("button", { name: "展开经历", exact: true })
            .count()
        )
          await entry
            .getByRole("button", { name: "展开经历", exact: true })
            .click();
        await entry.scrollIntoViewIfNeeded();
        const metrics = await entry.evaluate((el) => {
          const actions = [...el.querySelectorAll(".entry-actions button")].map(
            (x) => {
              const r = x.getBoundingClientRect();
              const s = getComputedStyle(x);
              return {
                x: r.x,
                y: r.y,
                w: r.width,
                h: r.height,
                radius: s.borderRadius,
              };
            },
          );
          const heading = el.querySelector(".entry-header");
          const text = heading.firstElementChild.getBoundingClientRect();
          const area = heading.lastElementChild.getBoundingClientRect();
          return {
            actions,
            overlap: text.right > area.left + 1,
            formBorder: getComputedStyle(el.querySelector(".entry-form"))
              .borderTopWidth,
          };
        });
        assert.equal(metrics.overlap, false);
        assert.equal(metrics.formBorder, "0px");
        for (const a of metrics.actions) {
          assert.equal(a.w, 28);
          assert.equal(a.h, 28);
          assert.equal(a.radius, "5px");
        }
        assert(metrics.actions[0].x + 28 <= metrics.actions[1].x - 3);
        await entry
          .getByRole("button", { name: "删除经历", exact: true })
          .click();
        await page.getByRole("alertdialog").waitFor();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await entry
          .getByRole("button", { name: "插入链接", exact: true })
          .click();
        await page.getByRole("dialog", { name: "插入或编辑链接" }).waitFor();
        await page.keyboard.press("Escape");
        await entry
          .getByRole("button", { name: "收起经历", exact: true })
          .click();
        checks.push(
          `${module} at pane ${paneWidth}: actions, cancellation, link, collapsed summary`,
        );
      }
      const summary = page.locator('[data-editor-module="summary"]');
      await summary
        .getByRole("button", { name: "展开自我评价", exact: true })
        .first()
        .click();
      await summary
        .getByRole("button", { name: "收起自我评价", exact: true })
        .click();
    }
    await page.getByRole("separator").dblclick();
    for (const mode of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion: mode });
      await page.getByRole("button", { name: "格式", exact: true }).click();
      const animation = await page.locator(".floating-host").evaluate((el) => ({
        name: getComputedStyle(el).getPropertyValue("--motion-enter").trim(),
        css: getComputedStyle(el).animationName,
        active: el.getAnimations().length,
      }));
      assert.equal(
        animation.name,
        mode === "reduce" ? "none" : "surface-arrive",
      );
      assert.equal(animation.css, "none");
      if (mode === "reduce") assert.equal(animation.active, 0);
      await page.waitForTimeout(200);
      assert.equal(
        await page
          .locator(".floating-host")
          .evaluate((el) => getComputedStyle(el).opacity),
        "1",
      );
      await page.keyboard.press("Escape");
      checks.push(`toolbar animation ${mode}`);
    }
    assert.deepEqual(errors, []);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(
      path.join(output, "module-results.json"),
      JSON.stringify({ status: "PASS", checks, errors }, null, 2),
    );
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
    await context.close();
    activePage = undefined;
  } catch (error) {
    fs.mkdirSync(output, { recursive: true });
    if (activePage && !activePage.isClosed()) {
      try {
        await activePage.screenshot({
          path: path.join(output, "module-failure.png"),
        });
      } catch (screenshotError) {
        console.error("Failure screenshot unavailable:", screenshotError);
      }
    }
    fs.writeFileSync(
      path.join(output, "module-failure.json"),
      JSON.stringify({ error: String(error), checks, errors }, null, 2),
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
