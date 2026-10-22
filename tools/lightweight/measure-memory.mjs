#!/usr/bin/env node
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

const here = import.meta.dirname;
const repoRoot = resolve(here, "../..");
const SAMPLER = join(here, "process-tree-sampler.ps1");
const STOPPER = join(here, "stop-tree.ps1");
const DEFAULT_APP = join(repoRoot, "src-tauri/target/release/zinecv-desktop.exe");
const SCHEMA = "zinecv.lightweight.memory.v1";
const PREP_TEXT = "轻量化内存测量冻结修订：中文内容与多页排版。"; // repeated to force >1 page
const PREP_REPEAT = 200;
const PRESETS = {
  quick: { soakMs: 20_000, runs: 1 },
  standard: { soakMs: 120_000, runs: 3 },
  extended: { soakMs: 1_800_000, runs: 3 },
};

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

const HELP = `measure-memory.mjs — see tools/lightweight/README.md

Modes
  (default)                 start the release host N times, sample idle/preview/export, write run JSON
  --selftest                sampler dry-run on this process + missing-app error path, writes selftest JSON
  --sample-pid <pid>        sample an existing process tree only (no host started), prints JSON
  --machine-info            record OS/CPU/RAM/WebView2 runtime/baseline census, starts nothing
  --diagnostics             record JS heap and DOM counters during soak; never forces garbage collection
  --history-mode <mode>     growing (default) commits each cycle; fixed seeds history before timing and only loads it

Common options
  --app <path>              host executable (default src-tauri/target/release/zinecv-desktop.exe)
  --preset <name>           quick: 20s x 1 (default); standard: 120s x 3; extended: 30min x 3
  --runs <n>                override preset run count, independent of argument order
  --interval-ms <n>         sampler interval, 20..200 (default 150)
  --topology-every-n <n>    in-loop CIM command-line refresh period in ticks; 0 disables it (default 0,
                            command lines then come from the pre-teardown one-shot snapshot)
  --sampler-boot-timeout-ms <n>  budget for the sampler's own PowerShell + CIM warm-up (default 60000)
  --out <dir>               evidence directory (required for default/selftest modes)
  --label <name>            file prefix, e.g. run -> run-1.json (default "run")
  --idle-settle-ms <n>      quiet time before the idle checkpoint (default 3000)
  --preview-settle-ms <n>   quiet time after the preview render resolves (default 1500)
  --export-settle-ms <n>    quiet time after the export render resolves (default 1500)
  --boot-timeout-ms <n>     budget for process start -> draft ready (default 90000)
  --step-timeout-ms <n>     budget for a single IPC step (default 120000)
  --total-timeout-ms <n>    hard watchdog per run, triggers tree kill (default 300000)
  --soak-ms <n>             override preset UI duration; 0 keeps checkpoint-only measurement
  --keep-profile            keep the isolated profile of a failed run for diagnosis
  --allow-preexisting-host  do not refuse when a zinecv-desktop.exe is already running
  --require-no-webview2     also refuse when any unrelated msedgewebview2.exe is running (strict isolation)
  --sample-ms <n>           duration for --sample-pid / --selftest sampler dry-run (default 2000)
`;

/* --------------------------------------------------------------- helpers ---- */

const nowMs = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

function runPowerShell(scriptPath, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}${error.message}` }); });
    child.on("exit", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

function runPowerShellInline(script, { timeoutMs = 30_000 } = {}) {
  return new Promise((done) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}${error.message}` }); });
    child.on("exit", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* keep raw line out of the way */ }
  }
  return out;
}

/**
 * Minimal PE header/section reader. The release exe is NOT bit-reproducible: the PE COFF
 * header carries a build TimeDateStamp, so two builds of identical layout differ in SHA256.
 * Size + section raw sizes are therefore recorded alongside the hash so "was the binary
 * swapped mid-run?" can be answered even when the hash legitimately changes.
 */
function parsePe(bytes) {
  try {
    if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return { error: "not a PE file (missing MZ)" };
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) return { error: "not a PE file (missing PE signature)" };
    const coff = peOffset + 4;
    const numberOfSections = bytes.readUInt16LE(coff + 2);
    const timeDateStampRaw = bytes.readUInt32LE(coff + 4);
    const sizeOfOptionalHeader = bytes.readUInt16LE(coff + 16);
    const sections = [];
    const tableStart = coff + 20 + sizeOfOptionalHeader;
    for (let index = 0; index < numberOfSections; index += 1) {
      const base = tableStart + index * 40;
      if (base + 40 > bytes.length) break;
      sections.push({
        name: bytes.toString("latin1", base, base + 8).replace(/\0+$/, ""),
        virtualSize: bytes.readUInt32LE(base + 8),
        virtualAddress: bytes.readUInt32LE(base + 12),
        sizeOfRawData: bytes.readUInt32LE(base + 16),
        pointerToRawData: bytes.readUInt32LE(base + 20),
        characteristics: bytes.readUInt32LE(base + 36),
      });
    }
    return {
      timeDateStampRaw,
      timeDateStampNote: "PE COFF TimeDateStamp written by the linker; it is NOT the file mtime and it changes between builds of identical source",
      timeDateStampIso: timeDateStampRaw ? new Date(timeDateStampRaw * 1000).toISOString() : null,
      numberOfSections,
      sections,
      sectionSignature: sections.map((section) => `${section.name}:${section.sizeOfRawData}`).join("|"),
    };
  } catch (error) { return { error: String(error.message ?? error) }; }
}

async function fileFingerprint(path) {
  const info = await stat(path);
  const bytes = await readFile(path);
  const hash = createHash("sha256");
  hash.update(bytes);
  return { path, sizeBytes: info.size, mtimeIso: info.mtime.toISOString(), sha256: hash.digest("hex"), pe: parsePe(bytes) };
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function machineInfo() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$cs=Get-CimInstance Win32_ComputerSystem",
    "$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1",
    // Highest version-numbered runtime folder (skip folders like SetupMetrics).
    "$root='C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application'",
    "$wvFolder=(Get-ChildItem $root -Directory | Where-Object { $_.Name -match '^\\d+(\\.\\d+){2,3}$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName",
    "$wvVersion=''",
    "if($wvFolder){$exe=Join-Path $wvFolder 'msedgewebview2.exe'; if(Test-Path $exe){$wvVersion=(Get-Item $exe).VersionInfo.FileVersion}}",
    "if(-not $wvVersion){$wvVersion=[string](Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv).pv}",
    "[ordered]@{osCaption=$os.Caption;osVersion=$os.Version;osBuild=$os.BuildNumber;totalRamBytes=[int64]$cs.TotalPhysicalMemory;freeRamBytes=[int64]$os.FreePhysicalMemory*1024;cpuName=$cpu.Name;logicalProcessors=[int]$cs.NumberOfLogicalProcessors;webview2Version=$wvVersion;webview2Folder=$wvFolder;queriedAtIso=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await runPowerShellInline(script);
  try { return JSON.parse(result.stdout.trim()); } catch { return { error: "machine info unavailable", stderr: result.stderr.trim() }; }
}

async function hostProcessCount() {
  // Test hook: the selftest forces the failure path to prove a failed census is reported as
  // "unknown" with null counts, never as 0 (or -1).
  if (process.env.ZINECV_MEASURE_CENSUS_FAIL === "1") {
    return { unknown: true, zinecvDesktop: null, msedgewebview2: null, zinecvPids: null, webview2Pids: null,
      cimQueriesOk: false, raw: "", stderr: "", note: "forced failure via ZINECV_MEASURE_CENSUS_FAIL (test hook)" };
  }
  const result = await runPowerShell(join(here, "host-count.ps1"), [], { timeoutMs: 60_000 });
  const parsed = parseJsonLines(result.stdout).find((entry) => entry.kind === "hostCount");
  if (!parsed || typeof parsed.zinecvDesktop !== "number" || typeof parsed.msedgewebview2 !== "number") {
    // A failed census stays "unknown"; it must never be reported as zero.
    return { unknown: true, zinecvDesktop: null, msedgewebview2: null, zinecvPids: null, webview2Pids: null,
      cimQueriesOk: false, raw: result.stdout.trim().slice(0, 300), stderr: result.stderr.trim().slice(0, 300),
      note: "machine census unavailable: reported as unknown, never as zero" };
  }
  return { unknown: false, zinecvDesktop: parsed.zinecvDesktop, msedgewebview2: parsed.msedgewebview2,
    zinecvPids: parsed.zinecvPids ?? [], webview2Pids: parsed.webview2Pids ?? [],
    cimQueriesOk: parsed.cimQueriesOk === true, queriedAtEpochMs: parsed.queriedAtEpochMs ?? null,
    stderr: result.stderr.trim().slice(0, 300) };
}

async function freeRamBytes() {
  const result = await runPowerShellInline("$os=Get-CimInstance Win32_OperatingSystem; [int64]$os.FreePhysicalMemory*1024");
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : -1;
}

/* --------------------------------------------------- process-tree sampling ---- */

// Role classification, window aggregation and sample derivation live in classify.mjs, shared
// with tools/lightweight/reclassify.mjs so offline re-derivation cannot drift from live runs.

function processInventory(derived) {
  const byPid = new Map();
  for (const sample of derived) {
    for (const proc of sample.procs) {
      const record = byPid.get(proc.pid) ?? {
        pid: proc.pid, role: proc.role, name: proc.name, commandLine: proc.cmd, ppid: proc.ppid,
        createdMs: proc.createMs, firstSeenMs: sample.tMs, lastSeenMs: sample.tMs,
        workerCommandLineVerified: proc.workerCommandLineVerified ?? null,
        osPeakWorkingSetBytes: 0, osPeakPageFileBytes: 0, lastWorkingSetBytes: 0, lastPrivateBytes: 0, samples: 0,
      };
      record.lastSeenMs = sample.tMs;
      record.osPeakWorkingSetBytes = Math.max(record.osPeakWorkingSetBytes, proc.peakWs || 0);
      record.osPeakPageFileBytes = Math.max(record.osPeakPageFileBytes, proc.peakPageFile || 0);
      record.lastWorkingSetBytes = proc.ws; record.lastPrivateBytes = proc.priv;
      record.samples += 1;
      byPid.set(proc.pid, record);
    }
  }
  return [...byPid.values()].sort((a, b) => a.firstSeenMs - b.firstSeenMs || a.pid - b.pid);
}

/* ------------------------------------------------------------ in-page steps ---- */

const PAGE_BOOTSTRAP = `
window.__zinecvMeasure = window.__zinecvMeasure || { previewBox: null, urls: [], bundle: null };
const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
`;

async function ipcProbe(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const state = await invoke("document_state");
    return { ok: true, revision: state.cursor.revision, documentId: state.cursor.documentId, sections: state.document.sections.length };
  })()`);
}

async function prepareContent(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const text = ${JSON.stringify(PREP_TEXT)}.repeat(${PREP_REPEAT});
    const state = await invoke("document_state");
    const summary = state.document.sections.find((section) => section.kind === "summary");
    if (!summary) throw new Error("no summary section in the default document");
    const command = async (payload) => {
      const current = await invoke("document_state");
      return invoke("apply_document_command", { envelope: {
        protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId,
        contextId: current.cursor.contextId, expectedRevision: current.cursor.revision,
        expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload } });
    };
    await command({ type: "setSectionVisibility", section_id: summary.id, visible: true });
    await command({ type: "setSummaryBody", section_id: summary.id, body: [{ type: "paragraph", children: [{ type: "text", text, marks: [] }] }] });
    const after = await invoke("document_state");
    return { preparedChars: text.length, summaryId: summary.id, revision: after.cursor.revision };
  })()`);
}

async function renderPreview(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const state = await invoke("document_state");
    const result = await invoke("render_document_preview", { cursor: state.cursor });
    const pages = result.data.pages;
    const box = document.createElement("div");
    box.id = "__zinecv_measure_preview__";
    box.style.cssText = "position:fixed;left:-20000px;top:0;width:1200px;height:10px;overflow:hidden";
    document.body.appendChild(box);
    const urls = [];
    let decodeFailures = 0;
    for (const page of pages) {
      const url = URL.createObjectURL(new Blob([page.svg], { type: "image/svg+xml" }));
      const image = new Image();
      image.src = url;
      box.appendChild(image);
      try { await image.decode(); } catch { decodeFailures += 1; }
      urls.push(url);
    }
    window.__zinecvMeasure.previewBox = box;
    window.__zinecvMeasure.urls = urls;
    return {
      renderKey: result.renderKey,
      pageCount: pages.length,
      pageHashes: pages.map((page) => page.pageHash),
      svgBytes: pages.reduce((sum, page) => sum + page.svg.length, 0),
      logicalTextChars: result.data.textMap.logicalText.length,
      decodedPages: urls.length - decodeFailures,
      decodeFailures,
    };
  })()`);
}

async function releasePreview(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const state = window.__zinecvMeasure;
    for (const url of state.urls || []) URL.revokeObjectURL(url);
    state.urls = [];
    state.previewBox?.remove();
    state.previewBox = null;
    return { released: true };
  })()`);
}

async function renderExport(page, paths) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const state = await invoke("document_state");
    const bundle = await invoke("render_document_export", { cursor: state.cursor });
    const pdfWrite = await invoke("write_export_file", { path: ${JSON.stringify(paths.pdf)}, dataBase64: bundle.data.pdfBase64 });
    let longWrite = null;
    if (bundle.data.longPng && !bundle.data.longImageLimited) {
      longWrite = await invoke("write_export_file", { path: ${JSON.stringify(paths.longPng)}, dataBase64: bundle.data.longPng.dataBase64 });
    }
    window.__zinecvMeasure.bundle = bundle; // retained until releaseExport, like the real viewer holds the bundle
    return {
      pageCount: bundle.data.pageCount,
      pdfSha256: bundle.data.pdfSha256,
      pdfBase64Chars: bundle.data.pdfBase64.length,
      pdfBytesWritten: pdfWrite.bytes,
      pngPages: bundle.data.pngPages.map((page) => ({ page: page.page, width: page.width, height: page.height })),
      longImageLimited: bundle.data.longImageLimited,
      longPng: bundle.data.longPng ? { width: bundle.data.longPng.width, height: bundle.data.longPng.height } : null,
      longPngBytesWritten: longWrite ? longWrite.bytes : null,
      dpi: bundle.data.dpi,
      textMapChars: bundle.data.textMap.logicalText.length,
    };
  })()`);
}

async function releaseExport(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    window.__zinecvMeasure.bundle = null;
    if (typeof window.gc === "function") window.gc();
    return { released: true };
  })()`);
}

/* -------------------------------------------------------------- host start ---- */

/**
 * Mirrors tests/native/host-fixture.mjs env contract (read that file before changing this).
 * Returns the child plus the marks we can observe from outside the page.
 */
function startHost({ app, profile, port, dataDir }) {
  const environment = {
    ...process.env,
    APPDATA: join(profile, "Roaming"),
    LOCALAPPDATA: join(profile, "Local"),
    ZINECV_DATA_DIR: dataDir,
    WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
    // Same flags as webview.test.mjs: occluded-window throttling hangs rAF-dependent flushes.
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
  };
  const child = spawn(app, [], { cwd: repoRoot, windowsHide: true, stdio: "ignore", env: environment });
  return { child, environment: sanitizeEnvironment(environment, profile) };
}

function sanitizeEnvironment(environment, profile) {
  const keep = ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"];
  const out = {};
  for (const key of keep) out[key] = environment[key];
  out.APPDATA = `<profile>/Roaming`;
  out.LOCALAPPDATA = `<profile>/Local`;
  out.ZINECV_DATA_DIR = `<profile>/Data`;
  out.WEBVIEW2_USER_DATA_FOLDER = `<profile>/WebView2`;
  out.profile = profile;
  return out;
}

/* -------------------------------------------------------------- run driver ---- */

async function sampleOnce(rootPid, { allProcesses = false } = {}) {
  const args = ["-RootPid", String(rootPid), "-Once"];
  if (allProcesses) args.push("-AllProcesses");
  const result = await runPowerShell(SAMPLER, args, { timeoutMs: 60_000 });
  const parsed = parseJsonLines(result.stdout).find((entry) => entry.kind === "sample");
  if (!parsed) throw new Error(`snapshot returned no sample (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
  return parsed;
}

class Sampler {
  constructor({ rootPid = null, rootPidFile = null, intervalMs, stopFile, topologyEveryN = 20, processNames = null }) {
    this.rootPid = rootPid; this.rootPidFile = rootPidFile; this.intervalMs = intervalMs;
    this.stopFile = stopFile; this.topologyEveryN = topologyEveryN; this.processNames = processNames;
    this.lines = []; this.buffer = ""; this.stderr = ""; this.child = null; this.exited = null;
  }
  start() {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SAMPLER,
      "-IntervalMs", String(this.intervalMs), "-StopFile", this.stopFile, "-TopologyEveryN", String(this.topologyEveryN)];
    if (this.processNames) args.push("-ProcessNames", this.processNames);
    if (this.rootPidFile && !this.rootPid) args.push("-RootPidFile", this.rootPidFile);
    else args.push("-RootPid", String(this.rootPid ?? 0));
    this.child = spawn("powershell", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8"); this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.lines.push(line);
      }
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.exited = new Promise((done) => this.child.once("exit", (code) => done(code)));
  }
  entries() { return parseJsonLines(this.lines.join("\n")); }
  find(kind) { return this.entries().find((entry) => entry.kind === kind) ?? null; }
  async waitFor(kind, timeoutMs) {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      const entry = this.find(kind);
      if (entry) return entry;
      if (this.child.exitCode !== null) throw new Error(`sampler exited (code ${this.child.exitCode}) before "${kind}": ${this.stderr.trim().slice(0, 300)}`);
      await sleep(50);
    }
    throw new Error(`sampler never reported "${kind}" within ${timeoutMs} ms; stderr: ${this.stderr.trim().slice(0, 300)}`);
  }
  async stop({ timeoutMs = 10_000 } = {}) {
    if (!this.child) return { stopped: false, reason: "not started" };
    try { closeSync(openSync(this.stopFile, "w")); } catch { /* already there */ }
    const code = await Promise.race([this.exited, sleep(timeoutMs).then(() => Symbol("timeout"))]);
    let killed = false;
    if (typeof code === "symbol") { this.child.kill(); killed = true; await Promise.race([this.exited, sleep(3000)]); }
    const trailing = this.buffer.trim();
    if (trailing) this.lines.push(trailing);
    return { stopped: true, exitCode: typeof code === "number" ? code : null, forceKilled: killed, stderr: this.stderr.trim().slice(0, 2000) };
  }
}

async function cleanupTree(pids, { label }) {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!unique.length) return { label, requested: [], killed: [], failed: [], remaining: [] };
  const result = await runPowerShell(STOPPER, ["-Pids", unique.join(","), "-WaitMs", "15000"], { timeoutMs: 60_000 });
  const parsed = parseJsonLines(result.stdout).find((entry) => entry.kind === "stopTree");
  return parsed ? { label, ...parsed } : { label, requested: unique, killed: [], failed: [], remaining: [], error: `stopper produced no result (exit ${result.code}): ${result.stderr.trim().slice(0, 300)}` };
}

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

export function soakMemoryWindow(derived, fromMs, toMs) {
  const samples = derived.filter((sample) => sample.tMs >= fromMs && sample.tMs <= toMs);
  const scopes = {};
  for (const scope of ["host", "renderWorker", "webview2", "other", "tree"]) {
    const totals = samples.map((sample) => scope === "tree" ? { ws: sample.totalWs, priv: sample.totalPriv }
      : Object.entries(sample.byRole).filter(([role]) => scopeOf(role) === scope)
        .reduce((sum, [, bucket]) => ({ ws: sum.ws + bucket.ws, priv: sum.priv + bucket.priv }), { ws: 0, priv: 0 }));
    scopes[scope] = { workingSetBytes: percentiles(totals.map((item) => item.ws)),
      privateBytes: percentiles(totals.map((item) => item.priv)) };
  }
  return { fromMs, toMs, sampleCount: samples.length, scopes };
}

export function longSoakQualification({ soakMs, runs }, reports) {
  const budgetEligible = soakMs >= 1_800_000 && runs >= 3;
  const actualEligible = reports.length >= 3 && reports.every(report => report.status === "passed"
    && report.soak?.actualMs >= 1_800_000 && report.soak.completedCycles > 0
    && report.soak.failures.length === 0 && report.soak.exportCount > 0
    && report.soak.memory?.sampleCount > 0 && report.cleanupVerified === true
    && report.profileDeleted === true && report.binaryStableAcrossRun === true);
  return { budgetEligible, actualEligible, accepted: budgetEligible && actualEligible,
    definition: "at least three complete 30-minute real-UI windows with samples, exports, stable binary and verified cleanup; short presets cannot qualify" };
}

async function soakUi(page, { durationMs, stepTimeoutMs, profile, report, mark, diagnostics = false, historyMode = "growing" }) {
  report.soak = { requestedMs: durationMs, historyMode, cycles: [], failures: [], exports: [],
    fixture: "isolated synthetic imported templates; real UI edits/template application/pointer drag/history load/PDF export; growing commits each cycle, fixed seeds bounded history before timing; only save-picker path supplied" };
  // Fixture creation is separate from the measured interaction window.
  await page.evaluate(async () => {
    const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
    const catalog = await invoke("read_imported_template_catalog");
    const templates = ["A", "B"].map((suffix, index) => ({ id: `soak-${suffix}`, name: `持续运行模板 ${suffix}`,
      sourceName: `soak-${suffix}.png`, sourceType: "image", createdAt: "2026-10-04T00:00:00.000Z",
      accent: index ? "#2563eb" : "#b45309", formatId: "legacy-v1", layout: "single-column", analysis: "隔离合成测量模板" }));
    await invoke("write_imported_template_catalog", { expectedRevision: catalog.revision, payloadJson: JSON.stringify(templates) });
  });
  await page.reload({ waitUntil: "commit" });
  await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: stepTimeoutMs });
  const minimize = page.getByRole("button", { name: "最小化到 Bot" });
  if (await minimize.count()) await minimize.click();
  const fixedHistories = {};
  const graphIdentity = graph => JSON.stringify(graph.commits.map(commit => [commit.id, commit.parentId]).sort());
  if (historyMode === "fixed") {
    // Prepare bounded synthetic history outside the measurement window; never delete measured history.
    for (const suffix of ["A", "B"]) {
      await page.getByRole("button", { name: "模板", exact: true }).click();
      await page.locator(".template-library-select").filter({ hasText: `持续运行模板 ${suffix}` }).click();
      for (const version of [1, 2]) {
        await page.getByRole("button", { name: "简历编辑", exact: true }).click();
        const expand = page.getByRole("button", { name: "展开基本信息", exact: true });
        if (await expand.count()) await expand.click();
        const name = `固定负载 ${suffix}-${version}`;
        await page.getByLabel("姓名", { exact: true }).fill(name);
        await page.getByLabel("姓名", { exact: true }).press("Tab");
        await page.waitForFunction(async expected => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name === expected, name);
        await page.getByRole("button", { name: "版本管理" }).first().click();
        const message = `固定历史 ${suffix}-${version}`;
        await page.getByLabel("版本说明").fill(message);
        await page.getByRole("button", { name: "提交到当前分支" }).click();
        await page.waitForFunction(async expected => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.some(commit => commit.message === expected), message);
      }
    }
    for (const suffix of ["A", "B"]) {
      await page.getByRole("button", { name: "模板", exact: true }).click();
      await page.locator(".template-library-select").filter({ hasText: `持续运行模板 ${suffix}` }).click();
      const graph = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
      fixedHistories[suffix] = { identity: graphIdentity(graph), commitCount: graph.commits.length };
    }
    report.soak.fixedHistories = fixedHistories;
  }
  const target = join(profile, "导出 中文 目录", "持续运行.pdf");
    const { installIpcInterceptor } = await import("../../tests/native/ipc-interceptor.mjs");
    await installIpcInterceptor(page);
    await page.evaluate(target => {
      window.__zinecvTestInvoke = (command, args, invoke) => command === "pick_export_path"
        ? Promise.resolve(target) : invoke(command, args);
  }, target);
  const interactionTimeoutMs = Math.min(stepTimeoutMs, 30_000);
  page.setDefaultTimeout(interactionTimeoutMs);
  const started = mark("soakStart");
  let nextExport = started, nextProgress = started + 60_000;
  const cdp = diagnostics ? await page.context().newCDPSession(page) : null;
  if (cdp) report.soak.diagnostics = [];
  const observe = async () => {
    if (!cdp) return;
    const readings = await Promise.allSettled([cdp.send("Runtime.getHeapUsage"), cdp.send("Memory.getDOMCounters")]);
    report.soak.diagnostics.push({ elapsedMs: nowMs() - started,
      heap: readings[0].status === "fulfilled" ? readings[0].value : { error: String(readings[0].reason) },
      dom: readings[1].status === "fulfilled" ? readings[1].value : { error: String(readings[1].reason) } });
  };
  let nextObservation = started;
  let index = 0;
  try {
    while (nowMs() - started < durationMs) {
      if (cdp && nowMs() >= nextObservation) { await observe(); nextObservation = nowMs() + 60_000; }
      const cycle = { index: ++index, startedMs: nowMs() - report.timeline.t0EpochMs, steps: [] };
      report.soak.cycles.push(cycle);
      const step = async (name, action) => {
        const begin = nowMs();
        try { const evidence = await withTimeout(action(), interactionTimeoutMs, `soak ${name}`);
          cycle.steps.push({ name, durationMs: nowMs() - begin, status: "passed", evidence }); }
        catch (error) { cycle.steps.push({ name, durationMs: nowMs() - begin, status: "failed", error: String(error.message ?? error) }); throw error; }
      };
      await step("edit", async () => {
        await page.getByRole("button", { name: "简历编辑", exact: true }).click();
        const expand = page.getByRole("button", { name: "展开基本信息", exact: true });
        if (await expand.count()) await expand.click();
        const name = `持续运行 ${historyMode === "fixed" ? index % 2 : index}`;
        await page.getByLabel("姓名", { exact: true }).fill(name);
        await page.getByLabel("姓名", { exact: true }).press("Tab");
        await page.waitForFunction(async expected => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name === expected,
          name, { timeout: stepTimeoutMs });
        return { savedName: name };
      });
      await step("template", async () => {
        await page.getByRole("button", { name: "模板", exact: true }).click();
        const template = page.locator(".template-library-select").filter({ hasText: `持续运行模板 ${index % 2 ? "A" : "B"}` });
        await template.click();
        await page.waitForFunction(suffix => [...document.querySelectorAll(".template-library-select")].some(button =>
          button.textContent.includes(`持续运行模板 ${suffix}`) && button.getAttribute("aria-pressed") === "true"),
          index % 2 ? "A" : "B", { timeout: stepTimeoutMs });
        return { template: index % 2 ? "A" : "B" };
      });
      await step("splitter", async () => {
        await page.getByRole("button", { name: "简历编辑", exact: true }).click();
        // Template contexts restore their own drafts. Edit the active context again before committing.
        const expand = page.getByRole("button", { name: "展开基本信息", exact: true });
        if (await expand.count()) await expand.click();
        const name = `持续运行 ${historyMode === "fixed" ? index % 2 : index}`;
        await page.getByLabel("姓名", { exact: true }).fill(name);
        await page.getByLabel("姓名", { exact: true }).press("Tab");
        await page.waitForFunction(async expected => (await window.__TAURI_INTERNALS__.invoke("document_state"))
          .document.basic.name === expected, name, { timeout: stepTimeoutMs });
        const separator = page.getByRole("separator", { name: "调整编辑器与预览宽度" });
        const before = Number(await separator.getAttribute("aria-valuenow"));
        const box = await separator.boundingBox();
        if (!box) throw new Error("splitter has no visible bounding box");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        try { await page.mouse.move(box.x + box.width / 2 + (index % 2 ? 24 : -24), box.y + box.height / 2, { steps: 6 }); }
        finally { await page.mouse.up(); }
        await page.waitForFunction(previous => Number(document.querySelector(".workspace-splitter").getAttribute("aria-valuenow")) !== previous,
          before, { timeout: interactionTimeoutMs });
        const after = Number(await separator.getAttribute("aria-valuenow"));
        if (before === after) throw new Error("pointer drag did not change pane width");
        return { before, after };
      });
      await step("commitAndHistory", async () => {
        await page.getByRole("button", { name: "版本管理" }).first().click();
        const message = `持续运行提交 ${index}`;
        if (historyMode === "growing") {
          await page.getByLabel("版本说明").fill(message);
          await page.getByRole("button", { name: "提交到当前分支" }).click();
          await page.waitForFunction(async message => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))
            .commits.some(commit => commit.message === message), message, { timeout: stepTimeoutMs });
        }
        const graph = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
        const state = historyMode === "fixed" ? await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state")) : null;
        const commit = graph.commits.find(item => historyMode === "fixed" ? item.id === state.cursor.headId : item.message === message);
        if (historyMode === "fixed" && graphIdentity(graph) !== fixedHistories[index % 2 ? "A" : "B"].identity) throw new Error("fixed history graph changed during measurement");
        const history = graph.commits.find(item => item.id === commit.parentId);
        if (!history) throw new Error("no previous history commit available after UI commit");
        const loadedName = JSON.parse(history.snapshotDocumentJson).basic.name;
        await page.locator(`.branch-tree-node[data-version-commit-id="${history.id}"]`).click();
        await page.getByRole("button", { name: "载入", exact: true }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "载入此版本" }).click();
        await page.getByRole("alertdialog").waitFor({ state: "hidden", timeout: stepTimeoutMs });
        await page.waitForFunction(async expected => (await window.__TAURI_INTERNALS__.invoke("document_state"))
          .document.basic.name === expected, loadedName, { timeout: stepTimeoutMs });
        if (historyMode === "fixed") {
          const after = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
          if (after.cursor.headId !== state.cursor.headId) throw new Error("history load changed the fixed branch HEAD");
        }
        return { commitId: commit.id, historyCommitId: history.id, commitCount: graph.commits.length, loadedName };
      });
      if (nowMs() >= nextExport) await step("pdfExport", async () => {
        const attempt = { cycle: index, phase: "open-menu", startedMs: nowMs() - started };
        report.soak.exportAttempts ??= [];
        report.soak.exportAttempts.push(attempt);
        await page.getByRole("button", { name: "导出", exact: false }).first().click();
        attempt.phase = "choose-pdf";
        await page.getByRole("menuitem", { name: /PDF 文档/ }).click();
        attempt.phase = "wait-result";
        const result = page.locator(".notice-toast").filter({ hasText: /PDF 已保存|导出已暂停|PDF 导出失败|已取消导出/ });
        await result.waitFor({ timeout: stepTimeoutMs });
        attempt.notice = await result.innerText();
        if (!attempt.notice.includes("PDF 已保存")) throw new Error(`UI export rejected: ${attempt.notice}`);
        attempt.phase = "read-file";
        const bytes = await readFile(target);
        if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("UI export did not write a PDF");
        const evidence = { cycle: index, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        report.soak.exports.push(evidence); nextExport = nowMs() + 60_000;
        attempt.phase = "passed";
        attempt.durationMs = nowMs() - started - attempt.startedMs;
        return evidence;
      });
      cycle.status = "passed"; cycle.durationMs = nowMs() - report.timeline.t0EpochMs - cycle.startedMs;
      if (nowMs() >= nextProgress) { process.stdout.write(`[${report.run.id}] soak ${Math.round((nowMs() - started) / 1000)}s cycles=${index} exports=${report.soak.exports.length}\n`); nextProgress = nowMs() + 60_000; }
      // Real UI operations already await durable state and render/export completion.
      // A bounded yield avoids a hot loop without spending five seconds idle per cycle.
      await sleep(Math.min(250, Math.max(0, started + durationMs - nowMs())));
    }
  } catch (error) {
    report.soak.failures.push({ cycle: index, error: String(error.stack ?? error) });
    const cycle = report.soak.cycles.at(-1); cycle.status = "failed";
    cycle.durationMs = nowMs() - report.timeline.t0EpochMs - cycle.startedMs;
    await page.screenshot({ path: join(resolve(profile, "../.."), `${report.run.id}-soak-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    report.soak.actualMs = nowMs() - started;
    if (cdp) { await observe(); await cdp.detach().catch(() => {}); }
    mark("soakEnd");
    report.soak.cycleDurationMs = percentiles(report.soak.cycles.map(cycle => cycle.durationMs));
    report.soak.completedCycles = report.soak.cycles.filter(cycle => cycle.status === "passed").length;
  }
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
