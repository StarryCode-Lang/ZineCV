#!/usr/bin/env node
import {
  here, repoRoot, SAMPLER, STOPPER, DEFAULT_APP, SCHEMA, PREP_TEXT, PREP_REPEAT, PRESETS,
  disableInspectorNetworkRecording, HELP, nowMs, iso, sleep, withTimeout, runPowerShell,
  runPowerShellInline, parseJsonLines, parsePe, fileFingerprint, freePort, machineInfo,
  hostProcessCount, freeRamBytes, processInventory, PAGE_BOOTSTRAP, ipcProbe, prepareContent,
  renderPreview, releasePreview, renderExport, releaseExport, startHost, sanitizeEnvironment,
  sampleOnce, Sampler, cleanupTree, percentiles, soakMemoryWindow, longSoakQualification,
  soakUi,
} from './measurement-runtime.mjs';
export { disableInspectorNetworkRecording, percentiles, soakMemoryWindow, longSoakQualification };
/**
 * measure-memory.mjs — real-process memory / startup-footprint measurement for the
 * ZineCV Tauri desktop host (tools/lightweight).
 *
 * Why this exists: the "极致轻量化" memory claim must be backed by numbers read from
 * real processes, not estimates. This tool starts the *release* host exactly the way
 * tests/native/host-fixture.mjs does (isolated APPDATA / LOCALAPPDATA / ZINECV_DATA_DIR /
 * WEBVIEW2_USER_DATA_FOLDER + remote debugging port), samples the whole process tree
 * (host -> render worker -> msedgewebview2 children) every <=200 ms from a long-lived
 * PowerShell sampler, records explicit checkpoints (idle / preview / export), then kills
 * the tree and deletes the isolated profile.
 *
 * It never builds anything and never imports from tests/ (the launcher below is a
 * standalone copy of the fixture's env contract, kept in sync by reading that file).
 *
 * Serialization: this tool starts a real WebView2 host. Only run it when the Lead has
 * confirmed no other WebView2 test is running on the machine.
 *
 * Usage: see tools/lightweight/README.md
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyProcesses, computeWindows, deriveSamples, scopeOf, summarizeWindow } from "./classify.mjs";

/* ------------------------------------------------------------------ CLI ---- */

export function parseArgs(argv) {
  const options = {
    app: DEFAULT_APP, runs: 1, intervalMs: 150, out: null, label: "run",
    idleSettleMs: 3000, previewSettleMs: 1500, exportSettleMs: 1500,
    bootTimeoutMs: 90_000, stepTimeoutMs: 120_000, totalTimeoutMs: 300_000,
    samplerBootTimeoutMs: 60_000, topologyEveryN: 0, soakMs: null, preset: "quick",
    keepProfile: false, allowPreexistingHost: false, requireNoWebview2: false, samplePid: 0, sampleMs: 2000,
    selftest: false, machineInfo: false, help: false, diagnostics: false, historyMode: "growing",
  };
  const explicit = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    switch (arg) {
      case "--app": options.app = value(); break;
      case "--runs": options.runs = Number(value()); explicit.add("runs"); break;
      case "--interval-ms": options.intervalMs = Number(value()); break;
      case "--topology-every-n": options.topologyEveryN = Number(value()); break;
      case "--sampler-boot-timeout-ms": options.samplerBootTimeoutMs = Number(value()); break;
      case "--out": options.out = value(); break;
      case "--label": options.label = value(); break;
      case "--idle-settle-ms": options.idleSettleMs = Number(value()); break;
      case "--preview-settle-ms": options.previewSettleMs = Number(value()); break;
      case "--export-settle-ms": options.exportSettleMs = Number(value()); break;
      case "--boot-timeout-ms": options.bootTimeoutMs = Number(value()); break;
      case "--step-timeout-ms": options.stepTimeoutMs = Number(value()); break;
      case "--total-timeout-ms": options.totalTimeoutMs = Number(value()); break;
      case "--soak-ms": options.soakMs = Number(value()); explicit.add("soakMs"); break;
      case "--preset": options.preset = value(); break;
      case "--keep-profile": options.keepProfile = true; break;
      case "--allow-preexisting-host": options.allowPreexistingHost = true; break;
      case "--require-no-webview2": options.requireNoWebview2 = true; break;
      case "--sample-pid": options.samplePid = Number(value()); break;
      case "--sample-ms": options.sampleMs = Number(value()); break;
      case "--selftest": options.selftest = true; break;
      case "--machine-info": options.machineInfo = true; break;
      case "--diagnostics": options.diagnostics = true; break;
      case "--history-mode": options.historyMode = value(); break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Object.hasOwn(PRESETS, options.preset)) throw new Error("--preset must be quick, standard, or extended");
  if (!["growing", "fixed"].includes(options.historyMode)) throw new Error("--history-mode must be growing or fixed");
  for (const [name, budget] of Object.entries(PRESETS[options.preset])) if (!explicit.has(name)) options[name] = budget;
  if (!Number.isSafeInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 20 || options.intervalMs > 200) {
    throw new Error(`--interval-ms must be between 20 and 200 (got ${options.intervalMs})`);
  }
  if (!Number.isSafeInteger(options.soakMs) || options.soakMs < 0) throw new Error("--soak-ms must be a non-negative integer");
  // Leave room for boot/checkpoints/teardown outside the continuous UI window.
  options.totalTimeoutMs = Math.max(options.totalTimeoutMs, options.soakMs + 300_000);
  return options;
}

async function runOnce({ index, options, machine, outDir, binaryBefore, chromium }) {
  const runId = `${options.label}-${index}`;
  const startedAtMs = nowMs();
  const tmpRoot = join(outDir, "tmp");
  const profile = join(tmpRoot, `${runId}-${Math.random().toString(36).slice(2, 8)}`);
  const dataDir = join(profile, "Data");
  const report = {
    schema: SCHEMA,
    run: { id: runId, index, label: options.label, startedAtIso: iso(startedAtMs), status: "running", error: null },
    tool: { path: join(here, "measure-memory.mjs"), sampler: SAMPLER, stopper: STOPPER },
    options: { app: options.app, runs: options.runs, intervalMs: options.intervalMs, idleSettleMs: options.idleSettleMs,
      previewSettleMs: options.previewSettleMs, exportSettleMs: options.exportSettleMs, bootTimeoutMs: options.bootTimeoutMs,
      stepTimeoutMs: options.stepTimeoutMs, totalTimeoutMs: options.totalTimeoutMs, preset: options.preset,
      soakMs: options.soakMs, historyMode: options.historyMode, requestedInteractionBudgetMs: options.soakMs * options.runs, prepText: PREP_TEXT, prepRepeat: PREP_REPEAT },
    machine,
    binary: { before: binaryBefore, after: null, stableAcrossRun: null },
    host: { pid: null, profile, dataDir, environment: null, freeRamBytesBefore: await freeRamBytes(),
      preRunHostCount: await hostProcessCount(), preRunWebview2Pids: null },
    timeline: { t0EpochMs: startedAtMs, marks: [] },
    checkpoints: {},
    memory: null,
    processes: null,
    cleanup: null,
    limitations: [],
    rawSamples: [],
    rawSamplerMeta: null,
  };
  const marks = report.timeline.marks;
  const mark = (name, atMs = nowMs()) => { marks.push({ name, atMs, tMs: atMs - startedAtMs, iso: iso(atMs) }); return atMs; };

  let child = null, browser = null, page = null, sampler = null, watchdog = null;
  const observedPids = new Set();
  let fatal = null;
  const hardStop = () => {
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* noop */ } }
  };
  try {
    if (report.host.preRunHostCount.unknown) {
      report.limitations.push("pre-run machine census was unavailable; pre-existing host processes could not be ruled out");
    } else if (report.host.preRunHostCount.zinecvDesktop > 0 && !options.allowPreexistingHost) {
      throw new Error(`refusing to measure with ${report.host.preRunHostCount.zinecvDesktop} pre-existing zinecv-desktop.exe process(es); attribution would be ambiguous`);
    }
    if (!report.host.preRunHostCount.unknown) report.host.preRunWebview2Pids = report.host.preRunHostCount.webview2Pids;
    await mkdir(profile, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(profile, "Roaming"), { recursive: true });
    await mkdir(join(profile, "Local"), { recursive: true });
    await mkdir(join(profile, "WebView2"), { recursive: true });
    await mkdir(join(profile, "导出 中文 目录"), { recursive: true });

    const port = await freePort();
    // The sampler is pre-warmed BEFORE the host exists, then attaches to the host pid via a
    // pid file, so the cold-start window is covered from a few ms after process creation.
    const pidFile = join(profile, "root.pid");
    sampler = new Sampler({ rootPidFile: pidFile, intervalMs: options.intervalMs, stopFile: join(profile, ".sampler-stop"),
      topologyEveryN: options.topologyEveryN });
    sampler.start();
    report.samplerControl = { ready: await sampler.waitFor("ready", options.samplerBootTimeoutMs) };
    mark("samplerReady");

    const spawnAtMs = nowMs();
    const host = startHost({ app: options.app, profile, port, dataDir });
    child = host.child;
    report.host.pid = child.pid;
    report.host.environment = host.environment;
    mark("hostSpawned", spawnAtMs);
    report.timeline.spawnAtMs = spawnAtMs;
    await writeFile(pidFile, `${child.pid}\n`, "utf8");
    mark("pidFileWritten");

    watchdog = setTimeout(() => {
      fatal = fatal ?? new Error(`total watchdog fired after ${options.totalTimeoutMs} ms`);
      hardStop();
    }, options.totalTimeoutMs);

    // --- process creation -> first IPC available -------------------------------
    let connectError = null;
    const connectDeadline = nowMs() + options.bootTimeoutMs;
    while (nowMs() < connectDeadline) {
      if (child.exitCode !== null) throw new Error(`host exited during boot with code ${child.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; }
      catch (error) { connectError = error; await sleep(250); }
    }
    if (!browser) throw new Error(`WebView2 host never exposed CDP on port ${port}: ${connectError?.message ?? "unknown"}`);
    mark("cdpConnected");

    for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
      page = browser.contexts().flatMap((context) => context.pages())[0] ?? null;
      if (!page) await sleep(250);
    }
    if (!page) throw new Error("CDP connected but the host exposed no page");
    report.instrumentation = { startup: await disableInspectorNetworkRecording(browser) };
    const { installAsyncWait } = await import("../../tests/native/async-wait.mjs");
    installAsyncWait(page);
    mark("pageAttached");

    await page.locator(".app-shell").waitFor({ timeout: options.bootTimeoutMs });
    mark("appShellVisible");
    const saveState = page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/);
    await saveState.waitFor({ timeout: options.bootTimeoutMs });
    report.timeline.saveStateText = (await saveState.first().textContent())?.trim() ?? null;
    mark("draftReady");

    const probe = await withTimeout(ipcProbe(page), options.stepTimeoutMs, "document_state probe");
    report.checkpoints.ipc = probe;
    mark("firstIpcOk");

    // --- checkpoint: cold start idle ------------------------------------------
    await sleep(options.idleSettleMs);
    const idleCheckpoint = nowMs();
    mark("idleCheckpoint", idleCheckpoint);

    // --- deterministic content, so preview and export are real multi-page work --
    const prepStart = nowMs();
    mark("contentPrepStart", prepStart);
    report.checkpoints.contentPrep = await withTimeout(prepareContent(page), options.stepTimeoutMs, "prepare content");
    const prepEnd = nowMs();
    mark("contentPrepDone", prepEnd);

    const previewStart = nowMs();
    mark("previewStart", previewStart);
    report.checkpoints.preview = await withTimeout(renderPreview(page), options.stepTimeoutMs, "render_document_preview");
    const previewRendered = nowMs();
    mark("previewRendered", previewRendered);
    await sleep(options.previewSettleMs);
    const previewCheckpoint = nowMs();
    mark("previewCheckpoint", previewCheckpoint);

    report.checkpoints.previewRelease = await withTimeout(releasePreview(page), options.stepTimeoutMs, "release preview");
    mark("previewReleased");

    const exportStart = nowMs();
    mark("exportStart", exportStart);
    report.checkpoints.export = await withTimeout(renderExport(page, {
      pdf: join(profile, "导出 中文 目录", "测量 导出.pdf"),
      longPng: join(profile, "导出 中文 目录", "测量 导出.png"),
    }), options.stepTimeoutMs, "render_document_export");
    const exportRendered = nowMs();
    mark("exportRendered", exportRendered);
    await sleep(options.exportSettleMs);
    const exportCheckpoint = nowMs();
    mark("exportCheckpoint", exportCheckpoint);
    report.checkpoints.exportRelease = await withTimeout(releaseExport(page), options.stepTimeoutMs, "release export");
    mark("exportReleased");

    if (options.soakMs > 0) await soakUi(page, { durationMs: options.soakMs,
      stepTimeoutMs: options.stepTimeoutMs, profile, report, mark, diagnostics: options.diagnostics, historyMode: options.historyMode });

    // final observation while every process is still alive (peak counters + command lines)
    const finalSnapshot = await sampleOnce(child.pid);
    mark("finalSnapshot");
    const finalClassified = classifyProcesses(finalSnapshot.procs || [], child.pid);
    report.checkpoints.finalSnapshot = {
      at: iso(finalSnapshot.atEpochMs),
      inTreeCount: finalSnapshot.inTreeCount,
      treeWorkingSetBytes: (finalSnapshot.procs || []).reduce((sum, proc) => sum + proc.ws, 0),
      treePrivateBytes: (finalSnapshot.procs || []).reduce((sum, proc) => sum + proc.priv, 0),
      pids: (finalSnapshot.procs || []).map((proc) => proc.pid),
      // Command lines are only available here (the hot loop avoids WMI): this is the runtime
      // proof for --zinecv-render-worker and for the WebView2 --type= sub-roles.
      procs: finalClassified.map((proc) => ({ pid: proc.pid, ppid: proc.ppid, role: proc.role, name: proc.name,
        workingSetBytes: proc.ws, privateBytes: proc.priv, peakWorkingSetBytes: proc.peakWs,
        peakPageFileBytes: proc.peakPageFile, threads: proc.threads, commandLine: proc.cmd,
        workerCommandLineVerified: proc.workerCommandLineVerified ?? null, webview2Type: proc.webview2Type ?? null })),
      workerCommandLines: finalClassified.filter((proc) => proc.role === "renderWorker").map((proc) => ({ pid: proc.pid, commandLine: proc.cmd })),
      webview2Types: Object.fromEntries(finalClassified.filter((proc) => String(proc.role).startsWith("webview2"))
        .map((proc) => [proc.pid, { role: proc.role, type: proc.webview2Type ?? null, roleSource: proc.webview2RoleSource ?? null }])),
    };
    report.processesRuntimeCommandLineEvidence = {
      capturedAt: iso(finalSnapshot.atEpochMs),
      source: "one-shot CIM snapshot taken before teardown while the whole tree was alive",
      workerCommandLines: report.checkpoints.finalSnapshot.workerCommandLines,
      webview2Types: report.checkpoints.finalSnapshot.webview2Types,
    };
    // scan for descendants that are neither zinecv-desktop.exe nor msedgewebview2.exe
    const allDescendants = await sampleOnce(child.pid, { allProcesses: true });
    report.checkpoints.unexpectedDescendants = (allDescendants.procs || [])
      .filter((proc) => !/^(zinecv-desktop|msedgewebview2)\.exe$/i.test(proc.name))
      .map((proc) => ({ pid: proc.pid, name: proc.name, commandLine: proc.cmd }));

    report.run.status = "passed";
  } catch (error) {
    fatal = fatal ?? error;
    report.run.status = "failed";
    report.run.error = String(error?.stack ?? error);
  } finally {
    clearTimeout(watchdog);
    mark("teardownStarted");

    if (page && report.run.status === "passed") {
      try { const state = await withTimeout(ipcProbe(page), 15_000, "post-run document_state"); report.checkpoints.postRunState = state; }
      catch (error) { report.checkpoints.postRunState = { ok: false, error: String(error.message ?? error) }; }
    }
    // Same teardown order as tests/native/host-fixture.mjs: stop the host, then drop CDP.
    const hostKill = child && child.exitCode === null
      ? await new Promise((done) => { child.once("exit", (code) => done(code)); try { child.kill(); } catch { done(null); } })
      : (child ? child.exitCode : null);
    if (child) mark("hostExited");
    if (browser) { try { await withTimeout(browser.close(), 10_000, "browser close"); } catch { /* host already stopped */ } }
    // Stop the sampler last, so the samples include the whole live window of the tree.
    const samplerMeta = sampler ? await sampler.stop() : null;
    const rawEntries = sampler ? sampler.entries() : [];
    for (const entry of rawEntries) for (const proc of entry.procs || []) observedPids.add(proc.pid);
    if (child?.pid) observedPids.add(child.pid);

    const treeCleanup = await cleanupTree([...observedPids], { label: "recorded pids" });
    const leftovers = await hostProcessCount();
    report.cleanup = {
      samplerStop: samplerMeta,
      hostExitCode: hostKill,
      treeStop: treeCleanup,
      observedPids: [...observedPids].sort((a, b) => a - b),
      leftoverCheck: leftovers,
      profileDeleted: false,
      profileKept: null,
      freeRamBytesAfter: await freeRamBytes(),
    };
    mark("cleanupDone");

    report.rawSamples = rawEntries.filter((entry) => entry.kind === "sample");
    report.rawSamplerMeta = rawEntries.filter((entry) => entry.kind === "meta");
    report.samplerDiagnostics = rawEntries.filter((entry) => entry.kind === "error");
    report.samplerControl = { ...(report.samplerControl ?? {}), attached: rawEntries.find((entry) => entry.kind === "attached") ?? null };

    // Aggregate only the samples that belong to this run window.
    const derived = deriveSamples(report.rawSamples, report.host.pid, report.timeline.t0EpochMs);
    const t = (name) => marks.find((entry) => entry.name === name)?.tMs ?? null;
    report.memory = {
      sampleIntervalMs: options.intervalMs,
      topologyEveryN: options.topologyEveryN,
      sampleCount: derived.length,
      observedSpanMs: derived.length ? derived[derived.length - 1].tMs - derived[0].tMs : 0,
      meanSampleIntervalMs: derived.length > 1 ? Number(((derived[derived.length - 1].tMs - derived[0].tMs) / (derived.length - 1)).toFixed(2)) : null,
      maxSampleDeltaMs: derived.reduce((max, sample) => Math.max(max, sample.deltaMs ?? 0), 0),
      deltasOver200ms: derived.filter((sample) => (sample.deltaMs ?? 0) > 200).length,
      maxFastPathMs: derived.reduce((max, sample) => Math.max(max, sample.fastMs ?? 0), 0),
      maxCimRefreshMs: derived.reduce((max, sample) => Math.max(max, sample.cimMs ?? 0), 0),
      topologyRefreshCount: derived.filter((sample) => sample.topologyRefreshed).length,
      maxQueryMs: derived.reduce((max, sample) => Math.max(max, sample.queryMs ?? 0), 0),
      queryMsDefinition: "fastMs (GetProcesses fast path) + cimMs (topology refresh when it ran); measurement overhead per sample",
      peak: {
        treeWorkingSetBytes: derived.reduce((max, sample) => Math.max(max, sample.totalWs), 0),
        treePrivateBytes: derived.reduce((max, sample) => Math.max(max, sample.totalPriv), 0),
        atMs: derived.reduce((best, sample) => (sample.totalWs > (best?.totalWs ?? -1) ? sample : best), null)?.tMs ?? null,
      },
      windows: computeWindows(derived, t, { idleSettleMs: options.idleSettleMs }),
    };
    const inventory = processInventory(derived);
    if (report.soak && t("soakStart") !== null) {
      report.memory.windows.soak = summarizeWindow(derived, t("soakStart"), t("soakEnd"));
      report.soak.memory = soakMemoryWindow(derived, t("soakStart"), t("soakEnd"));
      report.soak.memoryWindows = [];
      for (let from = t("soakStart"); from < t("soakEnd"); from += 300_000) {
        report.soak.memoryWindows.push(soakMemoryWindow(derived, from, Math.min(from + 300_000, t("soakEnd"))));
      }
    }
    report.processes = {
      count: inventory.length,
      byRole: Object.fromEntries([...new Set(inventory.map((proc) => proc.role))].map((role) => [role,
        inventory.filter((proc) => proc.role === role).map((proc) => proc.pid)])),
      firstWorkerSeenMs: inventory.find((proc) => proc.role === "renderWorker")?.firstSeenMs ?? null,
      workerEvidence: (() => {
        const workers = inventory.filter((proc) => proc.role === "renderWorker");
        const commandLines = report.checkpoints?.finalSnapshot?.workerCommandLines ?? [];
        return {
          pids: workers.map((proc) => proc.pid),
          firstSeenMs: workers.length ? Math.min(...workers.map((proc) => proc.firstSeenMs)) : null,
          lastSeenMs: workers.length ? Math.max(...workers.map((proc) => proc.lastSeenMs)) : null,
          identification: "zinecv-desktop.exe process whose ppid is the host pid (the host spawns exactly one render worker, in a Windows Job object)",
          commandLineCapturedRuntime: commandLines,
          commandLineSwitchVerified: commandLines.length ? commandLines.every((entry) => /--zinecv-render-worker/.test(entry.commandLine || "")) : null,
          commandLineNote: commandLines.length
            ? "runtime command line captured by the pre-teardown CIM snapshot"
            : "no runtime command line captured in this run (in-loop samples carry none); identity rests on the structural rule above",
        };
      })(),
      lifetimePeakSumWorkingSetBytes: inventory.reduce((sum, proc) => sum + proc.osPeakWorkingSetBytes, 0),
      lifetimePeakSumPrivateBytes: inventory.reduce((sum, proc) => sum + proc.osPeakPageFileBytes, 0),
      lifetimePeakNote: "sum of per-process OS lifetime peaks; an upper bound because the peaks are not simultaneous",
      inventory,
    };

    // Cleanup verification + profile removal.
    const baselineWebview2Pids = report.host.preRunWebview2Pids ?? [];
    const ourPids = [...observedPids];
    const postCensus = report.cleanup.leftoverCheck;
    if (postCensus.unknown) {
      report.cleanup.ownPidsStillAlive = null;
      report.cleanup.newWebview2PidsAfterCleanup = null;
      report.cleanup.webview2BaselineDelta = null;
      report.cleanup.cleanupVerified = false;
      report.cleanup.cleanupVerificationNote = "post-run machine census unavailable: leftover verification unknown, not zero";
      report.limitations.push("post-run machine census failed, so 'no leftover processes' could not be verified for this run");
    } else {
      const alive = new Set([...(postCensus.zinecvPids ?? []), ...(postCensus.webview2Pids ?? [])]);
      report.cleanup.ownPidsStillAlive = ourPids.filter((pid) => alive.has(pid));
      report.cleanup.newWebview2PidsAfterCleanup = (postCensus.webview2Pids ?? []).filter((pid) => !baselineWebview2Pids.includes(pid));
      report.cleanup.webview2BaselineDelta = baselineWebview2Pids.length
        ? postCensus.msedgewebview2 - baselineWebview2Pids.length : null;
      report.cleanup.cleanupVerified = report.cleanup.ownPidsStillAlive.length === 0;
      report.cleanup.cleanupVerificationNote = "ownPidsStillAlive is the pid intersection of every pid we ever saw with the machine census after cleanup; "
        + "newWebview2PidsAfterCleanup lists machine-level msedgewebview2 pids that appeared during the run and are still alive (unrelated apps can create these; none of ours may remain)";
    }

    if (child && child.exitCode === null) {
      report.limitations.push("host process did not exit on kill request; leftovers were force-stopped by pid");
    }
    if (options.keepProfile) {
      report.cleanup.profileKept = "requested by --keep-profile";
    } else {
      try {
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        report.cleanup.profileDeleted = true;
      } catch (error) {
        report.cleanup.profileDeleted = false;
        report.cleanup.profileDeleteError = String(error.message ?? error);
      }
    }
    try { await rm(join(tmpRoot), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* keep tmp evidence */ }

    report.binary.after = await fileFingerprint(options.app).catch((error) => ({ error: String(error.message ?? error) }));
    report.binary.stableAcrossRun = Boolean(report.binary.after?.sha256 && binaryBefore?.sha256 && report.binary.after.sha256 === binaryBefore.sha256);
    report.binary.sizeStableAcrossRun = report.binary.after?.sizeBytes === binaryBefore?.sizeBytes;
    report.binary.layoutStableAcrossRun = Boolean(report.binary.after?.pe?.sectionSignature
      && binaryBefore?.pe?.sectionSignature && report.binary.after.pe.sectionSignature === binaryBefore.pe.sectionSignature);
    report.binary.identicalLayoutDifferentHash = report.binary.sizeStableAcrossRun && report.binary.layoutStableAcrossRun && !report.binary.stableAcrossRun;
    report.binary.stabilityVerdict = report.binary.stableAcrossRun ? "byte-identical"
      : (report.binary.sizeStableAcrossRun && report.binary.layoutStableAcrossRun
        ? "same-size-same-section-layout (only the PE build TimeDateStamp differs: not a mid-run replacement)"
        : "changed (size or section layout differs: treat as a replaced binary)");
    if (report.binary.identicalLayoutDifferentHash) {
      report.binary.peTimeStamps = { before: binaryBefore?.pe?.timeDateStampIso ?? null, after: report.binary.after?.pe?.timeDateStampIso ?? null };
    }
    report.run.endedAtIso = iso(nowMs());
    report.run.durationMs = nowMs() - startedAtMs;
    if (report.run.status === "passed" && fatal) { report.run.status = "failed"; report.run.error = String(fatal?.stack ?? fatal); }
    if (fatal) report.run.status = "failed";

    report.limitations.push(
      "WorkingSet64 counts shared pages mapped into a process; summing a tree therefore double-counts shared WebView2/OS pages. PrivateMemorySize64 (commit) is the closer additive figure.",
      "WebView2 child processes are recycled by the runtime; a per-pid OS lifetime peak disappears with the process, so tree peaks are sampled (<=200 ms) and cross-checked against per-process peak counters.",
      "Only zinecv-desktop.exe and msedgewebview2.exe members are tracked in samples; a one-shot full descendant scan verifies nothing else was spawned.",
      "Preview was triggered through the same Tauri command the UI uses plus an <img> decode of every returned page; the React viewer's own overhead is not included.",
      "Sampler adds one Win32_Process query per interval; the sampler's own CPU/working set is recorded in rawSamplerMeta.",
    );
  }
  return report;
}

/* ---------------------------------------------------------------- selftest ---- */

async function selftest(options) {
  const outDir = resolve(options.out ?? join(repoRoot, ".artifacts/remaining/lightweight-20261003/measure"));
  await mkdir(outDir, { recursive: true });
  const report = { schema: `${SCHEMA}.selftest`, startedAtIso: iso(nowMs()), checks: {} };

  // 1) sampler fast path + parent/child closure, without any host: watch this Node process
  //    and the sampler's own PowerShell child (spawned by Node, so it must appear in-tree).
  const stopFile = join(outDir, "tmp-selftest-stop");
  await rm(stopFile, { force: true });
  const sampler = new Sampler({ rootPid: process.pid, intervalMs: 100, stopFile, topologyEveryN: options.topologyEveryN,
    processNames: "node.exe,powershell.exe" });
  sampler.start();
  let readyError = null;
  try { await sampler.waitFor("sample", options.samplerBootTimeoutMs); } catch (error) { readyError = String(error.message ?? error); }
  await sleep(options.sampleMs);
  const samplerStop = await sampler.stop();
  const entries = sampler.entries();
  const samples = entries.filter((entry) => entry.kind === "sample");
  const selfSamples = samples.filter((sample) => (sample.procs || []).some((proc) => proc.pid === process.pid && proc.present !== false && proc.ws > 0));
  const childSamples = samples.filter((sample) => (sample.procs || []).some((proc) => proc.ppid === process.pid && proc.present !== false));
  const deltas = samples.map((sample) => sample.deltaMs).filter((value) => typeof value === "number" && value > 0);
  report.checks.samplerFastPath = {
    pass: samples.length >= 3 && selfSamples.length === samples.length && childSamples.length > 0 && readyError === null
      && (deltas.length ? Math.max(...deltas) : Infinity) <= 200,
    samples: samples.length, samplesWithSelf: selfSamples.length, samplesWithChildOfSelf: childSamples.length, readyError,
    meanIntervalMs: deltas.length ? Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(2)) : null,
    maxIntervalMs: deltas.length ? Math.max(...deltas) : null,
    topologyRefreshes: samples.filter((sample) => sample.topologyRefreshed).length,
    cadenceTimeline: samples.map((sample) => ({ index: sample.index, deltaMs: sample.deltaMs, fastMs: sample.fastMs,
      cimMs: sample.cimMs, refreshed: sample.topologyRefreshed === true })),
    stop: samplerStop,
    meta: entries.filter((entry) => entry.kind === "meta"),
  };
  await rm(stopFile, { force: true });

  // 2) production attach path: pre-warmed sampler waits for the root pid file, then samples.
  const rootPidFile = join(outDir, "tmp-selftest-root.pid");
  const stopFile2 = join(outDir, "tmp-selftest-stop2");
  await rm(rootPidFile, { force: true }); await rm(stopFile2, { force: true });
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
  const attaching = new Sampler({ rootPidFile, intervalMs: 100, stopFile: stopFile2, topologyEveryN: 20, processNames: "node.exe" });
  attaching.start();
  let attachReport = { error: null };
  try {
    const ready = await attaching.waitFor("ready", options.samplerBootTimeoutMs);
    await writeFile(rootPidFile, `${dummy.pid}\n`, "utf8");
    const attached = await attaching.waitFor("attached", 20_000);
    await sleep(900);
    attachReport = { readyWarmupMs: ready.warmupMs, attachedRootPid: attached.rootPid, attachWaitedMs: attached.waitedMs, error: null };
  } catch (error) { attachReport.error = String(error.message ?? error); }
  const attachStop = await attaching.stop();
  if (dummy.exitCode === null) dummy.kill();
  const attachSamples = attaching.entries().filter((entry) => entry.kind === "sample");
  const dummySeen = attachSamples.some((sample) => (sample.procs || []).some((proc) => proc.pid === dummy.pid && proc.present !== false && proc.ws > 0));
  report.checks.pidFileAttach = {
    pass: attachReport.error === null && attachReport.attachedRootPid === dummy.pid && attachSamples.length >= 3 && dummySeen,
    ...attachReport, dummyPid: dummy.pid, samples: attachSamples.length, dummySeen, stop: attachStop,
    expectation: "ready -> attached(rootPid) -> samples that contain the attached root with a real working set",
  };
  await rm(rootPidFile, { force: true }); await rm(stopFile2, { force: true });

  // 3) CIM one-shot snapshot path, used in real runs for command lines (-Once) and for the
  //    unexpected-descendant scan (-Once -AllProcesses). The snapshot's own PowerShell child
  //    must show up with real memory values.
  let onceReport;
  try {
    const once = await sampleOnce(process.pid, { allProcesses: true });
    const powerShellChild = (once.procs || []).find((proc) => /^powershell\.exe$/i.test(proc.name) && proc.ppid === process.pid);
    onceReport = {
      pass: once.inTreeCount >= 2 && Boolean(powerShellChild) && (powerShellChild?.ws ?? 0) > 0
        && (once.procs || []).some((proc) => proc.pid === process.pid && proc.ws > 0),
      inTreeCount: once.inTreeCount, allProcesses: once.allProcesses === true,
      procs: (once.procs || []).map((proc) => ({ pid: proc.pid, name: proc.name, ws: proc.ws, priv: proc.priv })),
      expectation: "root pid + its PowerShell child with non-zero working set from Win32_Process",
    };
  } catch (error) { onceReport = { pass: false, error: String(error.message ?? error) }; }
  report.checks.cimOnceSnapshot = onceReport;

  // 4) cleanup path: stop-tree.ps1 must really kill the given pids and confirm they are gone.
  const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
  const stopResult = await cleanupTree([victim.pid], { label: "selftest" });
  const stillAlive = await runPowerShellInline(`@(Get-Process -Id ${victim.pid} -ErrorAction SilentlyContinue).Count`);
  report.checks.stopTreeCleanup = {
    pass: stopResult.remaining?.length === 0 && stillAlive.stdout.trim() === "0" && stopResult.killed?.includes(victim.pid),
    victimPid: victim.pid, stopResult, aliveAfterCheck: stillAlive.stdout.trim(),
    expectation: "the recorded pid is force-stopped and no longer present afterwards",
  };

  // 5) missing application must fail fast with a clear message and no hang.
  const missingApp = join(outDir, "definitely-missing", "zinecv-desktop.exe");
  const child = spawn(process.execPath, [join(here, "measure-memory.mjs"), "--app", missingApp, "--runs", "1",
    "--out", join(outDir, "selftest-missing-app")], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const startedAt = nowMs();
  const exitCode = await Promise.race([new Promise((done) => child.once("exit", done)), sleep(30_000).then(() => "timeout")]);
  const elapsedMs = nowMs() - startedAt;
  if (exitCode === "timeout") child.kill();
  report.checks.missingApp = {
    pass: exitCode === 2 && elapsedMs < 15_000 && /not found|does not exist/i.test(stderr),
    exitCode, elapsedMs, stderrHead: stderr.trim().slice(0, 500), stdoutHead: stdout.trim().slice(0, 300),
    expectation: "exit code 2, clear message, well under 15 s, no host started",
  };

  report.passed = Object.values(report.checks).every((check) => check.pass === true);
  report.noHostStarted = true;
  const finalCensus = await hostProcessCount();
  report.finalHostProcessCount = finalCensus;
  process.env.ZINECV_MEASURE_CENSUS_FAIL = "1";
  const forcedCensus = await hostProcessCount();
  delete process.env.ZINECV_MEASURE_CENSUS_FAIL;
  report.checks.hostCountCensus = {
    pass: finalCensus.unknown === false && finalCensus.cimQueriesOk === true
      && Number.isInteger(finalCensus.zinecvDesktop) && Number.isInteger(finalCensus.msedgewebview2)
      && finalCensus.zinecvDesktop >= 0 && finalCensus.msedgewebview2 >= 0
      && Array.isArray(finalCensus.zinecvPids) && Array.isArray(finalCensus.webview2Pids)
      && finalCensus.zinecvPids.length === finalCensus.zinecvDesktop
      && finalCensus.webview2Pids.length === finalCensus.msedgewebview2
      && forcedCensus.unknown === true && forcedCensus.zinecvDesktop === null && forcedCensus.msedgewebview2 === null,
    census: finalCensus,
    forcedFailureCensus: forcedCensus,
    expectation: "counts are real integers cross-checked against the pid lists; a failed census is 'unknown' with null counts, never 0 or -1",
  };
  if (report.checks.hostCountCensus.pass && finalCensus.zinecvDesktop > 0) {
    report.noHostStarted = false; // this selftest itself must not leave hosts behind
    report.checks.hostCountCensus.pass = false;
    report.checks.hostCountCensus.note = "zinecv-desktop.exe processes exist after the selftest, which starts no host";
  }
  report.endedAtIso = iso(nowMs());
  const target = join(outDir, "selftest.json");
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ selftest: report.passed, target, checks: Object.fromEntries(Object.entries(report.checks).map(([key, value]) => [key, value.pass])) }, null, 2) + "\n");
  return report.passed ? 0 : 1;
}

/* ------------------------------------------------------------------- main ---- */

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`measure-memory: ${error.message}\n\n${HELP}`); return 2; }
  if (options.help) { process.stdout.write(HELP); return 0; }

  // Mode: sample an existing pid only (no host started, no WebView2 involved).
  if (options.samplePid > 0) {
    const snapshot = await sampleOnce(options.samplePid);
    process.stdout.write(JSON.stringify({
      pid: options.samplePid, at: iso(snapshot.atEpochMs), inTreeCount: snapshot.inTreeCount,
      outsideCount: snapshot.outsideCount, procs: snapshot.procs,
    }, null, 2) + "\n");
    return 0;
  }

  if (options.selftest) return selftest(options);

  // Mode: record the measurement environment only (OS, CPU, RAM, WebView2 runtime, baseline
  // census). Starts nothing, so it can be run at any time.
  if (options.machineInfo) {
    const outDir = options.out ? resolve(options.out) : null;
    const environment = { schema: `${SCHEMA}.environment`, generatedAtIso: iso(nowMs()),
      machine: await machineInfo(), censusBaseline: await hostProcessCount() };
    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n", "utf8");
      process.stdout.write(`environment written to ${join(outDir, "environment.json")}\n`);
    }
    process.stdout.write(JSON.stringify(environment, null, 2) + "\n");
    return 0;
  }

  if (!options.out) { process.stderr.write("measure-memory: --out is required\n"); return 2; }
  const outDir = resolve(options.out);
  const app = resolve(options.app);

  // Fail fast and clearly when the binary is not there (error-path contract).
  let binaryBefore;
  try { binaryBefore = await fileFingerprint(app); }
  catch (error) {
    process.stderr.write(`measure-memory: application not found or unreadable: ${app}\n  reason: ${error.message}\n`
      + `  build it first (Lead owns builds) or pass --app <path>. Nothing was started; no processes were left behind.\n`);
    return 2;
  }
  if (binaryBefore.sizeBytes < 1_000_000) {
    process.stderr.write(`measure-memory: ${app} is only ${binaryBefore.sizeBytes} bytes; that does not look like the release host. Aborting.\n`);
    return 2;
  }

  // Pure statistics/help/environment checks do not need the browser dependency.
  // Resolve it before any machine baseline or measured host startup.
  const { chromium } = await import("playwright");
  await mkdir(outDir, { recursive: true });
  const machine = await machineInfo();
  const preexisting = await hostProcessCount();
  if (preexisting.unknown) {
    process.stderr.write("measure-memory: warning: machine census unavailable; pre-existing host processes could not be ruled out. "
      + "This will be recorded as 'unknown' (never as zero) in the evidence.\n");
  } else if (preexisting.zinecvDesktop > 0 && !options.allowPreexistingHost) {
    process.stderr.write(`measure-memory: ${preexisting.zinecvDesktop} zinecv-desktop.exe process(es) already running; `
      + `attribution would be ambiguous (and WebView2 runs must be serial). Stop them or pass --allow-preexisting-host.\n`);
    return 3;
  }
  if (!preexisting.unknown && preexisting.msedgewebview2 > 0) {
    process.stderr.write(`measure-memory: note: ${preexisting.msedgewebview2} msedgewebview2.exe process(es) already exist and are NOT ours `
      + `(no zinecv-desktop.exe host). They are excluded by pid-closure attribution, recorded as the machine baseline, `
      + `and re-checked after cleanup.\n`);
    if (options.requireNoWebview2) {
      process.stderr.write("measure-memory: --require-no-webview2 was given, so this run is refused.\n");
      return 3;
    }
  }

  const driver = {
    schema: `${SCHEMA}.driver`,
    startedAtIso: iso(nowMs()), app, outDir, machine,
    binary: { ...binaryBefore, before: binaryBefore },
    preexistingProcesses: preexisting,
    measurementBudget: { preset: options.preset, historyMode: options.historyMode, perRunInteractionMs: options.soakMs,
      runsRequested: options.runs, requestedInteractionTotalMs: options.soakMs * options.runs,
      note: "boot/checkpoints/cleanup and completion of the final UI cycle add elapsed time outside this interaction budget" },
    runsRequested: options.runs,
    runs: [],
  };

  let exitCode = 0;
  for (let index = 1; index <= options.runs; index += 1) {
    const report = await runOnce({ index, options, machine, outDir, binaryBefore, chromium });
    driver.runs.push({
      id: report.run.id, status: report.run.status, error: report.run.error,
      file: join(outDir, `${options.label}-${index}.json`),
      peakTreeWorkingSetBytes: report.memory?.peak?.treeWorkingSetBytes ?? null,
      peakTreePrivateBytes: report.memory?.peak?.treePrivateBytes ?? null,
      idleWorkingSetBytes: report.memory?.windows?.idle?.tree?.lastWorkingSetBytes ?? null,
      previewWorkingSetBytes: report.memory?.windows?.preview?.tree?.maxWorkingSetBytes ?? null,
      exportWorkingSetBytes: report.memory?.windows?.export?.tree?.maxWorkingSetBytes ?? null,
      sampleCount: report.memory?.sampleCount ?? 0,
      soak: report.soak ? { requestedMs: report.soak.requestedMs, actualMs: report.soak.actualMs, historyMode: report.soak.historyMode,
        completedCycles: report.soak.completedCycles, failures: report.soak.failures,
        exportCount: report.soak.exports.length, cycleDurationMs: report.soak.cycleDurationMs,
        memory: report.soak.memory, memoryWindows: report.soak.memoryWindows } : null,
      cleanupLeftovers: report.cleanup?.leftoverCheck ?? null,
      profileDeleted: report.cleanup?.profileDeleted ?? null,
      cleanupVerified: report.cleanup?.cleanupVerified ?? null,
      binaryStableAcrossRun: report.binary?.stableAcrossRun ?? null,
      binarySizeStableAcrossRun: report.binary?.sizeStableAcrossRun ?? null,
      binaryLayoutStableAcrossRun: report.binary?.layoutStableAcrossRun ?? null,
      binaryStabilityVerdict: report.binary?.stabilityVerdict ?? null,
      binarySha256: report.binary?.before?.sha256 ?? null,
      binarySizeBytes: report.binary?.before?.sizeBytes ?? null,
      binarySectionSignature: report.binary?.before?.pe?.sectionSignature ?? null,
      binaryPeTimeDateStamp: report.binary?.before?.pe?.timeDateStampIso ?? null,
    });
    const target = join(outDir, `${options.label}-${index}.json`);
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", "utf8");
    process.stdout.write(`[${report.run.id}] ${report.run.status} peakTreeWS=${fmtMiB(report.memory?.peak?.treeWorkingSetBytes)} `
      + `peakTreePriv=${fmtMiB(report.memory?.peak?.treePrivateBytes)} samples=${report.memory?.sampleCount ?? 0} -> ${target}\n`);
    if (report.run.status !== "passed") { exitCode = 1; break; }
    // runOnce awaits process exit, census and profile deletion before the next run.
  }

  driver.endedAtIso = iso(nowMs());
  driver.longSoakQualification = longSoakQualification(options, driver.runs);
  if (options.soakMs > 0) {
    driver.soakComparison = {
      preset: options.preset, historyMode: options.historyMode,
      requestedMs: options.soakMs,
      runsRequested: options.runs,
      runsCompleted: driver.runs.length,
      sameBinary: driver.runs.every(run => run.binarySha256 === binaryBefore.sha256 && run.binaryStableAcrossRun === true),
      allWindowsCompleted: driver.runs.every(run => run.status === "passed" && run.soak?.actualMs >= options.soakMs
        && run.soak.completedCycles > 0 && run.soak.failures.length === 0 && run.soak.exportCount > 0),
      allProfilesDeleted: driver.runs.every(run => run.profileDeleted === true),
      actualInteractionTotalMs: driver.runs.reduce((sum, run) => sum + (run.soak?.actualMs ?? 0), 0),
      longSoakQualification: driver.longSoakQualification,
      percentileDefinition: "nearest-rank p50/p95/max of simultaneous scope totals; WorkingSet includes shared pages, private bytes are additive",
      note: "Completion and comparable scope statistics do not by themselves establish absence of a memory leak; review five-minute windows and raw samples alongside cycle failures and cleanup evidence.",
    };
  }
  await writeFile(join(outDir, `${options.label}-driver.json`), JSON.stringify(driver, null, 2) + "\n", "utf8");
  return exitCode;
}

function fmtMiB(bytes) {
  return typeof bytes === "number" ? `${(bytes / 1024 / 1024).toFixed(1)}MiB` : "n/a";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`measure-memory: unexpected failure: ${error?.stack ?? error}\n`); process.exitCode = 1; });
}
