import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { readRemainingFixtureBytes } from "../fixtures/remaining.mjs";

const root = resolve(import.meta.dirname, "..");
const artifactRoot = join(root, ".artifacts", "verification-runs");
const stageDefinitions = [
  { id: "check:ts", dependencies: [] },
  { id: "verify:contracts", dependencies: [] },
  { id: "verify:fixtures", dependencies: [] },
  { id: "verify:licenses", dependencies: [] },
  { id: "test:unit", dependencies: [] },
  { id: "test:lightweight", dependencies: [] },
  { id: "test:browser", dependencies: [] },
  { id: "check:native", dependencies: [] },
  { id: "test:bindings", dependencies: [] },
  { id: "test:native", dependencies: [] },
  { id: "test:native-hooks", dependencies: ["build:native-hooks"] },
  { id: "test:engine-poc", dependencies: [] },
  { id: "build:engine-poc", dependencies: [] },
  { id: "test:engine-worker", dependencies: ["build:engine-poc"] },
  { id: "build:native", dependencies: [] },
  { id: "build:native-hooks", dependencies: [] },
  { id: "test:webview", dependencies: ["build:native"] },
  { id: "test:native-shell", dependencies: ["build:native"] },
  { id: "test:webview-preview", dependencies: ["build:native"] },
  { id: "test:webview-fit", dependencies: ["build:native", "build:native-hooks"] },
  { id: "test:webview-export", dependencies: ["build:native", "build:native-hooks"] },
  { id: "test:webview-fonts", dependencies: ["build:native"] },
  { id: "test:webview-supplemental", dependencies: ["build:native"] },
  { id: "test:webview-agent-ui", dependencies: ["build:native"] },
  { id: "test:webview-persistence", dependencies: ["build:native"] },
  { id: "test:webview-proposal-assets", dependencies: ["build:native"] },
  // 以下四组依赖 hooks 宿主（tests 内直接引用 target/hooks/zinecv-desktop.exe 或其 phase 包装）
  { id: "test:webview-migration", dependencies: ["build:native-hooks"] },
  { id: "test:webview-migration-crash", dependencies: ["build:native-hooks"] },
  { id: "test:webview-publication", dependencies: ["build:native-hooks"] },
  { id: "test:webview-fit-faults", dependencies: ["build:native-hooks"] },
  { id: "test:webview-hooks", dependencies: ["build:native-hooks"] },
  { id: "build:engine-render", dependencies: [] },
  { id: "test:visual-parity", dependencies: [] },
  { id: "engine-parity", dependencies: ["build:engine-render"], command: ["node", "tools/engine-parity.mjs"] },
];
export const safetyStages = ["check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit"];
const suites = {
  daily: [...safetyStages],
  ui: [...safetyStages, "test:browser", "test:webview"],
  native: [...safetyStages, "check:native", "test:native", "test:bindings"],
  agent: [...safetyStages, "test:webview-agent-ui"],
  recovery: [...safetyStages, "test:webview-persistence", "test:webview-migration", "test:webview-publication", "test:webview-fit-faults"],
  fast: [...safetyStages, "test:browser"],
  // 常用行为覆盖只用正式宿主，避免隐式触发 debug/hooks/引擎示例冷编译。
  // PDF/PNG 正常导出由 editor-contracts/preview/fonts 覆盖；保存故障等深检留 remaining。
  regression: [
    ...safetyStages,
    "test:lightweight", "test:browser", "test:webview", "test:webview-preview",
    "test:webview-fonts", "test:webview-supplemental", "test:webview-agent-ui",
    "test:webview-persistence", "test:webview-proposal-assets",
  ],
  ci: [
    ...safetyStages, "test:lightweight", "test:browser",
    "check:native", "test:bindings", "test:native", "test:engine-poc", "build:engine-poc",
    "test:engine-worker", "build:native", "test:webview", "test:native-shell", "test:visual-parity",
  ],
  // 完整调度（执行计划 §F1）：ci 全部内容 + native-hooks 档 + 12 组 WebView2 专项 + engine-parity。
  // bench 与 package:windows 有独立采样/冻结协议（§10、§F1 性能/安装态组），不进共享套件，单独按协议执行。
  full: [
    ...safetyStages, "test:browser",
    "check:native", "test:bindings", "test:native", "test:native-hooks",
    "test:engine-poc", "build:engine-poc", "test:engine-worker",
    "build:native", "build:native-hooks", "test:webview", "test:native-shell",
    "test:webview-preview", "test:webview-fit", "test:webview-export",
    "test:webview-fonts", "test:webview-supplemental", "test:lightweight",
    "test:webview-agent-ui", "test:webview-persistence", "test:webview-proposal-assets",
    "test:webview-migration", "test:webview-migration-crash", "test:webview-publication",
    "test:webview-fit-faults", "test:webview-hooks",
    "build:engine-render", "test:visual-parity", "engine-parity",
  ],
};
const definitionsById = new Map(stageDefinitions.map((stage) => [stage.id, stage]));
const parallelStages = new Set(["check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit", "test:lightweight"]);
const receiptStages = new Set(["build:native", "build:native-hooks", "build:engine-poc", "build:engine-render"]);
// 从唯一完整清单取差集，避免两份手工清单逐渐漏项。共享构建依赖仍检查收据。
const regressionCoverage = new Set(expandDependencies(suites.regression));
suites.remaining = suites.full.filter(id => !regressionCoverage.has(id));

function parseOptions(argv) {
  const options = {
    suite: process.env.ZINECV_VERIFY_SUITE ?? "fast",
    only: process.env.ZINECV_VERIFY_ONLY?.split(",").map((value) => value.trim()).filter(Boolean) ?? null,
    plan: process.env.ZINECV_VERIFY_PLAN === "1",
    forceBuild: process.env.ZINECV_FORCE_BUILD === "1",
    extended: process.env.ZINECV_FAST_WORKER_TIMEOUT === "0",
    failFast: false,
    retryFailed: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") options.plan = true;
    else if (argument === "--force-build" || argument === "--no-reuse") options.forceBuild = true;
    else if (argument === "--extended") options.extended = true;
    else if (argument === "--fail-fast") options.failFast = true;
    else if (argument === "--retry-failed") options.retryFailed = argv[++index];
    else if (argument === "--suite") options.suite = argv[++index];
    else if (argument === "--only") options.only = argv[++index]?.split(",").map((value) => value.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Object.hasOwn(suites, options.suite)) throw new Error(`Unknown suite ${options.suite}; choose ${Object.keys(suites).join(", ")}.`);
  if (argv.includes("--retry-failed") && !options.retryFailed) throw new Error("--retry-failed needs a completed run.json");
  if (options.retryFailed && options.only) throw new Error("--retry-failed cannot be combined with --only");
  if (options.only?.length && options.only.some((id) => !definitionsById.has(id))) {
    throw new Error(`Unknown --only stage. Choose: ${stageDefinitions.map(({ id }) => id).join(", ")}`);
  }
  return options;
}

function expandDependencies(stageIds) {
  const expanded = new Set();
  const include = (id) => {
    if (expanded.has(id)) return;
    const definition = definitionsById.get(id);
    for (const dependency of definition.dependencies) include(dependency);
    expanded.add(id);
  };
  for (const id of stageIds) include(id);
  return [...expanded];
}

// Only adjacent, independent lightweight checks overlap. Every native build,
// browser/WebView and other stage holds the entire scheduler exclusively.
export async function scheduleStages(stageIds, execute, onResult = async () => {}, { failFast = false } = {}) {
  const results = new Map();
  let stoppedBy = null;
  for (let index = 0; index < stageIds.length;) {
    if (stoppedBy) {
      const script = stageIds[index++], now = new Date().toISOString();
      const result = { script, startedAt: now, endedAt: now, exitCode: null, status: "not_run_after_failure", executionMode: "skipped", blockedBy: stoppedBy };
      results.set(script, result);
      await onResult(result);
      continue;
    }
    const batch = [stageIds[index++]];
    const next = stageIds[index];
    if (parallelStages.has(batch[0]) && parallelStages.has(next) &&
        definitionsById.get(next).dependencies.every(id => results.get(id)?.status === "passed")) {
      batch.push(next);
      index += 1;
    }
    const completed = await Promise.all(batch.map(async id => {
      const dependency = definitionsById.get(id).dependencies.find(id => results.get(id)?.status !== "passed");
      if (dependency) {
        const now = new Date().toISOString();
        return { script: id, startedAt: now, endedAt: now, exitCode: null, status: "skipped_dependency_failed", executionMode: "skipped", blockedBy: dependency };
      }
      return execute(id);
    }));
    // Report writes stay ordered and atomic even when checks finish together.
    for (const result of completed) {
      results.set(result.script, result);
      await onResult(result);
    }
    if (failFast) stoppedBy = completed.find(result => result.status !== "passed")?.script ?? null;
  }
  return [...results.values()];
}

// A diagnostic retry always runs on current inputs and is never full evidence.
// Dependency expansion below includes a fresh receipt check for every producer.
export function retryFailedStages(record) {
  if (!record?.endedAt || !["partial", "failed"].includes(record.status) || !Array.isArray(record.stages) || !record.stages.length) {
    throw new Error("Retry requires a completed failed/partial verifier run");
  }
  const ids = new Set(), allowed = new Set(["passed", "failed", "spawn_error", "skipped_dependency_failed", "not_run_after_failure"]);
  for (const stage of record.stages) {
    if (!definitionsById.has(stage.script) || ids.has(stage.script) || !allowed.has(stage.status)) throw new Error("Invalid or duplicate retry stage");
    ids.add(stage.script);
  }
  const failed = record.stages.filter(stage => stage.status !== "passed").map(stage => stage.script);
  if (!failed.length) throw new Error("No failed stages to retry");
  return failed;
}

export function stageTiming(stages) {
  return stages.filter(stage => stage.executionMode === "executed" && stage.startedAt && stage.endedAt)
    .map(stage => ({ script: stage.script, status: stage.status, seconds: Math.max(0, (Date.parse(stage.endedAt) - Date.parse(stage.startedAt)) / 1000) }))
    .sort((a, b) => b.seconds - a.seconds).slice(0, 6);
}

export async function executeBuildStage(stageId, { forceBuild, checkReceipt, execute }) {
  if (!receiptStages.has(stageId)) return { ...await execute(false), executionMode: "executed" };
  const verifiedReceipt = async () => {
    try { return await checkReceipt(); }
    catch (error) { return { reusable: false, reason: "receipt_check_failed", error: error.message }; }
  };
  const receipt = forceBuild ? { reusable: false, reason: "forced_rebuild" } : await verifiedReceipt();
  if (receipt.reusable === true && receipt.provenance) {
    const now = new Date().toISOString();
    return { script: stageId, startedAt: now, endedAt: now, exitCode: 0, status: "passed", executionMode: "reused", buildReuse: receipt };
  }
  // The scheduler already made its cache decision: force the child wrapper to
  // really execute, so its report cannot mislabel a wrapper cache hit.
  const result = await execute(true);
  const builtReceipt = result.status === "passed" ? await verifiedReceipt() : null;
  return { ...result, executionMode: "executed", buildReuse: { reusable: false, reason: receipt.reason ?? "unverified_receipt", provenance: builtReceipt?.reusable === true ? builtReceipt.provenance : null } };
}

function runText(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function sha256(path) {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function runStage(script, logDirectory, environment) {
  const stdoutPath = join(logDirectory, `${script.replaceAll(":", "-")}.stdout.log`);
  const stderrPath = join(logDirectory, `${script.replaceAll(":", "-")}.stderr.log`);
  const stdoutLog = createWriteStream(stdoutPath, { flags: "w" });
  const stderrLog = createWriteStream(stderrPath, { flags: "w" });
  const logsFinished = Promise.all([finished(stdoutLog), finished(stderrLog)]);
  const windows = process.platform === "win32";
  const definition = definitionsById.get(script);
  const spawnSpec = definition?.command
    ? { command: definition.command[0], args: definition.command.slice(1) }
    : windows
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script}`] }
      : { command: "npm", args: ["run", script] };
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: root,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const startedAt = new Date().toISOString();
  return new Promise((resolveResult) => {
    let settled = false;
    child.once("error", async (error) => {
      if (settled) return;
      settled = true;
      stdoutLog.end();
      stderrLog.end();
      await logsFinished;
      resolveResult({ script, startedAt, endedAt: new Date().toISOString(), exitCode: null, status: "spawn_error", error: error.message, stdoutPath, stderrPath });
    });
    child.once("close", async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      stdoutLog.end();
      stderrLog.end();
      await logsFinished;
      resolveResult({
        script,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        status: exitCode === 0 ? "passed" : "failed",
        signal: signal ?? null,
        stdoutPath,
        stderrPath,
      });
    });
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const retryBytes = options.retryFailed ? await readFile(resolve(root, options.retryFailed)) : null;
  const requested = retryBytes ? retryFailedStages(JSON.parse(retryBytes)) : options.only ?? suites[options.suite];
  const fullCoverage = options.suite === "full" && !options.only && !options.retryFailed;
  const stages = expandDependencies(requested);
  if (options.plan) {
    process.stdout.write(`${JSON.stringify({ suite: options.suite, requested, forceBuild: options.forceBuild, failFast: options.failFast, retryFailed: options.retryFailed, maxConcurrency: 2, fullCoverage, stages: stages.map((id) => ({ id, dependencies: definitionsById.get(id).dependencies, concurrency: parallelStages.has(id) ? "lightweight" : "exclusive", buildReuse: receiptStages.has(id) && !options.forceBuild })) }, null, 2)}\n`);
    return 0;
  }

  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(/[:.]/g, "-")}-${process.pid}`;
  const runDirectory = join(artifactRoot, runId);
  const logDirectory = join(runDirectory, "logs");
  const isolatedDataDirectory = join(runDirectory, "data");
  const cargoTargetDirectory = resolve(root, "src-tauri", "target");
  const desktopExecutable = join(cargoTargetDirectory, "release", "zinecv-desktop.exe");
  const engineWorkerExecutable = join(cargoTargetDirectory, "release", "examples", "typst_poc.exe");
  await mkdir(logDirectory, { recursive: true });
  await mkdir(isolatedDataDirectory, { recursive: true });
  const runRecord = {
    schemaVersion: 1,
    runId,
    suite: options.suite,
    requestedStages: requested,
    stages: [],
    startedAt,
    endedAt: null,
    status: "running",
    exitCode: null,
    revision: {
      branch: runText("git", ["branch", "--show-current"]),
      head: runText("git", ["rev-parse", "HEAD"]),
      workingTreeDirty: runText("git", ["status", "--porcelain=v1"])?.length > 0,
    },
    environment: {
      node: process.version,
      npm: process.platform === "win32" ? runText("cmd.exe", ["/d", "/s", "/c", "npm --version"]) : runText("npm", ["--version"]),
      platform: process.platform,
      architecture: process.arch,
      os: runText("cmd", ["/c", "ver"]) ?? runText("uname", ["-srv"]),
      isolatedDataDirectory,
      cargoTargetDirectory,
      webviewViewport: "1440x900 configured main window; scenario-specific viewports remain in test logs",
      testOnlyWorkerTimeoutBudgetMs: options.extended ? 90_000 : 3000,
      productionWorkerTimeoutMs: 90_000,
    },
    inputs: {
      packageJsonSha256: await sha256(join(root, "package.json")),
      packageLockSha256: await sha256(join(root, "package-lock.json")),
      matrixSha256: await sha256(join(root, "docs", "feature-parity.json")),
      fixtureIndexSha256: createHash("sha256").update(await readRemainingFixtureBytes("coverage-input-map.json")).digest("hex"),
    },
    releaseArtifact: null,
    retryFrom: retryBytes ? { path: resolve(root, options.retryFailed), sha256: createHash("sha256").update(retryBytes).digest("hex"), scope: "Diagnostic only; previous passed tests are not imported. Run full again after repairs." } : null,
  };
  const environment = {
    ...process.env,
    CI: "true",
    CARGO_TARGET_DIR: cargoTargetDirectory,
    ZINECV_TEST_EXE: desktopExecutable,
    ZINECV_ENGINE_POC_EXE: engineWorkerExecutable,
    ZINECV_DATA_DIR: isolatedDataDirectory,
    ZINECV_VERIFICATION_RUN_ID: runId,
    ZINECV_FAST_WORKER_TIMEOUT: options.extended ? "0" : "1",
  };
  await writeJsonAtomic(join(runDirectory, "run.json"), runRecord);
  process.stdout.write(`Verification run ${runId}; suite=${options.suite}; artifacts=${runDirectory}\n`);
  runRecord.scheduling = { maxConcurrency: 2, exclusiveNativeAndUI: true, forceBuild: options.forceBuild, failFast: options.failFast };
  runRecord.fullCoverage = fullCoverage;
  await scheduleStages(stages, async stageId => {
    process.stdout.write(`START ${stageId}\n`);
    return executeBuildStage(stageId, {
      forceBuild: options.forceBuild,
      checkReceipt: async () => {
        const { checkBuildReceipt } = await import("./build-receipt.mjs");
        return checkBuildReceipt(root, stageId);
      },
      execute: forceBuild => runStage(stageId, logDirectory, { ...environment, ...(forceBuild ? { ZINECV_FORCE_BUILD: "1" } : {}) }),
    });
  }, async result => {
    const stageId = result.script;
    runRecord.stages.push(result);
    process.stdout.write(`${result.status === "passed" ? "PASS" : "FAIL"} ${stageId} mode=${result.executionMode} exit=${result.exitCode ?? result.blockedBy ?? "spawn_error"}\n`);
    if (stageId === "build:native" && result.exitCode === 0) {
      try {
        const info = await stat(desktopExecutable);
        runRecord.releaseArtifact = {
          path: relative(root, desktopExecutable).split(sep).join("/"),
          bytes: info.size,
          sha256: await sha256(desktopExecutable),
        };
      } catch {
        runRecord.releaseArtifact = { path: relative(root, desktopExecutable).split(sep).join("/"), missingAfterSuccessfulBuild: true };
      }
    }
    await writeJsonAtomic(join(runDirectory, "run.json"), runRecord);
  }, { failFast: options.failFast });
  runRecord.endedAt = new Date().toISOString();
  runRecord.slowestStages = stageTiming(runRecord.stages);
  runRecord.status = runRecord.stages.every(({ status }) => status === "passed") ? "passed" : "partial";
  runRecord.exitCode = runRecord.status === "passed" ? 0 : 1;
  await writeJsonAtomic(join(runDirectory, "run.json"), runRecord);
  process.stdout.write(`Verification ${runRecord.status}; report=${join(runDirectory, "run.json")}\n`);
  return runRecord.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
