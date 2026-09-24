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

function fixturePng(sideColor = [35, 39, 44]) {
  const image = new PNG({ width: 240, height: 340 });
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const side = x < 64;
      const accent = !side && y > 42 && y < 48;
      image.data[offset] = side ? sideColor[0] : accent ? 224 : 250;
      image.data[offset + 1] = side ? sideColor[1] : accent ? 80 : 248;
      image.data[offset + 2] = side ? sideColor[2] : accent ? 43 : 244;
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

async function importedSideBandColors(page) {
  return page
    .locator(".paper.template-imported-side-band:not(.layout-measure)")
    .first()
    .evaluate((paper) => {
      const style = getComputedStyle(paper);
      const heading = paper.querySelector(".preview-header h1");
      return {
        background: style.getPropertyValue("--imported-side-background").trim(),
        foreground: heading ? getComputedStyle(heading).color : null,
        gradient: style.backgroundImage,
      };
    });
}

async function minimizeAgentWhenExpanded(page) {
  const minimize = page.getByRole("button", { name: "最小化到 Bot" });
  if (await minimize.count()) await minimize.click();
}

function fixturePdf() {
  const document = new jsPDF({ unit: "pt", format: "a4" });
  document.setFontSize(22);
  document.text("Lin Qiao", 52, 58);
  document.setDrawColor(224, 96, 32);
  document.line(52, 70, 540, 70);
  document.setFontSize(9);
  document.text("13800138000", 52, 87);
  document.text("lin.qiao@example.com", 52, 101);
  document.text("Make work visible", 52, 115);
  document.setFontSize(12);
  const lines = [
    [
      "Education",
      "2020-09 - 2024-06",
      "East Shore University",
      "Computer Science",
      "2016-09 - 2020-06",
      "River High School",
      "Science",
    ],
    ["Skills", "TypeScript / React / PDF.js", "Figma and accessible design"],
    [
      "Experience",
      "2024-07 - Present",
      "Spark Technology",
      "Frontend Engineer",
      "Delivered the resume editor and local template recognition.",
      "2022-01 - 2024-06",
      "Mountain Studio",
      "Product Designer",
      "Owned cross-platform product experience.",
    ],
    [
      "Projects",
      "2023-01 - 2023-12",
      "Resume Builder",
      "Built editable template import and A4 preview.",
    ],
    [
      "Activities",
      "2021-03 - 2022-03",
      "Open Design Club",
      "Hosted accessibility design sessions.",
    ],
    [
      "Research",
      "2020-02 - 2020-08",
      "Accessible Interface Study",
      "Completed keyboard navigation usability analysis.",
    ],
    [
      "Awards",
      "2021-10",
      "Product Design Award",
      "First place in the university innovation contest.",
    ],
    ["Portfolio", "Portfolio", "https://resume.example.com"],
    ["Hobbies and Interests", "Hiking, photography, and open source."],
    ["Summary", "Focused on accessible and useful resume products."],
  ];
  let y = 134;
  for (const section of lines) {
    document.setFont("helvetica", "bold");
    document.text(section[0], 52, y);
    y += 13;
    document.setFont("helvetica", "normal");
    for (const line of section.slice(1)) {
      document.text(line, 52, y);
      y += 12;
    }
    y += 4;
  }
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
  if (!sessionStorage.getItem("template-workflow-initialized")) {
    localStorage.clear();
    sessionStorage.setItem("template-workflow-initialized", "1");
  }
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
  assert.ok(
    await page.locator("[data-agent-overlay].agent-mode-composer").count(),
    "desktop should start with the lightweight composer",
  );
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
  await formatButton.click();
  assert.equal(
    await page.getByRole("button", { name: /清晰单栏|原版/ }).count(),
    0,
    "removed layout style choices are still visible",
  );
  assert.equal(
    await page.getByRole("dialog", { name: "格式与颜色" }).count(),
    1,
    "remaining format controls are unavailable",
  );
  assert.equal(
    await page.evaluate(() =>
      window.__notices.some((item) => item.includes("自动调用智能一页")),
    ),
    false,
    "opening format controls displayed an automatic toast",
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
  const darkBand = await importedSideBandColors(page);
  assert.equal(darkBand.background, "#23272c");
  assert.equal(darkBand.foreground, "rgb(255, 255, 255)");
  assert.match(darkBand.gradient, /rgb\(35, 39, 44\)/);

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
    /Lin Qiao/,
    "PDF text layer content was not preserved",
  );
  assert.match(
    recognizedPdf.previewDataUrl,
    /^data:image\/png;base64,/,
    "PDF source preview was not retained as a lossless PNG",
  );
  assert.ok(
    [
      "education",
      "skills",
      "work",
      "projects",
      "orgs",
      "research",
      "awards",
      "portfolio",
      "other",
      "summary",
      "custom",
    ].every((module) => recognizedPdf.moduleOrder.includes(module)),
    `PDF sections were not mapped to every editor module: ${recognizedPdf.moduleOrder.join(", ")}`,
  );
  assert.equal(recognizedPdf.resume.basic.name, "Lin Qiao");
  assert.equal(recognizedPdf.resume.basic.phone, "13800138000");
  assert.equal(recognizedPdf.resume.basic.email, "lin.qiao@example.com");
  assert.equal(recognizedPdf.resume.education.length, 2);
  assert.ok(recognizedPdf.resume.work.length >= 2);
  assert.ok(recognizedPdf.resume.skills[0]?.html.includes("TypeScript"));
  for (const module of [
    "education",
    "skills",
    "work",
    "projects",
    "orgs",
    "research",
    "awards",
    "portfolio",
    "other",
    "custom",
  ]) {
    assert.ok(
      recognizedPdf.resume[module].length > 0,
      `recognized PDF content was not editable in ${module}`,
    );
  }
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
  await page.locator('input[type="file"]').setInputFiles({
    name: "light-side-band.png",
    mimeType: "image/png",
    buffer: fixturePng([248, 225, 225]),
  });
  await page.getByRole("button", { name: "识别并保存" }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".template-library-card-copy strong")].some(
      (element) => element.textContent === "light-side-band",
    ),
  );
  const lightBand = await importedSideBandColors(page);
  assert.equal(lightBand.background, "#f8e1e1");
  assert.equal(lightBand.foreground, "rgb(37, 42, 47)");
  assert.match(lightBand.gradient, /rgb\(248, 225, 225\)/);
  await page.waitForTimeout(250);
  await page.reload();
  await page.waitForSelector(
    ".paper.template-imported-side-band:not(.layout-measure)",
  );
  assert.deepEqual(
    await importedSideBandColors(page),
    lightBand,
    "light side-band palette was lost after reload",
  );
  await page.locator(".export-trigger").click();
  await page.waitForSelector(".download-menu");
  const lightExportPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "高清 PNG" }).click();
  const lightExport = await lightExportPromise;
  const lightPng = PNG.sync.read(fs.readFileSync(await lightExport.path()));
  const sampleOffset =
    (Math.floor(lightPng.height * 0.5) * lightPng.width +
      Math.floor(lightPng.width * 0.2)) *
    4;
  assert.deepEqual(
    [...lightPng.data.subarray(sampleOffset, sampleOffset + 3)],
    [248, 225, 225],
    "PNG export lost the imported light side-band color",
  );
  await page.getByRole("button", { name: "模板", exact: true }).click();
  await minimizeAgentWhenExpanded(page);
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
  await page.locator("[data-imported-source-preview]").waitFor();
  const sourcePreviewBounds = await page.evaluate(() => {
    const image = document.querySelector("[data-imported-source-preview]");
    const paper = document.querySelector(
      ".paper-frame .paper:not(.layout-measure)",
    );
    const activeId = localStorage.getItem(
      "resume-diy-active-imported-template",
    );
    const template = JSON.parse(
      localStorage.getItem("resume-diy-imported-templates-v1") || "[]",
    ).find((item) => item.id === activeId);
    if (!image || !paper || !template) return null;
    const source = image.getBoundingClientRect();
    const rendered = paper.getBoundingClientRect();
    return {
      sameSource: image.getAttribute("src") === template.previewDataUrl,
      widthDelta: Math.abs(source.width - rendered.width),
      heightDelta: Math.abs(source.height - rendered.height),
      topDelta: Math.abs(source.top - rendered.top),
      leftDelta: Math.abs(source.left - rendered.left),
      hasImage: image.complete && image.naturalWidth > 0,
    };
  });
  assert.ok(sourcePreviewBounds?.sameSource && sourcePreviewBounds.hasImage);
  assert.ok(
    sourcePreviewBounds.widthDelta < 1 &&
      sourcePreviewBounds.heightDelta < 1 &&
      sourcePreviewBounds.topDelta < 1 &&
      sourcePreviewBounds.leftDelta < 1,
    `PDF source preview did not exactly cover the first A4 page: ${JSON.stringify(sourcePreviewBounds)}`,
  );
  const educationCard = page.locator('[data-editor-module="education"]');
  const educationDisclosure = educationCard.getByRole("button", {
    name: /展开教育经历|收起教育经历/,
  });
  if ((await educationDisclosure.getAttribute("aria-expanded")) === "false")
    await educationDisclosure.click();
  const educationEntry = educationCard
    .locator("[data-editor-entry-id]")
    .first();
  await educationEntry.locator("button.entry-expand-affordance").click();
  const importedSchool = educationEntry.getByRole("textbox", {
    name: "学校名称",
  });
  await importedSchool.fill("East Shore University (edited)");
  await page
    .locator("[data-imported-source-preview]")
    .waitFor({ state: "detached" });
  await page
    .locator(".paper:not(.layout-measure)")
    .getByText("East Shore University (edited)", { exact: true })
    .waitFor();
  assert.ok(
    (await page.locator("[data-editor-module]").count()) >= 8,
    "selected imported PDF did not expose its recognized editor modules",
  );

  await educationEntry.locator("button.entry-expand-affordance").click();
  await page.locator(".editor-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
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

  const orderBefore = await page
    .locator("[data-editor-module]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  const firstHeading = page
    .locator("[data-editor-module]")
    .first()
    .locator(".section-heading");
  const thirdCard = page.locator("[data-editor-module]").nth(2);
  const sourceBox = await firstHeading.boundingBox();
  const targetBox = await thirdCard.boundingBox();
  assert.ok(sourceBox && targetBox, "module drag bounds were unavailable");
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
  await page.waitForTimeout(50);
  await page.mouse.up();
  const orderAfter = await page
    .locator("[data-editor-module]")
    .evaluateAll((cards) => cards.map((card) => card.dataset.editorModule));
  assert.notDeepEqual(
    orderAfter,
    orderBefore,
    "module drag did not reorder whole cards",
  );

  // The next synthetic pointer coordinates come from a card bounding box.
  // Wait until the previous reorder's FLIP transform reaches its final box.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-editor-module]")].every((card) =>
      card
        .getAnimations()
        .every((animation) => animation.playState !== "running"),
    ),
  );

  const agentOverlay = page.locator("[data-agent-overlay]");
  await agentOverlay.waitFor();
  assert.equal(await page.getByRole("button", { name: "AI 助手" }).count(), 0);
  await page.getByRole("button", { name: "模板", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-agent-overlay]")
        ?.getAttribute("data-agent-view") === "templates",
  );
  await page.getByRole("button", { name: "简历编辑" }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-agent-overlay]")
        ?.getAttribute("data-agent-view") === "editor",
  );
  await page.locator('[data-editor-target="basic"]').waitFor();
  await page.locator('button[aria-label="编辑基本信息"]').click();
  const importedNameInput = page.getByRole("textbox", {
    name: "姓名",
    exact: true,
  });
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    Object.defineProperty(window, "__templateOriginalSetItem", {
      configurable: true,
      value: originalSetItem,
    });
    Storage.prototype.setItem = function setItemWithTemplateQuotaFailure(
      key,
      value,
    ) {
      if (key === "resume-diy-imported-templates-v1")
        throw new DOMException("blocked", "QuotaExceededError");
      return originalSetItem.call(this, key, value);
    };
  });
  await importedNameInput.fill("Quota Failure Check");
  await page
    .getByText("导入模板同步保存失败，浏览器存储空间可能已满。", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(errors, [], "template storage failure escaped the timer");
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__templateOriginalSetItem;
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
          formatControls:
            "remaining format controls present; layout style presets removed",
          importedTemplate: storedTemplates[0].analysis,
          importedTypes: allImportedTypes,
          moduleDrag: {
            before: orderBefore,
            after: orderAfter,
            pointerDriven: true,
          },
          agentHarness:
            "single persistent overlay follows the three workspaces",
          importedPdf: {
            recognizedModules: recognizedPdf.moduleOrder,
            sourcePageOverlay: sourcePreviewBounds,
            entryEditReflectedInPreview: true,
          },
          importedEditState: "persisted per selected template",
          templateStorageFailure:
            "reported without an uncaught error when quota is exceeded",
          importedSideBand:
            "dark/light sampled palette, reload and PNG export verified",
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
