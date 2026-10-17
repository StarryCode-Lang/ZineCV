// P13/R29 基准 1/6：模板切换端到端延迟（真实 WebView2 宿主）。
//
// 测量口径：
//   合成注入两个"仅视觉样式"导入模板（formatId = clear-single-v1 / compact-single-v1，
//   不含 resume 正文，经 write_imported_template_catalog 写入原生目录），重启页面后走
//   真实用户路径：点击左栏"模板" → 点击模板卡片（applyTemplate → flushDraftBeforeVersionAction
//   + apply_document_command 写入 importedTemplate 扩展 + presentation 重置）→ 出现
//   "已应用/已切换"通知（阶段 A，含原生命令与提交）→ 点击左栏"简历编辑" →
//   `.paper-frame .paper[data-template-id="<目标>"]` 可见（阶段 B，含视图切换与预览重绘）。
//   样本耗时 = 阶段 A + 阶段 B（含 Playwright/CDP 传输开销，与 bench-webview.mjs 同口径，
//   humanInputComparable: false）。
// 阈值：total p95 ≤ 500ms（docs/REMAINING_WORK_PLAN_20261001.md P13）。
// 输出 JSON 字段：
//   schemaVersion/runId/capturedAt/status/error/scope/comparability/threshold
//   templateCatalog（注入的两个模板 id/name/formatId）
//   samples: [{ index, from, to, stageAApplyMs, stageBPreviewMs, totalMs }]
//   aggregate: { stageAApply, stageBPreview, total }（各含 count/p50/p95/max）
//   passed（total p95 ≤ 阈值）
//   executable/environment
// 运行命令：node tools/bench/bench-template-switch.mjs [--samples 10]
// 前置：npm run build:native 已产出 release 宿主；不与其它 webview 测试并行。
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  benchmarkEnvironment,
  assertHostExecutable,
  evidenceRoot,
  parseArgs,
  summarize,
  writeEvidence,
} from "./lib.mjs";
import { startNativeHost, stopNativeHost } from "../../tests/native/host-fixture.mjs";

const args = parseArgs(process.argv.slice(2));
const sampleCount = Math.max(2, Number(args.samples ?? 10));
const thresholdTotalP95Ms = 500;

const catalogSeeds = [
  {
    id: "bench-tpl-clear",
    name: "R29基准-清晰",
    sourceName: "bench-clear.png",
    sourceType: "image",
    createdAt: "2026-10-02T00:00:00.000Z",
    accent: "#111827",
    formatId: "clear-single-v1",
    layout: "single-column",
    analysis: "R29 基准合成模板（仅视觉样式）",
    recognitionConfidence: "high",
    recognitionWarnings: [],
  },
  {
    id: "bench-tpl-compact",
    name: "R29基准-紧凑",
    sourceName: "bench-compact.png",
    sourceType: "image",
    createdAt: "2026-10-02T00:00:00.000Z",
    accent: "#111827",
    formatId: "compact-single-v1",
    layout: "single-column",
    analysis: "R29 基准合成模板（仅视觉样式）",
    recognitionConfidence: "high",
    recognitionWarnings: [],
  },
];

async function main() {
  const runId = `template-switch-${Date.now()}`;
  const executable = await assertHostExecutable();
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-tpl-"));
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    status: "failed",
    error: null,
    scope: "real WebView2 host; synthetic visual-only imported templates; click template card -> toast -> editor pane shows paper with new data-template-id",
    comparability: {
      automationTransportIncluded: true,
      humanInputComparable: false,
      stageSplit: "stageA = click card -> success toast visible; stageB = click editor nav -> target data-template-id paper visible",
    },
    threshold: { totalP95Ms: thresholdTotalP95Ms },
    templateCatalog: catalogSeeds.map(({ id, name, formatId }) => ({ id, name, formatId })),
    samples: [],
  };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;

    const seeded = await host.page.evaluate(async (templates) => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      const stored = await invoke("read_imported_template_catalog");
      const existing = stored ? JSON.parse(stored.payloadJson) : [];
      const merged = [...existing.filter((item) => !templates.some((seed) => seed.id === item.id)), ...templates];
      await invoke("write_imported_template_catalog", {
        payloadJson: JSON.stringify(merged),
        expectedRevision: stored ? stored.revision : 0,
      });
      return merged.length;
    }, catalogSeeds);
    report.catalogEntryCount = seeded;

    // 重新载入页面，让应用经 loadImportedTemplates 水合原生目录。
    await host.page.reload();
    await host.page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await host.page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    // 把 Re:me 助手最小化为 Bot（真实用户在卡片按钮被浮动助手遮挡时的常规操作，
    // chat 模式浮窗默认停靠右下最大 712×580，会拦截模板卡片点击）；非测量段。
    const minimizeAgent = host.page.locator("button[aria-label='最小化到 Bot']");
    if (await minimizeAgent.isVisible().catch(() => false)) await minimizeAgent.click();

    for (let index = 0; index < sampleCount; index += 1) {
      const seed = catalogSeeds[index % catalogSeeds.length];
      const other = catalogSeeds[(index + 1) % catalogSeeds.length];
      const from = index === 0 ? "legacy-v1(初始)" : catalogSeeds[(index - 1) % catalogSeeds.length].formatId;
      // 打开模板库并等待两张合成模板卡片就绪。
      await host.page.locator("button[aria-label='模板']").click();
      const card = host.page.locator(".template-library-card", { hasText: seed.name });
      await card.waitFor({ timeout: 20_000 });
      await host.page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 20_000 });

      const begin = Date.now();
      await card.locator(".template-library-select").click();
      await host.page
        .locator(".notice-toast")
        .filter({ hasText: seed.name })
        .waitFor({ timeout: 10_000 });
      const stageA = Date.now() - begin;

      const beginB = Date.now();
      await host.page.locator("button[aria-label='简历编辑']").click();
      await host.page
        .locator(`.paper-frame .paper[data-template-id="${seed.formatId}"]`)
        .first()
        .waitFor({ timeout: 10_000 });
      const stageB = Date.now() - beginB;

      report.samples.push({
        index: index + 1,
        from,
        to: seed.formatId,
        stageAApplyMs: stageA,
        stageBPreviewMs: stageB,
        totalMs: stageA + stageB,
      });
      // 通知会常驻至下一次 notify；先切回编辑视图再等保存完成，随后下一个样本会覆盖通知。
      await host.page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 20_000 });
      void other;
    }

    const stageA = summarize(report.samples.map((sample) => sample.stageAApplyMs));
    const stageB = summarize(report.samples.map((sample) => sample.stageBPreviewMs));
    const total = summarize(report.samples.map((sample) => sample.totalMs));
    report.aggregate = { stageAApply: stageA, stageBPreview: stageB, total };
    report.passed = total.p95 !== null && total.p95 <= thresholdTotalP95Ms;
    report.status = report.passed ? "passed" : "threshold-exceeded";
    passed = true;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    await stopNativeHost(host).catch(() => {});
    report.executable = { path: executable };
    report.environment = benchmarkEnvironment();
    const output = await writeEvidence("template-switch", report);
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    else report.keptProfile = "失败运行保留隔离 profile 以便诊断";
    console.log(JSON.stringify({
      status: report.status,
      output,
      threshold: report.threshold,
      aggregate: report.aggregate ?? null,
      passed: report.passed ?? false,
      error: report.error,
    }, null, 2));
    // 阈值超标/blocked/失败都必须以非零退出码暴露给门禁编排，不能只写在 report 里。
    if (report.status !== "passed") process.exitCode = 1;
  }
}

await main();
