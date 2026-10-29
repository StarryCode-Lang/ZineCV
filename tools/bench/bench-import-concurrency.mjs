// P13/R29 基准 5/6：导入草稿并发与取消语义（真实 WebView2 宿主，命令级管道）。
//
// 测量口径：
//   全部经页面内 window.__TAURI_INTERNALS__.invoke 走真实 IPC，与 UI 的
//   services/import-draft.ts 同一命令面（create_import_draft / transition_import_draft /
//   get_import_draft / apply_import）。四个阶段：
//   A 并发创建：8 个 create_import_draft 同时发出（不同 draftId）→ 全部成功且互不影响；
//   B 同草稿状态机 CAS：同一 draft 的两次 queued→running 并发 → 恰好一次成功一次失败
//     （expectedStatus 预期校验，与前端 AbortController 取消路径同一机制）；
//   C 取消语义：draft queued→running→cancelled 后，get_import_draft 返回 cancelled，
//     cancelled→running 的逆转换必须失败；
//   D 并发应用冲突：4 个 apply_import 携同一 cursor、不同 commandId 并发 → 恰好一次成功，
//     文档 revision 恰好 +1，姓名恰好被写入一次（其余按冲突拒绝）。
//   每条命令记录 wall time（无固定时间阈值，P13 只要求并发/取消行为正确；
//   延迟分布作为配套证据输出）。
// 阈值（行为正确性）：
//   A 全部成功；B 成功数=1；C 状态=cancelled 且逆转换失败；D 成功数=1 且 revisionDelta=1。
// 输出 JSON 字段：
//   schemaVersion/runId/capturedAt/status/error/scope/threshold
//   phases: { concurrentCreate, casRace, cancelSemantics, concurrentApply }
//     —— 各含 assertions、latencies（count/p50/p95/max）、明细
//   passed / executable / environment
// 运行命令：node tools/bench/bench-import-concurrency.mjs
// 前置：npm run build:native 已产出 release 宿主；不与其它 webview 测试并行。
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  benchmarkEnvironment,
  assertHostExecutable,
  evidenceRoot,
  parseArgs,
  writeEvidence,
} from "./lib.mjs";
import { startNativeHost, stopNativeHost } from "../../tests/native/host-fixture.mjs";

const args = parseArgs(process.argv.slice(2));
const concurrentCreate = Math.max(2, Number(args.concurrent ?? 8));
const concurrentApply = 4;

async function main() {
  const runId = `import-concurrency-${Date.now()}`;
  const executable = await assertHostExecutable();
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-import-"));
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    status: "failed",
    error: null,
    scope: "real WebView2 host; command-level import draft pipeline (create/transition/get/apply) concurrency and cancellation semantics",
    threshold: {
      concurrentCreateAllSucceed: true,
      casRaceExactlyOneSuccess: true,
      cancelStatusEnforced: true,
      concurrentApplyExactlyOneSuccessAndRevisionDeltaOne: true,
    },
    phases: {},
  };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;

    report.phases = await host.page.evaluate(async ({ concurrentCreate, concurrentApply }) => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      const timed = async (promise) => {
        const begin = performance.now();
        try {
          return { ok: true, value: await promise, ms: performance.now() - begin };
        } catch (error) {
          return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 160), ms: performance.now() - begin };
        }
      };
      const latencies = (records) => records.map(({ ms }) => Math.round(ms * 1000) / 1000);
      const digest = (records) => {
        const values = latencies(records);
        const sorted = [...values].sort((left, right) => left - right);
        return {
          count: sorted.length,
          p50: sorted.length ? sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)] : null,
          p95: sorted.length ? sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] : null,
          max: sorted.length ? sorted[sorted.length - 1] : null,
        };
      };
      // M2 起 create_import_draft 携带目标文档与宿主 epoch；并发创建共享同一 active 目标。
      const active = await invoke("document_state");
      const createDraft = (draftId) => invoke("create_import_draft", { request: {
        draftId, sourceKind: "legacy_json", displayName: `${draftId}.json`, sourceHash: "a".repeat(64),
        expectedEpoch: active.epoch, targetDocumentId: active.cursor.documentId,
      } });
      const transition = (draftId, expectedStatus, nextStatus, candidates = null) => invoke("transition_import_draft", { request: {
        draftId, expectedStatus, nextStatus, candidates, warnings: null, unsupportedFeatures: null, previewDataUrl: null,
      } });
      const candidate = (id, name) => ({
        id, label: "合成姓名", value: { type: "basicField", field: "name", value: name },
        evidence: { page: null, excerpt: "r29 bench", sourceField: "name", confidence: "high" },
      });
      const phases = {};

      // ---- A 并发创建 ----
      {
        const ids = Array.from({ length: concurrentCreate }, (_, index) => `r29-a-${index + 1}`);
        const records = await Promise.all(ids.map((id) => timed(createDraft(id))));
        const reads = await Promise.all(ids.map((id) => invoke("get_import_draft", { draftId: id })));
        phases.concurrentCreate = {
          attempts: records.length,
          successes: records.filter((record) => record.ok).length,
          statuses: reads.map((draft) => draft?.status),
          latencies: { all: digest(records), detail: latencies(records) },
          raw: records.map((record, index) => ({ id: ids[index], ok: record.ok, ms: Math.round(record.ms * 1000) / 1000 })),
        };
      }

      // ---- B 同草稿 CAS 竞争 ----
      {
        const draftId = "r29-b-cas";
        await createDraft(draftId);
        const records = await Promise.all([
          timed(transition(draftId, "queued", "running")),
          timed(transition(draftId, "queued", "running")),
        ]);
        const draft = await invoke("get_import_draft", { draftId });
        phases.casRace = {
          successes: records.filter((record) => record.ok).length,
          failures: records.filter((record) => !record.ok).length,
          failureCodes: records.filter((record) => !record.ok).map((record) => record.code),
          finalStatus: draft?.status,
          latencies: digest(records),
          raw: records.map((record) => ({ ok: record.ok, code: record.code ?? null, ms: Math.round(record.ms * 1000) / 1000 })),
        };
      }

      // ---- C 取消语义 ----
      {
        const draftId = "r29-c-cancel";
        await createDraft(draftId);
        const steps = [];
        steps.push(await timed(transition(draftId, "queued", "running")));
        steps.push(await timed(transition(draftId, "running", "cancelled")));
        const cancelled = await invoke("get_import_draft", { draftId });
        const illegal = await timed(transition(draftId, "cancelled", "running"));
        const applied = await timed(invoke("apply_import", { request: {
          commandId: "r29-c-apply",
          cursor: (await invoke("document_state")).cursor,
          draftId,
          acceptedCandidateIds: [],
        } }));
        phases.cancelSemantics = {
          steps: steps.map((step) => ({ ok: step.ok, code: step.code ?? null, ms: Math.round(step.ms * 1000) / 1000 })),
          statusAfterCancel: cancelled?.status,
          illegalReverse: { rejected: !illegal.ok, code: illegal.code ?? null },
          applyAfterCancel: { rejected: !applied.ok, code: applied.code ?? null },
          latencies: digest(steps),
        };
      }

      // ---- D 并发应用冲突 ----
      {
        const draftId = "r29-d-apply";
        await createDraft(draftId);
        await transition(draftId, "queued", "running");
        await transition(draftId, "running", "review_required", [candidate("r29-d-name", "R29 并发基准")]);
        const before = await invoke("document_state");
        const records = await Promise.all(Array.from({ length: concurrentApply }, (_, index) =>
          timed(invoke("apply_import", { request: {
            commandId: `r29-d-apply-${index + 1}`,
            cursor: before.cursor,
            draftId,
            acceptedCandidateIds: ["r29-d-name"],
          } }))));
        const after = await invoke("document_state");
        const revisionDelta = String(after.cursor.revision) === String(before.cursor.revision)
          ? 0
          : Number(BigInt(after.cursor.revision) - BigInt(before.cursor.revision));
        phases.concurrentApply = {
          attempts: records.length,
          successes: records.filter((record) => record.ok).length,
          failureCodes: records.filter((record) => !record.ok).map((record) => record.code),
          revisionBefore: String(before.cursor.revision),
          revisionAfter: String(after.cursor.revision),
          revisionDelta,
          nameAfter: after.document.basic.name,
          draftStatusAfter: (await invoke("get_import_draft", { draftId }))?.status,
          latencies: digest(records),
          raw: records.map((record) => ({ ok: record.ok, code: record.code ?? null, ms: Math.round(record.ms * 1000) / 1000 })),
        };
      }
      return phases;
    }, { concurrentCreate, concurrentApply });

    const a = report.phases.concurrentCreate;
    const b = report.phases.casRace;
    const c = report.phases.cancelSemantics;
    const d = report.phases.concurrentApply;
    report.checks = {
      concurrentCreateAllSucceed: a.successes === a.attempts && a.statuses.every((status) => status === "queued"),
      casRaceExactlyOneSuccess: b.successes === 1 && b.failures === 1 && b.finalStatus === "running",
      cancelStatusEnforced: c.statusAfterCancel === "cancelled" && c.illegalReverse.rejected,
      concurrentApplyExactlyOne: d.successes === 1 && d.revisionDelta === 1 && d.nameAfter === "R29 并发基准",
    };
    report.passed = Object.values(report.checks).every(Boolean);
    report.status = report.passed ? "passed" : "semantics-failed";
    if (!report.passed) process.exitCode = 1;
    passed = true;
  } catch (error) {
    report.error = String(error?.stack ?? error);
    process.exitCode = 1;
  } finally {
    await stopNativeHost(host).catch(() => {});
    report.executable = { path: executable };
    report.environment = benchmarkEnvironment();
    const output = await writeEvidence("import-concurrency", report);
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    else report.keptProfile = "失败运行保留隔离 profile 以便诊断";
    console.log(JSON.stringify({
      status: report.status,
      output,
      checks: report.checks ?? null,
      phaseLatencies: report.phases ? Object.fromEntries(Object.entries(report.phases).map(([name, phase]) => [name, phase.latencies ?? null])) : null,
      error: report.error,
    }, null, 2));
  }
}

await main();
