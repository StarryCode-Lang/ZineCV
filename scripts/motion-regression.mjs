import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const dist = path.resolve("dist");
const output = path.resolve(".artifacts/motion-migration");
fs.mkdirSync(output, { recursive: true });
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
const server = http.createServer((req, res) => {
  let file = path.resolve(
    dist,
    `.${new URL(req.url, "http://localhost").pathname}`,
  );
  if (
    !file.startsWith(`${dist}${path.sep}`) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  )
    file = path.join(dist, "index.html");
  res.setHeader(
    "Content-Type",
    mime[path.extname(file)] ?? "application/octet-stream",
  );
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const url = `http://127.0.0.1:${server.address().port}`;
const report = { checks: [], errors: [] };
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector(".paper:not(.layout-measure)");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  assert.ok((await page.title()).length);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  const geometry = await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .boundingBox();
  const format = page.getByRole("button", { name: "格式", exact: true });
  await page.mouse.move(3, 3);
  const rest = await format.evaluate((el) => ({
    color: getComputedStyle(el).color,
    shadow: getComputedStyle(el).boxShadow,
    transform: getComputedStyle(el).transform,
  }));
  await format.hover();
  await page.waitForTimeout(220);
  assert.equal(await format.getAttribute("data-motion-hover"), "");
  const hovered = await format.evaluate((el) => getComputedStyle(el).boxShadow);
  assert.notEqual(hovered, rest.shadow);
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(3, 3);
    await page.waitForTimeout(25);
    await format.hover({ force: true });
    await page.waitForTimeout(25);
  }
  await page.mouse.move(3, 3);
  await page.waitForTimeout(300);
  const restored = await format.evaluate((el) => ({
    color: getComputedStyle(el).color,
    shadow: getComputedStyle(el).boxShadow,
    transform: getComputedStyle(el).transform,
  }));
  assert.deepEqual(
    restored,
    rest,
    "rapid hover reversal must restore CSS endpoint",
  );
  report.checks.push(
    "rapid hover reversal restores color, shadow and transform",
  );
  await format.hover();
  await page.mouse.down();
  await page.waitForTimeout(200);
  assert.notEqual(
    await format.evaluate((el) => getComputedStyle(el).transform),
    "none",
  );
  await page.mouse.up();
  await page.waitForSelector(".floating-host");
  await page.waitForTimeout(250);
  assert.equal(
    await page
      .locator(".floating-host")
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  await page.screenshot({ path: path.join(output, "desktop-menu.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".floating-host").count(), 0);
  assert.equal(
    await format.evaluate((el) => el === document.activeElement),
    true,
  );
  report.checks.push("press, portal mount, Escape and focus restoration");
  await format.focus();
  await page.keyboard.down("Space");
  await page.waitForTimeout(180);
  assert.equal(await format.getAttribute("data-motion-press"), "");
  await page.keyboard.up("Space");
  await page.waitForSelector(".floating-host");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await format.getAttribute("data-motion-press"), null);
  report.checks.push("Space press feedback and a single native activation");
  assert.deepEqual(
    await page.locator(".paper:not(.layout-measure)").first().boundingBox(),
    geometry,
  );
  assert.equal(
    await page
      .locator(".paper [data-motion-hover], .paper [data-motion-press]")
      .count(),
    0,
  );
  report.checks.push("document geometry and interaction exclusion");
  await page.getByRole("button", { name: "模板", exact: true }).click();
  await page.waitForSelector(".template-workspace");
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, "desktop-templates.png") });
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await page.waitForSelector(".editor-scroll");
  await page.waitForTimeout(400);
  // Exercise the same dynamically mounted spinner used during async imports.
  await page.evaluate(() => {
    const spinner = document.createElement("span");
    spinner.className = "spin";
    spinner.id = "motion-test-spinner";
    document.querySelector(".topbar").append(spinner);
  });
  await page.waitForTimeout(150);
  const spinner = page.locator("#motion-test-spinner");
  const spinA = await spinner.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(130);
  assert.notEqual(
    await spinner.evaluate((el) => getComputedStyle(el).transform),
    spinA,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(100);
  assert.equal(await spinner.evaluate((el) => el.getAnimations().length), 0);
  assert.equal(await spinner.evaluate((el) => el.style.transform), "");
  await format.click();
  assert.equal(
    await page
      .locator(".floating-host")
      .evaluate((el) => el.getAnimations().length),
    0,
  );
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(100);
  assert.ok(await spinner.evaluate((el) => el.getAnimations().length));
  await spinner.evaluate((el) => el.remove());
  report.checks.push(
    "dynamic spinner, live reduced-motion cancellation and restart",
  );
  await page.mouse.move(3, 3);
  await page.waitForTimeout(350);
  assert.equal(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) => a instanceof CSSAnimation || a instanceof CSSTransition,
          ).length,
    ),
    0,
  );
  report.checks.push("no legacy CSS animation or transition active in editor");
  await page.setViewportSize({ width: 1050, height: 800 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(output, "compact-editor.png") });
  await context.close();
  const touch = await browser.newContext({
    viewport: { width: 1050, height: 800 },
    hasTouch: true,
  });
  const touchPage = await touch.newPage();
  touchPage.on("pageerror", (error) => report.errors.push(error.message));
  await touchPage.goto(url);
  await touchPage.waitForSelector(".paper:not(.layout-measure)");
  await touchPage.waitForTimeout(600);
  await touchPage.getByRole("button", { name: "格式", exact: true }).tap();
  await touchPage.waitForTimeout(250);
  assert.equal(await touchPage.locator("[data-motion-hover]").count(), 0);
  report.checks.push("touch tap does not leave emulated hover behind");
  await touch.close();
  assert.deepEqual(report.errors, []);
  fs.writeFileSync(
    path.join(output, "motion-report.json"),
    JSON.stringify({ status: "PASS", ...report }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
