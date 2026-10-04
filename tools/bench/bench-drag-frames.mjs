// P13/R29 基准 3/6：编辑器模块拖拽期间帧间隔 p95（真实 WebView2 宿主）。
//
// 测量口径：
//   编辑器视图内，对第一个 `[data-editor-module]` 的 `.section-heading` 按下指针并激活
//   拖拽（5px 阈值后出现 ghost，processDragFrame 在 requestAnimationFrame 中执行排序
//   预览与 transform 更新），随后在前两个模块卡片的翻转区之间往复移动触发排序翻转，
//   最后抬起（偶数次翻转，保证模块顺序还原）。帧数据由页面内 rAF 采样器采集：
//   - frameIntervalMs：相邻两次 rAF 回调的间隔（受垂直同步约束，60Hz 下约 16.7ms）；
//   - orderFlips：采样期内 [data-editor-module] 序列发生变化的总次数（拖拽确实生效）；
//   - longTask：PerformanceObserver 记录的 >50ms 主线程长任务（拖拽卡顿证据）。
//   指针事件经 Playwright/CDP 合成注入，速率约为每步 8-12ms。
// 阈值：frameInterval p95 ≤ 16.7ms（docs/REMAINING_WORK_PLAN_20261001.md P13，
//       即 60Hz 单帧预算）；orderFlips 总数 > 0；longTask 0 条为佳（仅记录不判阈值）。
//       注意分位数基于升序排序后的数组（历史工具 max 未排序 bug 在本脚本中不可复现）。
// 输出 JSON 字段：
//   schemaVersion/runId/capturedAt/status/error/scope/threshold
//   sessions: [{ index, frames, orderFlips, longTasks }]
//   aggregate: { count/p50/p95/max, over16_7Count, over16_7Ratio, over33_4Count, medianIntervalMs }
//   longTasks: { count, maxMs }
//   passed / executable / environment
// 运行命令：node tools/bench/bench-drag-frames.mjs [--sessions 5]
// 前置：npm run build:native 已产出 release 宿主；不与其它 webview 测试并行；
//       窗口保持可见（夹具已带禁用后台节流参数，但物理遮挡仍可能拉长帧间隔）。
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import {
  assertHostExecutable,
  evidenceRoot,
  parseArgs,
  summarize,
  writeEvidence,
} from "./lib.mjs";
import { startNativeHost, stopNativeHost } from "../../tests/native/host-fixture.mjs";

const args = parseArgs(process.argv.slice(2));
const sessionCount = Math.max(1, Number(args.sessions ?? 5));
const thresholdP95Ms = 16.7;

async function main() {
  const runId = `drag-frames-${Date.now()}`;
  const executable = await assertHostExecutable();
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-drag-"));
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    status: "failed",
    error: null,
    scope: "real WebView2 host; synthetic pointer drag between two adjacent editor module headings; in-page rAF sampler",
    threshold: { frameIntervalP95Ms: thresholdP95Ms, requireOrderFlips: true },
    sessions: [],
    frameIntervalsMs: [],
  };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;
    await host.page.locator("button[aria-label='简历编辑']").click().catch(() => {});
    const summaryHeading = host.page.locator("[data-editor-module='summary'] .section-heading");
    await summaryHeading.waitFor({ timeout: 20_000 });
    // 把 Re:me 助手最小化为 Bot（真实用户常规操作），避免右下浮动面板遮挡编辑器卡片
    // 导致 elementFromPoint 命中浮层而无法翻转排序；非测量段。
    const minimizeAgent = host.page.locator("button[aria-label='最小化到 Bot']");
    if (await minimizeAgent.isVisible().catch(() => false)) await minimizeAgent.click();

    // 安装 rAF 采样器与长任务观察器。
    // 采样器以代际计数保证每次 start() 独占循环：stop() 后遗留的 tick 在下次 start()
    // 时必须自行终止（否则并发多循环会把同一帧记为 0 间隔并复活负值首间隔）；
    // 每个 start() 重置缓冲区，首帧仅对齐 last 不记录（避免与 performance.now() 时钟差）。
    await host.page.evaluate(() => {
      const state = { intervals: [], orders: [], longTasks: [], running: false };
      let generation = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
      const orderSnapshot = () => [...document.querySelectorAll("[data-editor-module]")]
        .map((element) => element.dataset.editorModule).join(">");
      window.__r29DragSampler = {
        start() {
          generation += 1;
          const mine = generation;
          state.intervals = [];
          state.orders = [];
          state.longTasks = [];
          state.running = true;
          let primed = false;
          let last = performance.now();
          const tick = (now) => {
            if (!state.running || mine !== generation) return;
            if (!primed) {
              primed = true;
              last = now;
              requestAnimationFrame(tick);
              return;
            }
            state.intervals.push(now - last);
            state.orders.push(orderSnapshot());
            last = now;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        stop() {
          state.running = false;
          observer.disconnect();
          const flips = state.orders.reduce(
            (count, order, index) => (index > 0 && order !== state.orders[index - 1] ? count + 1 : count), 0,
          );
          return { intervals: [...state.intervals], orderFlips: flips, longTasks: [...state.longTasks] };
        },
      };
    });

    for (let index = 0; index < sessionCount; index += 1) {
      // 按下点：第一个模块标题中心（拖拽句柄为 .section-heading）。
      const press = await host.page.evaluate(() => {
        const first = document.querySelector("[data-editor-module]");
        const heading = first.querySelector(".section-heading");
        const rect = heading.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });

      await host.page.evaluate(() => window.__r29DragSampler.start());
      await host.page.mouse.move(press.x, press.y);
      await host.page.mouse.down();
      // 8px 激活拖拽（超过 5px 阈值）。
      await host.page.mouse.move(press.x + 2, press.y + 8, { steps: 4 });
      // 在前两个模块卡片的翻转区之间往复 6 次。翻转判据要求指针越过目标卡片
      // 62%/38% 高度线，因此下行目标取槽位 1 卡片底部上方 0.2×min 高度处、
      // 上行目标取槽位 0 卡片顶部下方 0.2×min 高度处；每半程按当前 DOM 重取
      // 几何（翻转后 displayModuleOrder 立即重排，固定标题坐标会失效）。
      for (let pass = 0; pass < 6; pass += 1) {
        const goingDown = pass % 2 === 0;
        const target = await host.page.evaluate((down) => {
          const cards = [...document.querySelectorAll("[data-editor-module]")]
            .slice(0, 2)
            .map((element) => element.getBoundingClientRect());
          const minHeight = Math.min(cards[0].height, cards[1].height);
          const x = cards[0].left + cards[0].width / 2;
          return down
            ? { x, y: cards[1].bottom - minHeight * 0.2 }
            : { x, y: cards[0].top + minHeight * 0.2 };
        }, goingDown);
        await host.page.mouse.move(target.x, target.y, { steps: 10 });
        await new Promise((done) => setTimeout(done, 12));
      }
      await host.page.mouse.up();
      await new Promise((done) => setTimeout(done, 250));
      const session = await host.page.evaluate(() => window.__r29DragSampler.stop());
      report.sessions.push({
        index: index + 1,
        frames: session.intervals.length,
        orderFlips: session.orderFlips,
        longTasks: session.longTasks.length,
      });
      report.frameIntervalsMs.push(...session.intervals.map((value) => Math.round(value * 1000) / 1000));
      if (session.longTasks.length) {
        report.longTasksDetail = report.longTasksDetail ?? [];
        report.longTasksDetail.push(...session.longTasks);
      }
      await host.page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 }).catch(() => {});
    }

    const aggregate = summarize(report.frameIntervalsMs);
    const sortedIntervals = [...report.frameIntervalsMs].sort((left, right) => left - right);
    report.aggregate = {
      ...aggregate,
      over16_7Count: sortedIntervals.filter((value) => value > 16.7).length,
      over16_7Ratio: sortedIntervals.length
        ? Math.round((sortedIntervals.filter((value) => value > 16.7).length / sortedIntervals.length) * 10000) / 10000
        : null,
      over33_4Count: sortedIntervals.filter((value) => value > 33.4).length,
      medianIntervalMs: aggregate.p50,
    };
    const longTasks = report.sessions.reduce((sum, session) => sum + session.longTasks, 0);
    report.longTasks = { count: longTasks, maxMs: report.longTasksDetail ? Math.max(...report.longTasksDetail) : null };
    delete report.longTasksDetail;
    const totalFlips = report.sessions.reduce((sum, session) => sum + session.orderFlips, 0);
    report.totalOrderFlips = totalFlips;
    report.passed = aggregate.p95 !== null
      && aggregate.p95 <= thresholdP95Ms
      && totalFlips > 0;
    report.status = report.passed ? "passed" : "threshold-exceeded";
    passed = true;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    await stopNativeHost(host).catch(() => {});
    report.executable = { path: executable };
    report.environment = {
      os: `${platform()} ${release()}`,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    };
    const output = await writeEvidence("drag-frames", report);
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    else report.keptProfile = "失败运行保留隔离 profile 以便诊断";
    console.log(JSON.stringify({
      status: report.status,
      output,
      threshold: report.threshold,
      aggregate: report.aggregate ?? null,
      totalOrderFlips: report.totalOrderFlips ?? 0,
      longTasks: report.longTasks ?? null,
      passed: report.passed ?? false,
      error: report.error,
    }, null, 2));
    // 阈值超标/blocked/失败都必须以非零退出码暴露给门禁编排，不能只写在 report 里。
    if (report.status !== "passed") process.exitCode = 1;
  }
}

await main();
