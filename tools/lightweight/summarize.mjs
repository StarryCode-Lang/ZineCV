#!/usr/bin/env node
/**
 * summarize.mjs — turn the per-run evidence JSON from measure-memory.mjs into
 * .artifacts/.../measure/summary.json plus a markdown table for the conclusion doc.
 *
 * It only reads evidence files; it never starts anything.
 *
 * Usage:
 *   node tools/lightweight/summarize.mjs --out <evidence dir> [--label run] [--runs 2]
 *                                        [--expect-sha256 <hex>]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MiB = (bytes) => (typeof bytes === "number" ? Number((bytes / 1024 / 1024).toFixed(1)) : null);
const pct = (a, b) => (typeof a === "number" && typeof b === "number" && b !== 0 ? Number((((a - b) / b) * 100).toFixed(1)) : null);

function parseArgs(argv) {
  const options = { out: null, label: "run", runs: 2, expectSha256: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    switch (arg) {
      case "--out": options.out = value(); break;
      case "--label": options.label = value(); break;
      case "--runs": options.runs = Number(value()); break;
      case "--expect-sha256": options.expectSha256 = value().toLowerCase(); break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.help && !options.out) throw new Error("--out is required");
  return options;
}

function extract(run, classified = null) {
  const windows = run.memory?.windows ?? {};
  const inventory = run.processes?.inventory ?? [];
  const spawnT = run.timeline?.marks?.find((mark) => mark.name === "hostSpawned")?.tMs ?? 0;
  const workerFirstSeenMs = classified?.byRolePeak?.renderWorker?.firstSeenMs ?? run.processes?.firstWorkerSeenMs ?? null;
  return {
    id: run.run?.id ?? null,
    classificationSource: classified ? "run-N.classified.json (offline re-derivation with classify.mjs)" : "run-N.json (live classification)",
    scopes: classified?.windows
      ? Object.fromEntries(Object.entries(classified.windows).map(([name, window]) => [name, window.scopes]))
      : null,
    rolePeak: classified?.byRolePeak ?? null,
    scopePeak: classified?.byScopePeak ?? null,
    correctedPeak: classified?.peak ?? null,
    status: run.run?.status ?? null,
    error: run.run?.error ?? null,
    startedAtIso: run.run?.startedAtIso ?? null,
    durationMs: run.run?.durationMs ?? null,
    binary: {
      path: run.binary?.before?.path ?? null,
      sizeBytes: run.binary?.before?.sizeBytes ?? null,
      sizeMiB: MiB(run.binary?.before?.sizeBytes),
      sha256: run.binary?.before?.sha256 ?? null,
      mtimeIso: run.binary?.before?.mtimeIso ?? null,
      stableAcrossRun: run.binary?.stableAcrossRun ?? null,
    },
    hostPid: run.host?.pid ?? null,
    sampling: {
      configuredIntervalMs: run.memory?.sampleIntervalMs ?? null,
      sampleCount: run.memory?.sampleCount ?? null,
      observedSpanMs: run.memory?.observedSpanMs ?? null,
      meanSampleIntervalMs: run.memory?.meanSampleIntervalMs ?? null,
      maxSampleDeltaMs: run.memory?.maxSampleDeltaMs ?? null,
      deltasOver200ms: run.memory?.deltasOver200ms ?? null,
      maxFastPathMs: run.memory?.maxFastPathMs ?? null,
      maxCimRefreshMs: run.memory?.maxCimRefreshMs ?? null,
      topologySource: run.rawSamplerMeta?.[0]?.topologySource ?? null,
      samplerCpuSeconds: run.rawSamplerMeta?.[0]?.cpuSeconds ?? null,
      samplerWorkingSetMiB: MiB(run.rawSamplerMeta?.[0]?.ws),
      samplerWarmupMs: run.samplerControl?.ready?.warmupMs ?? null,
      attachWaitedMs: run.samplerControl?.attached?.waitedMs ?? null,
    },
    checkpoints: {
      idle: {
        treeWorkingSetMiB: MiB(windows.idle?.tree?.lastWorkingSetBytes),
        treePrivateMiB: MiB(windows.idle?.tree?.lastPrivateBytes),
        maxTreeWorkingSetMiB: MiB(windows.idle?.tree?.maxWorkingSetBytes),
        roles: roleTable(windows.idle),
      },
      preview: {
        treeWorkingSetMiB: MiB(windows.preview?.tree?.lastWorkingSetBytes),
        treePrivateMiB: MiB(windows.preview?.tree?.lastPrivateBytes),
        maxTreeWorkingSetMiB: MiB(windows.preview?.tree?.maxWorkingSetBytes),
        roles: roleTable(windows.preview),
      },
      export: {
        treeWorkingSetMiB: MiB(windows.export?.tree?.lastWorkingSetBytes),
        treePrivateMiB: MiB(windows.export?.tree?.lastPrivateBytes),
        maxTreeWorkingSetMiB: MiB(windows.export?.tree?.maxWorkingSetBytes),
        roles: roleTable(windows.export),
      },
    },
    peaks: {
      treeWorkingSetMiB: MiB(run.memory?.peak?.treeWorkingSetBytes),
      treePrivateMiB: MiB(run.memory?.peak?.treePrivateBytes),
      atMs: run.memory?.peak?.atMs ?? null,
      lifetimePeakSumWorkingSetMiB: MiB(run.processes?.lifetimePeakSumWorkingSetBytes),
      lifetimePeakSumPrivateMiB: MiB(run.processes?.lifetimePeakSumPrivateBytes),
      coldBootMaxWorkingSetMiB: MiB(windows.coldBoot?.tree?.maxWorkingSetBytes),
    },
    timeline: Object.fromEntries((run.timeline?.marks ?? []).map((mark) => [mark.name, mark.tMs])),
    // Timeline marks are anchored at the run's t0, which includes the sampler warm-up. The
    // claim is about process creation, so the same marks are also given relative to
    // hostSpawned (the moment the host process was created).
    timelineFromProcessCreationMs: (() => {
      const marks = run.timeline?.marks ?? [];
      const spawn = marks.find((mark) => mark.name === "hostSpawned")?.tMs ?? 0;
      return Object.fromEntries(marks.map((mark) => [mark.name, mark.tMs - spawn]));
    })(),
    workerFirstSeenMs,
    workerFirstSeenFromProcessCreationMs: workerFirstSeenMs === null || workerFirstSeenMs === undefined ? null : workerFirstSeenMs - spawnT,
    roles: run.processes?.byRole ?? {},
    perProcessPeaks: inventory.map((proc) => ({ pid: proc.pid, role: proc.role, firstSeenMs: proc.firstSeenMs,
      lastSeenMs: proc.lastSeenMs, osPeakWorkingSetMiB: MiB(proc.osPeakWorkingSetBytes), osPeakPageFileMiB: MiB(proc.osPeakPageFileBytes) })),
    renders: {
      preview: run.checkpoints?.preview ? { renderKey: run.checkpoints.preview.renderKey, pageCount: run.checkpoints.preview.pageCount,
        pageHashes: run.checkpoints.preview.pageHashes, svgBytes: run.checkpoints.preview.svgBytes, decodeFailures: run.checkpoints.preview.decodeFailures } : null,
      export: run.checkpoints?.export ? { pageCount: run.checkpoints.export.pageCount, pdfSha256: run.checkpoints.export.pdfSha256,
        pdfBase64Chars: run.checkpoints.export.pdfBase64Chars, pdfBytesWritten: run.checkpoints.export.pdfBytesWritten,
        longPng: run.checkpoints.export.longPng, longPngBytesWritten: run.checkpoints.export.longPngBytesWritten,
        pngPages: run.checkpoints.export.pngPages?.length ?? null, dpi: run.checkpoints.export.dpi } : null,
    },
    unexpectedDescendants: run.checkpoints?.unexpectedDescendants ?? null,
    cleanup: {
      hostExitCode: run.cleanup?.hostExitCode ?? null,
      pidsRecorded: run.cleanup?.observedPids?.length ?? null,
      pidsKilledByStopper: run.cleanup?.treeStop?.killed?.length ?? null,
      pidsRemainingAfterStop: run.cleanup?.treeStop?.remaining ?? null,
      ownPidsStillAlive: run.cleanup?.ownPidsStillAlive ?? null,
      cleanupVerified: run.cleanup?.cleanupVerified ?? null,
      newWebview2PidsAfterCleanup: run.cleanup?.newWebview2PidsAfterCleanup ?? null,
      webview2BaselineDelta: run.cleanup?.webview2BaselineDelta ?? null,
      machineWideLeftovers: run.cleanup?.leftoverCheck ?? null,
      machineWideLeftoversUnknown: run.cleanup?.leftoverCheck?.unknown ?? null,
      preRunWebview2Pids: run.host?.preRunWebview2Pids ?? null,
      profileDeleted: run.cleanup?.profileDeleted ?? null,
      samplerExitCode: run.cleanup?.samplerStop?.exitCode ?? null,
      freeRamBytesBefore: run.host?.freeRamBytesBefore ?? null,
      freeRamBytesAfter: run.cleanup?.freeRamBytesAfter ?? null,
    },
    limitations: run.limitations ?? [],
  };
}

function roleTable(window) {
  if (!window?.roles) return null;
  return Object.fromEntries(Object.entries(window.roles).map(([role, value]) => [role, {
    maxWorkingSetMiB: MiB(value.maxWorkingSetBytes), maxPrivateMiB: MiB(value.maxPrivateBytes),
    lastWorkingSetMiB: MiB(value.lastWorkingSetBytes), lastPrivateMiB: MiB(value.lastPrivateBytes),
    maxProcessCount: value.maxProcessCount,
  }]));
}

function markdown(summary) {
  const lines = [];
  lines.push("| 指标 | " + summary.runs.map((run) => run.id).join(" | ") + " |");
  lines.push("| --- |" + summary.runs.map(() => " --- |").join(""));
  const row = (label, pick) => lines.push(`| ${label} | ` + summary.runs.map((run) => {
    const value = pick(run);
    return value === null || value === undefined ? "n/a" : String(value);
  }).join(" | ") + " |");
  row("状态", (run) => run.status);
  row("exe SHA256 前 12 位", (run) => run.binary.sha256?.slice(0, 12));
  row("exe 大小 (MiB)", (run) => run.binary.sizeMiB);
  row("采样次数", (run) => run.sampling.sampleCount);
  row("平均/最大采样间隔 (ms)", (run) => `${run.sampling.meanSampleIntervalMs} / ${run.sampling.maxSampleDeltaMs}`);
  row("超过 200ms 的间隔数", (run) => run.sampling.deltasOver200ms);
  row("idle 整树工作集 (MiB)", (run) => run.checkpoints.idle.treeWorkingSetMiB);
  row("idle 整树私有内存 (MiB)", (run) => run.checkpoints.idle.treePrivateMiB);
  row("预览后整树工作集 (MiB)", (run) => run.checkpoints.preview.treeWorkingSetMiB);
  row("导出后整树工作集 (MiB)", (run) => run.checkpoints.export.treeWorkingSetMiB);
  row("峰值整树工作集 (MiB)", (run) => run.peaks.treeWorkingSetMiB);
  row("峰值整树私有内存 (MiB)", (run) => run.peaks.treePrivateMiB);
  const scope3 = (name) => (run) => {
    const window = run.scopes?.[name];
    if (!window) return "n/a";
    return `${window.host?.maxWorkingSetMiB ?? 0} / ${window.renderWorker?.maxWorkingSetMiB ?? 0} / ${window.webview2?.maxWorkingSetMiB ?? 0}`;
  };
  row("idle 分解 host/worker/webview2 (MiB WS)", scope3("idle"));
  row("预览检查点 分解 host/worker/webview2", scope3("preview"));
  row("导出检查点 分解 host/worker/webview2", scope3("export"));
  row("口径峰值 host / worker / webview2 (MiB WS)", (run) => run.scopePeak
    ? `${run.scopePeak.host?.maxWorkingSetMiB ?? 0} / ${run.scopePeak.renderWorker?.maxWorkingSetMiB ?? 0} / ${run.scopePeak.webview2?.maxWorkingSetMiB ?? 0}`
    : "n/a");
  row("各进程生命周期峰值之和 WS (MiB)", (run) => run.peaks.lifetimePeakSumWorkingSetMiB);
  row("进程创建→CDP (ms)", (run) => run.timelineFromProcessCreationMs.cdpConnected);
  row("进程创建→草稿就绪 (ms)", (run) => run.timelineFromProcessCreationMs.draftReady);
  row("进程创建→首次 IPC (ms)", (run) => run.timelineFromProcessCreationMs.firstIpcOk);
  row("进程创建→首次渲染完成 (ms)", (run) => run.timelineFromProcessCreationMs.previewRendered);
  row("render worker 首次出现 (ms)", (run) => run.workerFirstSeenFromProcessCreationMs);
  row("预览页数 / 导出页数", (run) => `${run.renders.preview?.pageCount ?? "n/a"} / ${run.renders.export?.pageCount ?? "n/a"}`);
  row("清理后 profile 已删除", (run) => run.cleanup.profileDeleted);
  row("清理后遗留自有 pid", (run) => Array.isArray(run.cleanup.ownPidsStillAlive) ? run.cleanup.ownPidsStillAlive.length : "unknown");
  row("机器级 zinecv/msedgewebview2 残留", (run) => run.cleanup.machineWideLeftoversUnknown
    ? "unknown" : `${run.cleanup.machineWideLeftovers?.zinecvDesktop ?? "?"} / ${run.cleanup.machineWideLeftovers?.msedgewebview2 ?? "?"}`);
  row("清理后新增 msedgewebview2 pid", (run) => Array.isArray(run.cleanup.newWebview2PidsAfterCleanup) ? run.cleanup.newWebview2PidsAfterCleanup.length : "unknown");
  return lines.join("\n");
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`summarize: ${error.message}\n`); return 2; }
  if (options.help) { process.stdout.write("node tools/lightweight/summarize.mjs --out <dir> [--label run] [--runs 2] [--expect-sha256 <hex>]\n"); return 0; }

  const outDir = resolve(options.out);
  const runs = [];
  const missing = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const file = join(outDir, `${options.label}-${index}.json`);
    try {
      const run = JSON.parse(await readFile(file, "utf8"));
      // Prefer the corrected classifier view when reclassify.mjs has produced it.
      let classified = null;
      try { classified = JSON.parse(await readFile(join(outDir, `${options.label}-${index}.classified.json`), "utf8")); }
      catch { classified = null; }
      runs.push(extract(run, classified));
    } catch (error) { missing.push(`${file}: ${error.message}`); }
  }
  if (!runs.length) { process.stderr.write(`summarize: no run evidence found\n${missing.join("\n")}\n`); return 1; }

  const expected = options.expectSha256;
  for (const run of runs) {
    run.binary.matchesExpected = expected ? run.binary.sha256 === expected : null;
  }
  const [a, b] = runs;
  const comparison = {
    runsCompared: runs.length,
    sameBinary: runs.every((run) => run.binary.sha256 === runs[0].binary.sha256),
    sameOrderOfMagnitude: runs.length > 1
      ? (a.peaks.treeWorkingSetMiB > 0 && b.peaks.treeWorkingSetMiB > 0
        && Math.max(a.peaks.treeWorkingSetMiB, b.peaks.treeWorkingSetMiB) / Math.min(a.peaks.treeWorkingSetMiB, b.peaks.treeWorkingSetMiB) < 10)
      : null,
    peakWorkingSetDeltaPct: runs.length > 1 ? pct(a.peaks.treeWorkingSetMiB, b.peaks.treeWorkingSetMiB) : null,
    peakPrivateDeltaPct: runs.length > 1 ? pct(a.peaks.treePrivateMiB, b.peaks.treePrivateMiB) : null,
    allRunsPassed: runs.every((run) => run.status === "passed"),
    allDeltasWithin200ms: runs.every((run) => run.sampling.deltasOver200ms === 0),
    allProfilesDeleted: runs.every((run) => run.cleanup.profileDeleted === true),
    noOwnPidLeftovers: runs.every((run) => (run.cleanup.pidsRemainingAfterStop ?? []).length === 0
      && Array.isArray(run.cleanup.ownPidsStillAlive) && run.cleanup.ownPidsStillAlive.length === 0),
    allCensusKnown: runs.every((run) => run.cleanup.machineWideLeftoversUnknown === false),
    noUnexpectedNewWebview2: runs.every((run) => Array.isArray(run.cleanup.newWebview2PidsAfterCleanup)
      && run.cleanup.newWebview2PidsAfterCleanup.length === 0),
    allBinariesStableAcrossRun: runs.every((run) => run.binary.stableAcrossRun === true),
    binaryMatchesExpected: expected ? runs.every((run) => run.binary.matchesExpected === true) : null,
    noUnexpectedDescendants: runs.every((run) => (run.unexpectedDescendants ?? []).length === 0),
  };
  const summary = {
    schema: "zinecv.lightweight.memory.summary.v1",
    generatedAtIso: new Date().toISOString(),
    evidenceDir: outDir,
    label: options.label,
    expectedBinarySha256: expected,
    missingFiles: missing,
    runs,
    comparison,
    table: markdown({ runs }),
  };
  const target = join(outDir, "summary.json");
  await writeFile(target, JSON.stringify(summary, null, 2) + "\n", "utf8");
  process.stdout.write(`${summary.table}\n\n`);
  process.stdout.write(JSON.stringify({ target, comparison }, null, 2) + "\n");
  return comparison.allRunsPassed ? 0 : 1;
}

main().then((code) => { process.exitCode = code; })
  .catch((error) => { process.stderr.write(`summarize: unexpected failure: ${error?.stack ?? error}\n`); process.exitCode = 1; });
