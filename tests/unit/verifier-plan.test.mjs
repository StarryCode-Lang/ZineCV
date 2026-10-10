import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { scheduleStages, executeBuildStage, retryFailedStages, stageTiming } from "../../tools/verify-project.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../..");

function readPlan(args) {
  const environment = { ...process.env };
  delete environment.ZINECV_VERIFY_ONLY;
  const result = spawnSync(process.execPath, ["tools/verify-project.mjs", ...args, "--plan"], {
    cwd: root, env: environment, encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

for (const suite of ["full", "ci", "fast", "regression"]) {
  test(`${suite} verification plan schedules each dependency before its consumer`, () => {
    const plan = readPlan(["--suite", suite]);
    const indices = new Map(plan.stages.map((stage, index) => [stage.id, index]));
    assert.equal(indices.size, plan.stages.length, "each stage must execute once");
    for (const requested of plan.requested) assert.ok(indices.has(requested), `missing requested stage ${requested}`);
    for (const stage of plan.stages) {
      for (const dependency of stage.dependencies) {
        assert.ok(indices.has(dependency), `${stage.id} requires missing ${dependency}`);
        assert.ok(indices.get(dependency) < indices.get(stage.id), `${dependency} must run before ${stage.id}`);
      }
    }
  });
}

test("hooks-only selection needs only its independent hooks build", () => {
  const plan = readPlan(["--suite", "full", "--only", "test:native-hooks"]);
  assert.deepEqual(plan.stages.map(stage => stage.id), ["build:native-hooks", "test:native-hooks"]);
});

test("full retains all 34 stages, export retains both hosts, and regression is explicitly partial", () => {
  const full = readPlan(["--suite", "full"]);
  assert.equal(full.stages.length, 34);
  assert.equal(full.fullCoverage, true);
  assert.equal(full.maxConcurrency, 2);
  const exp = readPlan(["--only", "test:webview-export"]);
  assert.deepEqual(exp.stages.map(stage => stage.id), ["build:native", "build:native-hooks", "test:webview-export"]);
  const regression = readPlan(["--suite", "regression"]);
  assert.equal(regression.fullCoverage, false);
  assert.ok(regression.requested.includes("test:webview-agent-ui"));
  assert.ok(regression.requested.length < full.requested.length);
});

test("only the six independent lightweight checks permit overlap", async () => {
  const ids = ["check:ts", "verify:contracts", "verify:fixtures", "verify:licenses", "test:unit", "test:lightweight", "test:browser", "check:native", "test:webview", "build:native-hooks"];
  let active = 0;
  let maximum = 0;
  const overlaps = [];
  const completed = await scheduleStages(ids, async script => {
    active += 1;
    maximum = Math.max(maximum, active);
    overlaps.push({ script, active });
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return { script, status: "passed" };
  });
  assert.equal(maximum, 2);
  assert.ok(overlaps.slice(0, 6).some(sample => sample.active === 2));
  assert.ok(overlaps.slice(6).every(sample => sample.active === 1));
  assert.equal(completed.find(stage => stage.script === "test:webview").status, "skipped_dependency_failed", "unsatisfied dependencies must never execute");
});

test("failed build blocks its consumer while independent stages still execute serially", async () => {
  const called = [];
  const results = await scheduleStages(["build:native", "test:webview", "build:native-hooks", "test:native-hooks", "test:webview-export"], async script => {
    called.push(script);
    return { script, status: script === "build:native" ? "failed" : "passed" };
  });
  assert.deepEqual(called, ["build:native", "build:native-hooks", "test:native-hooks"]);
  assert.equal(results.find(stage => stage.script === "test:webview-export").blockedBy, "build:native");
});

test("verified receipt reuses a build and preserves exact provenance", async () => {
  const provenance = { inputSha256: "source-hash", artifactSha256: "exe-hash", receiptPath: "/isolated/receipt.json" };
  const result = await executeBuildStage("build:native", { forceBuild: false, checkReceipt: async () => ({ reusable: true, reason: "verified", provenance }), execute: async () => { throw new Error("must not spawn a reused build"); } });
  assert.equal(result.executionMode, "reused");
  assert.deepEqual(result.buildReuse.provenance, provenance);
});

test("missing, changed and unverified receipts always rebuild", async () => {
  for (const receipt of [{ reusable: false, reason: "receipt_missing" }, { reusable: false, reason: "inputs_changed" }, { reusable: false, reason: "artifact_changed" }, { reusable: true }]) {
    let calls = 0;
    const result = await executeBuildStage("build:native-hooks", { forceBuild: false, checkReceipt: async () => receipt, execute: async forced => { assert.equal(forced, true); calls += 1; return { script: "build:native-hooks", status: "passed", exitCode: 0 }; } });
    assert.equal(calls, 1);
    assert.equal(result.executionMode, "executed");
  }
});

test("force build and no reuse bypass valid receipts", async () => {
  for (const flag of ["--force-build", "--no-reuse"]) {
    const plan = readPlan(["--only", "build:native", flag]);
    assert.equal(plan.forceBuild, true);
    assert.equal(plan.stages[0].buildReuse, false);
  }
  let checks = 0;
  const result = await executeBuildStage("build:engine-poc", { forceBuild: true, checkReceipt: async () => { checks += 1; return { reusable: true, provenance: { sha256: "valid" } }; }, execute: async forced => { assert.equal(forced, true); return { script: "build:engine-poc", status: "passed", exitCode: 0 }; } });
  assert.equal(result.executionMode, "executed");
  assert.equal(result.buildReuse.reason, "forced_rebuild");
  assert.equal(checks, 1, "only record post-build provenance; do not check for reuse before a forced build");
});

test("unreadable receipt is unresolved and falls back to a real build", async () => {
  let calls = 0;
  const result = await executeBuildStage("build:native", { forceBuild: false, checkReceipt: async () => { throw new Error("receipt unreadable"); }, execute: async forced => { assert.equal(forced, true); calls += 1; return { script: "build:native", status: "passed", exitCode: 0 }; } });
  assert.equal(calls, 1);
  assert.equal(result.executionMode, "executed");
  assert.equal(result.buildReuse.reason, "receipt_check_failed");
  assert.equal(result.buildReuse.provenance, null);
});

test("fail-fast drains the active lightweight pair and marks every unexecuted stage", async () => {
  const called = [], reported = [], ids = ["check:ts", "verify:contracts", "build:native", "test:webview"];
  const results = await scheduleStages(ids, async script => {
    called.push(script);
    await new Promise(resolve => setImmediate(resolve));
    return { script, status: script === "check:ts" ? "failed" : "passed" };
  }, async result => reported.push(result.script), { failFast: true });
  assert.deepEqual(called, ids.slice(0, 2));
  assert.deepEqual(reported, ids);
  assert.deepEqual(results.slice(2).map(stage => stage.status), ["not_run_after_failure", "not_run_after_failure"]);
  assert.ok(results.slice(2).every(stage => stage.exitCode === null && stage.blockedBy === "check:ts"));
});

test("failure retry expands both export producers and remains explicitly partial even with --suite full", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "zinecv-retry-"));
  try {
    const path = resolve(directory, "run.json");
    const record = { endedAt: new Date().toISOString(), status: "partial", stages: [
      { script: "build:native", status: "passed" }, { script: "build:native-hooks", status: "passed" },
      { script: "test:webview-export", status: "failed" }, { script: "test:webview-fonts", status: "not_run_after_failure" },
    ] };
    writeFileSync(path, JSON.stringify(record));
    assert.deepEqual(retryFailedStages(record), ["test:webview-export", "test:webview-fonts"]);
    const plan = readPlan(["--suite", "full", "--retry-failed", path]);
    assert.equal(plan.fullCoverage, false);
    assert.deepEqual(plan.stages.map(stage => stage.id), ["build:native", "build:native-hooks", "test:webview-export", "test:webview-fonts"]);
    assert.ok(plan.stages.filter(stage => stage.id.startsWith("build:")).every(stage => stage.buildReuse));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("retry refuses running, forged, duplicate, unknown and all-passed records", () => {
  const valid = { endedAt: "2026-10-09", status: "partial", stages: [{ script: "test:unit", status: "failed" }] };
  for (const record of [null, { ...valid, endedAt: null }, { ...valid, status: "running" },
    { ...valid, stages: [] }, { ...valid, stages: [...valid.stages, ...valid.stages] },
    { ...valid, stages: [{ script: "invented", status: "failed" }] },
    { ...valid, stages: [{ script: "test:unit", status: "reused" }] },
    { ...valid, stages: [{ script: "test:unit", status: "passed" }] }]) {
    assert.throws(() => retryFailedStages(record));
  }
});

test("fail-fast does not omit any full stage when all checks pass", async () => {
  const plan = readPlan(["--suite", "full", "--fail-fast"]);
  assert.equal(plan.stages.length, 34);
  assert.equal(plan.fullCoverage, true);
  const results = await scheduleStages(plan.stages.map(stage => stage.id), async script => ({ script, status: "passed" }), undefined, { failFast: true });
  assert.equal(results.length, 34);
  assert.ok(results.every(stage => stage.status === "passed"));
});

test("timing identifies real bottlenecks without counting receipt reuse or deferred tests", () => {
  const stage = (script, seconds, executionMode = "executed") => ({ script, executionMode, status: "passed", startedAt: "2026-10-09T00:00:00Z", endedAt: new Date(Date.parse("2026-10-09T00:00:00Z") + seconds * 1000).toISOString() });
  assert.deepEqual(stageTiming([stage("test:unit", 2), stage("build:native", 100, "reused"), stage("engine-parity", 186), stage("test:webview", 72), stage("test:webview-export", 999, "skipped")]).map(stage => [stage.script, stage.seconds]), [["engine-parity", 186], ["test:webview", 72], ["test:unit", 2]]);
});
