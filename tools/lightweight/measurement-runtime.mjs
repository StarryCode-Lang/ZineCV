import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyProcesses, computeWindows, deriveSamples, scopeOf, summarizeWindow } from "./classify.mjs";

export const here = import.meta.dirname;

export const repoRoot = resolve(here, "../..");

export const SAMPLER = join(here, "process-tree-sampler.ps1");

export const STOPPER = join(here, "stop-tree.ps1");

export const DEFAULT_APP = join(repoRoot, "src-tauri/target/release/zinecv-desktop.exe");

export const SCHEMA = "zinecv.lightweight.memory.v1";

export const PREP_TEXT = "轻量化内存测量冻结修订：中文内容与多页排版。";

export const PREP_REPEAT = 200;

export const PRESETS = {
  quick: { soakMs: 20_000, runs: 1 },
  standard: { soakMs: 120_000, runs: 3 },
  extended: { soakMs: 1_800_000, runs: 3 },
};


// Playwright enables Chromium's Network agent on its own CDP sessions. That
// agent retains IPC responses in the measured renderer (InspectorNetworkAgent /
// NetworkResourcesData), although this measurement never reads network bodies.
// A separate newCDPSession().send('Network.disable') would disable a different
// agent and leave Playwright's recorder running. Use the in-process adapter to
// address the existing sessions, before any measured workload. Fail closed if
// the installed Playwright changes this adapter; never silently mix recordings.
export async function disableInspectorNetworkRecording(browser) {
  const implementation = browser?._connection?.toImpl?.(browser);
  const pages = implementation?._crPages;
  if (!(pages instanceof Map) || !pages.size) throw new Error("Cannot locate Playwright measurement CDP sessions");
  let sessions = 0;
  for (const page of pages.values()) {
    const active = page._networkManager?._sessions;
    if (!(active instanceof Map) || !active.size) throw new Error("Cannot locate Playwright Network agent sessions");
    for (const session of active.keys()) {
      await session.send("Network.disable");
      sessions += 1;
    }
  }
  return { networkRecording: false, sessions, phase: "before-workload",
    note: "Only inspector response recording is disabled; application requests, real UI operations, process sampling and PDF file verification remain active. No mid-workload cache clearing or forced GC." };
}

export const HELP = `measure-memory.mjs — see tools/lightweight/README.md

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

export const nowMs = () => Date.now();

export const iso = (ms) => new Date(ms).toISOString();

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function runPowerShell(scriptPath, args, { timeoutMs = 30_000 } = {}) {
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

export function runPowerShellInline(script, { timeoutMs = 30_000 } = {}) {
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

export function parseJsonLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* keep raw line out of the way */ }
  }
  return out;
}

export function parsePe(bytes) {
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

export async function fileFingerprint(path) {
  const info = await stat(path);
  const bytes = await readFile(path);
  const hash = createHash("sha256");
  hash.update(bytes);
  return { path, sizeBytes: info.size, mtimeIso: info.mtime.toISOString(), sha256: hash.digest("hex"), pe: parsePe(bytes) };
}

export async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function machineInfo() {
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

export async function hostProcessCount() {
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

export async function freeRamBytes() {
  const result = await runPowerShellInline("$os=Get-CimInstance Win32_OperatingSystem; [int64]$os.FreePhysicalMemory*1024");
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : -1;
}

export function processInventory(derived) {
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

export const PAGE_BOOTSTRAP = `
window.__zinecvMeasure = window.__zinecvMeasure || { previewBox: null, urls: [], bundle: null };
const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
`;

export async function ipcProbe(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const state = await invoke("document_state");
    return { ok: true, revision: state.cursor.revision, documentId: state.cursor.documentId, sections: state.document.sections.length };
  })()`);
}

export async function prepareContent(page) {
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

export async function renderPreview(page) {
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

export async function releasePreview(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    const state = window.__zinecvMeasure;
    for (const url of state.urls || []) URL.revokeObjectURL(url);
    state.urls = [];
    state.previewBox?.remove();
    state.previewBox = null;
    return { released: true };
  })()`);
}

export async function renderExport(page, paths) {
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

export async function releaseExport(page) {
  return page.evaluate(`(async () => { ${PAGE_BOOTSTRAP}
    window.__zinecvMeasure.bundle = null;
    if (typeof window.gc === "function") window.gc();
    return { released: true };
  })()`);
}

export function startHost({ app, profile, port, dataDir }) {
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

export function sanitizeEnvironment(environment, profile) {
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

export async function sampleOnce(rootPid, { allProcesses = false } = {}) {
  const args = ["-RootPid", String(rootPid), "-Once"];
  if (allProcesses) args.push("-AllProcesses");
  const result = await runPowerShell(SAMPLER, args, { timeoutMs: 60_000 });
  const parsed = parseJsonLines(result.stdout).find((entry) => entry.kind === "sample");
  if (!parsed) throw new Error(`snapshot returned no sample (exit ${result.code}): ${result.stderr.trim().slice(0, 400)}`);
  return parsed;
}

export class Sampler {
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
    let timer;
    const code = await Promise.race([this.exited, new Promise(done => {
      timer = setTimeout(() => done(Symbol("timeout")), timeoutMs);
    })]).finally(() => clearTimeout(timer));
    let killed = false;
    if (typeof code === "symbol") {
      this.child.kill(); killed = true;
      await Promise.race([this.exited, new Promise(done => { timer = setTimeout(done, 3000); })])
        .finally(() => clearTimeout(timer));
    }
    const trailing = this.buffer.trim();
    if (trailing) this.lines.push(trailing);
    return { stopped: true, exitCode: typeof code === "number" ? code : null, forceKilled: killed, stderr: this.stderr.trim().slice(0, 2000) };
  }
}

export async function cleanupTree(pids, { label }) {
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

export async function soakUi(page, { durationMs, stepTimeoutMs, profile, report, mark, diagnostics = false, historyMode = "growing" }) {
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
    await installIpcInterceptor(page, { commands: ["pick_export_path"] });
    report.instrumentation.ipcInterceptor = { commands: ["pick_export_path"], otherResponses: "untouched-native-fetch" };
    await page.evaluate(target => {
      window.__zinecvTestInvoke = (command, args, invoke) => command === "pick_export_path"
        ? Promise.resolve(target) : invoke(command, args);
  }, target);
  const interactionTimeoutMs = Math.min(stepTimeoutMs, 30_000);
  page.setDefaultTimeout(interactionTimeoutMs);
  report.instrumentation.soak = await disableInspectorNetworkRecording(page.context().browser());
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
        // M5 投递检查先于写盘：确认通过后才进入保存。
        attempt.phase = "review";
        const preflight = page.getByRole("dialog", { name: "投递前检查" });
        await preflight.waitFor({ timeout: 15_000 }).catch(() => {});
        const proceed = preflight.getByRole("button", { name: /^(已核对建议，)?继续导出$/ });
        if (await proceed.isVisible().catch(() => false)) await proceed.click();
        attempt.phase = "wait-result";
        // M5 起成功提示为「"…"已保存：路径」，失败为「导出未完成：原因」。
        // M5 起导出提示挂在根级检查容器的 export-notice（含成功/暂停/失败/取消）。
        const result = page.locator(".export-notice").filter({ hasText: /已保存：|导出已暂停|导出未完成|已取消/ });
        await result.waitFor({ timeout: stepTimeoutMs });
        attempt.notice = await result.innerText();
        if (!attempt.notice.includes("已保存：")) throw new Error(`UI export rejected: ${attempt.notice}`);
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
