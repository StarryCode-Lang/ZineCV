// P14 安装态启动验证：以隔离 profile 从安装目录启动已安装的 ZineCV.exe，
// 通过 WebView2 CDP 断言 .app-shell 出现、document_state 可用，并调用一次
// render_document_export 证明安装态引擎资源完整。最后关闭进程并清理 profile。
//
// 用法：
//   node tools/verify-installed-app.mjs <ZineCV.exe 路径> <证据输出 json> [--mode=diagnosis]
// --mode=diagnosis：只记录启动行为（页面加载/控制台错误），不执行导出、不以导出成败判定退出码。
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve, dirname } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const exePath = resolve(args[0] ?? "");
const evidencePath = resolve(args[1] ?? "");
const diagnosis = args.some((arg) => arg === "--mode=diagnosis");
if (!existsSync(exePath)) {
  console.error(`exe not found: ${exePath}`);
  process.exit(2);
}

const report = {
  exe: exePath,
  exeBytes: (await import("node:fs")).statSync(exePath).size,
  mode: diagnosis ? "diagnosis" : "full",
  startedAt: new Date().toISOString(),
};

const installDir = dirname(exePath);
const profile = await mkdtemp(join(tmpdir(), "zinecv-installed-"));
report.profile = profile;
const server = createServer();
await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
report.cdpPort = port;

const child = spawn(exePath, [], {
  cwd: installDir,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: join(profile, "Roaming"),
    LOCALAPPDATA: join(profile, "Local"),
    ZINECV_DATA_DIR: join(profile, "Data"),
    WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
    // 与 tests/native/host-fixture.mjs 相同：遮挡节流会让依赖 rAF 的 flush 挂起。
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
  },
});
report.hostPid = child.pid;

let browser;
let passed = false;
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
try {
  let connected = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Installed host exited before initialization (code=${child.exitCode})`);
    }
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 });
      connected = true;
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  if (!connected) throw new Error("Installed WebView2 host did not expose CDP");
  report.cdpConnected = true;

  const page = browser.contexts().flatMap((context) => context.pages())[0];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push({ type: message.type(), text: message.text().slice(0, 300) });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
  page.on("requestfailed", (request) => {
    failedRequests.push({ url: request.url().slice(0, 200), failure: request.failure()?.errorText });
  });

  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  report.appShellVisible = true;
  await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
  report.saveStateReady = true;
  report.pageTitle = await page.title();
  report.windowUrl = page.url();

  const state = await page.evaluate(async () => window.__TAURI_INTERNALS__.invoke("document_state"));
  report.documentState = {
    ok: Boolean(state?.cursor?.documentId),
    documentId: state?.cursor?.documentId ?? null,
    revision: state?.cursor?.revision ?? null,
    sections: state?.document?.sections?.length ?? null,
  };

  if (!diagnosis) {
    const bundle = await page.evaluate(async (cursor) => window.__TAURI_INTERNALS__.invoke("render_document_export", { cursor }), state.cursor);
    const pdfBytes = Buffer.from(bundle.data.pdfBase64, "base64");
    report.export = {
      pageCount: bundle.data.pageCount,
      pdfSha256: bundle.data.pdfSha256,
      pdfHeader: pdfBytes.subarray(0, 5).toString("latin1"),
      pngPages: bundle.data.pngPages?.length ?? null,
      longPngPresent: Boolean(bundle.data.longPng),
      dpi: bundle.data.dpi,
    };
    report.export.ok =
      report.export.pdfHeader === "%PDF-" &&
      report.export.pageCount > 0 &&
      report.export.pngPages === report.export.pageCount;
  }

  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.failedRequests = failedRequests;

  passed = diagnosis ? report.appShellVisible === true : report.appShellVisible && report.saveStateReady && report.documentState.ok && report.export.ok === true;
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 500);
  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.failedRequests = failedRequests;
} finally {
  report.finishedAt = new Date().toISOString();
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill();
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
  }
  report.hostClosed = true;
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ ok: passed, exe: exePath, appShellVisible: report.appShellVisible === true, exportOk: report.export?.ok === true, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, failedRequests: failedRequests.length }, null, 1));
process.exit(passed ? 0 : 1);
