const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

// An isolated static server cannot write to the user's project version store.
const root = path.resolve("dist");
const server = http.createServer((req, res) => {
  const target = path.resolve(
    root,
    "." + new URL(req.url, "http://localhost").pathname,
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
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".woff2": "font/woff2",
    }[path.extname(file)] || "application/octet-stream",
  );
  res.end(fs.readFileSync(file));
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const checks = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1050, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      if (localStorage.getItem("resume-diy-state")) return;
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
    await context.addInitScript(() => {
      const fixture = sessionStorage.getItem("__preview_controls_fixture__");
      if (!fixture) return;
      sessionStorage.removeItem("__preview_controls_fixture__");
      localStorage.setItem("resume-diy-state", fixture);
      localStorage.setItem("resume-diy-preferences", "{}");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => document.fonts.ready);
    const input = page.getByRole("spinbutton", { name: "预览缩放百分比" });
    for (const width of [1050, 1440, 1776, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const layout = await page.evaluate(() => {
        const pane = document.querySelector(".preview-pane");
        const paper = document.querySelector(".paper-frame");
        const decoration = document.querySelector(".preview-decoration-resume");
        const styles = getComputedStyle(pane);
        return {
          paneWidth: pane.clientWidth,
          paperWidth: paper.getBoundingClientRect().width,
          paperRight: paper.getBoundingClientRect().right,
          decorationLeft: decoration.getBoundingClientRect().left,
          decorationVisible:
            getComputedStyle(
              document.querySelector(".preview-decoration-layer"),
            ).display !== "none",
          horizontalPadding:
            parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight),
          percent: Number(
            document.querySelector(".preview-zoom-value input").value,
          ),
        };
      });
      const usableWidth = layout.paneWidth - layout.horizontalPadding;
      assert.ok(
        layout.paperWidth <= usableWidth + 1 &&
          layout.paperWidth >= usableWidth * 0.75,
        `automatic paper fit should use the preview width at ${width}px: ${JSON.stringify(layout)}`,
      );
      if (layout.decorationVisible)
        assert.ok(
          layout.paperRight <= layout.decorationLeft - 6,
          `default paper should leave the RESUME lettering visible at ${width}px: ${JSON.stringify(layout)}`,
        );
      assert.ok(
        Math.abs(layout.percent - (layout.paperWidth / 793.688) * 100) <= 1,
        `displayed zoom should match the paper at ${width}px`,
      );
    }
    checks.push(
      "automatic A4 preview uses available width without covering visible background lettering",
    );
    for (const width of [1050, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const target of [200, 20, 70]) {
        await input.fill(String(target));
        await input.press("Enter");
        await page.waitForTimeout(150);
        const actual = await page
          .locator(".resume-pages")
          .evaluate(
            (el) => Number(el.style.getPropertyValue("--preview-scale")) * 100,
          );
        const displayed = Number(await input.inputValue());
        const label = `zoom ${width}px: target=${target}, actual=${actual.toFixed(2)}, displayed=${displayed}`;
        (Math.abs(actual - target) < 0.6 && Math.abs(displayed - actual) < 0.6
          ? checks
          : failures
        ).push(label);
      }
    }
    for (const [target, button] of [
      [200, "放大预览"],
      [20, "缩小预览"],
    ]) {
      await input.fill(String(target));
      await input.press("Enter");
      assert.equal(
        await page
          .getByRole("button", { name: button, exact: true })
          .isDisabled(),
        true,
      );
    }
    await input.fill("");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "20");
    await page.getByRole("button", { name: "放大预览", exact: true }).click();
    assert.equal(await input.inputValue(), "30");
    checks.push(
      "zoom limits, empty input recovery and ten-percent button step",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    const originalPaper = await page
      .locator(".resume-pages .paper")
      .first()
      .evaluate((el) => ({
        html: el.innerHTML,
        width: el.offsetWidth,
        height: el.offsetHeight,
      }));
    const splitter = page.getByRole("separator", {
      name: "调整编辑器与预览宽度",
    });
    const rect = await splitter.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 200);
    await page.mouse.down();
    const samples = [];
    for (const delta of [
      ...Array.from({ length: 41 }, (_, i) => i * 4),
      ...Array.from({ length: 81 }, (_, i) => 160 - i * 4),
    ]) {
      await page.mouse.move(rect.x + rect.width / 2 + delta, rect.y + 200);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      samples.push(
        await page.evaluate(() => ({
          editor: document.querySelector(".editor-pane").getBoundingClientRect()
            .width,
          paper: document.querySelector(".paper-frame").getBoundingClientRect()
            .width,
          backgroundRightGap:
            document.querySelector(".preview-pane").getBoundingClientRect()
              .right -
            document
              .querySelector(".preview-decoration-manifesto")
              .getBoundingClientRect().right,
          collapsedCards: [
            ...document.querySelectorAll(".entry-card:not(.expanded)"),
          ].map((card) => {
            const cardRect = card.getBoundingClientRect();
            const heading = card.querySelector(".entry-heading-main");
            const headingRect = heading?.getBoundingClientRect();
            return {
              height: cardRect.height,
              overflow: card.scrollWidth - card.clientWidth,
              headingInside:
                !headingRect ||
                (headingRect.left >= cardRect.left - 1 &&
                  headingRect.right <= cardRect.right + 1),
            };
          }),
          verbosePreviews: document.querySelectorAll(
            ".entry-content-summary, .skill-preview-tag",
          ).length,
        })),
      );
    }
    await page.mouse.up();
    for (let i = 1; i < samples.length; i++) {
      assert.ok(
        Math.abs(samples[i].paper - samples[i - 1].paper) <= 5,
        "continuous drag must not jump",
      );
      assert.ok(
        (samples[i].editor - samples[i - 1].editor) *
          (samples[i].paper - samples[i - 1].paper) <=
          0.1,
        "paper must track editor width inversely",
      );
      assert.ok(
        Math.abs(
          samples[i].backgroundRightGap - samples[0].backgroundRightGap,
        ) <= 1,
        "background lettering must stay anchored to the preview board",
      );
      assert.equal(samples[i].verbosePreviews, 0);
      assert.ok(samples[i].collapsedCards.length > 0);
      assert.ok(
        samples[i].collapsedCards.every(
          (card) =>
            card.height >= 43 &&
            card.height <= 45 &&
            card.overflow <= 1 &&
            card.headingInside,
        ),
        `collapsed editor cards must stay aligned and clipped during drag: ${JSON.stringify(samples[i])}`,
      );
    }
    assert.deepEqual(
      await page
        .locator(".resume-pages .paper")
        .first()
        .evaluate((el) => ({
          html: el.innerHTML,
          width: el.offsetWidth,
          height: el.offsetHeight,
        })),
      originalPaper,
    );
    await splitter.dblclick();
    await page.getByRole("button", { name: "全屏预览", exact: true }).click();
    await page.waitForFunction(() =>
      document.fullscreenElement?.classList.contains("preview-pane"),
    );
    await page
      .getByRole("button", { name: "退出全屏预览", exact: true })
      .click();
    await page.waitForFunction(() => !document.fullscreenElement);
    checks.push(
      `${samples.length} continuous drag samples keep collapsed cards aligned, preserve A4 content, and support fullscreen`,
    );
    fs.mkdirSync(path.resolve(".artifacts/review"), { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: ".artifacts/review/current-workspace.png" });
    const seed = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("resume-diy-state")),
    );
    seed.projects = Array.from({ length: 18 }, (_, i) => ({
      id: `controls-${i}`,
      title: `分页测试 ${i}`,
      role: "",
      department: "",
      city: "",
      start: "",
      end: "",
      html: `<p>${"虚构的分页测试内容。".repeat(35)}</p>`,
    }));
    await page.evaluate((state) => {
      sessionStorage.setItem(
        "__preview_controls_fixture__",
        JSON.stringify(state),
      );
    }, seed);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await page.waitForFunction(
      () => document.querySelectorAll(".paper-frame").length > 1,
      undefined,
      { timeout: 30000 },
    );
    const total = await page.locator(".paper-frame").count();
    await page
      .locator(".preview-pane")
      .evaluate((el) =>
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" }),
      );
    await page.waitForTimeout(200);
    const current = Number(
      await page.locator(".preview-pagination strong").innerText(),
    );
    (current === total ? checks : failures).push(
      `manual scroll: current=${current}, total=${total}`,
    );
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(
      Number(await page.locator(".preview-pagination strong").innerText()),
      total - 1,
    );
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    checks.push(
      "previous page follows visible page without moving the outer workspace",
    );
    assert.deepEqual(errors, [], "No browser errors");
    console.log(
      JSON.stringify(
        { status: failures.length ? "FAIL" : "PASS", checks, failures },
        null,
        2,
      ),
    );
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
