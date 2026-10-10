import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import ts from "typescript";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = resolve(root, process.env.ZINECV_NATIVE_EVIDENCE_OUT_DIR ?? ".artifacts/remaining/closure-optimization-20261008/native-current", "fit-faults");
const runFile = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function workerPid(parentPid) {
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Where-Object { $_.CommandLine -like '*--zinecv-render-worker*' } | Select-Object -ExpandProperty ProcessId`]);
  return Number.parseInt(stdout.trim(), 10) || null;
}
async function isGone(pid) {
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`]);
  return stdout.trim() === "gone";
}

for (const scenario of ["timeout", "cancel", "failure"]) {
  test(`real fit ${scenario} preserves draft and releases avatar lease`, { timeout: 60_000 }, async () => {
    await mkdir(evidenceRoot, { recursive: true });
    const profile = await mkdtemp(join(evidenceRoot, `${scenario}-profile-`));
    assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
    const reset = join(profile, "reset-hooks.txt");
    const buildProfile = scenario === "failure" ? "release" : "hooks";
    const exe = join(root, "src-tauri/target", buildProfile, "zinecv-desktop.exe");
    const report = { scenario, profile, executableSha256: createHash("sha256").update(await readFile(exe)).digest("hex"),
      fixture: "isolated synthetic avatar / actual worker fault; cancellation discards proposal, does not kill worker" };
    let host, passed = false;
    try {
      host = await startNativeHost(profile, { buildProfile, env: {
        ZINECV_TEST_WORKER_RESET_FILE: reset,
        ...(scenario === "failure" ? {} : { ZINECV_TEST_WORKER_DELAY_MS: scenario === "timeout" ? "15000" : "1500" }),
      } });
      report.hostPid = host.child.pid;
      await host.page.exposeFunction("fitLeaseCount", () => {
        const db = new DatabaseSync(join(profile, "Data/zinecv.sqlite3"), { readOnly: true });
        try { return db.prepare("SELECT COUNT(*) AS count FROM resource_leases").get().count; }
        finally { db.close(); }
      });
      const source = await readFile(join(root, "src/preview/engineFit.ts"), "utf8");
      const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export /gm, "");
      const png = new PNG({ width: 8, height: 8 }); png.data.fill(180);
      const validImage = "data:image/png;base64," + PNG.sync.write(png).toString("base64");
      const image = scenario === "failure"
        ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9xoAAAAASUVORK5CYII=" : validImage;
      const before = await host.page.evaluate(async image => {
        const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
        const current = await invoke("document_state");
        const asset = await invoke("store_avatar_asset", { cursor: current.cursor, dataUrl: image, previousHash: null });
        await invoke("apply_document_command", { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId,
          contextId: current.cursor.contextId, expectedRevision: current.cursor.revision, expectedBranchId: current.cursor.branchId,
          expectedHeadId: current.cursor.headId, payload: { type: "updateBasic", patch: { avatarAssetId: asset.hash } } } });
        return { state: await invoke("document_state"), leases: await window.fitLeaseCount() };
      }, image);
      report.before = before;
      const started = Date.now();
      const pending = host.page.evaluate(async ({ code, scenario, cursor }) => {
        const { EngineFitClient } = new Function(code + ";return {EngineFitClient};")();
        const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
        const client = new EngineFitClient(invoke);
        try {
          const request = client.request(cursor);
          if (scenario === "cancel") { await new Promise(resolve => setTimeout(resolve, 150)); client.cancel(); }
          return { ok: true, result: await request };
        } catch (error) { return { ok: false, error }; }
      }, { code, scenario, cursor: before.state.cursor });
      if (scenario !== "failure") {
        await sleep(300);
        report.workerPid = await workerPid(host.child.pid);
        assert.ok(report.workerPid);
      }
      report.firstResult = await pending;
      report.elapsedMs = Date.now() - started;
      const after = await host.page.evaluate(async () => ({ state: await window.__TAURI_INTERNALS__.invoke("document_state"), leases: await window.fitLeaseCount() }));
      assert.deepEqual(after, before);
      assert.equal(host.child.exitCode, null);
      if (scenario === "cancel") {
        assert.deepEqual(report.firstResult, { ok: true, result: null });
        assert.equal(await isGone(report.workerPid), false, "proposal cancellation intentionally leaves the worker available");
      } else {
        assert.equal(report.firstResult.ok, false);
        assert.equal(report.firstResult.error.code, "ENGINE_FAILURE");
        if (scenario === "timeout") {
          assert.match(report.firstResult.error.message, /timeout/i);
          assert.ok(report.elapsedMs >= 9_500 && report.elapsedMs < 15_000);
          assert.equal(await isGone(report.workerPid), true);
        }
      }
      await writeFile(reset, "disable injected fault after observing result");
      if (scenario === "failure") {
        await host.page.evaluate(async ({ cursor, image }) => {
          const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
          const asset = await invoke("store_avatar_asset", { cursor, dataUrl: image, previousHash: null });
          await invoke("apply_document_command", { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(), documentId: cursor.documentId,
            contextId: cursor.contextId, expectedRevision: cursor.revision, expectedBranchId: cursor.branchId, expectedHeadId: cursor.headId,
            payload: { type: "updateBasic", patch: { avatarAssetId: asset.hash } } } });
        }, { cursor: before.state.cursor, image: validImage });
      }
      const recovery = await host.page.evaluate(async () => {
        const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
        const state = await invoke("document_state");
        const leases = await window.fitLeaseCount();
        const plan = await invoke("fit_document_one_page", { cursor: state.cursor });
        return { state, leases, plan, after: await invoke("document_state"), afterLeases: await window.fitLeaseCount() };
      });
      assert.equal(recovery.plan.plan.status, "alreadyFits");
      assert.deepEqual(recovery.after, recovery.state);
      assert.equal(recovery.afterLeases, recovery.leases);
      report.recovery = recovery;
      report.recoveryWorkerPid = await workerPid(host.child.pid);
      if (scenario === "timeout") assert.notEqual(report.recoveryWorkerPid, report.workerPid);
      if (scenario === "cancel") assert.equal(report.recoveryWorkerPid, report.workerPid);
      report.passed = true; passed = true;
    } catch (error) { report.passed = false; report.error = String(error.stack ?? error); throw error; }
    finally {
      if (host) await stopNativeHost(host);
      if (report.recoveryWorkerPid) assert.equal(await isGone(report.recoveryWorkerPid), true);
      await writeFile(join(evidenceRoot, `${scenario}.json`), JSON.stringify(report, null, 2) + "\n");
      if (passed) await rm(profile, { recursive: true, maxRetries: 20, retryDelay: 250 });
    }
  });
}
