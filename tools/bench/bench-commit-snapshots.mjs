// P13/R29 基准 4/6：1000 个 50KiB 纯文本快照的版本提交延迟（真实 WebView2 宿主）。
//
// 测量口径：
//   循环 1000 次：apply_document_command（setSummaryBody 写入 ≥50KiB UTF-8 纯文本，
//   每次内容不同以保证快照不同）→ commit_version（生成含完整快照 JSON 的提交）。
//   apply/commit 各自在页面内以 performance.now() 计时（webview→Rust IPC 端到端，
//   不含 CDP 自动化往返；分块提交避免单次 evaluate 长阻塞）。
// 阈值（两种口径都输出，避免歧义）：
//   口径 A（docs/DEVELOPMENT_PLAN.md:431 "1000个50KiB纯文本快照时p95 ≤150ms"）：
//     commit p95 ≤ 150ms —— passed 主判据；
//   口径 B（任务表述 "1000 个提交 ≤150ms"）：totalWallMs —— 仅记录，供人工对照。
// 输出 JSON 字段：
//   schemaVersion/runId/capturedAt/status/error/scope/threshold
//   payload: { utf8Bytes, textChars, chunks, perChunk }
//   samples: [{ index, applyMs, commitMs, totalMs }]
//   aggregate: { apply, commit, perIterationTotal }（各含 count/p50/p95/max）
//   totalWallMs / dbSizeBeforeBytes / dbSizeAfterBytes / finalRevision
//   passed / executable / environment
// 运行命令：node tools/bench/bench-commit-snapshots.mjs [--count 1000]
// 前置：npm run build:native 已产出 release 宿主；不与其它 webview 测试并行。
//       本基准会向隔离 profile 的 SQLite 写入 1000×~50KiB 快照（约数十 MB），运行完自动清理。
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
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
const totalCount = Math.max(1, Number(args.count ?? 1000));
const chunkSize = 100;
const thresholdCommitP95Ms = 150;

async function main() {
  const runId = `commit-snapshots-${Date.now()}`;
  const executable = await assertHostExecutable();
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-commit-"));
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    status: "failed",
    error: null,
    scope: "real WebView2 host; in-page timed apply_document_command + commit_version loop; 50KiB UTF-8 body per snapshot",
    threshold: { commitP95Ms: thresholdCommitP95Ms, note: "口径A=p95≤150ms(判据)；口径B=totalWallMs(记录)" },
    samples: [],
  };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;
    const databasePath = join(profile, "Data", "zinecv.sqlite3");
    report.dbSizeBeforeBytes = (await stat(databasePath)).size;

    const chunks = Math.ceil(totalCount / chunkSize);
    report.payload = { chunks, perChunk: chunkSize };
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const start = chunk * chunkSize;
      const end = Math.min(start + chunkSize, totalCount);
      const result = await host.page.evaluate(async ({ start, end }) => {
        const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
        // ~50KiB UTF-8：基准串每重复一次 72 字节，712 次 ≈ 51,264 字节；迭代号作后缀保证快照互异。
        const baseText = "统一版本快照压力基准：自我评价正文填充到五十KiB。".repeat(712);
        const samples = [];
        let cursor = (await invoke("document_state")).cursor;
        const summaryId = (await invoke("document_state")).document.sections
          .find((section) => section.kind === "summary").id;
        let bytesChecked = null;
        for (let index = start; index < end; index += 1) {
          const text = `${baseText}#${index}`;
          const bytes = new TextEncoder().encode(text).length;
          if (index === start) bytesChecked = bytes;
          const beginApply = performance.now();
          const result = await invoke("apply_document_command", { envelope: {
            protocolVersion: 1, commandId: crypto.randomUUID(),
            documentId: cursor.documentId, contextId: cursor.contextId,
            expectedRevision: cursor.revision, expectedBranchId: cursor.branchId,
            expectedHeadId: cursor.headId,
            payload: { type: "setSummaryBody", section_id: summaryId, body: [{
              type: "paragraph", children: [{ type: "text", text, marks: [] }],
            }] },
          } });
          const applyMs = performance.now() - beginApply;
          const beginCommit = performance.now();
          cursor = await invoke("commit_version", { cursor: result.cursor, message: `R29 基准提交 ${index + 1}` });
          const commitMs = performance.now() - beginCommit;
          samples.push({
            index: index + 1,
            applyMs: Math.round(applyMs * 1000) / 1000,
            commitMs: Math.round(commitMs * 1000) / 1000,
            totalMs: Math.round((applyMs + commitMs) * 1000) / 1000,
          });
        }
        // 显式对象返回：数组上的扩展属性经 JSON 序列化会丢失。
        return { samples, bytesChecked, cursor };
      }, { start, end });
      if (chunk === 0) report.payload.utf8Bytes = result.bytesChecked;
      report.samples.push(...result.samples);
      report.finalRevision = String(result.cursor.revision);
      console.log(`chunk ${chunk + 1}/${chunks} done (${report.samples.length}/${totalCount})`);
    }
    if (report.payload.utf8Bytes < 50 * 1024) {
      throw new Error(`快照正文 UTF-8 字节数 ${report.payload.utf8Bytes} 低于 50KiB 下限，口径不成立`);
    }

    const apply = summarize(report.samples.map((sample) => sample.applyMs));
    const commit = summarize(report.samples.map((sample) => sample.commitMs));
    const perIteration = summarize(report.samples.map((sample) => sample.totalMs));
    report.aggregate = { apply, commit, perIterationTotal: perIteration };
    report.totalWallMs = Math.round(report.samples.reduce((sum, sample) => sum + sample.totalMs, 0) * 1000) / 1000;
    report.dbSizeAfterBytes = (await stat(databasePath)).size;
    report.passed = commit.p95 !== null && commit.p95 <= thresholdCommitP95Ms;
    report.status = report.passed ? "passed" : "threshold-exceeded";
    passed = true;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    await stopNativeHost(host).catch(() => {});
    report.executable = { path: executable };
    report.environment = benchmarkEnvironment();
    const output = await writeEvidence("commit-snapshots", report);
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
    else report.keptProfile = "失败运行保留隔离 profile 以便诊断";
    console.log(JSON.stringify({
      status: report.status,
      output,
      payload: report.payload ?? null,
      aggregate: report.aggregate ?? null,
      totalWallMs: report.totalWallMs ?? null,
      passed: report.passed ?? false,
      error: report.error,
    }, null, 2));
    // 阈值超标/blocked/失败都必须以非零退出码暴露给门禁编排，不能只写在 report 里。
    if (report.status !== "passed") process.exitCode = 1;
  }
}

await main();
