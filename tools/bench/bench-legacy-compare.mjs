// P13/R29 基准 6/6：旧版（D:\Desktop\resume DIY，纯 Vite Web 应用）同口径对照。
//
// 【运行条件】
// 外部条件（运行前必须全部满足，缺任一项本脚本会以 blocked 退出并在报告中记录）：
//   1. D:\Desktop\resume DIY 存在且 node_modules 已安装（旧版依赖不由本仓库管理）；
//   2. 本机可启动独立 Vite dev server：端口取 LEGACY_BENCH_PORT（默认 5199，strictPort），
//      绝不连接/控制用户可能在 5173 打开的页面——本脚本只访问自己拉起的 server；
//   3. 浏览器使用 Playwright 自带 chromium 的全新持久化 profile（.artifacts 下临时目录），
//      与用户日常浏览器 profile 完全隔离；
//   4. 测量窗口内机器空闲（同其余基准）。
//
// 测量口径（与基准 1/3 同口径，只读测量）：
//   - 输入→预览端到端：fill 姓名 → .paper 文本可见；
//   - 模板切换：旧版模板库卡片点击 → 编辑器纸面 data-template-id 更新；
//   - 拖拽帧：旧版编辑器模块指针拖拽，rAF 帧间隔及实际排序翻转。
//   只读约束：不触发版本提交/备份类操作；旧版 localStorage 写入仅落在临时浏览器 profile。
//   无同口径对应项：PDF 导出（旧版为浏览器打印/截图链路）、版本提交（旧版无 SQLite 权威
//   版本库）、导入并发/取消（旧版无原生导入管道）——输出中记为 null 并注明原因。
//
// 阈值：与新版一致（模板切换 total p95 ≤500ms；拖拽帧 p95 ≤16.7ms 且真实翻转；输入 e2e 仅记录）。
// 输出 JSON 字段：
//   schemaVersion/runId/capturedAt/status(blocked|passed|failed|threshold-exceeded)/error
//   blockedReason（blocked 时）/legacyRoot/devServer{port,command}/metrics{...}/notes
// 运行命令：node tools/bench/bench-legacy-compare.mjs [--legacy-root "D:\Desktop\resume DIY"] [--port 5199]
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { chromium } from "playwright";
import { evidenceRoot, parseArgs, summarize, writeEvidence } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const legacyRoot = resolve(args["legacy-root"] ?? "D:\\Desktop\\resume DIY");
const requestedPort = Number(args.port ?? process.env.LEGACY_BENCH_PORT ?? 5199);
const SELECTORS = {
  basicNameInput: ".basic-form .field:has-text('姓名') input",
  paperText: ".paper-frame .paper",
  templateCard: ".template-library-card.imported .template-library-select",
  paperFrame: ".paper-frame .paper",
};
const seeds = [
  { id: "legacy-bench-clear", name: "旧版基准-清晰", formatId: "clear-single-v1" },
  { id: "legacy-bench-compact", name: "旧版基准-紧凑", formatId: "compact-single-v1" },
].map((seed) => ({
  ...seed, sourceName: seed.id + ".png", sourceType: "image",
  createdAt: "2026-10-02T00:00:00.000Z", accent: "#111827",
  layout: "single-column", analysis: "隔离基准合成模板",
  recognitionConfidence: "high", recognitionWarnings: [],
}));

async function portAvailable(port) {
  const server = createServer();
  try {
    await new Promise((done, reject) => server.once("error", reject).listen(port, "127.0.0.1", done));
    await new Promise((done) => server.close(done));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const runId = `legacy-compare-${Date.now()}`;
  await mkdir(evidenceRoot, { recursive: true });
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    status: "failed",
    error: null,
    scope: "legacy Vite web app (resume DIY) same-criteria read-only comparison; isolated dev server + isolated browser profile; never touches any user-opened 5173 page",
    legacyRoot,
    devServer: { port: requestedPort, command: `node node_modules/vite/bin/vite.js --port ${requestedPort} --strictPort` },
    metrics: {
      inputE2E: null,
      templateSwitch: null,
      dragFrames: null,
      pdfExport: null, // 无同口径对应：旧版为浏览器打印/截图链路
      versionCommit: null, // 无同口径对应：旧版无 SQLite 权威版本库
      importConcurrency: null, // 无同口径对应：旧版无原生导入管道
    },
    notes: [
      "旧版 DOM 选择器依据 D:\\Desktop\\resume DIY 源码校准；仅临时 profile 中注入两张视觉样式模板。",
      "只读测量：不触发旧版版本提交/备份；浏览器写入仅落在临时 profile。",
      "对照口径与新版基准 1（bench-template-switch）、3（bench-drag-frames）一致。",
    ],
  };
  let serverProcess;
  let browser;
  let profileDir;
  try {
    // 外部条件检查：旧版仓库与依赖。
    await access(join(legacyRoot, "package.json"), constants.F_OK);
    await access(join(legacyRoot, "node_modules", "vite", "bin", "vite.js"), constants.F_OK);
    if (!(await portAvailable(requestedPort))) {
      report.status = "blocked";
      report.blockedReason = `端口 ${requestedPort} 已被占用（含用户可能已启动的旧版 dev server）；本脚本不连接既有 server，请换 --port 重试`;
      throw new Error(report.blockedReason);
    }
    profileDir = await mkdtemp(join(evidenceRoot, "profile-legacy-"));

    // 启动独立 dev server（不使用用户的 5173 实例）。
    serverProcess = spawn(process.execPath, [join(legacyRoot, "node_modules", "vite", "bin", "vite.js"), "--port", String(requestedPort), "--strictPort"], {
      cwd: legacyRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverOutput = "";
    serverProcess.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    serverProcess.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    const url = `http://127.0.0.1:${requestedPort}/`;
    let up = false;
    for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
      if (serverProcess.exitCode !== null) throw new Error(`旧版 dev server 提前退出：${serverOutput.slice(-400)}`);
      up = await fetch(url).then((response) => response.ok).catch(() => false);
      if (!up) await new Promise((done) => setTimeout(done, 250));
    }
    if (!up) throw new Error(`旧版 dev server 未在预期时间内就绪：${serverOutput.slice(-400)}`);

    // 独立浏览器 profile（Playwright 自带 chromium，非用户浏览器）。
    browser = await chromium.launchPersistentContext(profileDir, { headless: true });
    const page = browser.pages()[0] ?? await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await page.locator(".app-shell").waitFor({ timeout: 30_000 });
    await page.evaluate((templates) => {
      localStorage.setItem("resume-diy-imported-templates-v1", JSON.stringify(templates));
    }, seeds);
    await page.reload();
    const agentMinimize = page.locator("button[aria-label='最小化到 Bot']");
    if (await agentMinimize.isVisible().catch(() => false)) await agentMinimize.click();

    await page.locator("button[aria-label='展开编辑基本信息']").click();
    const nameInput = page.locator(SELECTORS.basicNameInput);
    await nameInput.waitFor();
    const inputSamples = [];
    for (let index = 0; index < 5; index += 1) {
      const value = `旧版基准${index}`;
      const start = performance.now();
      await nameInput.fill(value);
      await page.locator(SELECTORS.paperText).first().getByText(value, { exact: false }).waitFor();
      inputSamples.push(performance.now() - start);
    }
    report.metrics.inputE2E = summarize(inputSamples);
    await page.locator(".basic-form .save-button").click();

    const switchSamples = [];
    for (let index = 0; index < 6; index += 1) {
      const seed = seeds[index % seeds.length];
      await page.locator("button[aria-label='模板']").click();
      const card = page.locator(".template-library-card.imported", { hasText: seed.name });
      await card.waitFor();
      const start = performance.now();
      await card.locator(".template-library-select").click();
      await page.locator("button[aria-label='简历编辑']").click();
      await page.locator(`${SELECTORS.paperFrame}[data-template-id='${seed.formatId}']`).first().waitFor();
      switchSamples.push(performance.now() - start);
    }
    report.metrics.templateSwitch = summarize(switchSamples);

    await page.evaluate(() => {
      const state = { intervals: [], orders: [], running: false, last: null };
      window.__legacyDragSample = {
        start() {
          state.intervals = []; state.orders = []; state.running = true; state.last = null;
          const tick = (now) => {
            if (!state.running) return;
            if (state.last !== null) {
              state.intervals.push(Math.round((now - state.last) * 1000) / 1000);
              state.orders.push([...document.querySelectorAll("[data-editor-module]")]
                .map((item) => item.getAttribute("data-editor-module")).join(">"));
            }
            state.last = now;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        stop() {
          state.running = false;
          return { intervals: state.intervals,
            orderFlips: state.orders.reduce((count, order, index) =>
              count + (index > 0 && order !== state.orders[index - 1] ? 1 : 0), 0) };
        },
      };
    });
    const intervals = [];
    let orderFlips = 0;
    for (let index = 0; index < 3; index += 1) {
      const heading = page.locator("[data-editor-module] .section-heading").first();
      await heading.scrollIntoViewIfNeeded();
      const box = await heading.boundingBox();
      if (!box) throw new Error("旧版拖拽标题没有可用几何");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.evaluate(() => window.__legacyDragSample.start());
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 2, y + 8, { steps: 4 });
      for (let pass = 0; pass < 6; pass += 1) {
        const point = await page.evaluate((down) => {
          const cards = [...document.querySelectorAll("[data-editor-module]")].slice(0, 2)
            .map((item) => item.getBoundingClientRect());
          const minHeight = Math.min(cards[0].height, cards[1].height);
          return { x: cards[0].left + cards[0].width / 2,
            y: down ? cards[1].bottom - minHeight * 0.2 : cards[0].top + minHeight * 0.2 };
        }, pass % 2 === 0);
        await page.mouse.move(point.x, point.y, { steps: 10 });
        await new Promise((done) => setTimeout(done, 12));
      }
      await page.mouse.up();
      await new Promise((done) => setTimeout(done, 200));
      const session = await page.evaluate(() => window.__legacyDragSample.stop());
      intervals.push(...session.intervals);
      orderFlips += session.orderFlips;
    }
    report.metrics.dragFrames = summarize(intervals);
    report.metrics.dragFrames.over16_7Count = intervals.filter((value) => value > 16.7).length;
    report.metrics.dragFrames.over16_7Ratio = intervals.length
      ? report.metrics.dragFrames.over16_7Count / intervals.length : null;
    report.metrics.dragFrames.orderFlips = orderFlips;
    report.threshold = { templateSwitchP95Ms: 500, dragFrameP95Ms: 16.7 };
    report.passed = report.metrics.templateSwitch.p95 <= 500
      && report.metrics.dragFrames.p95 <= 16.7 && orderFlips > 0;
    report.status = report.passed ? "passed" : "threshold-exceeded";
  } catch (error) {
    report.error = String(error?.stack ?? error);
    if (report.status !== "blocked") process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise((done) => setTimeout(done, 500));
    }
    if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
    report.environment = {
      os: `${platform()} ${release()}`,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    };
    const output = await writeEvidence("legacy-compare", report);
    console.log(JSON.stringify({
      status: report.status,
      output,
      blockedReason: report.blockedReason ?? null,
      error: report.error,
    }, null, 2));
    // 阈值超标/blocked/失败都必须以非零退出码暴露给门禁编排，不能只写在 report 里。
    if (report.status !== "passed") process.exitCode = 1;
  }
}

await main();
