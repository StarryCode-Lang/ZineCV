import { test } from "node:test";
// Register transport regressions in the existing Windows measurement gate.
import "./ipc-interceptor.test.mjs";
import assert from "node:assert/strict";
import { parseArgs, percentiles, soakMemoryWindow, longSoakQualification } from "../../tools/lightweight/measure-memory.mjs";
import { Sampler } from "../../tools/lightweight/measurement-runtime.mjs";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("sampler stop clears both deadline guards and retains forced-termination evidence", async () => {
  const stopFile = join(tmpdir(), `zinecv-sampler-stop-${randomUUID()}`);
  const timeouts = () => process.getActiveResourcesInfo().filter(name => name === "Timeout").length;
  const before = timeouts();
  let killed = 0, finish;
  const sampler = new Sampler({ stopFile, intervalMs: 150 });
  sampler.child = { kill() { killed++; finish(0); } };
  try {
    sampler.exited = Promise.resolve(0);
    const clean = await sampler.stop();
    assert.equal(clean.exitCode, 0);
    assert.equal(clean.forceKilled, false);
    assert.equal(killed, 0);
    assert.equal(timeouts(), before);
    sampler.exited = new Promise(done => { finish = done; });
    const forced = await sampler.stop({ timeoutMs: 5 });
    assert.equal(forced.forceKilled, true);
    assert.equal(forced.exitCode, null, "deadline expiry cannot turn into a clean sampler completion");
    assert.equal(killed, 1);
    assert.equal(timeouts(), before);
  } finally { unlinkSync(stopFile); }
});

test("measurement presets default to quick and explicit budgets override in either argument order", () => {
  for (const [preset, soakMs, runs] of [["quick", 20_000, 1], ["standard", 120_000, 3], ["extended", 1_800_000, 3]]) {
    const options = parseArgs(["--preset", preset]);
    assert.equal(options.soakMs, soakMs); assert.equal(options.runs, runs);
  }
  assert.equal(parseArgs([]).preset, "quick");
  assert.equal(parseArgs([]).diagnostics, false);
  assert.equal(parseArgs([]).historyMode, "growing");
  const fixed = parseArgs(["--preset", "extended", "--history-mode", "fixed"]);
  assert.equal(fixed.historyMode, "fixed");
  assert.equal(fixed.soakMs, 1_800_000);
  assert.equal(fixed.runs, 3);
  assert.throws(() => parseArgs(["--history-mode", "unknown"]));
  const diagnostic = parseArgs(["--preset", "standard", "--diagnostics"]);
  assert.equal(diagnostic.diagnostics, true);
  assert.equal(diagnostic.soakMs, 120_000);
  assert.equal(diagnostic.runs, 3);
  for (const args of [["--runs", "2", "--soak-ms", "45000", "--preset", "extended"],
    ["--preset", "extended", "--runs", "2", "--soak-ms", "45000"]]) {
    const options = parseArgs(args);
    assert.equal(options.soakMs, 45_000); assert.equal(options.runs, 2);
  }
  assert.equal(parseArgs(["--preset", "standard", "--runs", "1"]).soakMs, 120_000);
  assert.equal(parseArgs(["--preset", "extended", "--soak-ms", "20000"]).runs, 3);
  assert.throws(() => parseArgs(["--preset", "unknown"]));
  for (const value of ["0", "-1", "1.5"]) assert.throws(() => parseArgs(["--runs", value]));
});

test("30-minute qualification is separate from short-budget success and requires actual clean completion", () => {
  const successful = { status: "passed", binaryStableAcrossRun: true, cleanupVerified: true, profileDeleted: true,
    soak: { actualMs: 1_800_000, completedCycles: 1, failures: [], exportCount: 1, memory: { sampleCount: 1 } } };
  const reports = Array.from({ length: 3 }, () => structuredClone(successful));
  assert.equal(longSoakQualification(parseArgs(["--preset", "extended"]), reports).accepted, true);
  for (const preset of ["quick", "standard"]) assert.equal(longSoakQualification(parseArgs(["--preset", preset]), reports).accepted, false);
  reports[0].soak.actualMs = 120_000;
  const verdict = longSoakQualification(parseArgs(["--preset", "extended"]), reports);
  assert.equal(verdict.budgetEligible, true); assert.equal(verdict.actualEligible, false); assert.equal(verdict.accepted, false);
  reports[0].soak.actualMs = 1_800_000; reports[0].cleanupVerified = false;
  assert.equal(longSoakQualification(parseArgs(["--preset", "extended"]), reports).accepted, false);
});

test("soak reserves a watchdog budget beyond the continuous interaction window", () => {
  assert.equal(parseArgs(["--soak-ms", "1800000"]).totalTimeoutMs, 2100000);
  assert.equal(parseArgs(["--soak-ms", "0"]).totalTimeoutMs, 300000);
  for (const value of ["-1", "NaN", "1.5"]) assert.throws(() => parseArgs(["--soak-ms", value]));
});

test("percentiles use nearest rank and never report unknown values as zero", () => {
  assert.deepEqual(percentiles([]), { count: 0, p50: null, p95: null, max: null });
  assert.deepEqual(percentiles([9, 2, 7, 4, Number.NaN]), { count: 4, p50: 4, p95: 9, max: 9 });
});

test("soak scope statistics sum same-time process buckets before taking percentiles", () => {
  const samples = [
    { tMs: 10, totalWs: 45, totalPriv: 25, byRole: { host: { ws: 10, priv: 5 }, webview2Browser: { ws: 30, priv: 15 }, renderWorker: { ws: 5, priv: 5 } } },
    { tMs: 20, totalWs: 105, totalPriv: 60, byRole: { host: { ws: 20, priv: 10 }, webview2Browser: { ws: 40, priv: 20 }, webview2Renderer: { ws: 40, priv: 25 }, renderWorker: { ws: 5, priv: 5 } } },
  ];
  const report = soakMemoryWindow(samples, 10, 20);
  assert.equal(report.sampleCount, 2);
  assert.equal(report.scopes.webview2.workingSetBytes.p95, 80);
  assert.equal(report.scopes.tree.workingSetBytes.max, 105);
  assert.equal(report.scopes.other.privateBytes.p50, 0);
  assert.equal(soakMemoryWindow(samples, 30, 40).scopes.tree.privateBytes.max, null);
});
