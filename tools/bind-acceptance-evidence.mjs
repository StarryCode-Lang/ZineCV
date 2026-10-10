// Evidence bookkeeping only: this helper never promotes acceptance statuses.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, relative, join, sep, isAbsolute } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!["--snapshot", "--run", "--before", "--after", "--extra", "--out", "--apply"].includes(key)) throw new Error(`Unknown option ${key}`);
  options[key.slice(2)] = key === "--apply" ? true : process.argv[++index];
}
const rel = path => relative(root, resolve(root, path)).split(sep).join("/");
function local(path) {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`Path escapes repository: ${path}`);
  return target;
}
function git(args) {
  const result = spawnSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}
const configFiles = new Set(["package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "tsconfig.platform.json", "index.html", "web.html", "vite.web.config.ts", ".cargo/config.toml", "src-tauri/.cargo/config.toml", "docs/public-ipc-contract-v1.md"]);
function included(path) {
  return /^(src\/|public\/|crates\/|fixtures\/|tools\/|tests\/)/.test(path)
    || /^src-tauri\/(src\/|examples\/|capabilities\/|permissions\/|icons\/|Cargo\.(toml|lock)$|build\.rs$|tauri.*\.json$)/.test(path)
    || configFiles.has(path) || /^tsconfig.*\.json$/.test(path);
}
async function snapshot() {
  // Explicit config candidates also cover ignored .cargo build-identity files.
  const paths = [...new Set([...git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(included), ...configFiles])].sort();
  const files = [];
  for (const path of paths) {
    try { files.push({ path, sha256: hash(await readFile(local(path))) }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { schemaVersion: 1, head: git(["rev-parse", "HEAD"]).trim(), capturedAt: new Date().toISOString(),
    scope: "Product src/public/crates/src-tauri source, examples, capabilities, icons and Cargo/build/Tauri config; fixtures/tools/tests; package locks, tsconfig, Vite desktop/Web config, index.html/web.html, .cargo/config.toml and public IPC contract. Excludes other docs, artifacts, generated reports and build output.",
    sourceDigest: hash(JSON.stringify(files)), files,
    matrixSha256: hash(await readFile(join(root, "docs/feature-parity.json"))) };
}
async function writeJson(path, value) {
  await mkdir(resolve(local(path), ".."), { recursive: true });
  await writeFile(local(path), JSON.stringify(value, null, 2) + "\n");
}
if (options.snapshot && !options.run) {
  const record = await snapshot(); await writeJson(options.snapshot, record);
  console.log(JSON.stringify({ head: record.head, sourceDigest: record.sourceDigest, files: record.files.length, snapshot: rel(options.snapshot) }));
} else {
  if (!options.run || !options.before || !options.after) throw new Error("Use --snapshot PATH before/after verification; then --run run.json --before before.json --after after.json [--extra extra.json] [--apply]");
  const run = await json(options.run), before = await json(options.before), after = await json(options.after), current = await snapshot();
  for (const record of [before, after]) {
    if (record.schemaVersion !== 1 || !Array.isArray(record.files) || hash(JSON.stringify(record.files)) !== record.sourceDigest) throw new Error("Invalid source snapshot");
  }
  if (before.head !== after.head || after.head !== current.head || before.sourceDigest !== after.sourceDigest || after.sourceDigest !== current.sourceDigest) throw new Error("Source changed before/during/after verification: new evidence cannot bind this revision");
  if (!run.endedAt || run.status === "running" || run.revision?.head !== before.head) throw new Error("Verifier must have completed against the same HEAD");
  if (Date.parse(before.capturedAt) > Date.parse(run.startedAt) || Date.parse(after.capturedAt) < Date.parse(run.endedAt)) throw new Error("Snapshots must enclose verifier execution");
  const revision = `${after.head}+worktree:${after.sourceDigest}`;
  const out = options.out ?? ".artifacts/remaining/remaining-20261004/C1-f2";
  const rows = await json("docs/feature-parity.json");
  const ids = new Set(rows.map(row => row.featureId));
  if (rows.length !== 56 || ids.size !== 56 || ![...Array(44)].every((_, i) => ids.has(`F${String(i + 1).padStart(2, "0")}`)) || ![...Array(8)].every((_, i) => ids.has(`D${String(i + 1).padStart(2, "0")}`))) throw new Error("Expected intact 52 required plus four supplemental rows");
  const checkKinds = new Set(["U", "B", "N", "V", "M", "D", "R"]);
  const stages = new Map(run.stages.map(stage => [stage.script, stage]));
  const type = script => script === "test:unit" || script === "test:lightweight" ? "U" : script === "test:browser" ? "B" : script === "test:visual-parity" || script === "engine-parity" ? "V" : script.startsWith("test:webview") || script === "test:native" || script === "test:native-hooks" || script === "test:native-shell" || script === "test:engine-poc" || script === "test:engine-worker" ? "N" : null;
  // These stages implement a narrower, recorded behavior relevant to the listed row.
  const additions = {
    F01: ["test:webview-persistence", "test:webview-publication"], F10: ["test:webview-preview", "engine-parity"],
    F11: ["test:webview-fonts", "engine-parity"], F13: ["test:webview-fit", "test:webview-fit-faults"],
    F16: ["test:webview-export", "test:unit"], F17: ["test:webview-export"], F24: ["test:unit"],
    F25: ["test:unit"], F29: ["test:webview-persistence", "test:webview-publication"],
    F30: ["test:webview-migration", "test:webview-migration-crash"], F35: ["test:webview-agent-ui"],
    F43: ["test:webview-export"], F44: ["test:visual-parity", "test:webview-fonts", "engine-parity"],
    D03: ["test:webview-fonts"], D06: ["test:native", "test:native-hooks", "test:webview-hooks"], D07: ["test:webview-export", "test:unit"],
  };
  const external = {
    F07: ["M: 真人 IME 由用户验收"], F15: ["M: 真人选字/键盘核对由用户验收"],
    F41: ["M: 真人系统动态效果核对由用户验收"], F42: ["M: 真人辅助技术验收由用户验收"],
    F10: ["iconfont 再分发授权未闭合；本机系统标题字体不捆绑，几何门禁以当前独立实测为准"], F11: ["iconfont 再分发授权未闭合；本机系统标题字体不捆绑，字体视觉以实际覆盖为准"],
    F33: ["R: 真实模型端到端移出本轮"], F36: ["R: 真实模型显式引用端到端移出本轮"],
    F38: ["R: 真实模型提议端到端移出本轮"], F39: ["R: 真实模型取消/迟到保护移出本轮"],
    F44: ["字体再分发许可未验证；移出本轮"],
    D01: ["干净机无开发环境安装移出本轮"], D02: ["干净 VM 在线/离线安装移出本轮"],
    D03: ["本机资源自动化不证明干净安装与字体再分发许可；外部门禁移出本轮"],
    D04: ["干净机安装/升级/卸载生命周期移出本轮"], D05: ["签名与真实升级回退链移出本轮"],
    D08: ["第二执行者干净复现移出本轮"],
  };
  const fixturePath = `${out}/suite-input-manifest.json`;
  const fixtureManifest = { schemaVersion: 1, revision, description: "Source and fixture hashes frozen around this verifier; suite-level evidence does not assert every acceptance clause was exercised", files: after.files };
  await writeJson(fixturePath, fixtureManifest);
  const fixture = { path: rel(fixturePath), sha256: hash(await readFile(local(fixturePath))) };
  const extras = options.extra ? (await json(options.extra)).records : [];
  if (!Array.isArray(extras)) throw new Error("Extra evidence requires a records array");
  const extraById = new Map();
  for (const item of extras) {
    if (!Array.isArray(item.featureIds) || !checkKinds.has(item.kind) || !item.command || item.exitCode !== 0 || !item.fixture?.path || !item.evidencePath || !item.environment || !Object.keys(item.environment).length) throw new Error("Incomplete normalized extra record: explicit exitCode=0 and actual successful evidence are mandatory");
    if (["B", "V"].includes(item.kind) && !item.environment.viewport) throw new Error("Extra B/V evidence requires actual viewport");
    if (item.kind === "M" && (item.result !== "accepted" || !item.reviewer)) throw new Error("Manual evidence requires real reviewer acceptance");
    const source = await json(item.evidencePath);
    for (const id of item.featureIds) {
      if (!ids.has(id) || !(source.passed === true || source.status === "passed" || source.checks?.[id]?.passed === true)) throw new Error(`Extra evidence has no passing record for ${id}`);
      const entry = { kind: item.kind, command: item.command, exitCode: item.exitCode,
        fixture: { path: rel(item.fixture.path), sha256: hash(await readFile(local(item.fixture.path))) }, environment: item.environment,
        sourceEvidence: { path: rel(item.evidencePath), sha256: hash(await readFile(local(item.evidencePath))) },
        coverage: item.coverage ?? "Only the behavior explicitly asserted by sourceEvidence", ...(item.kind === "M" ? { result: item.result, reviewer: item.reviewer } : {}) };
      extraById.set(id, [...(extraById.get(id) ?? []), entry]);
    }
  }
  const summary = { revision, run: rel(options.run), before: rel(options.before), after: rel(options.after), sourceDigest: after.sourceDigest,
    matrixHashBeforeBookkeeping: current.matrixSha256, policy: "No status promotion; suite checks are partial behavior evidence, never complete feature acceptance", rows: [] };
  for (const row of rows) {
    let candidates = row.tests.filter(value => value.startsWith("npm run ")).map(value => value.slice(8));
    // Build/contract checks do not demonstrate VM installation or independent reproduction.
    if (["D01", "D02", "D04", "D05", "D08"].includes(row.featureId)) candidates = [];
    if (row.featureId === "D03") candidates = [];
    candidates.push(...(additions[row.featureId] ?? []));
    if (row.supplemental) candidates.push("test:webview-supplemental");
    const checks = [...(extraById.get(row.featureId) ?? [])], observations = [];
    for (const script of new Set(candidates)) {
      const stage = stages.get(script), kind = type(script);
      if (!kind) continue;
      if (!stage || stage.status !== "passed" || stage.exitCode !== 0) {
        observations.push({ stage: script, status: stage?.status ?? "not_run", exitCode: stage?.exitCode ?? null }); continue;
      }
      if (!stage.stdoutPath) throw new Error(`Passing stage ${script} has no stdout evidence`);
      const stdout = await readFile(local(stage.stdoutPath));
      const environment = { ...run.environment };
      if (["B", "V"].includes(kind)) environment.viewport = run.environment.webviewViewport ?? "Scenario viewport is recorded by suite; not separately verified by bookkeeping";
      checks.push({ kind, command: script === "engine-parity" ? "node tools/engine-parity.mjs" : `npm run ${script}`,
        exitCode: 0, fixture, environment, stage: script, sourceEvidence: { path: rel(stage.stdoutPath), sha256: hash(stdout) },
        coverage: "Related passing suite only; no claim that every clause of this feature was covered" });
    }
    const record = { schemaVersion: 1, featureId: row.featureId, revision, recordedAt: new Date().toISOString().slice(0, 10),
      checks, observations, coverageStatus: "partial_unreviewed", remainingRequirements: [...(external[row.featureId] ?? []), "逐条 acceptance 覆盖需人工审核；本生成器不升级 passed"],
      provenance: { verifier: rel(options.run), before: rel(options.before), after: rel(options.after), sourceDigest: after.sourceDigest },
      legacyEvidence: row.evidence };
    const evidencePath = `${out}/${row.featureId}.json`; await writeJson(evidencePath, record);
    summary.rows.push({ featureId: row.featureId, statusPreserved: row.status, checks: checks.map(check => ({ kind: check.kind, command: check.command })), observations, evidence: rel(evidencePath), remainingRequirements: record.remainingRequirements });
    if (options.apply) {
      if (row.status === "passed") throw new Error(`Refuse rebinding already-passed ${row.featureId} without manual review`);
      row.revision = revision;
      row.evidence = [...new Set([...row.evidence, rel(evidencePath)])];
      row.environment = { ...run.environment, sourceDigest: after.sourceDigest };
    }
  }
  await writeJson(`${out}/summary.json`, summary);
  if (options.apply) await writeJson("docs/feature-parity.json", rows);
  console.log(JSON.stringify({ revision, rows: summary.rows.length, checks: summary.rows.reduce((n, row) => n + row.checks.length, 0), applied: options.apply === true, statusesPromoted: 0, summary: rel(`${out}/summary.json`) }));
}
