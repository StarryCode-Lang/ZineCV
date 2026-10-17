// P13/R29 基准 2/6：5 页文档统一导出耗时（真实 WebView2 宿主 + 引擎导出命令）。
//
// 测量口径：
//   经 apply_document_command（setSummaryBody）把自我评价正文填充到引擎渲染恰好 5 页
//   （先二分探测 pageCount，见 probe 阶段），随后冻结 cursor，对同一冻结修订连续计时
//   `render_document_export`（R15 统一导出：PDF + 逐页 PNG + 长图 + 文本映射一次返回）。
//   单样本耗时 = 该命令端到端 wall time（页内 performance.now() 计时，无 CDP 逐次往返）。
//   注意：R15 统一导出管道中 PDF 与 PNG 在同一命令内产出，无法单独剥离 PDF 段；
//   阈值按"整条导出命令 ≤2s"执行，若最终只测 PDF 段需等 R15 拆分计时字段。
// 阈值：p95 ≤ 2000ms 且首个（冷）样本 ≤ 4000ms（冷样本仅记录，不参与阈值判定）。
// 输出 JSON 字段：
//   schemaVersion/runId/capturedAt/status/error/scope/threshold
//   probe: { probes: [{repeatChars, pageCount}], finalRepeatChars, finalPageCount }
//   samples: [{ index, elapsedMs, pageCount, pdfSha256, pngPageCount, longPngHeight, limited }]
//   aggregate: { count/p50/p95/max }（排序后取值）
//   coldSampleMs、pdfDeterministic（各样本 pdfSha256 是否一致）
//   executable/environment
// 运行命令：node tools/bench/bench-pdf-export.mjs [--samples 5]
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
const sampleCount = Math.max(1, Number(args.samples ?? 5));
const thresholdP95Ms = 2000;
const targetPageCount = 5;

async function main() {
  const runId = `pdf-export-${Date.now()}`;
  const executable = await assertHostExecutable();
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-pdf-"));
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    status: "failed",
    error: null,
    scope: "real WebView2 host; unified engine export (render_document_export) on a frozen cursor; per-call wall time measured in page",
    threshold: { p95Ms: thresholdP95Ms, targetPageCount },
    probe: { probes: [], finalRepeatChars: null, finalPageCount: null },
    samples: [],
  };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;

    // 1) 探测阶段：调整自我评价正文长度，使引擎渲染恰好 5 页。
    //    22 字中文基准串 × repeat；UTF-8 每字 3 字节，随长度近似单调增页。
    const probeResult = await host.page.evaluate(async ({ targetPageCount }) => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      const state = () => invoke("document_state");
      const command = (current, payload) => invoke("apply_document_command", { envelope: {
        protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId,
        contextId: current.cursor.contextId, expectedRevision: current.cursor.revision,
        expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload,
      } });
      const baseText = "统一导出同冻结修订：中文路径与错误反馈。";
      let current = await state();
      const summary = current.document.sections.find((section) => section.kind === "summary");
      const setBody = async (repeat) => {
        current = await state();
        await command(current, { type: "setSummaryBody", section_id: summary.id, body: [{
          type: "paragraph", children: [{ type: "text", text: baseText.repeat(repeat), marks: [] }],
        }] });
        current = await state();
      };
      const pageCountFor = async (repeat) => {
        await setBody(repeat);
        const frozen = await state();
        const bundle = await invoke("render_document_export", { cursor: frozen.cursor });
        return bundle.data.pageCount;
      };
      // 指数上探 + 二分收敛到恰好 5 页（最多 10 次探测；找不到精确 5 页取最小 ≥5 的档位）。
      let low = null;
      let high = 100;
      const probes = [];
      let count = await pageCountFor(high);
      probes.push({ repeatChars: high, pageCount: count });
      while (count < targetPageCount && high < 6400) {
        low = high;
        high *= 2;
        count = await pageCountFor(high);
        probes.push({ repeatChars: high, pageCount: count });
      }
      let best = count >= targetPageCount ? { repeatChars: high, pageCount: count } : null;
      while (low !== null && high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        const midCount = await pageCountFor(mid);
        probes.push({ repeatChars: mid, pageCount: midCount });
        if (midCount >= targetPageCount) { high = mid; best = { repeatChars: mid, pageCount: midCount }; }
        else low = mid;
      }
      if (!best) throw new Error("无法在探测上限内达到 5 页渲染");
      // 若精确命中 5 页则回设；否则保持当前 best 档位。
      await setBody(best.repeatChars);
      const frozen = await state();
      return { probes, best, frozen };
    }, { targetPageCount });

    report.probe.probes = probeResult.probes;
    report.probe.finalRepeatChars = probeResult.best.repeatChars;
    report.probe.finalPageCount = probeResult.best.pageCount;
    if (probeResult.best.pageCount !== targetPageCount) {
      report.warning = `未能精确命中 ${targetPageCount} 页，实际 ${probeResult.best.pageCount} 页（阈值判定仍按本次实际页数记录，需人工复核）`;
    }

    // 2) 计时阶段：同一冻结 cursor 连续导出。首个样本视为冷样本单独记录。
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = await host.page.evaluate(async (cursor) => {
        const begin = performance.now();
        const bundle = await window.__TAURI_INTERNALS__.invoke("render_document_export", { cursor });
        const elapsedMs = performance.now() - begin;
        return {
          elapsedMs,
          pageCount: bundle.data.pageCount,
          pdfSha256: bundle.data.pdfSha256,
          pngPageCount: bundle.data.pngPages.length,
          longPngHeight: bundle.data.longPng ? bundle.data.longPng.height : null,
          limited: bundle.data.longImageLimited,
        };
      }, probeResult.frozen.cursor);
      report.samples.push({ index: index + 1, ...sample, elapsedMs: Math.round(sample.elapsedMs * 1000) / 1000 });
    }

    const elapsed = report.samples.map((sample) => sample.elapsedMs);
    report.coldSampleMs = elapsed[0];
    report.aggregate = summarize(elapsed);
    const warm = elapsed.slice(1);
    report.aggregateWarm = warm.length ? summarize(warm) : null;
    const shaSet = new Set(report.samples.map((sample) => sample.pdfSha256));
    report.pdfDeterministic = shaSet.size === 1;
    report.passed = report.aggregate.p95 !== null
      && report.aggregate.p95 <= thresholdP95Ms
      && report.pdfDeterministic;
    report.status = report.passed ? "passed" : "threshold-exceeded";
    passed = true;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    await stopNativeHost(host).catch(() => {});
    report.executable = { path: executable };
    report.environment = benchmarkEnvironment();
    const output = await writeEvidence("pdf-export", report);
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    else report.keptProfile = "失败运行保留隔离 profile 以便诊断";
    console.log(JSON.stringify({
      status: report.status,
      output,
      probe: report.probe,
      coldSampleMs: report.coldSampleMs ?? null,
      aggregate: report.aggregate ?? null,
      aggregateWarm: report.aggregateWarm ?? null,
      passed: report.passed ?? false,
      error: report.error,
    }, null, 2));
    // 阈值超标/blocked/失败都必须以非零退出码暴露给门禁编排，不能只写在 report 里。
    if (report.status !== "passed") process.exitCode = 1;
  }
}

await main();
