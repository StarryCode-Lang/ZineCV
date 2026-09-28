// 新旧版本预览视觉对照：同一 Chromium、同一虚构夹具数据、同一视口，
// 分别渲染旧版 dist 与桌面版 dist，对右侧 A4 纸面区域逐像素比较。
// 该比较证明"同一输入在两套构建里的排版输出一致"；WebView2 的原生滚动条
// 差异属于宿主层，另行在真实 exe 验收中覆盖。
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { preview } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { resolve } from "node:path";

const oldRoot = "D:/Desktop/resume DIY";
const newRoot = resolve(import.meta.dirname, "..");
const moduleKeys = ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"];

function fixtureStorage() {
  const resume = {
    basic: {
      name: "张三", phone: "138-0000-0000", email: "zhangsan@example.com",
      city: "上海", wechat: "zhangsan_dev", birth: "2001-06",
      ageMode: "birthday", website: "https://zhangsan.example.com",
      linkedin: "", gender: "", height: "", weight: "", ethnicity: "",
      birthplace: "", politicalStatus: "", maritalStatus: "", zodiac: "", mbti: "",
      avatar: "",
    },
    ...Object.fromEntries(moduleKeys.map((key) => [key, []])),
    summary: "<p>三年全栈开发经验，熟悉<b>React 与 Rust</b>，擅长把复杂系统拆成可维护的小模块。</p>",
    education: [{
      id: "edu-1", title: "某某大学", role: "计算机科学与技术", department: "", city: "",
      start: "2019-09", end: "2023-06", html: "<p>主修课程：数据结构、操作系统、编译原理</p><ol><li>GPA 3.8 / 4.0</li><li>校级一等奖学金</li></ol>",
    }],
    work: [
      { id: "work-1", title: "某科技公司", role: "前端工程师", department: "平台组", city: "上海", start: "2023-07", end: "至今", html: "<p>负责简历编辑器核心链路，<u>性能优化</u>与稳定性建设。</p><ul><li>首屏加载从 3s 降至 1s</li><li>崩溃率下降 40%</li></ul>" },
      { id: "work-2", title: "某创业公司", role: "实习工程师", department: "", city: "杭州", start: "2022-12", end: "2023-05", html: "<p>参与协作文档产品开发，负责<em>光标协同</em>与离线缓存。</p>" },
    ],
    projects: [{ id: "proj-1", title: "开源简历引擎", role: "", department: "", city: "", start: "2024-01", end: "2024-08", html: "<p>基于 Web 的所见即所得简历编辑器，支持<a href=\"https://example.com/repo\">开源仓库</a>。</p>" }],
  };
  const moduleOrder = ["education", "work", "projects", "summary", "skills"];
  const moduleNames = Object.fromEntries(moduleKeys.map((key) => [key, key === "work" ? "实习经历" : key]));
  const preferences = {
    font: "宋体", fontSize: "13", lineHeight: "13", moduleSpacing: "0",
    pageMargin: "30", theme: "#000000", smartFillV2: "false",
    dateFormat: "2021年1月", titleFormat: "单行标题", separator: "使用分隔符号", textAlign: "两端对齐",
  };
  return {
    "resume-diy-state": JSON.stringify(resume),
    "resume-diy-presentation-v1": JSON.stringify({ templateId: "legacy-v1", templateVersion: 1, densityPreset: "standard", overrides: {} }),
    "resume-diy-section-order-v2": JSON.stringify(moduleOrder),
    "resume-diy-modules": JSON.stringify(moduleOrder),
    "resume-diy-module-names": JSON.stringify(moduleNames),
    "resume-diy-title": "视觉对照简历",
    "resume-diy-summary-title": "自我评价",
    "resume-diy-preferences": JSON.stringify(preferences),
    "resume-diy-layout-consistency-v1": "true",
  };
}

async function servePreview(root) {
  const server = await preview({
    configFile: false,
    root,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function capturePaper(context, url, storage, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  // 在应用脚本执行前注入夹具：旧版 pagehide 的 flushDraft 会用当前状态覆盖
  // localStorage，必须在首帧之前就位，避免 reload 时被空白状态冲掉。
  await page.addInitScript((entries) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(url, { waitUntil: "networkidle" });
  const paper = page.locator(".paper-frame").first();
  await paper.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600); // 字体加载与动效余量
  const shot = await paper.screenshot({ animations: "disabled" });
  await page.close();
  return shot;
}

test("old and desktop builds render identical A4 preview pixels from the same fixture", { timeout: 120_000 }, async () => {
  const oldServer = await servePreview(oldRoot);
  const newServer = await servePreview(newRoot);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const storage = fixtureStorage();
    const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
    const results = [];
    for (const viewport of viewports) {
      const oldShot = await capturePaper(context, oldServer.url, storage, viewport);
      const newShot = await capturePaper(context, newServer.url, storage, viewport);
      const oldPng = PNG.sync.read(oldShot);
      const newPng = PNG.sync.read(newShot);
      assert.equal(oldPng.width, newPng.width, `paper width mismatch at ${viewport.width}`);
      assert.equal(oldPng.height, newPng.height, `paper height mismatch at ${viewport.width}`);
      const diff = new PNG({ width: oldPng.width, height: oldPng.height });
      const mismatched = pixelmatch(oldPng.data, newPng.data, diff.data, oldPng.width, oldPng.height, { threshold: 0.1 });
      const ratio = mismatched / (oldPng.width * oldPng.height);
      results.push({ viewport: `${viewport.width}x${viewport.height}`, width: oldPng.width, height: oldPng.height, mismatchedPixels: mismatched, diffRatio: Number(ratio.toFixed(5)) });
    }
    console.log("VISUAL_PARITY:", JSON.stringify(results));
    for (const result of results) {
      // 完全相同的组件树、样式与字体下，差异应几乎为零；0.2% 作为报警阈值。
      assert.ok(result.diffRatio <= 0.002, `preview diff ${result.diffRatio} exceeds 0.2% at ${result.viewport}`);
    }
  } finally {
    await context.close();
    await browser.close();
    await new Promise((done, reject) => oldServer.server.httpServer.close((error) => error ? reject(error) : done()));
    await new Promise((done, reject) => newServer.server.httpServer.close((error) => error ? reject(error) : done()));
  }
});
