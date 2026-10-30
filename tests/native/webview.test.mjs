// Same serial process; the window test owns an independent profile and host.
import "./webview-window-chrome.test.mjs";
import { exerciseTemplateCatalog, exerciseNativeSelectedContext, exerciseNativeModelStream, exerciseNativeAgentSessionReload, exerciseR24VersionUIRoundTrip, exerciseLegacyMigrationReviewAndIdempotency, exerciseR241001CommitCompleteJSONBackupViaUI, exerciseCloseFlush } from './webview/scenarios.mjs';
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { installAsyncWait, waitForFirstPage, settleBefore } from "./async-wait.mjs";
import { readRemainingFixture } from "../../fixtures/remaining.mjs";

const root = resolve(import.meta.dirname, "../..");
const executable = resolve(process.env.ZINECV_TEST_EXE ?? join(root, "src-tauri", "target", "release", "zinecv-desktop.exe"));
const artifactRoot = join(root, ".artifacts", "runtime-tmp", "test-evidence", "webview");
const verifyWorkerJobCleanup = process.env.ZINECV_TEST_WORKER_CLEANUP === "1";
const exerciseWorkerCrashRecovery = process.env.ZINECV_TEST_CRASH_RENDER_WORKER === "1";

async function findRenderWorkerProcessId(executablePath, hostPid) {
  assert.ok(Number.isInteger(hostPid) && hostPid > 0, "worker lookup requires its actual host PID");
  const escapedPath = executablePath.replaceAll("'", "''");
  const command = `$path='${escapedPath}'; $worker=Get-CimInstance Win32_Process -Filter 'ParentProcessId=${hostPid}' | Where-Object { $_.ExecutablePath -eq $path -and $_.CommandLine -like '*--zinecv-render-worker*' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($worker) { Write-Output $worker }`;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", command]);
  const processId = Number.parseInt(stdout.trim(), 10);
  return Number.isInteger(processId) && processId > 0 ? processId : null;
}

async function waitForRenderWorkerProcessId(executablePath, hostPid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const processId = await findRenderWorkerProcessId(executablePath, hostPid);
    if (processId) return processId;
    await new Promise((done) => setTimeout(done, 25));
  } while (Date.now() < deadline);
  return null;
}

async function killRenderWorkerProcess(processId, executablePath, hostPid) {
  assert.ok(Number.isInteger(processId) && processId > 0);
  assert.ok(Number.isInteger(hostPid) && hostPid > 0);
  const escapedPath = executablePath.replaceAll("'", "''");
  const command = `$ErrorActionPreference='Stop'; $path='${escapedPath}'; $worker=Get-CimInstance Win32_Process -Filter 'ProcessId=${processId}' | Where-Object { $_.ParentProcessId -eq ${hostPid} -and $_.ExecutablePath -eq $path -and $_.CommandLine -like '*--zinecv-render-worker*' }; if (-not $worker) { throw 'Worker is no longer owned by the expected host' }; Stop-Process -Id $worker.ProcessId -Force`;
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
}

async function waitForProcessExit(processId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const command = `if (Get-Process -Id ${processId} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`;
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", command]);
    if (stdout.trim() === "gone") return true;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  return false;
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done) => server.close(done));
  return address.port;
}

// 通过原生窗口句柄识别 Windows 文件选择器，并模拟用户取消。
// PDF 内容和落盘由 webview-export.test.mjs 独立覆盖。
function cancelSaveDialog(hostPid) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ZineSaveDialog {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  public static IntPtr Find(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid == targetPid && IsWindowVisible(hWnd)) {
        StringBuilder name = new StringBuilder(256);
        GetClassName(hWnd, name, 256);
        if (name.ToString() == "#32770") { found = hWnd; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$handle = [ZineSaveDialog]::Find(${hostPid})
if ($handle -eq [IntPtr]::Zero) { 'no-dialog'; exit }
[ZineSaveDialog]::PostMessage($handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
'closed'
`;
  return spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8", timeout: 30_000,
  });
}

async function exerciseUiPdfPicker(page, hostPid) {
  let result = "no-dialog";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    const probe = cancelSaveDialog(hostPid);
    result = probe.stdout.trim() || probe.stderr.trim();
    if (result === "closed") break;
  }
  assert.equal(result, "closed", `PDF action must open the native save dialog; app notice: ${
    await page.evaluate(() => document.querySelector(".export-notice")?.textContent ?? document.body.innerText.slice(0, 300))
  }; review dialog: ${
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog.export-review[open]");
      if (!dialog) return "none";
      const items = [...dialog.querySelectorAll("li")].map(li => li.textContent?.trim()).join(" | ");
      return JSON.stringify({ text: dialog.textContent?.slice(0, 600), items });
    })
  }`);
  // M5 起取消保存对话框在根级提示为「已取消"…"的保存/导出」。
  await page.getByText(/已取消/).waitFor({ timeout: 20_000 });
}

test("release desktop exe renders the React workspace backed by SQLite", { timeout: 90_000 }, async () => {
  await mkdir(artifactRoot, { recursive: true });
  const profile = await mkdtemp(join(artifactRoot, "profile-"));
  const roaming = join(profile, "Roaming");
  const local = join(profile, "Local");
  await Promise.all([mkdir(roaming), mkdir(local)]);
  const port = await availablePort();
  const modelRequests = [];
  const modelServer = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    modelRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model", name: "Fixture model" }] }));
      return;
    }
    const payload = JSON.parse(body);
    if (payload.tools?.some(({ function: fn }) => fn.name === "zinecv_capability_probe")) {
      const nonce = payload.tools[0].function.parameters.properties.nonce.enum[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
        id: "call-fixture", type: "function", function: {
          name: "zinecv_capability_probe", arguments: JSON.stringify({ nonce }),
        },
      }] } }] }));
      return;
    }
    const lastUserMessage = payload.messages?.findLast(({ role }) => role === "user")?.content ?? "";
    if (lastUserMessage.includes("请生成合成提议")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end(
        'data: {"model":"fixture-model","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-proposal-fixture","type":"function","function":{"name":"propose_commands","arguments":"{\\"explanation\\":\\"合成建议\\",\\"commands\\":[{\\"op\\":\\"set_text\\",\\"referenceId\\":\\"basic:name\\",\\"value\\":\\"未经确认的新名称\\"}] }"}}]}}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write('data: {"model":"fixture-model","choices":[{"delta":{"content":"桌面网关"}}]}\n\n');
    response.end('data: {"choices":[{"delta":{"content":"已连接"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((done, reject) => modelServer.once("error", reject).listen(0, "127.0.0.1", done));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const child = spawn(executable, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: roaming,
      LOCALAPPDATA: local,
      ZINECV_DATA_DIR: join(profile, "ZineCVData"),
      WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
      // 桌面被其他窗口遮挡时 Chromium 会节流 rAF，flushEditorBuffers 的
      // 帧回调将永不触发；测试机桌面状态不可控，禁用三类后台节流。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
    },
  });
  let browser;
  let page;
  let peerBrowser;
  let peerChild;
  let renderWorkerProcessId;
  let testError;
  let phase = "launch";
  try {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Desktop exe exited: ${child.exitCode}`);
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
        break;
      } catch (error) {
        lastError = error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    if (!browser) throw new Error(`WebView2 CDP was unavailable: ${lastError}`);
    phase = "initial workspace";
    page = await waitForFirstPage(browser, {
      isAlive: () => child.exitCode === null && child.signalCode === null,
    });
    installAsyncWait(page);
    page.on("console", (message) => {
      if (message.text().includes("DEBUG")) console.log(`PAGE: ${message.text()}`);
    });
    await page.waitForURL(/tauri\.localhost/, { timeout: 15_000 });
    // React 工作区按旧版结构渲染，引导完成后从 SQLite 恢复并完成首轮草稿同步。
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page
      .locator(".save-state")
      .getByText(/草稿已保存|已从本地数据库恢复|保存失败/)
      .waitFor({ timeout: 20_000 });

    phase = "fresh profile blank document";
    const initial = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    for (const [field, value] of Object.entries(initial.document.basic)) {
      if (field === "ageMode") continue;
      assert.ok(value === "" || value === null, `fresh profile must not seed personal information: ${field}`);
    }
    for (const section of initial.document.sections) {
      if (section.entries) assert.equal(section.entries.length, 0, `fresh profile ${section.kind} must be empty`);
      if (section.body) assert.equal(section.body.length, 0, "fresh profile summary must be empty");
    }

    // 标题编辑 → 180ms 防抖 → 命令写入 SQLite → durable ack 后显示已保存。
    phase = "title save";
    await page.locator(".resume-title").click();
    const titleInput = page.getByLabel("简历名称", { exact: true });
    await titleInput.waitFor();
    await titleInput.fill("桌面保存测试");
    await titleInput.press("Tab");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });

    // 重启回路：刷新页面重新引导，标题必须从 SQLite 读回。
    phase = "reload";
    await page.reload({ waitUntil: "commit" });
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page
      .locator(".save-state")
      .getByText(/草稿已保存|已从本地数据库恢复|保存失败/)
      .waitFor({ timeout: 20_000 });
    await page.locator(".resume-title").click();
    await page.getByLabel("简历名称", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("简历名称", { exact: true }).inputValue(), "桌面保存测试");

    // R26: two actual Tauri/WebView2 processes race the same SQLite cursor.
    phase = "R26 two-process compare-and-swap";
    const peerProfile = join(profile, "peer-window");
    const peerRoaming = join(peerProfile, "Roaming");
    const peerLocal = join(peerProfile, "Local");
    const peerData = join(peerProfile, "WebView2");
    await Promise.all([mkdir(peerRoaming, { recursive: true }), mkdir(peerLocal, { recursive: true }), mkdir(peerData, { recursive: true })]);
    const peerPort = await availablePort();
    peerChild = spawn(executable, [], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        APPDATA: peerRoaming,
        LOCALAPPDATA: peerLocal,
        ZINECV_DATA_DIR: join(profile, "ZineCVData"),
        WEBVIEW2_USER_DATA_FOLDER: peerData,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${peerPort} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
      },
    });
    let peerLastError;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (peerChild.exitCode !== null) throw new Error(`Peer desktop exe exited: ${peerChild.exitCode}`);
      try {
        peerBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${peerPort}`, { timeout: 1000 });
        break;
      } catch (error) {
        peerLastError = error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    if (!peerBrowser) throw new Error(`Peer WebView2 CDP was unavailable: ${peerLastError}`);
    const peerPage = await waitForFirstPage(peerBrowser, {
      isAlive: () => peerChild.exitCode === null && peerChild.signalCode === null,
    });
    installAsyncWait(peerPage);
    await peerPage.waitForURL(/tauri\.localhost/, { timeout: 15_000 });
    await peerPage.locator(".app-shell").waitFor({ timeout: 20_000 });
    await peerPage.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    const [firstCursorState, peerCursorState] = await Promise.all([
      page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state")),
      peerPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state")),
    ]);
    assert.deepEqual(peerCursorState.cursor, firstCursorState.cursor, "independent native processes must load one authoritative cursor");
    const raceCommand = (state, commandId, title) => ({
      protocolVersion: 1,
      commandId,
      documentId: state.cursor.documentId,
      contextId: state.cursor.contextId,
      expectedRevision: state.cursor.revision,
      expectedBranchId: state.cursor.branchId,
      expectedHeadId: state.cursor.headId,
      payload: { type: "setDocumentTitle", title },
    });
    const invokeRace = (targetPage, envelope) => targetPage.evaluate(async (request) => {
      try {
        return { ok: true, result: await window.__TAURI_INTERNALS__.invoke("apply_document_command", { envelope: request }) };
      } catch (error) {
        return { ok: false, error: typeof error === "string" ? error : JSON.stringify(error) };
      }
    }, envelope);
    const raceResults = await Promise.all([
      invokeRace(page, raceCommand(firstCursorState, `r26-first-${Date.now()}`, "双窗口并发赢家 A")),
      invokeRace(peerPage, raceCommand(peerCursorState, `r26-second-${Date.now()}`, "双窗口并发赢家 B")),
    ]);
    const raceWinners = raceResults.filter((result) => result.ok);
    const raceLosers = raceResults.filter((result) => !result.ok);
    assert.equal(raceWinners.length, 1, `exactly one stale-cursor writer must commit: ${JSON.stringify(raceResults)}`);
    assert.equal(raceLosers.length, 1, `the other process must receive a conflict: ${JSON.stringify(raceResults)}`);
    assert.match(raceLosers[0].error, /CONFLICT|conflict|revision|stale/i);
    const winningTitle = raceWinners[0].result.document.title;
    assert.match(winningTitle, /^双窗口并发赢家 [AB]$/);
    assert.equal(
      (await peerPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"))).document.title,
      winningTitle,
      "the losing process must observe the winner from shared durable storage",
    );
    await page.reload({ waitUntil: "commit" });
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });

    // B08: SQLite catalog is restored into the real template UI; rename and delete persist.
    phase = "template catalog";
    await exerciseTemplateCatalog({ page });

    // R15：PDF 导出走统一引擎编译 + 原生保存对话框；文件由宿主写入磁盘。
    phase = "PDF export";
    // 纸面显示的是姓名而非工作区标题；基本信息默认折叠，先展开再填姓名并等待落盘。
    await page.locator("button[aria-label='展开基本信息']").click();
    await page.getByLabel("姓名", { exact: true }).fill("王测试");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    // UI 点击确实进入原生对话框；取消后应用恢复。PDF 字节与写盘另见 test:webview-export。
    await page.getByRole("button", { name: "导出", exact: false }).first().click();
    await page.getByRole("menuitem", { name: /PDF 文档/ }).click();
    // M5 投递检查先于保存对话框：内容确认通过后才进入原生保存。
    const review = page.getByRole("dialog", { name: "投递前检查" });
    await review.waitFor();
    const proceed = review.getByRole("button", { name: /^(已核对建议，)?继续导出$/ });
    assert.ok(await proceed.isEnabled(), "synthetic input must pass required preflight errors");
    await proceed.click();
    await exerciseUiPdfPicker(page, child.pid);
    if (verifyWorkerJobCleanup) {
      renderWorkerProcessId = await waitForRenderWorkerProcessId(executable, child.pid);
      assert.ok(renderWorkerProcessId, "UI export must start a hidden render worker");
      if (exerciseWorkerCrashRecovery) {
        const crashedWorkerProcessId = renderWorkerProcessId;
        await killRenderWorkerProcess(crashedWorkerProcessId, executable, child.pid);
        assert.equal(await waitForProcessExit(crashedWorkerProcessId), true);
        const state = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
        const bundle = await page.evaluate((cursor) =>
          window.__TAURI_INTERNALS__.invoke("render_document_export", { cursor }), state.cursor);
        assert.ok(bundle.data.pdfBase64.length > 2_000, "replacement worker must render the frozen document");
        renderWorkerProcessId = await waitForRenderWorkerProcessId(executable, child.pid);
        assert.ok(renderWorkerProcessId);
        assert.notEqual(renderWorkerProcessId, crashedWorkerProcessId);
      }
    }

    phase = "native account and provider";
    if (await page.getByRole("button", { name: "模型设置" }).count() === 0) {
      await page.locator(".agent-bot-button").click();
    }
    await page.getByRole("button", { name: "模型设置" }).click();
    const settings = page.getByRole("dialog", { name: "模型连接" });
    await settings.getByLabel("邮箱", { exact: true }).fill("desktop-fixture@example.com");
    await settings.getByLabel("密码", { exact: true }).fill("fixture-password-123");
    await settings.getByRole("button", { name: "注册并登录" }).click();
    await settings.getByText("已登录：desktop-fixture@example.com").waitFor({ timeout: 15_000 });
    await settings.getByLabel("连接名称", { exact: true }).fill("隔离测试连接");
    await settings.getByLabel("Base URL", { exact: true }).fill(`http://127.0.0.1:${modelAddress.port}/v1`);
    await settings.getByLabel("API Key", { exact: true }).fill("sk-fixture-secret-123456");
    await settings.getByLabel("模型 ID", { exact: true }).fill("fixture-model");
    await settings.getByRole("button", { name: "保存连接" }).click();
    await settings.getByText("连接已加密保存到此账户：可聊天；宿主工具需先通过结构化测试").waitFor({ timeout: 15_000 });
    await settings.getByRole("button", { name: "检测连接并获取模型" }).click();
    await settings.getByText(/服务返回 1 个模型/).waitFor({ timeout: 15_000 });
    await settings.getByRole("button", { name: "测试连接" }).click();
    await settings.getByText(/结构化工具通过（fixture-model）/).waitFor({ timeout: 15_000 });
    await settings.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:1/v1");
    assert.equal(await settings.getByRole("button", { name: "保存连接" }).isDisabled(), true);
    await settings.getByLabel("Base URL", { exact: true }).fill(`http://127.0.0.1:${modelAddress.port}/v1`);
    assert.equal(await settings.getByLabel("API Key", { exact: true }).inputValue(), "");
    const publicProfile = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("provider_profile"));
    assert.equal(publicProfile.name, "隔离测试连接");
    assert.equal(publicProfile.hasApiKey, true);
    assert.equal(publicProfile.capability, "structured");
    assert.ok(!JSON.stringify(publicProfile).includes("sk-fixture-secret-123456"));
    await page.reload({ waitUntil: "commit" });
    await page.getByRole("button", { name: "模型设置" }).click();
    await settings.getByText("已登录：desktop-fixture@example.com").waitFor({ timeout: 15_000 });
    // 页面会因既有机制偶发重载；reload 后挂载需要重新拉取 profile 再回填，
    // 因此这里按值轮询等待，而不是读一次输入框。
    await page.waitForFunction(
      (expected) => {
        const label = Array.from(document.querySelectorAll("label")).find(
          (element) => element.textContent?.startsWith("连接名称"),
        );
        return label?.querySelector("input")?.value === expected;
      },
      "隔离测试连接",
      { timeout: 15_000 },
    );
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("provider_profile"))).capability, "structured");
    await settings.getByRole("button", { name: "关闭模型设置" }).click();
    phase = "native selected context";
    await exerciseNativeSelectedContext({ page });
    phase = "native model stream";
    await exerciseNativeModelStream({ page, modelRequests });
    phase = "host proposal remains review-only";
    if (await page.getByRole("button", { name: "展开聊天" }).count()) {
      await page.getByRole("button", { name: "展开聊天" }).click();
    }
    await page.getByLabel("给 Re:me 助手发送消息").fill("请生成合成提议 ");
    await page.getByLabel("给 Re:me 助手发送消息").pressSequentially("@姓名");
    const referenceMenu = page.getByRole("listbox", { name: "选择引用" });
    if (!(await referenceMenu.count())) {
      const composerState = await page.evaluate(() => ({
        expanded: document.querySelector('textarea[aria-label="给 Re:me 助手发送消息"]')?.getAttribute("aria-expanded"),
        completionText: document.querySelector(".agent-completion")?.textContent,
        selectedReferences: [...document.querySelectorAll(".agent-chips .agent-chip")].map((item) => item.textContent),
      }));
      console.log(`R21 composer diagnostic: ${JSON.stringify(composerState)}`);
    }
    await referenceMenu.getByRole("option", { name: /姓名/ }).click();
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.locator(".agent-message-assistant").getByText("待确认建议（尚未应用）").waitFor({ timeout: 15_000 });
    assert.equal(modelRequests.length, 5);
    const proposalRun = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"));
    const afterProposal = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(afterProposal.document.basic.name, "王测试", "host proposal must not write before user confirmation");
    const pendingInbox = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_proposals"));
    assert.equal(pendingInbox.pending.length, 1);
    assert.equal(proposalRun.find(({ id }) => id === pendingInbox.pending[0].runId)?.lifecycleState, "awaiting_confirmation");
    const proposalSession = await page.evaluate(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" });
      return state.store.activeId;
    });
    assert.equal(pendingInbox.pending[0].sessionId, proposalSession);
    phase = "native agent session reload";
    await exerciseNativeAgentSessionReload({ page, pendingInbox, settings });
    phase = "agent account isolation";
    await settings.getByLabel("邮箱", { exact: true }).fill("other-fixture@example.com");
    await settings.getByLabel("密码", { exact: true }).fill("other-fixture-password");
    await settings.getByRole("button", { name: "注册并登录" }).click();
    await settings.getByText("已登录：other-fixture@example.com").waitFor({ timeout: 15_000 });
    await settings.getByText("登录成功，请配置此账户的模型连接").waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".agent-message-assistant").getByText("桌面网关已连接").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs")), []);
    await settings.getByRole("button", { name: "退出登录" }).click();
    await settings.getByRole("button", { name: "登录", exact: true }).waitFor({ timeout: 15_000 });
    await settings.getByLabel("邮箱", { exact: true }).fill("desktop-fixture@example.com");
    await settings.getByLabel("密码", { exact: true }).fill("fixture-password-123");
    await settings.getByRole("button", { name: "登录", exact: true }).click();
    await settings.getByText("已登录：desktop-fixture@example.com").waitFor({ timeout: 15_000 });
    await page.locator(".agent-message-assistant").getByText("桌面网关已连接").waitFor({ timeout: 15_000 });
    await settings.getByRole("button", { name: "关闭模型设置" }).click();
    if (await page.getByRole("button", { name: "最小化到 Bot" }).count()) {
      await page.getByRole("button", { name: "最小化到 Bot" }).click();
    }

    // 版本面板接真实版本图：初始提交在列表中可见。
    phase = "version panel";
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByText("简历版本管理").first().waitFor({ timeout: 15_000 });
    await page.getByText("初始版本").first().waitFor({ timeout: 15_000 });

    // R24: exercise the real version UI against SQLite, including cancellation,
    // history-to-draft loading, child reconnection, shared ancestors, and restart readback.
    phase = "R24 version UI round trip";
    await exerciseR24VersionUIRoundTrip({ page });

    // R24: version backup cancellation/replacement preserves the live draft;
    // full-database restore rejects a bad hash without mutation, then restores
    // the same isolated database and survives the application reload.
    phase = "R24 backup and restore UI round trip";
    await page.getByRole("button", { name: "简历编辑" }).click();
    const expandBackupBasic = page.locator("button[aria-label='展开基本信息']");
    if (await expandBackupBasic.count()) await expandBackupBasic.click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 备份未提交草稿");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByLabel("附带当前未提交草稿").check();
    const versionBackupDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出版本备份" }).click();
    const versionBackupPath = join(profile, "r24-version-backup.json");
    await (await versionBackupDownload).saveAs(versionBackupPath);
    const versionBackup = JSON.parse(await readFile(versionBackupPath, "utf8"));
    assert.equal(versionBackup.format, "resume-diy-version-backup");
    assert.ok(versionBackup.draft);
    assert.ok(JSON.stringify(versionBackup.draft.snapshot).includes("R24 备份未提交草稿"));
    assert.equal(versionBackup.store.currentBranchId, "main");
    assert.ok(versionBackup.store.branches.some((branch) => branch.id === "main"));

    const graphSignature = (graph) => ({
      cursor: [graph.cursor.branchId, graph.cursor.headId],
      branches: graph.branches.map(({ id, headCommitId }) => [id, headCommitId]).sort(),
      commits: graph.commits.map(({ id, parentId }) => [id, parentId]).sort(),
    });
    const chooseVersionBackup = async () => {
      await page.getByLabel("选择版本备份文件", { exact: true }).setInputFiles(versionBackupPath);
      await page.getByText("已读取版本备份", { exact: true }).waitFor({ timeout: 15_000 });
    };
    const graphBeforeBackupCancel = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    await chooseVersionBackup();
    await page.locator(".version-import-preview").getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(graphSignature(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))), graphSignature(graphBeforeBackupCancel));
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"))).document.basic.name, "R24 备份未提交草稿");

    await chooseVersionBackup();
    await page.locator(".version-import-preview").getByRole("button", { name: "替换当前版本库" }).click();
    await page.getByRole("alertdialog").getByRole("heading", { name: "替换当前版本库？" }).waitFor();
    await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
    assert.deepEqual(graphSignature(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))), graphSignature(graphBeforeBackupCancel));
    await chooseVersionBackup();
    await page.locator(".version-import-preview").getByRole("button", { name: "替换当前版本库" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认替换版本库" }).click();
    await page.getByText("版本库已替换，当前工作内容未自动变更", { exact: true }).waitFor({ timeout: 20_000 });
    assert.deepEqual(graphSignature(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))), graphSignature(graphBeforeBackupCancel));
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"))).document.basic.name, "R24 备份未提交草稿");

    const fullBackupDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出完整备份" }).click();
    const fullBackupPath = join(profile, "r24-full-backup.json");
    await (await fullBackupDownload).saveAs(fullBackupPath);
    await page.getByRole("heading", { name: "正在创建完整数据库备份" }).waitFor({ state: "detached", timeout: 15_000 });
    const fullBackup = JSON.parse(await readFile(fullBackupPath, "utf8"));
    assert.equal(fullBackup.format, "zinecv-sqlite-full-backup");
    const invalidFullBackupPath = join(profile, "r24-full-backup-bad-hash.json");
    await writeFile(invalidFullBackupPath, JSON.stringify({ ...fullBackup, databaseSha256: "0".repeat(64) }), "utf8");
    const chooseFullBackup = async (path) => {
      await page.getByLabel("选择完整数据库备份文件").setInputFiles(path);
      await page.getByRole("alertdialog").getByRole("heading", { name: "恢复完整数据库？" }).waitFor({ timeout: 15_000 });
    };
    const fullRestoreStateBefore = await page.evaluate(async () => ({
      document: await window.__TAURI_INTERNALS__.invoke("document_state"),
      graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
    }));
    await page.evaluate(() => {
      window.__r24RestoreNotices = [];
      new MutationObserver(() => {
        const notice = document.querySelector(".notice-toast")?.textContent?.trim();
        if (notice) window.__r24RestoreNotices.push(notice);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await chooseFullBackup(invalidFullBackupPath);
    await page.getByRole("alertdialog").getByRole("button", { name: "恢复完整数据库" }).click();
    try {
      await page.waitForFunction(
        () => window.__r24RestoreNotices.some((notice) => notice.includes("完整数据库恢复失败；")),
        null,
        { timeout: 20_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        notices: window.__r24RestoreNotices,
        dialog: document.querySelector('[role="alertdialog"]')?.textContent?.trim() ?? null,
        operation: document.querySelector('[aria-busy="true"]')?.textContent?.trim() ?? null,
      }));
      throw new Error(`Full database restore failure was not visible: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    const rejectedRestore = await page.evaluate(() => ({
      notices: window.__r24RestoreNotices,
    }));
    const restoreNotice = rejectedRestore.notices.find((notice) => notice.includes("完整数据库恢复失败；")) ?? "";
    assert.match(restoreNotice, /完整性或数据库校验/);
    assert.match(restoreNotice, /当前数据库未替换/);
    const afterRejectedRestore = await page.evaluate(async () => ({
      document: await window.__TAURI_INTERNALS__.invoke("document_state"),
      graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
    }));
    assert.equal(afterRejectedRestore.document.document.basic.name, "R24 备份未提交草稿");
    assert.deepEqual(graphSignature(afterRejectedRestore.graph), graphSignature(fullRestoreStateBefore.graph));
    assert.deepEqual(
      (await readdir(join(profile, "ZineCVData"))).filter((name) => name.includes(".pre-restore-")),
      [],
      "rejected backup must not publish a pre-restore replacement copy",
    );

    await page.locator(".notice-toast").waitFor({ state: "detached", timeout: 5_000 });
    await chooseFullBackup(fullBackupPath);
    const restoreSuccess = page.locator(".notice-toast").filter({ hasText: "完整数据库已恢复" });
    const restoreFailure = page.locator(".notice-toast").filter({ hasText: "完整数据库恢复失败" });
    await page.getByRole("alertdialog").getByRole("button", { name: "恢复完整数据库" }).click();
    const restoreOutcome = await Promise.race([
      restoreSuccess.waitFor({ timeout: 20_000 }).then(() => "success", () => "success-timeout"),
      restoreFailure.waitFor({ timeout: 20_000 }).then(() => "failure", () => "failure-timeout"),
    ]);
    if (restoreOutcome !== "success") {
      const diagnostics = {
        outcome: restoreOutcome,
        body: (await page.locator("body").innerText().catch(() => "unavailable")).slice(-1_500),
        backupFiles: (await readdir(join(profile, "ZineCVData")).catch(() => []))
          .filter((name) => name.includes(".pre-restore-")),
      };
      throw new Error(`Valid full database restore did not complete: ${JSON.stringify(diagnostics)}`);
    }
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    const afterFullRestore = await page.evaluate(async () => ({
      document: await window.__TAURI_INTERNALS__.invoke("document_state"),
      graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
    }));
    assert.equal(afterFullRestore.document.document.basic.name, "R24 备份未提交草稿");
    assert.deepEqual(graphSignature(afterFullRestore.graph), graphSignature(fullRestoreStateBefore.graph));
    await page.getByRole("button", { name: "版本管理" }).first().click();

    // R20: select a synthetic versions.json through the React UI, review it,
    // commit it atomically, and repeat the same source three times. The file
    // lives only in this isolated profile and its bytes must remain unchanged.
    phase = "legacy migration review and idempotency";
    await exerciseLegacyMigrationReviewAndIdempotency({ profile, page });

    // R24: extend the fixed graph with an ancestor outside the 1000 snapshot window.
    phase = "R24 1001-commit graph interaction and lazy history detail";
    const graphFixture = await readRemainingFixture("version-graph-1000.json");
    const graphSnapshot = versionBackup.store.commits[0]?.snapshot ?? versionBackup.draft?.snapshot;
    assert.ok(graphSnapshot, "portable fixture needs a schema-valid synthetic snapshot");
    const lazySnapshot = structuredClone(graphSnapshot);
    lazySnapshot.resume.basic.name = "R24 按需历史快照";
    const denseBackupPath = join(profile, "r24-version-graph-1000.json");
    await writeFile(denseBackupPath, JSON.stringify({
      format: versionBackup.format,
      formatVersion: versionBackup.formatVersion,
      exportedAt: new Date().toISOString(),
      store: {
        currentBranchId: "main",
        branches: graphFixture.branches.map((branch) => ({
          ...branch,
          createdAt: "2024-01-01T00:00:00.000Z",
        })),
        commits: [{
          id: "r24-lazy-ancestor", branchId: "main", parentId: null,
          message: "R24 按需历史版本", createdAt: "2020-01-01T00:00:00.000Z",
          snapshot: lazySnapshot,
        }, ...graphFixture.commits.map((commit) => ({
          id: commit.id,
          branchId: commit.branchId,
          parentId: commit.id === "commit-0000" ? "r24-lazy-ancestor" : commit.parentId,
          message: commit.message,
          createdAt: commit.createdAt,
          snapshot: graphSnapshot,
        }))],
      },
    }), "utf8");
    await page.getByLabel("选择版本备份文件", { exact: true }).setInputFiles(denseBackupPath);
    await page.getByText("已读取版本备份", { exact: true }).waitFor({ timeout: 20_000 });
    await page.locator(".version-import-preview").getByRole("button", { name: "替换当前版本库" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认替换版本库" }).click();
    await page.getByText("版本库已替换，当前工作内容未自动变更", { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.length === 1001, null, { timeout: 30_000 });
    const tree = page.locator(".branch-tree-scroll");
    await tree.waitFor();
    assert.equal(await page.locator(".branch-tree-node").count(), 1001);

    const beforeWheel = await tree.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const anchor = { x: rect.width * 0.63, y: rect.height * 0.42 };
      return {
        anchor,
        logical: {
          x: (element.scrollLeft + anchor.x) / 1,
          y: (element.scrollTop + anchor.y) / 1,
        },
        rect: { x: rect.x, y: rect.y },
      };
    });
    await page.keyboard.down("Control");
    await page.mouse.move(beforeWheel.rect.x + beforeWheel.anchor.x, beforeWheel.rect.y + beforeWheel.anchor.y);
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await page.waitForFunction(() => document.querySelector(".branch-tree-zoom-value")?.textContent === "110%", null, { timeout: 5_000 });
    await page.waitForTimeout(50);
    const afterWheel = await tree.evaluate((element, anchor) => ({
      x: (element.scrollLeft + anchor.x) / 1.1,
      y: (element.scrollTop + anchor.y) / 1.1,
    }), beforeWheel.anchor);
    assert.ok(Math.abs(afterWheel.x - beforeWheel.logical.x) <= 2, `pointer zoom shifted horizontal anchor: ${JSON.stringify({ beforeWheel, afterWheel })}`);
    assert.ok(Math.abs(afterWheel.y - beforeWheel.logical.y) <= 2, `pointer zoom shifted vertical anchor: ${JSON.stringify({ beforeWheel, afterWheel })}`);

    for (let step = 0; step < 14; step += 1) await tree.press("]");
    await page.waitForFunction(() => document.querySelector(".branch-tree-zoom-value")?.textContent === "250%", null, { timeout: 5_000 });
    const beforePan = await tree.evaluate((element) => {
      element.scrollLeft = Math.max(0, Math.round((element.scrollWidth - element.clientWidth) / 2));
      element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
      const rect = element.getBoundingClientRect();
      return { left: element.scrollLeft, top: element.scrollTop, x: rect.x + 8, y: rect.y + rect.height * 0.45 };
    });
    await page.mouse.move(beforePan.x, beforePan.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(beforePan.x - 60, beforePan.y - 60, { steps: 4 });
    await page.mouse.up({ button: "right" });
    const afterPan = await tree.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
      focused: document.activeElement === element,
    }));
    assert.ok(afterPan.left > beforePan.left, `horizontal pan did not advance: ${JSON.stringify({ beforePan, afterPan })}`);
    assert.ok(afterPan.top > beforePan.top, `vertical pan did not advance: ${JSON.stringify({ beforePan, afterPan })}`);
    assert.equal(afterPan.focused, true, "panning the graph must leave keyboard focus on the canvas");
    await tree.press("0");
    await page.waitForFunction(() => {
      const value = Number(document.querySelector(".branch-tree-zoom-value")?.textContent?.replace("%", ""));
      return Number.isFinite(value) && value < 250;
    }, null, { timeout: 5_000 });

    const newestNode = page.locator('.branch-tree-node[data-version-commit-id="commit-0999"]');
    await newestNode.scrollIntoViewIfNeeded();
    await newestNode.click();
    assert.equal(await newestNode.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator(".branch-node-detail strong").innerText(), "合成版本 0999");

      const lazyDetail = await page.evaluate(async () => {
        const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
        const lazy = graph.commits.find((commit) => commit.id === "r24-lazy-ancestor");
        const detail = await window.__TAURI_INTERNALS__.invoke("version_commit_detail", { commitId: lazy.id });
        return { graphSnapshot: lazy.snapshotDocumentJson, detail: JSON.parse(detail.snapshotDocumentJson) };
      });
      assert.equal(lazyDetail.graphSnapshot, "");
      assert.equal(lazyDetail.detail.basic.name, "R24 按需历史快照");
      const lazyNode = page.locator('.branch-tree-node[data-version-commit-id="r24-lazy-ancestor"]');
      await lazyNode.scrollIntoViewIfNeeded();
      await lazyNode.click();
      await page.waitForFunction(() => {
        const detail = document.querySelector(".branch-node-detail");
        return detail?.textContent.includes("R24 按需历史版本") && !detail?.textContent.includes("点击查看格式");
      }, null, { timeout: 20_000 });
      await page.locator(".branch-node-detail").getByRole("button", { name: "载入", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "载入此版本", exact: true }).click();
      await page.getByText("版本已载入到工作区", { exact: true }).waitFor({ timeout: 20_000 });
      const restoredLazy = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      assert.equal(restoredLazy.document.basic.name, "R24 按需历史快照");

    // Exercise the actual JSON download after loading an unmaterialized ancestor.
    // The graph still has 1001 commits and HEAD must remain on its original commit.
    phase = "R24 1001-commit complete JSON backup via UI";
    await exerciseR241001CommitCompleteJSONBackupViaUI({ page, profile, restoredLazy, graphSignature, versionBackup });

    phase = "close flush";
    await exerciseCloseFlush({ page, child, verifyWorkerJobCleanup, profile, waitForProcessExit, renderWorkerProcessId });
  } catch (error) {
    console.error(`WebView failure phase: ${phase}`);
    if (page) {
      console.error(`WebView status at failure: ${await page.locator(".save-state").textContent().catch(() => "unavailable")}`);
    }
    testError = error;
  } finally {
    await new Promise((done) => modelServer.close(done));
    if (peerBrowser) await settleBefore(peerBrowser.close(), 5_000);
    if (peerChild?.exitCode === null) {
      const peerExited = new Promise((done) => peerChild.once("exit", done));
      await new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(peerChild.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
      });
      if (peerChild.exitCode === null) peerChild.kill();
      if (peerChild.exitCode === null) await settleBefore(peerExited, 5_000);
    }
    if (browser) await settleBefore(browser.close(), 5_000);
    if (child.exitCode === null) {
      const childExited = new Promise((done) => child.once("exit", done));
      await new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
      });
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null) await settleBefore(childExited, 5_000);
    }
    if (testError) {
      console.error(`Preserved isolated failure evidence at: ${profile}`);
    } else {
      try {
        await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
      } catch (cleanupError) {
        if (!testError) testError = cleanupError;
        else console.error(`Isolated profile cleanup also failed: ${cleanupError}`);
      }
    }
  }
  if (testError) throw testError;
});
