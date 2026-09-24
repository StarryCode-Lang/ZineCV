import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const dist = path.resolve("dist");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
const server = http.createServer((request, response) => {
  let file = path.resolve(
    dist,
    `.${new URL(request.url, "http://localhost").pathname}`,
  );
  if (
    !file.startsWith(`${dist}${path.sep}`) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  )
    file = path.join(dist, "index.html");
  response.setHeader(
    "Content-Type",
    mime[path.extname(file)] ?? "application/octet-stream",
  );
  response.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const errors = [];
try {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector("[data-editor-module]");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const order = () =>
    page
      .locator("[data-editor-module]")
      .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  const initial = await order();
  assert.ok(initial.length >= 3, "editor modules did not render");

  const firstCollapse = page
    .locator(`[data-editor-module="${initial[0]}"]`)
    .getByRole("button", { name: /展开|收起/ });
  const secondCollapse = page
    .locator(`[data-editor-module="${initial[1]}"]`)
    .getByRole("button", { name: /展开|收起/ });
  assert.equal(await firstCollapse.getAttribute("aria-expanded"), "true");
  assert.equal(await secondCollapse.getAttribute("aria-expanded"), "true");
  assert.equal(
    await page
      .locator('button[aria-label="展开基本信息"]')
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page
      .locator('button[aria-label="展开自我评价"]')
      .getAttribute("aria-expanded"),
    "false",
  );
  await firstCollapse.click();
  await page.waitForFunction((key) => {
    const button = document
      .querySelector(`[data-editor-module="${key}"]`)
      ?.querySelector("button[aria-expanded]");
    return button?.getAttribute("aria-expanded") === "false";
  }, initial[0]);
  assert.equal(await secondCollapse.getAttribute("aria-expanded"), "true");
  await page.waitForFunction(
    (key) =>
      !document
        .querySelector(`[data-editor-module="${key}"]`)
        ?.querySelector(".module-content"),
    initial[0],
  );
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(
        "[data-editor-module], [data-editor-module] *",
      ),
    ].every((element) =>
      element
        .getAnimations()
        .every((animation) => animation.playState !== "running"),
    ),
  );

  const before = await order();
  await page.evaluate(() => {
    const frames = [];
    const longTasks = [];
    let active = true;
    let previous = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ entryTypes: ["longtask"] });
    const sample = (now) => {
      if (previous) frames.push(now - previous);
      previous = now;
      if (active) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__dragPerformance = {
      frames,
      longTasks,
      stop: () => {
        active = false;
        observer.disconnect();
      },
    };
  });
  const source = before[0];
  const firstHeading = page
    .locator(`[data-editor-module="${source}"]`)
    .locator(".section-heading");
  const sourceBox = await firstHeading.boundingBox();
  const target = before[1];
  const targetCard = page.locator(`[data-editor-module="${target}"]`);
  const targetBox = await targetCard.boundingBox();
  assert.ok(sourceBox && targetBox, "drag source or target was not measurable");
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height * 0.9,
    { steps: 12 },
  );
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForFunction(
    ({ source, target }) => {
      const keys = [...document.querySelectorAll("[data-editor-module]")].map(
        (card) => card.dataset.editorModule,
      );
      return keys.indexOf(source) > keys.indexOf(target);
    },
    { source, target },
    { timeout: 5000 },
  );

  const thirdTarget = before[2];
  const thirdCard = page.locator(`[data-editor-module="${thirdTarget}"]`);
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll(
        "[data-editor-module], [data-editor-module] *",
      ),
    ].every((element) =>
      element
        .getAnimations()
        .every((animation) => animation.playState !== "running"),
    ),
  );
  await thirdCard.scrollIntoViewIfNeeded();
  const thirdBox = await thirdCard.boundingBox();
  const sourceBoxAfterFirstDrop = await firstHeading.boundingBox();
  assert.ok(
    thirdBox && sourceBoxAfterFirstDrop,
    "second drag source or target was not measurable",
  );
  await page.mouse.move(
    sourceBoxAfterFirstDrop.x + sourceBoxAfterFirstDrop.width / 2,
    sourceBoxAfterFirstDrop.y + sourceBoxAfterFirstDrop.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    thirdBox.x + thirdBox.width / 2,
    thirdBox.y + thirdBox.height * 0.9,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    ({ source, thirdTarget }) => {
      const keys = [...document.querySelectorAll("[data-editor-module]")].map(
        (card) => card.dataset.editorModule,
      );
      return keys.indexOf(source) > keys.indexOf(thirdTarget);
    },
    { source, thirdTarget },
  );
  await page.waitForFunction(
    () => !document.querySelector(".module-drag-layer"),
  );
  const performance = await page.evaluate(() => {
    const sample = window.__dragPerformance;
    sample.stop();
    const frames = sample.frames.slice().sort((a, b) => a - b);
    return {
      frameCount: frames.length,
      p95FrameMs: frames[Math.ceil(frames.length * 0.95) - 1] ?? 0,
      longTasksOver50Ms: sample.longTasks.filter((duration) => duration > 50)
        .length,
    };
  });
  assert.ok(
    performance.frameCount >= 30 && performance.p95FrameMs <= 20,
    `drag animation missed the p95 frame target: ${JSON.stringify(performance)}`,
  );
  assert.equal(
    performance.longTasksOver50Ms,
    0,
    `drag animation introduced a long task: ${JSON.stringify(performance)}`,
  );

  const after = await order();
  const expected = [before[1], before[2], source, ...before.slice(3)];
  assert.deepEqual(
    after,
    expected,
    "pointer drag committed an unexpected order",
  );
  await page.reload();
  await page.waitForSelector("[data-editor-module]");
  assert.deepEqual(
    await order(),
    expected,
    "the final drop order did not survive reload in isolated browser storage",
  );
  const firstModule = page.locator(`[data-editor-module="${initial[0]}"]`);
  await firstModule.locator(".add-entry").click();
  await firstModule.locator(".add-entry").click();
  const firstModuleEntries = firstModule.locator(".entry-card");
  assert.equal(await firstModuleEntries.count(), 2);
  assert.equal(
    await firstModuleEntries
      .nth(0)
      .locator(".entry-header")
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await firstModuleEntries
      .nth(1)
      .locator(".entry-header")
      .getAttribute("aria-expanded"),
    "true",
  );
  await firstModuleEntries.nth(0).locator(".entry-header").click();
  assert.equal(
    await firstModuleEntries
      .nth(0)
      .locator(".entry-header")
      .getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(
    await firstModuleEntries
      .nth(1)
      .locator(".entry-header")
      .getAttribute("aria-expanded"),
    "false",
  );
  const secondModule = page.locator(`[data-editor-module="${initial[1]}"]`);
  await secondModule.locator(".add-entry").click();
  assert.equal(
    await firstModuleEntries
      .nth(0)
      .locator(".entry-header")
      .getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(
    await secondModule
      .locator(".entry-card .entry-header")
      .getAttribute("aria-expanded"),
    "true",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pass: true,
      checks: [
        "basic information and self evaluation collapsed, other modules expanded by default",
        "collapsing one content module preserves another module's state",
        "one entry opens per module while other modules retain their open entry",
        "real pointer drag committed across two target drops",
        "committed module order survives reload",
      ],
      performance,
      errors,
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
