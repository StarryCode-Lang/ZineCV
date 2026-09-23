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
  await page.waitForTimeout(500);
  const order = () =>
    page
      .locator("[data-editor-module]")
      .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  const initial = await order();
  const source = initial[0];
  const heading = page.locator(
    `[data-editor-module="${source}"] .section-heading`,
  );
  const data = await page.evaluateHandle(() => new DataTransfer());
  const rects = await page
    .locator("[data-editor-module]")
    .evaluateAll((cards) =>
      Object.fromEntries(
        cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return [
            card.dataset.editorModule,
            { top: rect.top, height: rect.height },
          ];
        }),
      ),
    );

  await heading.dispatchEvent("dragstart", { dataTransfer: data });
  await page.evaluate(
    ({ targetKey, rect }) => {
      const target = document.querySelector(
        `[data-editor-module="${targetKey}"]`,
      );
      for (const fraction of [0.9, 0.5])
        target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: new DataTransfer(),
            clientY: rect.top + rect.height * fraction,
          }),
        );
    },
    { targetKey: initial[1], rect: rects[initial[1]] },
  );
  await page.waitForTimeout(250);
  assert.deepEqual(
    await order(),
    initial,
    "retreat before the next frame must cancel a queued swap",
  );
  await heading.dispatchEvent("dragend", { dataTransfer: data });

  await heading.dispatchEvent("dragstart", { dataTransfer: data });
  await page
    .locator(`[data-editor-module="${initial[1]}"]`)
    .dispatchEvent("dragover", {
      dataTransfer: data,
      clientY: rects[initial[1]].top + rects[initial[1]].height * 0.9,
    });
  await page.waitForTimeout(250);
  const intermediate = [initial[1], source, ...initial.slice(2)];
  assert.deepEqual(
    await order(),
    intermediate,
    "the first drag hover must swap modules",
  );
  await page.evaluate(
    ({ targetKey, rect }) => {
      const target = document.querySelector(
        `[data-editor-module="${targetKey}"]`,
      );
      const options = {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
        clientY: rect.top + rect.height * 0.9,
      };
      target.dispatchEvent(new DragEvent("dragover", options));
      target.dispatchEvent(new DragEvent("drop", options));
    },
    { targetKey: initial[2], rect: rects[initial[2]] },
  );
  await heading.dispatchEvent("dragend", { dataTransfer: data });
  await page.waitForTimeout(300);
  const expected = [initial[1], initial[2], source, ...initial.slice(3)];
  assert.deepEqual(
    await order(),
    expected,
    "drop must commit the latest queued swap before cancelling its frame",
  );
  await page.reload();
  await page.waitForSelector("[data-editor-module]");
  assert.deepEqual(
    await order(),
    expected,
    "the final drop order must survive reload in isolated browser storage",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pass: true,
      checks: [
        "queued swap reversal",
        "immediate drop after second target",
        "persisted final order",
      ],
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
