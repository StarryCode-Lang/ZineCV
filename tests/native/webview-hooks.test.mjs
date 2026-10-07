import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { chromium } from "playwright";
import { installAsyncWait, waitForFirstPage } from "./async-wait.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = join(root, ".artifacts/remaining/R09/session3-hooks");
const hooksExe = join(root, "src-tauri/target/hooks/zinecv-desktop.exe");
const plainExe = join(root, "src-tauri/target/release/zinecv-desktop.exe");
const runFile = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Opt in only after rebuilding hooks; existing binaries retain the 90s test.
const fastWorkerTimeout = process.env.ZINECV_FAST_WORKER_TIMEOUT === "1";

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function workerPid(parentPid) {
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Where-Object { $_.CommandLine -like '*--zinecv-render-worker*' } | Select-Object -ExpandProperty ProcessId`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || null;
}

async function assertGone(pid) {
  assert.ok(pid, "real worker PID must be recorded");
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
  ]);
  assert.equal(stdout.trim(), "gone", `worker ${pid} must have terminated`);
}

async function launch(exe, profile, env) {
  const port = await freePort();
  const child = spawn(exe, [], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: { ...process.env, ...env,
      APPDATA: join(profile, "Roaming"), LOCALAPPDATA: join(profile, "Local"),
      ZINECV_DATA_DIR: join(profile, "Data"),
      WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      assert.equal(child.exitCode, null, "host must remain alive");
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; }
      catch { await sleep(250); }
    }
    assert.ok(browser, "real WebView2 CDP must be available");
    const page = await waitForFirstPage(browser, {
      isAlive: () => child.exitCode === null,
    });
    installAsyncWait(page);
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    return { child, browser, page };
  } catch (error) {
    await browser?.close();
    if (child.exitCode === null) child.kill();
    throw error;
  }
}

async function exportPdf(page, cursor) {
  return page.evaluate(async (cursor) => {
    try { return { ok: true, bytes: await window.__TAURI_INTERNALS__.invoke("export_document_pdf", { cursor }) }; }
    catch (error) { return { ok: false, error }; }
  }, cursor);
}

for (const scenario of ["timeout", "memory", "crash", "production"]) {
  test(`real host worker ${scenario} and recovery`, { timeout: 180_000 }, async () => {
    await mkdir(evidenceRoot, { recursive: true });
    const profile = await mkdtemp(join(evidenceRoot, `${scenario}-profile-`));
    assert.ok(resolve(profile).startsWith(resolve(evidenceRoot) + sep));
    const marker = join(profile, "crash-marker.txt");
    const reset = join(profile, "reset-hooks.txt");
    const exe = scenario === "production" ? plainExe : hooksExe;
    const env = { ZINECV_TEST_WORKER_RESET_FILE: reset };
    if (scenario === "timeout") {
      env.ZINECV_TEST_WORKER_DELAY_MS = fastWorkerTimeout ? "3500" : "95000";
      if (fastWorkerTimeout) env.ZINECV_TEST_RENDER_TIMEOUT_MS = "3000";
    }
    if (scenario === "memory") {
      env.ZINECV_TEST_WORKER_DELAY_MS = "5000";
      env.ZINECV_TEST_WORKER_ALLOC_MB = "1700";
    }
    if (scenario === "crash" || scenario === "production") {
      env.ZINECV_TEST_WORKER_DELAY_MS = "5000";
      env.ZINECV_TEST_CRASH_MARKER = marker;
    }
    if (scenario === "production") env.ZINECV_TEST_RENDER_TIMEOUT_MS = "3000";
    const report = { scenario, startedAt: new Date().toISOString(), executable: exe,
      executableSha256: sha256(await readFile(exe)), fixture: "isolated synthetic blank document", profile,
      timeoutMode: scenario === "timeout" && fastWorkerTimeout ? "test-hooks-3000ms" : "production-default",
      injectedDelayMs: env.ZINECV_TEST_WORKER_DELAY_MS, injectedTimeoutMs: env.ZINECV_TEST_RENDER_TIMEOUT_MS };
    let host;
    let passed = false;
    try {
      host = await launch(exe, profile, env);
      report.hostPid = host.child.pid;
      const before = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      report.frozenCursor = before.cursor;
      report.documentSha256 = sha256(JSON.stringify(before.document));
      const started = Date.now();
      const pending = exportPdf(host.page, before.cursor);
      await sleep(500);
      report.workerPid = await workerPid(host.child.pid);
      const result = await pending;
      report.elapsedMs = Date.now() - started;
      report.firstResult = result.ok ? { ok: true, pdfSha256: sha256(Buffer.from(result.bytes)) } : result;
      assert.equal(host.child.exitCode, null, "fault must not terminate host");
      if (scenario === "timeout" || scenario === "memory") {
        assert.equal(result.ok, false, "injected fault must produce a structured failure");
        assert.match(JSON.stringify(result.error), /engine.?failure/i);
        if (scenario === "timeout") {
          assert.match(JSON.stringify(result.error), /timeout/i);
          const minimumMs = fastWorkerTimeout ? 2900 : 89_000;
          const maximumMs = fastWorkerTimeout ? 15_000 : 110_000;
          assert.ok(report.elapsedMs >= minimumMs && report.elapsedMs < maximumMs,
            `real timeout must occur within ${minimumMs}–${maximumMs}ms: ${report.elapsedMs}`);
        }
        await assertGone(report.workerPid);
        await writeFile(reset, "faults disabled after observed failure");
      } else if (scenario === "crash") {
        assert.equal(result.ok, true, "host must replay the frozen request after the crash");
        report.crashMarkerPid = Number.parseInt(await readFile(marker, "utf8"), 10);
        assert.equal(report.crashMarkerPid, report.workerPid);
        await assertGone(report.crashMarkerPid);
        await writeFile(join(evidenceRoot, "crash-marker.txt"), String(report.crashMarkerPid));
        await writeFile(reset, "faults disabled after successful replay");
      } else {
        assert.equal(result.ok, true);
        assert.ok(report.elapsedMs < 5000, "production must ignore the delay and crash hooks");
        await assert.rejects(readFile(marker), { code: "ENOENT" });
      }
      const recovered = await exportPdf(host.page, before.cursor);
      assert.equal(recovered.ok, true, "same host must export successfully after fault removal");
      const bytes = Buffer.from(recovered.bytes);
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      report.recoveryWorkerPid = await workerPid(host.child.pid);
      if (scenario !== "production") assert.notEqual(report.recoveryWorkerPid, report.workerPid);
      const after = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      assert.deepEqual(after.cursor, before.cursor);
      assert.deepEqual(after.document, before.document, "frozen input must remain unchanged");
      report.recoveryPdfSha256 = sha256(bytes);
      await writeFile(join(evidenceRoot, `${scenario}-recovery.pdf`), bytes);
      report.status = "passed";
      passed = true;
    } catch (error) {
      report.status = "failed";
      report.failure = String(error.stack ?? error);
      throw error;
    } finally {
      if (host) {
        await host.browser.close();
        if (host.child.exitCode === null) {
          const exited = new Promise((done) => host.child.once("exit", done));
          host.child.kill();
          await exited;
        }
        if (report.recoveryWorkerPid) await assertGone(report.recoveryWorkerPid);
      }
      report.finishedAt = new Date().toISOString();
      await writeFile(join(evidenceRoot, `${scenario}.json`), JSON.stringify(report, null, 2));
      if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });
}
