import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { jsPDF } from "jspdf";
import JSZip from "jszip";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(projectRoot, "dist");
const artifactRoot = path.join(projectRoot, ".artifacts", "major-version");
fs.mkdirSync(artifactRoot, { recursive: true });

function serve() {
  const types = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
  };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url || "/", "http://127.0.0.1").pathname,
    );
    let file = path.resolve(distRoot, `.${pathname}`);
    if (
      !file.startsWith(`${distRoot}${path.sep}`) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    )
      file = path.join(distRoot, "index.html");
    response.setHeader(
      "Content-Type",
      types[path.extname(file).toLowerCase()] || "application/octet-stream",
    );
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

function fixturePng() {
  const image = new PNG({ width: 240, height: 340 });
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const side = x < 64;
      const accent = !side && y > 42 && y < 48;
      image.data[offset] = side ? 35 : accent ? 224 : 250;
      image.data[offset + 1] = side ? 39 : accent ? 80 : 248;
      image.data[offset + 2] = side ? 44 : accent ? 43 : 244;
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

function fixturePdf() {
  const document = new jsPDF({ unit: "pt", format: "a4" });
  document.setFontSize(22);
  document.text("Imported PDF Resume", 52, 68);
  document.setDrawColor(224, 96, 32);
  document.line(52, 84, 540, 84);
  document.setFontSize(12);
  document.text("Education", 52, 108);
  document.text("Example University", 52, 128);
  document.text("Skills", 52, 154);
  document.text("TypeScript / React / PDF.js", 52, 174);
  document.text("Experience", 52, 204);
  document.text("Local browser template recognition", 52, 224);
  return Buffer.from(document.output("arraybuffer"));
}

async function fixtureDocx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`,
  );
  zip.folder("_rels").file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`,
  );
  zip.folder("word").file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:rPr><w:b/><w:sz w:val="34"/></w:rPr><w:t>Imported Word Resume</w:t></w:r></w:p>
        <w:p><w:r><w:t>Experience and project summary</w:t></w:r></w:p>
        <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
      </w:body>
    </w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const server = await serve();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 980 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(() => {
  // DOCX rendering creates same-origin iframes; only reset the test's top page.
  if (window !== window.top) return;
  localStorage.clear();
  window.__notices = [];
  window.__smartPulses = 0;
  window.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      const message = document
        .querySelector(".notice-toast")
        ?.textContent?.trim();
      if (message && window.__notices.at(-1) !== message)
        window.__notices.push(message);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.matches(".smart-fill-pulse") && keyframes.boxShadow)
        window.__smartPulses += 1;
      return animate.call(this, keyframes, options);
    };
  });
});

try {
  await page.goto(baseUrl);
  await page.waitForSelector(".resume-pages .paper:not(.layout-measure)");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);

  assert.equal(
    await page.evaluate(() =>
      window.__notices.some((item) => item.includes("智能一页")),
    ),
    false,
    "automatic Smart One Page displayed a bottom toast",
  );
  assert.ok(
    (await page.evaluate(() => window.__smartPulses)) >= 1,
    "automatic Smart One Page did not animate the toolbar button",
  );

  const formatButton = page.getByRole("button", { name: "格式" });
  const pulseBeforeFormats = await page.evaluate(() => window.__smartPulses);
  await formatButton.click();
  await page.getByRole("button", { name: /清晰单栏/ }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /原版/ }).click();
  await page.waitForTimeout(500);
  assert.ok(
    (await page.evaluate(() => window.__smartPulses)) >= pulseBeforeFormats + 2,
    "each format selection should auto-run and animate Smart One Page",
  );
  assert.equal(
    await page.evaluate(() =>
      window.__notices.some((item) => item.includes("自动调用智能一页")),
    ),
    false,
    "format-triggered Smart One Page displayed an automatic toast",
  );

  await page.getByRole("button", { name: "智能一页" }).click();
  await page.waitForFunction(() =>
    window.__notices.some((item) => item.includes("智能一页")),
  );
  assert.ok(
    await page
      .locator(".smart-fill-toggle")
      .evaluate((button) => button.classList.contains("active")),
    "completed smart layout is not shown as active",
  );

  await page.locator('button[aria-label="编辑基本信息"]').click();
  const basicInput = page.locator('[data-editor-target="basic"] input').first();
  await basicInput.fill(`${await basicInput.inputValue()} A`);
  await page.waitForTimeout(80);
  assert.equal(
    await page
      .locator(".smart-fill-toggle")
      .evaluate((button) => button.classList.contains("active")),
    false,
    "editing content did not return Smart One Page to the light state",
  );

  await page.getByRole("button", { name: "模板", exact: true }).click();
  await page.locator(".template-library-card").first().waitFor();
  assert.equal(await page.locator(".template-library-card").count(), 1);
  await page.locator('input[type="file"]').setInputFiles({
    name: "side-band-resume.png",
    mimeType: "image/png",
    buffer: fixturePng(),
  });
  await page.getByRole("dialog", { name: "识别为简历模板？" }).waitFor();
  await page.getByRole("button", { name: "识别并保存" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".template-library-card").length === 2,
  );
  const storedTemplates = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("resume-diy-imported-templates-v1") || "[]",
    ),
  );
  assert.equal(storedTemplates.length, 1, "recognized template was not saved");
  assert.equal(storedTemplates[0].sourceType, "image");
  assert.match(storedTemplates[0].previewDataUrl, /^data:image\/jpeg/);

  await page.locator('input[type="file"]').setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: fixturePdf(),
  });
  await page.getByRole("button", { name: "识别并保存" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".template-library-card").length === 3,
  );

  await page.locator('input[type="file"]').setInputFiles({
    name: "resume.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await fixtureDocx(),
  });
  await page.getByRole("button", { name: "识别并保存" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".template-library-card").length === 4,
  );
  const allImportedTypes = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("resume-diy-imported-templates-v1") || "[]",
    ).map((item) => item.sourceType),
  );
  assert.deepEqual(
    [...allImportedTypes].sort(),
    ["image", "pdf", "word"],
    "image, PDF and Word imports were not all recognized",
  );
  const recognizedPdf = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("resume-diy-imported-templates-v1") || "[]",
    ).find((item) => item.sourceType === "pdf"),
  );
  assert.ok(
    recognizedPdf?.resume,
    "PDF content was not mapped to editable data",
  );
  assert.match(
    recognizedPdf.extractedText,
    /Imported PDF Resume/,
    "PDF text layer content was not preserved",
  );
  assert.ok(
    recognizedPdf.moduleOrder.length > 0,
    "PDF editable modules were not created",
  );
  const recognizedWord = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem("resume-diy-imported-templates-v1") || "[]",
    ).find((item) => item.sourceType === "word"),
  );
  assert.ok(
    recognizedWord?.resume,
    "Word content was not mapped to editable data",
  );
  assert.match(
    recognizedWord.extractedText,
    /Imported Word Resume/,
    "Word document content was not preserved",
  );
  await page
    .getByRole("button", { name: /^IMAGE · 已识别 side-band-resume/ })
    .click();
  await page.waitForTimeout(450);
  await page.screenshot({
    path: path.join(artifactRoot, "template-library.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: /^PDF · 已识别 resume/ }).click();

  await page.getByRole("button", { name: "返回编辑" }).click();
  const orderBefore = await page
    .locator("[data-editor-module]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  const firstHeading = page
    .locator("[data-editor-module]")
    .first()
    .locator(".section-heading");
  const thirdCard = page.locator("[data-editor-module]").nth(2);
  const dragData = await page.evaluateHandle(() => new DataTransfer());
  await firstHeading.dispatchEvent("dragstart", { dataTransfer: dragData });
  await thirdCard.dispatchEvent("dragenter", { dataTransfer: dragData });
  await page.waitForTimeout(40);
  await thirdCard.dispatchEvent("drop", { dataTransfer: dragData });
  await firstHeading.dispatchEvent("dragend", { dataTransfer: dragData });
  const orderAfter = await page
    .locator("[data-editor-module]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  assert.notDeepEqual(
    orderAfter,
    orderBefore,
    "module drag did not reorder whole cards",
  );

  const hoverOrderBefore = await page
    .locator("[data-editor-module]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  const hoverHeading = page
    .locator("[data-editor-module]")
    .first()
    .locator(".section-heading");
  const hoverTarget = page.locator("[data-editor-module]").nth(1);
  const hoverBox = await hoverTarget.boundingBox();
  assert.ok(hoverBox, "drag hover target was not measurable");
  const hoverData = await page.evaluateHandle(() => new DataTransfer());
  await hoverHeading.dispatchEvent("dragstart", { dataTransfer: hoverData });
  for (let step = 0; step < 12; step += 1) {
    await hoverTarget.dispatchEvent("dragover", {
      dataTransfer: hoverData,
      clientX: hoverBox.x + hoverBox.width / 2,
      clientY: hoverBox.y + hoverBox.height * (step % 2 ? 0.51 : 0.49),
    });
  }
  await page.waitForTimeout(80);
  assert.deepEqual(
    await page
      .locator("[data-editor-module]")
      .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule)),
    hoverOrderBefore,
    "module order flickered while pointer stayed inside the dead zone",
  );
  await hoverHeading.dispatchEvent("dragend", { dataTransfer: hoverData });

  await page.getByRole("button", { name: "AI 助手" }).click();
  await page.locator("[data-assistant-workspace]").waitFor();
  await page.getByRole("button", { name: "返回编辑模板" }).click();
  await page.locator('[data-editor-target="basic"]').waitFor();
  await page.locator('button[aria-label="编辑基本信息"]').click();
  const importedNameInput = page.getByRole("textbox", {
    name: "姓名",
    exact: true,
  });
  await importedNameInput.fill("Imported PDF Resume Edited");
  await page.waitForTimeout(320);
  assert.equal(
    await page.evaluate(() => {
      const activeId = localStorage.getItem(
        "resume-diy-active-imported-template",
      );
      return JSON.parse(
        localStorage.getItem("resume-diy-imported-templates-v1") || "[]",
      ).find((item) => item.id === activeId)?.resume?.basic?.name;
    }),
    "Imported PDF Resume Edited",
    "active imported template did not retain its own edit state",
  );

  const zoomInput = page.getByRole("spinbutton", { name: "预览缩放百分比" });
  await zoomInput.fill("112");
  await zoomInput.press("Enter");
  await page.locator(".preview-pane").evaluate((pane) => {
    const header = pane.querySelector(".preview-workspace-header");
    const block = pane.querySelector(
      '.paper:not(.layout-measure) [data-layout-block="education"]',
    );
    if (!header || !block) return;
    pane.scrollTop +=
      block.getBoundingClientRect().top -
      header.getBoundingClientRect().bottom +
      18;
    block.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 400,
        clientY: 120,
      }),
    );
  });
  await page.waitForSelector(".preview-interaction-outline");
  const bounds = await page.evaluate(() => ({
    outlineTop: document
      .querySelector(".preview-interaction-outline")
      .getBoundingClientRect().top,
    headerBottom: document
      .querySelector(".preview-workspace-header")
      .getBoundingClientRect().bottom,
    documentScroll: document.documentElement.scrollTop,
    bodyOverflow: document.documentElement.scrollHeight - innerHeight,
  }));
  assert.ok(
    bounds.outlineTop >= bounds.headerBottom,
    `preview outline crossed sticky header: ${JSON.stringify(bounds)}`,
  );
  assert.equal(
    bounds.documentScroll,
    0,
    "workspace leaked scrolling to the document",
  );

  assert.deepEqual(errors, [], `browser errors: ${errors.join(" | ")}`);
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        checks: {
          automaticSmartFitToast: "suppressed",
          manualSmartFitToast: "shown",
          smartButtonState: "active only for current smart layout",
          formatPresets: "moved to top Format panel and auto-fit twice",
          importedTemplate: storedTemplates[0].analysis,
          importedTypes: allImportedTypes,
          moduleDrag: {
            before: orderBefore,
            after: orderAfter,
            deadZoneStable: true,
          },
          assistantWorkspace: "real page and state-preserving return",
          importedEditState: "persisted per selected template",
          outlineAt112Percent: bounds,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      pageErrors: errors,
      importError: await page
        .locator(".template-recognition-error")
        .allTextContents(),
      cards: await page.locator(".template-library-card").count(),
      stored: await page.evaluate(() =>
        JSON.parse(
          localStorage.getItem("resume-diy-imported-templates-v1") ?? "[]",
        ).map(({ id, sourceType, formatId }) => ({ id, sourceType, formatId })),
      ),
    }),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
