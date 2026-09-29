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
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { visualFixture } from "./visual-parity-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const engineExecutable = join(root, "src-tauri", "target", "release", "examples", "engine_render.exe");
const outDir = join(root, ".artifacts", "engine-parity");

// 与 visualFixture() 同一内容的 ResumeDocument 表示（内容按构造等价，
// HTML→RichBlock 的转换正确性由 tests/browser/document-bridge.test.mjs
// 单独覆盖；本工具只测“同一内容的两套排版输出”）。
function fixtureDocument() {
  const text = (t, marks = []) => ({ type: "text", text: t, marks });
  const paragraph = (children) => ({ type: "paragraph", children });
  const section = (id, kind, title, entries) => ({ id, kind, title, visible: true, entries });
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
      templateId: "legacy-v1", templateRevision: "1", density: "standard",
      fontSetId: "legacy-font:宋体", fontSizePt: 9.75, lineHeightPt: 9.75,
      moduleGapPt: 0, pageMarginPt: 22.5, headingSizePt: 9.75,
      paragraphGapPt: 0, listGapPt: 0, theme: "#000000",
      dateFormat: "2021年1月", titleFormat: "单行标题",
      separator: "使用分隔符号", textAlign: "两端对齐", legacyOverrides: {},
    },
    legacyExtensions: {},
  };
}

async function renderEnginePage(document, pageIndex, workDir) {
  const documentPath = join(workDir, `document-${pageIndex}.json`);
  const outputPath = join(workDir, `engine-${pageIndex}.png`);
  await writeFile(documentPath, JSON.stringify(document, null, 2));
  const run = spawnSync(engineExecutable, [documentPath, outputPath, String(pageIndex), "1.333333"], { encoding: "utf8" });
  if (run.status !== 0) {
    return { ok: false, stdout: run.stdout, stderr: run.stderr, status: run.status };
  }
  return { ok: true, png: PNG.sync.read(await readFile(outputPath)), outputPath };
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
  await page.waitForTimeout(600); // 字体加载与动效余量
  const shot = await paper.screenshot({ animations: "disabled" });
  await page.close();
  return PNG.sync.read(shot);
}

test("typst engine paper vs dom paper on the shared fixture", { timeout: 120_000 }, async () => {
  assert.ok(
    (await readFile(engineExecutable).then(() => true, () => false)),
    `engine_render.exe is missing — run npm run build:engine-render first`,
  );
  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "zinecv-engine-parity-"));
  const document = fixtureDocument();
  const storage = visualFixture();

  const server = await preview({
    configFile: false,
    root,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const report = { pages: [] };
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const domPng = await captureDomPaper(context, `http://127.0.0.1:${address.port}`, storage);

    const firstPage = await renderEnginePage(document, 0, workDir);
    assert.ok(firstPage.ok, `engine page 0 render failed: ${firstPage.stderr ?? firstPage.stdout}`);
    // 引擎页数：第 2 页应超出范围（fixture 为单页内容）。
    const secondPage = await renderEnginePage(document, 1, workDir);
    const enginePageCount = secondPage.ok ? 2 : 1;

    const enginePng = firstPage.png;
    report.enginePageCount = enginePageCount;
    report.domSize = { width: domPng.width, height: domPng.height };
    report.engineSize = { width: enginePng.width, height: enginePng.height };

    const width = Math.max(domPng.width, enginePng.width);
    const height = Math.max(domPng.height, enginePng.height);
    const diff = new PNG({ width, height });
    const mismatched = pixelmatch(domPng.data, enginePng.data, diff.data, width, height, { threshold: 0.1 });
    const ratio = mismatched / (width * height);
    report.pages.push({
      viewport: `${width}x${height}`,
      mismatchedPixels: mismatched,
      diffRatio: Number(ratio.toFixed(5)),
    });

    const { Readable } = await import("node:stream");
    await pipeline(Readable.from(PNG.sync.write(domPng)), createWriteStream(join(outDir, "dom.png")));
    await pipeline(Readable.from(PNG.sync.write(enginePng)), createWriteStream(join(outDir, "engine.png")));
    await pipeline(Readable.from(PNG.sync.write(diff)), createWriteStream(join(outDir, "diff.png")));
    await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));

    console.log("ENGINE_PARITY:", JSON.stringify(report));
    // 尺寸必须一致（同一 A4、同一 px-per-pt 基准）。
    assert.equal(enginePng.width, domPng.width, `engine width ${enginePng.width} != dom width ${domPng.width}`);
    assert.equal(enginePng.height, domPng.height, `engine height ${enginePng.height} != dom height ${domPng.height}`);
    // 首轮量化的差异率作为报警基线记录；B07 验收门槛待该数据
    // 收敛后按计划的 0.75pt 关键块标准固定，不在首轮强设。
    assert.ok(ratio < 0.5, `engine/dom diff ratio ${ratio} unexpectedly huge — check template`);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((done, reject) => server.httpServer.close((error) => (error ? reject(error) : done())));
  }
});
