import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

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
  { id: "test:webview-fit", dependencies: ["build:native"] },
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
const suites = {
  fast: ["check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit", "test:browser"],
  // 常用实际行为回归；省略专项、视觉与性能终验，不能作为 full 证据。
  regression: ["check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit", "test:lightweight", "test:native", "test:webview", "test:webview-export", "test:webview-agent-ui", "test:webview-persistence"],
  ci: [
    "check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit", "test:lightweight", "test:browser",
    "check:native", "test:bindings", "test:native", "test:engine-poc", "build:engine-poc",
    "test:engine-worker", "build:native", "test:webview", "test:native-shell", "test:visual-parity",
  ],
  // 完整调度（执行计划 §F1）：ci 全部内容 + native-hooks 档 + 12 组 WebView2 专项 + engine-parity。
  // bench 与 package:windows 有独立采样/冻结协议（§10、§F1 性能/安装态组），不进共享套件，单独按协议执行。
  full: [
    "check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit", "test:browser",
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

function parseOptions(argv) {
  const options = {
    suite: process.env.ZINECV_VERIFY_SUITE ?? "full",
    only: process.env.ZINECV_VERIFY_ONLY?.split(",").map((value) => value.trim()).filter(Boolean) ?? null,
    plan: process.env.ZINECV_VERIFY_PLAN === "1",
    forceBuild: process.env.ZINECV_FORCE_BUILD === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") options.plan = true;
    else if (argument === "--force-build" || argument === "--no-reuse") options.forceBuild = true;
    else if (argument === "--suite") options.suite = argv[++index];
    else if (argument === "--only") options.only = argv[++index]?.split(",").map((value) => value.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Object.hasOwn(suites, options.suite)) throw new Error(`Unknown suite ${options.suite}; choose fast, regression, ci, or full.`);
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
export async function scheduleStages(stageIds, execute, onResult = async () => {}) {
  const results = new Map();
  for (let index = 0; index < stageIds.length;) {
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
  }
  return [...results.values()];
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
  const requested = options.only ?? suites[options.suite];
  const stages = expandDependencies(requested);
  if (options.plan) {
    process.stdout.write(`${JSON.stringify({ suite: options.suite, requested, forceBuild: options.forceBuild, maxConcurrency: 2, fullCoverage: options.suite === "full" && !options.only, stages: stages.map((id) => ({ id, dependencies: definitionsById.get(id).dependencies, concurrency: parallelStages.has(id) ? "lightweight" : "exclusive", buildReuse: receiptStages.has(id) && !options.forceBuild })) }, null, 2)}\n`);
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
    },
    inputs: {
      packageJsonSha256: await sha256(join(root, "package.json")),
      packageLockSha256: await sha256(join(root, "package-lock.json")),
      matrixSha256: await sha256(join(root, "docs", "feature-parity.json")),
      fixtureIndexSha256: await sha256(join(root, "fixtures", "remaining", "coverage-input-map.json")),
    },
    releaseArtifact: null,
  };
  const environment = {
    ...process.env,
    CI: "true",
    CARGO_TARGET_DIR: cargoTargetDirectory,
    ZINECV_TEST_EXE: desktopExecutable,
    ZINECV_ENGINE_POC_EXE: engineWorkerExecutable,
    ZINECV_DATA_DIR: isolatedDataDirectory,
    ZINECV_VERIFICATION_RUN_ID: runId,
  };
  await writeJsonAtomic(join(runDirectory, "run.json"), runRecord);
  process.stdout.write(`Verification run ${runId}; suite=${options.suite}; artifacts=${runDirectory}\n`);
  runRecord.scheduling = { maxConcurrency: 2, exclusiveNativeAndUI: true, forceBuild: options.forceBuild };
  runRecord.fullCoverage = options.suite === "full" && !options.only;
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
  });
  runRecord.endedAt = new Date().toISOString();
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
