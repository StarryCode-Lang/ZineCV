const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve("dist");
const server = http.createServer((request, response) => {
  const requested = path.resolve(
    root,
    `.${new URL(request.url, "http://localhost").pathname}`,
  );
  const file =
    requested.startsWith(`${root}${path.sep}`) &&
    fs.existsSync(requested) &&
    fs.statSync(requested).isFile()
      ? requested
      : path.join(root, "index.html");
  response.setHeader(
    "Content-Type",
    {
      ".css": "text/css",
      ".html": "text/html",
      ".js": "text/javascript",
      ".otf": "font/otf",
      ".ttf": "font/ttf",
      ".woff2": "font/woff2",
    }[path.extname(file)] || "application/octet-stream",
  );
  response.end(fs.readFileSync(file));
});

async function assertViewportLocked(page, scrollSelector, label) {
  const scrollArea = page.locator(scrollSelector);
  await scrollArea.waitFor();
  await scrollArea.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const box = await scrollArea.boundingBox();
  assert.ok(box, `${label} scroll area is missing`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel(0, 1200);
  }
  await page.waitForTimeout(80);
  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".app-shell")?.getBoundingClientRect();
    const workspace = document
      .querySelector(".workspace")
      ?.getBoundingClientRect();
    return {
      windowScrollY: window.scrollY,
      rootScrollTop: document.documentElement.scrollTop,
      rootScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      appTop: app?.top,
      appBottom: app?.bottom,
      workspaceTop: workspace?.top,
      workspaceBottom: workspace?.bottom,
    };
  });
  assert.equal(metrics.windowScrollY, 0, `${label} moved window scroll`);
  assert.equal(metrics.rootScrollTop, 0, `${label} moved root scroll`);
  assert.equal(metrics.appTop, 0);
  assert.equal(metrics.appBottom, metrics.viewportHeight);
  assert.equal(metrics.workspaceTop, 0);
  assert.equal(metrics.workspaceBottom, metrics.viewportHeight);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const checks = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".smart-fill-toggle:not(.active)").waitFor({
      timeout: 30000,
    });

    await assertViewportLocked(page, ".editor-scroll", "editor");
    checks.push("editor scroll stays inside the application viewport");

    await page.getByRole("button", { name: "版本管理", exact: true }).click();
    await assertViewportLocked(page, ".version-scroll", "versions");
    fs.mkdirSync(path.resolve(".artifacts", "shell-scroll"), {
      recursive: true,
    });
    await page.screenshot({
      path: path.resolve(
        ".artifacts",
        "shell-scroll",
        "versions-bottom-locked.png",
      ),
    });
    checks.push("version scroll cannot expose the outer blue background");

    await page.getByRole("button", { name: "模板", exact: true }).click();
    await assertViewportLocked(page, ".template-workspace", "templates");
    checks.push("template library uses the same scroll boundary");

    await page.setViewportSize({ width: 1050, height: 700 });
    await assertViewportLocked(
      page,
      ".template-workspace",
      "resized templates",
    );
    checks.push("viewport resizing preserves the shell boundary");

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
