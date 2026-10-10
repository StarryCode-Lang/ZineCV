// B07 视觉关卡：同一虚构简历分别由旧 DOM 纸面与 Typst 引擎渲染，
// 逐像素对照。这是“引擎纸面 vs DOM 纸面”的首次量化对照（此前
// tools/visual-parity.mjs 只证明新旧 DOM 构建一致，不涉及引擎）。
//
// 用法：node --test tools/engine-parity.mjs（需先 npm run build:engine-render）
// 输出：.artifacts/engine-parity/{dom.png,engine.png,diff.png,report.json}
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { preview } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { visualFixture } from "./visual-parity-fixture.mjs";
import { resolveDensitySpacing } from "../src/ui/domain/template-model.ts";

const root = resolve(import.meta.dirname, "..");
// Three samples per CSS pixel avoid treating opposite raster-edge rounding as
// a two-pixel width change. The acceptance tolerance remains one CSS pixel.
const geometryRasterScale = 3;
const targetDirectory = join(root, "src-tauri", "target");
const engineExecutable = resolve(
  process.env.ZINECV_ENGINE_RENDER_EXE ?? join(targetDirectory, "release", "examples", "engine_render.exe"),
);
// Keep the historic baseline directory immutable. Callers can select a fresh
// evidence directory without replacing the 2026-09-29/30 comparison images.
const outDir = resolve(
  process.env.ZINECV_ENGINE_PARITY_OUT_DIR ??
    join(root, ".artifacts", "engine-parity-runs", "latest"),
);

const templateProfiles = {
  "legacy-v1": {
    fontSizePt: 9.75, lineHeightPt: 9.75, moduleGapPt: 0, pageMarginPt: 22.5,
    headingSizePt: 9.75, paragraphGapPt: 0, listGapPt: 0, theme: "#000000",
    css: { fontSize: "13", lineHeight: "13", moduleSpacing: "0", pageMargin: "30" },
  },
  "clear-single-v1": {
    fontSizePt: 9.0, lineHeightPt: 12.75, moduleGapPt: 6.0, pageMarginPt: 25.5,
    headingSizePt: 12.0, paragraphGapPt: 3.0, listGapPt: 1.5, theme: "#ee5b2a",
    css: { fontSize: "12", lineHeight: "17", moduleSpacing: "8", pageMargin: "34" },
  },
  "compact-single-v1": {
    fontSizePt: 8.25, lineHeightPt: 10.5, moduleGapPt: 2.25, pageMarginPt: 18.75,
    headingSizePt: 10.5, paragraphGapPt: 0.75, listGapPt: 0.75, theme: "#ee5b2a",
    css: { fontSize: "11", lineHeight: "14", moduleSpacing: "3", pageMargin: "25" },
  },
};

// 与 visualFixture() 同一内容的 ResumeDocument 表示（内容按构造等价，
// HTML→RichBlock 的转换正确性由 tests/browser/document-bridge.test.mjs
// 单独覆盖；本工具只测“同一内容的两套排版输出”）。
function fixtureDocument(templateId, density = "standard") {
  const text = (t, marks = []) => ({ type: "text", text: t, marks });
  const paragraph = (children) => ({ type: "paragraph", children });
  const section = (id, kind, title, entries) => ({ id, kind, title, visible: true, entries });
  // 各模板 registry 默认值（px×0.75→pt）。
  const templatePresentation = templateProfiles[templateId] ?? templateProfiles["legacy-v1"];
  const densitySpacing = resolveDensitySpacing(templateId, density);
  return {
    schemaVersion: 2,
    documentId: "parity-document",
    title: "视觉对照简历",
    basic: {
      name: "张三", phone: "138-0000-0000", email: "zhangsan@example.com",
      city: "上海", wechat: "zhangsan_dev", birth: "2001-06", ageMode: "birthday",
      website: "https://zhangsan.example.com", linkedin: "", gender: "", height: "",
      weight: "", ethnicity: "", birthplace: "", politicalStatus: "", maritalStatus: "",
      zodiac: "", mbti: "", avatarAssetId: null,
    },
    sections: [
      section("legacy-section:education", "education", "education", [
        {
          id: "edu-1", title: "某某大学", role: "计算机科学与技术", department: "", city: "",
          start: "2019-09", end: "2023-06",
          body: [
            paragraph([text("主修课程：数据结构、操作系统、编译原理")]),
            { type: "list", ordered: true, items: [
              [paragraph([text("GPA 3.8 / 4.0")])],
              [paragraph([text("校级一等奖学金")])],
            ] },
          ],
        },
      ]),
      section("legacy-section:work", "work", "实习经历", [
        {
          id: "work-1", title: "某科技公司", role: "前端工程师", department: "平台组", city: "上海",
          start: "2023-07", end: "2025-02",
          body: [
            paragraph([text("负责简历编辑器核心链路，"), text("性能优化", ["underline"]), text("与稳定性建设。")]),
            { type: "list", ordered: false, items: [
              [paragraph([text("首屏加载从 3s 降至 1s")])],
              [paragraph([text("崩溃率下降 40%")])],
            ] },
          ],
        },
        {
          id: "work-2", title: "某创业公司", role: "实习工程师", department: "", city: "杭州",
          start: "2022-12", end: "2023-05",
          body: [paragraph([text("参与协作文档产品开发，负责"), text("光标协同", ["italic"]), text("与离线缓存。")])],
        },
      ]),
      section("legacy-section:projects", "projects", "projects", [
        {
          id: "proj-1", title: "开源简历引擎", role: "", department: "", city: "",
          start: "2024-01", end: "2024-08",
          body: [
            paragraph([
              text("基于 Web 的所见即所得简历编辑器，支持"),
              { type: "link", href: "https://example.com/repo", children: [text("开源仓库")] },
              text("。"),
            ]),
          ],
        },
      ]),
      {
        id: "legacy-section:summary", kind: "summary", title: "自我评价", visible: true,
        body: [paragraph([text("三年全栈开发经验，熟悉"), text("React 与 Rust", ["bold"]), text("，擅长把复杂系统拆成可维护的小模块。")])],
      },
      // DOM 不过滤空模块（skills 空数组仍渲染标题骨架），引擎必须一致。
      section("legacy-section:skills", "skills", "skills", []),
    ],
    presentation: {
      templateId, templateRevision: "1",
      density,
      fontSetId: "legacy-font:宋体",
      fontSizePt: templatePresentation.fontSizePt,
      lineHeightPt: templatePresentation.lineHeightPt,
      moduleGapPt: templatePresentation.moduleGapPt,
      pageMarginPt: templatePresentation.pageMarginPt,
      headingSizePt: Number(densitySpacing.headingFontSize) * 0.75,
      paragraphGapPt: Number(densitySpacing.paragraphSpacing) * 0.75,
      listGapPt: Number(densitySpacing.listSpacing) * 0.75,
      theme: templatePresentation.theme,
      dateFormat: "2021年1月", titleFormat: "单行标题",
      separator: "使用分隔符号", textAlign: "两端对齐", legacyOverrides: {},
    },
    legacyExtensions: {},
  };
}

// DOM 侧 localStorage 夹具按模板切换（preferences 为 registry 默认 px 值）。
function fixtureStorageFor(templateId, density, baseStorage) {
  const next = { ...baseStorage };
  const preferences = JSON.parse(next["resume-diy-preferences"]);
  Object.assign(preferences, templateProfiles[templateId].css, {
    theme: templateProfiles[templateId].theme,
  });
  next["resume-diy-preferences"] = JSON.stringify(preferences);
  next["resume-diy-presentation-v1"] = JSON.stringify({
    templateId, templateVersion: 1,
    densityPreset: density,
    overrides: {},
  });
  return next;
}

async function renderEnginePage(document, pageIndex, workDir, slug, { textMap = true, isolateIds = [] } = {}) {
  const documentPath = join(workDir, `document-${slug}.json`);
  const outputPath = join(workDir, `engine-${slug}-${pageIndex}.png`);
  const textMapPath = join(workDir, `textmap-${slug}.json`);
  const isolatedDirectory = join(workDir, `isolated-${slug}`);
  await writeFile(documentPath, JSON.stringify(document, null, 2));
  // 注意：异步 spawn。同步 spawnSync 在受控执行环境下会被拦截（EBUSY）。
  let pageCount, fontIdentity;
  try {
    const args = [documentPath, outputPath, String(pageIndex), String((4 / 3) * geometryRasterScale)];
    if (textMap) args.push("--textmap", textMapPath, "--isolated-dir", isolatedDirectory);
    const { stdout } = await promisify(execFile)(engineExecutable, args, {
      encoding: "utf8", timeout: 150_000,
      env: { ...process.env, ZINECV_ENGINE_ISOLATE_IDS: JSON.stringify(isolateIds) },
    });
    const metadata = stdout.split(/\r?\n/).find(line => line.startsWith("ENGINE_RENDER "));
    const details = JSON.parse(metadata.slice("ENGINE_RENDER ".length));
    pageCount = details.pageCount;
    fontIdentity = details.fonts;
  } catch (run) {
    return { ok: false, stdout: run.stdout, stderr: run.stderr, status: run.code, error: run.error ? String(run.error) : undefined };
  }
  return {
    ok: true,
    png: PNG.sync.read(await readFile(outputPath)),
    outputPath,
    pageCount,
    fontIdentity,
    textMap: textMap ? JSON.parse(await readFile(textMapPath, "utf8")) : null,
    isolatedDirectory,
  };
}

async function captureDomPaper(context, url, storage) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.addInitScript((entries) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(url, { waitUntil: "networkidle" });
  // 预览容器会按视口自适应缩放纸张；对照必须 1:1，
  // 用 !important 覆盖脚本写入的 CSS 变量（stylesheet !important 优先于内联非重要值）。
  await page.addStyleTag({
    content: `
      .resume-pages {
        --paper-render-width: 793.688px !important;
        --paper-render-height: 1122.52px !important;
        --preview-scale: 1 !important;
      }
    `,
  });
  const paper = page.locator(".paper-frame").first();
  await paper.waitFor({ timeout: 20_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const face of document.fonts) {
      if (["Source Han Serif CN", "iconfont"].includes(face.family.replaceAll('"', ""))) {
        if (face.status === "error") throw new Error(`Comparison font failed: ${face.family}`);
      }
    }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const layout = await paper.locator(".paper").evaluate((paperElement) => {
    const paperRect = paperElement.getBoundingClientRect();
    const rangeRect = (selector) => {
      const element = paperElement.querySelector(selector);
      if (!element) return null;
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return {
        x: rect.left - paperRect.left,
        y: rect.top - paperRect.top,
        width: rect.width,
        height: rect.height,
        text: element.innerText ?? element.textContent ?? "",
        color: getComputedStyle(element).color,
      };
    };
    const elementRect = (selector) => {
      const element = paperElement.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left - paperRect.left, y: rect.top - paperRect.top, width: rect.width, height: rect.height };
    };
    const lineRows = (selector) => {
      const element = paperElement.querySelector(selector);
      if (!element) return [];
      const intervals = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          intervals.push({
            y: Math.round((rect.top - paperRect.top) * 2) / 2,
            bottom: Math.round((rect.bottom - paperRect.top) * 2) / 2,
          });
        }
      }
      intervals.sort((left, right) => left.y - right.y);
      const rows = [];
      for (const interval of intervals) {
        const row = rows.at(-1);
        if (row && interval.y < row.bottom - 0.5) {
          row.bottom = Math.max(row.bottom, interval.bottom);
        } else {
          rows.push({ ...interval });
        }
      }
      return rows.map(({ y, bottom }) => ({ y, height: bottom - y }));
    };
    return {
      paper: { width: paperRect.width, height: paperRect.height },
      pageCount: document.querySelectorAll(".resume-pages .paper-frame").length,
      text: paperElement.querySelector(".paper-content")?.innerText ?? "",
      resolvedPresentation: (() => {
        const preferences = JSON.parse(localStorage.getItem("resume-diy-preferences") ?? "{}");
        const numberPx = (value) => Number.parseFloat(value) || 0;
        const style = getComputedStyle(paperElement);
        const title = paperElement.querySelector(".preview-title strong");
        const paragraph = paperElement.querySelector(".preview-rich p");
        const listItem = paperElement.querySelector(".preview-rich li + li");
        return {
          fontSizePt: numberPx(style.fontSize) * 0.75,
          lineHeightPt: numberPx(style.lineHeight) * 0.75,
          moduleGapPt: numberPx(style.getPropertyValue("--module-gap")) * 0.75,
          pageMarginPt: numberPx(style.paddingTop) * 0.75,
          headingSizePt: title ? numberPx(getComputedStyle(title).fontSize) * 0.75 : 0,
          paragraphGapPt: paragraph ? numberPx(getComputedStyle(paragraph).marginTop) * 0.75 : 0,
          listGapPt: listItem ? numberPx(getComputedStyle(listItem).marginTop) * 0.75 : 0,
          theme: preferences.theme ?? "#000000",
          dateFormat: preferences.dateFormat ?? "2021年1月",
          titleFormat: preferences.titleFormat ?? "单行标题",
          separator: preferences.separator ?? "使用分隔符号",
          textAlign: preferences.textAlign ?? "两端对齐",
          fontSetId: `legacy-font:${preferences.font ?? "宋体"}`,
        };
      })(),
      style: {
        fontSize: getComputedStyle(paperElement).fontSize,
        lineHeight: getComputedStyle(paperElement).lineHeight,
        padding: getComputedStyle(paperElement).padding,
      },
      blocks: {
        header: elementRect('[data-layout-block="header"]'),
        section: elementRect('[data-layout-block="education"]'),
        sectionTitle: elementRect(".preview-section .preview-title"),
        entry: elementRect('[data-preview-entry-id="edu-1"]'),
        entryHead: elementRect('[data-preview-entry-id="edu-1"] .preview-entry-head'),
        entryRich: elementRect('[data-preview-entry-id="edu-1"] .preview-rich'),
      },
      decorations: (() => {
        const header = paperElement.querySelector(".preview-header");
        const style = getComputedStyle(header);
        const border = Number.parseFloat(style.borderBottomWidth) || 0;
        const box = elementRect(".preview-header");
        return {
          unorderedMarkers: [...paperElement.querySelectorAll(".preview-rich ul > li")].map(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const fontSize = Number.parseFloat(style.fontSize);
            const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.2;
            return { x: rect.left - paperRect.left - fontSize * 1.5,
              y: rect.top - paperRect.top, width: fontSize * 1.5 - 1, height: lineHeight };
          }),
          headerRule: border > 0 ? { color: style.borderBottomColor,
            rect: { x: box.x, y: box.y + box.height - border, width: box.width, height: border } } : null,
          icons: [...paperElement.querySelectorAll(".preview-title-icon, .preview-contact-icon, .website-logo")].filter(element =>
            getComputedStyle(element).display !== "none").map(element => {
            const rect = element.getBoundingClientRect();
            return { kind: element.classList.contains("preview-title-icon") ? "sectionIcon" : "headerIcon", color: getComputedStyle(element).color,
              rect: { x: rect.left - paperRect.left, y: rect.top - paperRect.top - 4,
                width: rect.width, height: rect.height + 8 } };
          }),
        };
      })(),
      textRows: {
        education: lineRows('[data-preview-entry-id="edu-1"] .preview-rich'),
        workOne: lineRows('[data-preview-entry-id="work-1"] .preview-rich'),
        workTwo: lineRows('[data-preview-entry-id="work-2"] .preview-rich'),
        project: lineRows('[data-preview-entry-id="proj-1"] .preview-rich'),
        summary: lineRows('[data-layout-block="summary"] .preview-rich'),
      },
      lineStyles: Object.fromEntries([
        ["header", '[data-layout-block="header"]'],
        ["headerMain", ".preview-header-main"],
        ["name", ".preview-header h1"],
        ["primaryContact", ".preview-contact-primary"],
        ["secondaryContact", ".preview-contact-secondary"],
        ["sectionTitle", ".preview-title"],
        ["entryHead", ".preview-entry-head"],
        ["entryRich", ".preview-rich"],
        ["paragraph", ".preview-rich p"],
        ["listItem", ".preview-rich li"],
      ].map(([name, selector]) => {
        const element = paperElement.querySelector(selector);
        if (!element) return [name, null];
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return [name, {
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          marginTop: style.marginTop,
          marginBottom: style.marginBottom,
          height: rect.height,
        }];
      })),
      anchors: {
        educationParagraph: rangeRect('[data-preview-entry-id="edu-1"] .preview-rich > p:first-child'),
        orderedListOne: rangeRect('[data-preview-entry-id="edu-1"] .preview-rich ol > li:nth-child(1)'),
        orderedListTwo: rangeRect('[data-preview-entry-id="edu-1"] .preview-rich ol > li:nth-child(2)'),
        workTwoParagraph: rangeRect('[data-preview-entry-id="work-2"] .preview-rich > p:first-child'),
        unorderedListOne: rangeRect('[data-preview-entry-id="work-1"] .preview-rich ul > li:nth-child(1)'),
        unorderedListTwo: rangeRect('[data-preview-entry-id="work-1"] .preview-rich ul > li:nth-child(2)'),
        name: rangeRect(".preview-header h1"),
        website: rangeRect(".preview-sites a span"),
        educationHeading: rangeRect('[data-layout-block="education"] .preview-title strong'),
        educationTitle: rangeRect('[data-preview-entry-id="edu-1"] .preview-entry-left strong'),
        educationDates: rangeRect('[data-preview-entry-id="edu-1"] .preview-entry-head > span'),
        workHeading: rangeRect('[data-layout-block="work"] .preview-title strong'),
        workOneTitle: rangeRect('[data-preview-entry-id="work-1"] .preview-entry-left strong'),
        workOneDates: rangeRect('[data-preview-entry-id="work-1"] .preview-entry-head > span'),
        workTwoTitle: rangeRect('[data-preview-entry-id="work-2"] .preview-entry-left strong'),
        workTwoDates: rangeRect('[data-preview-entry-id="work-2"] .preview-entry-head > span'),
        projectsHeading: rangeRect('[data-layout-block="projects"] .preview-title strong'),
        projectTitle: rangeRect('[data-preview-entry-id="proj-1"] .preview-entry-left strong'),
        projectDates: rangeRect('[data-preview-entry-id="proj-1"] .preview-entry-head > span'),
        summaryHeading: rangeRect('[data-layout-block="summary"] .preview-title strong'),
        skillsHeading: rangeRect('[data-layout-block="skills"] .preview-title strong'),
      },
    };
  });
  // The production workspace clips the A4 page horizontally when its editor
  // and preview panes share the 1440px viewport. Move only the captured page
  // into an isolated viewport rectangle; resume CSS/layout and measurement are
  // recorded above before this screenshot-only adjustment.
  await page.addStyleTag({
    content: `
      .workspace { display: block !important; width: 1440px !important; overflow: visible !important; }
      .workspace > *:not(.preview-pane) { display: none !important; }
      .preview-pane {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        width: 1440px !important;
        min-width: 1440px !important;
        max-width: 1440px !important;
        height: 1400px !important;
        padding: 0 !important;
        overflow: visible !important;
        z-index: 2147483647 !important;
      }
      .preview-pane > *:not(.preview-canvas) { display: none !important; }
      .preview-canvas, .preview-stage {
        width: 1440px !important;
        min-width: 1440px !important;
        max-width: 1440px !important;
        overflow: visible !important;
      }
      .preview-stage > *:not(.resume-pages) { display: none !important; }
      .resume-pages {
        width: 1440px !important;
        align-items: flex-start !important;
        overflow: visible !important;
      }
      .paper-frame { margin: 0 !important; }
      .paper { transform: none !important; box-shadow: none !important; }
    `,
  });
  const shot = await page.locator(".paper-frame").first().screenshot({
    animations: "disabled",
  });
  // Preserve layout while isolating each label. Measure its entire raster,
  // independently of the engine position, so a displacement cannot be cropped.
  const selectors = {
    educationParagraph: '[data-preview-entry-id="edu-1"] .preview-rich > p:first-child',
    orderedListOne: '[data-preview-entry-id="edu-1"] .preview-rich ol > li:nth-child(1)',
    orderedListTwo: '[data-preview-entry-id="edu-1"] .preview-rich ol > li:nth-child(2)',
    workTwoParagraph: '[data-preview-entry-id="work-2"] .preview-rich > p:first-child',
    unorderedListOne: '[data-preview-entry-id="work-1"] .preview-rich ul > li:nth-child(1)',
    unorderedListTwo: '[data-preview-entry-id="work-1"] .preview-rich ul > li:nth-child(2)',
    name: ".preview-header h1",
    website: ".preview-sites a span",
    ...Object.fromEntries(["education", "work", "projects", "summary", "skills"].map(id => [`${id}Heading`, `[data-layout-block="${id}"] .preview-title strong`])),
    ...Object.fromEntries([["education", "edu-1"], ["workOne", "work-1"], ["workTwo", "work-2"], ["project", "proj-1"]].flatMap(([key, id]) => [
      [`${key}Title`, `[data-preview-entry-id="${id}"] .preview-entry-left strong`],
      [`${key}Dates`, `[data-preview-entry-id="${id}"] .preview-entry-head > span`],
    ])),
  };
  const isolation = await page.addStyleTag({ content: `.paper * { visibility: hidden !important; } .paper [data-parity-anchor], .paper [data-parity-anchor] * { visibility: visible !important; border-color: transparent !important; background: transparent !important; } .paper [data-parity-anchor]::marker {color:transparent !important;} .paper [data-parity-anchor]::before {visibility:hidden !important;}` });
  for (const [key, selector] of Object.entries(selectors)) {
    const anchor = paper.locator(selector).first();
    await anchor.evaluate(element => element.setAttribute("data-parity-anchor", ""));
    const isolated = PNG.sync.read(await paper.screenshot({ animations: "disabled" }));
    layout.anchors[key].isolatedInk = cssInkBounds(isolated);
    await anchor.evaluate(element => element.removeAttribute("data-parity-anchor"));
  }
  await isolation.evaluate(element => element.remove());
  await page.close();
  return { png: PNG.sync.read(shot), layout };
}

function normalizeText(value) {
  return value.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function engineAnchor(textMap, sourceNodeId) {
  const clusters = textMap.clusters
    .filter((cluster) => cluster.sourceNodeId === sourceNodeId ||
      (sourceNodeId.endsWith(":") && cluster.sourceNodeId.startsWith(sourceNodeId)))
    .sort((left, right) => left.startUtf16 - right.startUtf16);
  if (clusters.length === 0) return null;
  const x = Math.min(...clusters.map((cluster) => cluster.xPt));
  const y = Math.min(...clusters.map((cluster) => cluster.yPt));
  const right = Math.max(...clusters.map((cluster) => cluster.xPt + cluster.widthPt));
  const bottom = Math.max(...clusters.map((cluster) => cluster.yPt + cluster.heightPt));
  return {
    xPt: x,
    yPt: y,
    widthPt: right - x,
    heightPt: bottom - y,
    text: clusters
      .map((cluster) => textMap.logicalText.slice(cluster.startUtf16, cluster.endUtf16))
      .join(""),
    cssRect: {
      x: x * (4 / 3), y: y * (4 / 3),
      width: (right - x) * (4 / 3), height: (bottom - y) * (4 / 3),
    },
  };
}

function inkBounds(png, rect, padding) {
  if (!rect) return null;
  let minX = rect.width + rect.x;
  let minY = rect.height + rect.y;
  let maxX = -1;
  let maxY = -1;
  const left = Math.max(0, Math.floor(rect.x - padding));
  const top = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(png.width, Math.ceil(rect.x + rect.width + padding));
  const bottom = Math.min(png.height, Math.ceil(rect.y + rect.height + padding));
  const pixels = png.data;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * png.width + x) * 4;
      // Binarized geometry ignores anti-aliasing fringes and white paper tint.
      if (pixels[offset + 3] > 0 && pixels[offset] + pixels[offset + 1] + pixels[offset + 2] < 620) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function compareAnchor(dom, engine, enginePng) {
  if (!dom || !engine) return { passed: false, missing: true };
  // Both sides retain the actual compiled layout and isolate only this text.
  // Measure the complete paper, without any crop based on the other engine.
  const domInk = dom.isolatedInk;
  const engineInk = cssInkBounds(enginePng);
  if (!domInk || !engineInk) return { passed: false, missingInk: true, domInk, engineInk };
  const css = engineInk;
  const deltaCssPx = Object.fromEntries(
    Object.keys(css).map((key) => [key, Number(Math.abs(css[key] - domInk[key]).toFixed(3))]),
  );
  const textMatch = normalizeText(dom.text) === normalizeText(engine.text);
  const expectedColor = rgbChannels(dom.color);
  const actualColor = darkestInkColor(enginePng);
  const colorDelta = expectedColor && actualColor
    ? Math.max(...expectedColor.map((value, index) => Math.abs(value - actualColor[index]))) : Infinity;
  const baselineDelta = Math.abs(
    (css.y + css.height) - (domInk.y + domInk.height),
  );
  const maxDeltaCssPx = Math.max(
    baselineDelta,
    deltaCssPx.x,
    deltaCssPx.width,
    deltaCssPx.height,
    deltaCssPx.y,
  );
  return {
    passed: textMatch && maxDeltaCssPx <= 1 && colorDelta <= 8,
    textMatch,
    colorMatch: colorDelta <= 8,
    expectedColorRgb: expectedColor,
    engineColorRgb: actualColor,
    domText: normalizeText(dom.text),
    engineText: normalizeText(engine.text),
    geometryMethod: "independently isolated DOM and engine text at unchanged layout; DPR 3 full-paper ink x/y/width/height/bottom tolerance 1 CSS px",
    baselineDeltaCssPx: Number(baselineDelta.toFixed(3)),
    domInk,
    engineInk,
    engineLayoutBox: engine.cssRect,
    deltaCssPx,
    maxDeltaCssPx,
    maxDeltaPt: Number((maxDeltaCssPx * 0.75).toFixed(3)),
  };
}

function rgbChannels(color) {
  const values = color?.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  return values?.length === 3 ? values : null;
}

function darkestInkColor(png) {
  let minimum = 620, result = null;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const sum = png.data[offset] + png.data[offset + 1] + png.data[offset + 2];
    if (png.data[offset + 3] > 0 && sum < minimum) {
      minimum = sum;
      result = [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
    }
  }
  return result;
}

function colorBounds(png, color, rect) {
  const expected = rgbChannels(color);
  if (!expected) return null;
  const left = Math.max(0, Math.floor(rect.x * geometryRasterScale));
  const top = Math.max(0, Math.floor(rect.y * geometryRasterScale));
  const right = Math.min(png.width, Math.ceil((rect.x + rect.width) * geometryRasterScale));
  const bottom = Math.min(png.height, Math.ceil((rect.y + rect.height) * geometryRasterScale));
  let minX = right, minY = bottom, maxX = -1, maxY = -1, pixels = 0, minimum = 620, darkestRgb = null;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * png.width + x) * 4;
    const sum = png.data[offset] + png.data[offset + 1] + png.data[offset + 2];
    if (png.data[offset + 3] > 0 && sum < minimum) {
      minimum = sum; darkestRgb = [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
    }
    if (png.data[offset + 3] > 0 && expected.every((value, index) => Math.abs(value - png.data[offset + index]) <= 12)) {
      pixels++; minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return pixels ? { x: minX / geometryRasterScale, y: minY / geometryRasterScale,
    width: (maxX - minX + 1) / geometryRasterScale, height: (maxY - minY + 1) / geometryRasterScale, pixels, darkestRgb } : null;
}

function compareDecorations(layout, domPng, enginePng) {
  const results = [];
  for (const [index, rect] of layout.unorderedMarkers.entries()) {
    const dom = colorBounds(domPng, "rgb(0, 0, 0)", rect);
    const engine = colorBounds(enginePng, "rgb(0, 0, 0)", rect);
    const delta = dom && engine ? Math.max(...["x", "y", "width", "height"].map(key => Math.abs(dom[key] - engine[key]))) : Infinity;
    results.push({ kind: "unorderedMarker", index, passed: delta <= 1, dom, engine,
      maxDeltaCssPx: Number.isFinite(delta) ? delta : null });
  }
  if (layout.headerRule) {
    const { color, rect } = layout.headerRule;
    const region = { ...rect, y: rect.y - 4, height: rect.height + 8 };
    const dom = colorBounds(domPng, color, region), engine = colorBounds(enginePng, color, region);
    const delta = dom && engine ? Math.max(...["x", "y", "width", "height"].map(key => Math.abs(dom[key] - engine[key]))) : Infinity;
    results.push({ kind: "headerRule", passed: delta <= 1, color, dom, engine, maxDeltaCssPx: Number.isFinite(delta) ? delta : null });
  }
  for (const [index, { kind, color, rect }] of layout.icons.entries()) {
    const dom = colorBounds(domPng, color, rect), engine = colorBounds(enginePng, color, rect);
    const expected = rgbChannels(color);
    const colorMatch = engine?.darkestRgb && expected.every((value, channel) => Math.abs(value - engine.darkestRgb[channel]) <= 8);
    results.push({ kind, index, passed: Boolean(dom && engine && colorMatch), color, dom, engine });
  }
  return { passed: results.every(result => result.passed), results,
    scope: "Unordered marker and header border geometry (1 CSS px), and visible section-icon theme color; fixed DOM regions reject missing/out-of-region output, never replace text geometry gates" };
}

function cssInkBounds(png) {
  const ink = inkBounds(png, { x: 0, y: 0, width: png.width, height: png.height }, 0);
  return ink && Object.fromEntries(Object.entries(ink).map(([key, value]) => [key, value / geometryRasterScale]));
}

function padPaperRaster(png, width, height) {
  const padded = new PNG({ width, height });
  padded.data.fill(255);
  PNG.bitblt(png, padded, 0, 0, png.width, png.height, 0, 0);
  return padded;
}

function engineTextRows(textMap, prefix) {
  const intervals = textMap.clusters
    .filter((cluster) => cluster.sourceNodeId.startsWith(prefix))
    .map((cluster) => {
      const y = cluster.yPt * (4 / 3);
      return { y, bottom: y + cluster.heightPt * (4 / 3) };
    })
    .sort((left, right) => left.y - right.y);
  const rows = [];
  for (const interval of intervals) {
    const row = rows.at(-1);
    if (row && interval.y < row.bottom - 0.5) {
      row.bottom = Math.max(row.bottom, interval.bottom);
    } else {
      rows.push({ ...interval });
    }
  }
  return rows.map(({ y, bottom }) => ({ y: Number(y.toFixed(3)), height: Number((bottom - y).toFixed(3)) }));
}

test("Typst engine vs DOM: three templates × three density states", { timeout: 1_200_000 }, async () => {
  assert.ok(
    (await readFile(engineExecutable).then(() => true, () => false)),
    `engine_render.exe is missing — run npm run build:engine-render first`,
  );
  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(join(outDir, "temporary-"));
  const baseStorage = visualFixture();
  // Native dist excludes duplicate font files. The browser fixture receives the
  // retained source bytes, checked against the same immutable input manifest.
  const inputManifest = JSON.parse(await readFile(join(root, "fixtures/remaining/manifest.json"), "utf8"));
  const fontAssets = new Map();
  for (const file of ["source-han-serif-cn-regular.otf", "source-han-serif-cn-heavy.ttf", "wondercv-iconfont.ttf", "wondercv-iconfont.woff2"]) {
    const path = `public/fonts/${file}`;
    const bytes = await readFile(join(root, path));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256, inputManifest.fixedInputs.fontAndTemplateSha256[path], `Comparison font hash: ${path}`);
    fontAssets.set(`/fonts/${file}`, { bytes, sha256,
      mime: file.endsWith("otf") ? "font/otf" : file.endsWith("woff2") ? "font/woff2" : "font/ttf" });
  }

  const server = await preview({
    configFile: false,
    root,
    plugins: [{ name: "engine-parity-preserved-fonts", configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const asset = fontAssets.get(request.url ?? "");
        if (!asset) { next(); return; }
        if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
        response.writeHead(200, { "Content-Type": asset.mime, "Content-Length": asset.bytes.length,
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-ZineCV-Font-SHA256": asset.sha256 });
        response.end(request.method === "HEAD" ? undefined : asset.bytes);
      });
    } }],
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: geometryRasterScale });
  const report = {
    schemaVersion: 2,
    visualAcceptance: "pending",
    scope: "Synthetic one-page geometry/text comparison; raster differences remain separate diagnostics and do not waive geometry thresholds",
    contract: {
      uiAnchorToleranceCssPx: 1,
      foregroundColorToleranceRgb: 8,
      headerDecorationGeometryToleranceCssPx: 1,
      geometryRasterScale,
      rasterPadding: "only white right/bottom rounding margins; no crop, shift, masking, or geometry waiver",
      paperGeometryTolerancePt: 0.75,
      densityState: "all three density values resolve inherited heading/paragraph/list spacing; authored layout controls and explicit overrides take precedence",
      historicalEngineParityDirectoryPreserved: true,
    },
    cases: [],
  };
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const sourceNodeIds = {
      educationParagraph: "entry:edu-1:b0:l0",
      orderedListOne: "entry:edu-1:b1:i0:b0:l0",
      orderedListTwo: "entry:edu-1:b1:i1:b0:l0",
      workTwoParagraph: "entry:work-2:b0:",
      unorderedListOne: "entry:work-1:b1:i0:b0:l0",
      unorderedListTwo: "entry:work-1:b1:i1:b0:l0",
      name: "basic:name",
      website: "basic:website",
      educationHeading: "section:legacy-section:education:head",
      educationTitle: "entry:edu-1:title",
      educationDates: "entry:edu-1:dates",
      workHeading: "section:legacy-section:work:head",
      workOneTitle: "entry:work-1:title",
      workOneDates: "entry:work-1:dates",
      workTwoTitle: "entry:work-2:title",
      workTwoDates: "entry:work-2:dates",
      projectsHeading: "section:legacy-section:projects:head",
      projectTitle: "entry:proj-1:title",
      projectDates: "entry:proj-1:dates",
      summaryHeading: "section:legacy-section:summary:head",
      skillsHeading: "section:legacy-section:skills:head",
    };
    for (const templateId of ["legacy-v1", "clear-single-v1", "compact-single-v1"]) {
      for (const density of ["comfortable", "standard", "compact"]) {
        const slug = `${templateId}-${density}`;
        const storage = fixtureStorageFor(templateId, density, baseStorage);
        const dom = await captureDomPaper(context, `http://127.0.0.1:${address.port}`, storage);
        const document = fixtureDocument(templateId, density);
        Object.assign(document.presentation, dom.layout.resolvedPresentation);

        const firstPage = await renderEnginePage(document, 0, workDir, slug, { isolateIds: Object.values(sourceNodeIds) });
        assert.ok(firstPage.ok, `${slug} engine page 0 render failed: ${firstPage.error ?? firstPage.stderr ?? firstPage.stdout}`);
        const enginePageCount = firstPage.pageCount;
        assert.equal(enginePageCount, 1, `${slug} synthetic fixture must produce exactly one page`);
        const enginePng = firstPage.png;
        const domPng = dom.png;
        assert.ok(Math.abs(enginePng.width - domPng.width) / geometryRasterScale <= 1, `${slug} A4 width mismatch`);
        assert.ok(Math.abs(enginePng.height - domPng.height) / geometryRasterScale <= 1, `${slug} A4 height mismatch`);

        const width = Math.max(domPng.width, enginePng.width);
        const height = Math.max(domPng.height, enginePng.height);
        const diff = new PNG({ width, height });
        const mismatched = pixelmatch(padPaperRaster(domPng, width, height).data,
          padPaperRaster(enginePng, width, height).data, diff.data, width, height, { threshold: 0.1 });
        const ratio = mismatched / (width * height);
        const decorations = compareDecorations(dom.layout.decorations, domPng, enginePng);
        const anchors = {};
        for (const [key, sourceNodeId] of Object.entries(sourceNodeIds)) {
          const isolated = PNG.sync.read(await readFile(join(firstPage.isolatedDirectory, `${sourceNodeId.replace(/[:/]/g, "_")}.png`)));
          anchors[key] = compareAnchor(dom.layout.anchors[key], engineAnchor(firstPage.textMap, sourceNodeId), isolated);
          // Negative controls exercise the actual comparison. A moved label
          // must fail even when a candidate-derived crop would hide the shift.
          const original = dom.layout.anchors[key];
          if (key === "name") {
            assert.equal(compareAnchor({ ...original, color: "rgb(17, 97, 211)" },
              engineAnchor(firstPage.textMap, sourceNodeId), isolated).passed, false,
            `${slug} unchanged geometry with the wrong foreground color must fail`);
          }
          for (const axis of ["x", "y"]) {
            for (const displacement of [-4, 4]) {
              const ink = anchors[key].engineInk;
              assert.ok(ink, `${slug}/${key} isolated engine text must exist`);
              const moved = { ...original, isolatedInk: { ...ink, [axis]: ink[axis] + displacement } };
              assert.equal(compareAnchor(moved, engineAnchor(firstPage.textMap, sourceNodeId), isolated).passed, false, `${slug}/${key} ${axis} displacement must be rejected`);
            }
          }
        }
        const requiredText = [
          "主修课程：数据结构、操作系统、编译原理",
          "GPA 3.8 / 4.0",
          "校级一等奖学金",
          "参与协作文档产品开发",
          "开源仓库",
          "三年全栈开发经验",
        ];
        const missingText = requiredText.filter((text) =>
          !normalizeText(dom.layout.text).includes(normalizeText(text)) ||
          !normalizeText(firstPage.textMap.logicalText).includes(normalizeText(text)),
        );
        const maxAnchorDeltaCssPx = Math.max(...Object.values(anchors).map((anchor) => anchor.maxDeltaCssPx ?? Infinity));
        const textRows = {
          education: { dom: dom.layout.textRows.education, engine: engineTextRows(firstPage.textMap, "entry:edu-1:b") },
          workOne: { dom: dom.layout.textRows.workOne, engine: engineTextRows(firstPage.textMap, "entry:work-1:b") },
          workTwo: { dom: dom.layout.textRows.workTwo, engine: engineTextRows(firstPage.textMap, "entry:work-2:b") },
          project: { dom: dom.layout.textRows.project, engine: engineTextRows(firstPage.textMap, "entry:proj-1:b") },
          summary: { dom: dom.layout.textRows.summary, engine: engineTextRows(firstPage.textMap, "section:legacy-section:summary:b") },
        };
        const lineCountsMatch = Object.values(textRows).every((item) => item.dom.length === item.engine.length);
        const pageGeometry = {
          widthDeltaCssPx: Number(Math.abs(dom.layout.paper.width - enginePng.width / geometryRasterScale).toFixed(3)),
          heightDeltaCssPx: Number(Math.abs(dom.layout.paper.height - enginePng.height / geometryRasterScale).toFixed(3)),
        };
        const geometryPassed =
          Object.values(anchors).every((anchor) => anchor.passed) &&
          decorations.passed &&
          pageGeometry.widthDeltaCssPx <= 1 &&
          pageGeometry.heightDeltaCssPx <= 1 &&
          dom.layout.pageCount === enginePageCount;
        const caseReport = {
          templateId,
          density,
          densityChangesResolvedLayout: false,
          domPageCount: dom.layout.pageCount,
          enginePageCount,
          engineFontIdentity: firstPage.fontIdentity,
          domLayout: {
            paper: dom.layout.paper,
            resolvedPresentation: dom.layout.resolvedPresentation,
            style: dom.layout.style,
            blocks: dom.layout.blocks,
            lineStyles: dom.layout.lineStyles,
          },
          pageGeometry,
          anchors,
          decorations,
          textRows,
          lineCountsMatch,
          maxAnchorDeltaCssPx: Number(maxAnchorDeltaCssPx.toFixed(3)),
          missingText,
          geometryPassed,
          rasterDiagnostic: {
            mismatchedPixels: mismatched,
            diffRatio: Number(ratio.toFixed(5)),
            gate: "diagnostic_only; no threshold changes or masking",
          },
        };
        report.cases.push(caseReport);

        const { Readable } = await import("node:stream");
        await pipeline(Readable.from(PNG.sync.write(domPng)), createWriteStream(join(outDir, `dom-${slug}.png`)));
        await pipeline(Readable.from(PNG.sync.write(enginePng)), createWriteStream(join(outDir, `engine-${slug}.png`)));
        await pipeline(Readable.from(PNG.sync.write(diff)), createWriteStream(join(outDir, `diff-${slug}.png`)));

        // This reports the fixed geometry contract; any failure keeps B07 open.
      }
    }
    report.visualAcceptance = report.cases.every((item) => item.geometryPassed && item.missingText.length === 0)
      ? "geometry_and_text_passed; visual_review_pending"
      : "failed_geometry_or_text_contract";
    await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log("ENGINE_PARITY_SUMMARY:", JSON.stringify({
      visualAcceptance: report.visualAcceptance,
      cases: report.cases.length,
      passedCases: report.cases.filter((item) => item.geometryPassed && item.missingText.length === 0).length,
      maxAnchorDeltaCssPx: Math.max(...report.cases.map((item) => item.maxAnchorDeltaCssPx)),
      lineCountMismatches: report.cases.filter((item) => !item.lineCountsMatch).length,
      maxRasterDiffRatio: Math.max(...report.cases.map((item) => item.rasterDiagnostic.diffRatio)),
    }));
    assert.equal(report.visualAcceptance, "geometry_and_text_passed; visual_review_pending", "B07 UI anchor/text contract failed; inspect the R10 report and images");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((done, reject) => server.httpServer.close((error) => (error ? reject(error) : done())));
    await rm(workDir, { recursive: true, force: true });
  }
});
