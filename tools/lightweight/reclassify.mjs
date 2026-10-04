#!/usr/bin/env node
/**
 * reclassify.mjs — re-derive role classification and memory windows from ALREADY CAPTURED
 * raw samples, using the exact same shared code as the live driver (classify.mjs).
 *
 * Why this exists: an early revision of measure-memory.mjs labelled roles from command lines,
 * which the hot loop deliberately does not sample (WMI is too slow to run per tick). A process
 * that is a zinecv-desktop.exe child of the host was therefore reported as "hostExtra" and the
 * WebView2 children as "webview2Browser". The raw samples themselves were always complete
 * (pid/ppid/name/ws/priv/peaks), so the corrected classification can be recomputed offline
 * without starting any host again.
 *
 * This tool only reads evidence files and writes <label>-<n>.classified.json next to them.
 * It never starts a process.
 *
 * Usage:
 *   node tools/lightweight/reclassify.mjs --out <evidence dir> [--label run] [--runs 2]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { computeWindows, deriveSamples, scopeOf } from "./classify.mjs";

const MiB = (bytes) => (typeof bytes === "number" ? Number((bytes / 1024 / 1024).toFixed(1)) : null);

function parseArgs(argv) {
  const options = { out: null, label: "run", runs: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    switch (arg) {
      case "--out": options.out = value(); break;
      case "--label": options.label = value(); break;
      case "--runs": options.runs = Number(value()); break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.help && !options.out) throw new Error("--out is required");
  return options;
}

function trimWindow(window) {
  if (!window) return null;
  const scopes = {};
  for (const [scope, value] of Object.entries(window.scopes ?? {})) {
    scopes[scope] = { maxWorkingSetMiB: MiB(value.maxWorkingSetBytes), maxPrivateMiB: MiB(value.maxPrivateBytes),
      lastWorkingSetMiB: MiB(value.lastWorkingSetBytes), lastPrivateMiB: MiB(value.lastPrivateBytes),
      maxProcessCount: value.maxProcessCount };
  }
  return { windowMs: window.windowMs, sampleCount: window.sampleCount, firstSampleMs: window.firstSampleMs,
    lastSampleMs: window.lastSampleMs,
    tree: { maxWorkingSetMiB: MiB(window.tree.maxWorkingSetBytes), maxPrivateMiB: MiB(window.tree.maxPrivateBytes),
      lastWorkingSetMiB: MiB(window.tree.lastWorkingSetBytes), lastPrivateMiB: MiB(window.tree.lastPrivateBytes),
      atMaxWorkingSetMs: window.tree.atMaxWorkingSetMs, maxProcessCount: window.tree.maxProcessCount },
    scopes,
    roles: Object.fromEntries(Object.entries(window.roles ?? {}).map(([role, value]) => [role, {
      maxWorkingSetMiB: MiB(value.maxWorkingSetBytes), maxPrivateMiB: MiB(value.maxPrivateBytes),
      lastWorkingSetMiB: MiB(value.lastWorkingSetBytes), lastPrivateMiB: MiB(value.lastPrivateBytes),
      maxProcessCount: value.maxProcessCount }])),
  };
}

async function reclassifyOne(file) {
  const run = JSON.parse(await readFile(file, "utf8"));
  const rootPid = run.host?.pid ?? null;
  const t0 = run.timeline?.t0EpochMs ?? null;
  if (!rootPid || !t0) throw new Error(`${file}: missing host pid or timeline t0EpochMs`);
  const derived = deriveSamples(run.rawSamples ?? [], rootPid, t0);
  const tOf = (name) => run.timeline?.marks?.find((mark) => mark.name === name)?.tMs ?? null;
  const windows = computeWindows(derived, tOf, { idleSettleMs: run.options?.idleSettleMs ?? 3000 });

  // Per-role and per-scope peaks over the whole measured span.
  const roles = new Map();
  const scopes = new Map();
  const peaks = { treeWorkingSetBytes: 0, treePrivateBytes: 0, atMs: null };
  for (const sample of derived) {
    if (sample.totalWs > peaks.treeWorkingSetBytes) { peaks.treeWorkingSetBytes = sample.totalWs; peaks.atMs = sample.tMs; }
    peaks.treePrivateBytes = Math.max(peaks.treePrivateBytes, sample.totalPriv);
    for (const [role, bucket] of Object.entries(sample.byRole)) {
      const record = roles.get(role) ?? { pidSet: new Set(), maxWorkingSetBytes: 0, maxPrivateBytes: 0, maxProcessCount: 0 };
      if (bucket.ws > record.maxWorkingSetBytes) record.maxWorkingSetBytes = bucket.ws;
      record.maxPrivateBytes = Math.max(record.maxPrivateBytes, bucket.priv);
      record.maxProcessCount = Math.max(record.maxProcessCount, bucket.count);
      roles.set(role, record);
      const scope = scopeOf(role);
      const scopeRecord = scopes.get(scope) ?? { maxWorkingSetBytes: 0, maxPrivateBytes: 0, maxProcessCount: 0 };
      const scopeWs = Object.entries(sample.byRole).filter(([r]) => scopeOf(r) === scope).reduce((sum, [, b]) => sum + b.ws, 0);
      const scopePriv = Object.entries(sample.byRole).filter(([r]) => scopeOf(r) === scope).reduce((sum, [, b]) => sum + b.priv, 0);
      const scopeCount = Object.entries(sample.byRole).filter(([r]) => scopeOf(r) === scope).reduce((sum, [, b]) => sum + b.count, 0);
      scopeRecord.maxWorkingSetBytes = Math.max(scopeRecord.maxWorkingSetBytes, scopeWs);
      scopeRecord.maxPrivateBytes = Math.max(scopeRecord.maxPrivateBytes, scopePriv);
      scopeRecord.maxProcessCount = Math.max(scopeRecord.maxProcessCount, scopeCount);
      scopes.set(scope, scopeRecord);
    }
    for (const proc of sample.procs) {
      const record = roles.get(proc.role);
      if (record) record.pidSet.add(proc.pid);
    }
  }

  const firstSeen = new Map();
  for (const sample of derived) for (const proc of sample.procs) if (!firstSeen.has(proc.pid)) firstSeen.set(proc.pid, sample.tMs);

  return {
    schema: "zinecv.lightweight.memory.classified.v1",
    source: { file, runId: run.run?.id ?? null, status: run.run?.status ?? null, binarySha256: run.binary?.before?.sha256 ?? null,
      sampledAt: run.run?.startedAtIso ?? null, rawSampleCount: (run.rawSamples ?? []).length },
    classification: {
      note: "offline re-derivation from the same raw samples with the corrected structural classifier (classify.mjs)",
      rules: ["pid === host pid -> host", "zinecv-desktop.exe with pid !== host pid -> renderWorker",
        "msedgewebview2.exe whose parent is not WebView2 -> webview2Browser", "other msedgewebview2.exe -> webview2Child",
        "refined to renderer/gpu/utility/crashpad when a command line is available"],
    },
    sampling: { sampleCount: derived.length, configuredIntervalMs: run.memory?.sampleIntervalMs ?? null,
      meanIntervalMs: run.memory?.meanSampleIntervalMs ?? null, maxDeltaMs: run.memory?.maxSampleDeltaMs ?? null,
      deltasOver200ms: run.memory?.deltasOver200ms ?? null, topologySource: run.rawSamplerMeta?.[0]?.topologySource ?? null,
      samplerCpuSeconds: run.rawSamplerMeta?.[0]?.cpuSeconds ?? null, samplerWarmupMs: run.samplerControl?.ready?.warmupMs ?? null,
      attachWaitedMs: run.samplerControl?.attached?.waitedMs ?? null },
    timeline: Object.fromEntries((run.timeline?.marks ?? []).map((mark) => [mark.name, mark.tMs])),
    peak: { treeWorkingSetMiB: MiB(peaks.treeWorkingSetBytes), treePrivateMiB: MiB(peaks.treePrivateBytes), atMs: peaks.atMs },
    byRolePeak: Object.fromEntries([...roles].map(([role, record]) => [role, { pids: [...record.pidSet].sort((a, b) => a - b),
      maxWorkingSetMiB: MiB(record.maxWorkingSetBytes), maxPrivateMiB: MiB(record.maxPrivateBytes),
      maxProcessCount: record.maxProcessCount, firstSeenMs: Math.min(...[...record.pidSet].map((pid) => firstSeen.get(pid) ?? 0)) }])),
    byScopePeak: Object.fromEntries([...scopes].map(([scope, record]) => [scope, { maxWorkingSetMiB: MiB(record.maxWorkingSetBytes),
      maxPrivateMiB: MiB(record.maxPrivateBytes), maxProcessCount: record.maxProcessCount }])),
    windows: Object.fromEntries(Object.entries(windows).map(([name, window]) => [name, trimWindow(window)])),
    checkpoints: {
      preview: run.checkpoints?.preview ?? null,
      export: run.checkpoints?.export ?? null,
      contentPrep: run.checkpoints?.contentPrep ?? null,
      finalSnapshot: { at: run.checkpoints?.finalSnapshot?.at ?? null, inTreeCount: run.checkpoints?.finalSnapshot?.inTreeCount ?? null,
        treeWorkingSetBytes: run.checkpoints?.finalSnapshot?.treeWorkingSetBytes ?? null,
        treePrivateBytes: run.checkpoints?.finalSnapshot?.treePrivateBytes ?? null,
        workerCommandLines: run.checkpoints?.finalSnapshot?.workerCommandLines ?? null,
        webview2Types: run.checkpoints?.finalSnapshot?.webview2Types ?? null },
    },
    cleanup: run.cleanup ? { leftoverCheck: run.cleanup.leftoverCheck ?? null, ownPidsStillAlive: run.cleanup.ownPidsStillAlive ?? null,
      newWebview2PidsAfterCleanup: run.cleanup.newWebview2PidsAfterCleanup ?? null, profileDeleted: run.cleanup.profileDeleted ?? null,
      cleanupVerified: run.cleanup.cleanupVerified ?? null } : null,
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`reclassify: ${error.message}\n`); return 2; }
  if (options.help) { process.stdout.write("node tools/lightweight/reclassify.mjs --out <dir> [--label run] [--runs 2]\n"); return 0; }
  const outDir = resolve(options.out);
  const written = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const file = join(outDir, `${options.label}-${index}.json`);
    try {
      const classified = await reclassifyOne(file);
      const target = join(outDir, `${options.label}-${index}.classified.json`);
      await writeFile(target, JSON.stringify(classified, null, 2) + "\n", "utf8");
      written.push({ target, peakTreeWorkingSetMiB: classified.peak.treeWorkingSetMiB,
        scopes: classified.byScopePeak, worker: classified.byRolePeak.renderWorker ?? null });
    } catch (error) {
      process.stderr.write(`reclassify: ${file}: ${error.message}\n`);
      return 1;
    }
  }
  process.stdout.write(JSON.stringify(written, null, 2) + "\n");
  return 0;
}

main().then((code) => { process.exitCode = code; })
  .catch((error) => { process.stderr.write(`reclassify: unexpected failure: ${error?.stack ?? error}\n`); process.exitCode = 1; });
