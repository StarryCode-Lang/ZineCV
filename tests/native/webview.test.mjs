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
import { installAsyncWait, waitForFirstPage } from "./async-wait.mjs";

const root = resolve(import.meta.dirname, "../..");
const executable = resolve(process.env.ZINECV_TEST_EXE ?? join(root, "src-tauri", "target", "release", "zinecv-desktop.exe"));
const artifactRoot = join(root, ".artifacts", "runtime-tmp", "test-evidence", "webview");
const verifyWorkerJobCleanup = process.env.ZINECV_TEST_WORKER_CLEANUP === "1";
const exerciseWorkerCrashRecovery = process.env.ZINECV_TEST_CRASH_RENDER_WORKER === "1";

async function findRenderWorkerProcessId(executablePath) {
  const escapedPath = executablePath.replaceAll("'", "''");
  const command = `$path='${escapedPath}'; $worker=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $path -and $_.CommandLine -like '*--zinecv-render-worker*' } | Select-Object -First 1 -ExpandProperty ProcessId; if ($worker) { Write-Output $worker }`;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", command]);
  const processId = Number.parseInt(stdout.trim(), 10);
  return Number.isInteger(processId) && processId > 0 ? processId : null;
}

async function waitForRenderWorkerProcessId(executablePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const processId = await findRenderWorkerProcessId(executablePath);
    if (processId) return processId;
    await new Promise((done) => setTimeout(done, 25));
  } while (Date.now() < deadline);
  return null;
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
  assert.equal(result, "closed", "PDF action must open the native save dialog");
  await page.getByText("已取消导出").waitFor({ timeout: 20_000 });
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
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${peerPort}`,
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
    const importedFixture = [{
      id: "fixture-imported-template", name: "持久化模板", sourceName: "fixture.png",
      sourceType: "image", createdAt: "2026-01-01T00:00:00.000Z",
      accent: "#2563eb", formatId: "legacy-v1", layout: "single-column",
      analysis: "隔离测试模板",
    }];
    await page.evaluate(async (payloadJson) => {
      const current = await window.__TAURI_INTERNALS__.invoke("read_imported_template_catalog");
      await window.__TAURI_INTERNALS__.invoke("write_imported_template_catalog", {
        payloadJson, expectedRevision: current.revision,
      });
    }, JSON.stringify(importedFixture));
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "模板", exact: true }).click();
    await page.getByText("持久化模板", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "重命名模板 持久化模板" }).click();
    await page.getByLabel("模板名称").fill("已重命名模板");
    await page.getByLabel("模板名称").press("Enter");
    await page.getByText("已重命名模板", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "收藏模板 已重命名模板" }).click();
    await page.getByRole("button", { name: "取消收藏 已重命名模板" }).waitFor();
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "bootstrap_template_activity", { legacyJson: "{}" })))[0].favorite, true);
    assert.equal(JSON.parse((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "read_imported_template_catalog"))).payloadJson)[0].name, "已重命名模板");
    await page.reload({ waitUntil: "commit" });
    await page.getByRole("button", { name: "模板", exact: true }).click();
    await page.getByText("已重命名模板", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "取消收藏 已重命名模板" }).waitFor();
    await page.getByRole("button", { name: "删除模板 已重命名模板" }).click();
    // The async handler publishes the catalog before removing its UI card.
    // A click acknowledges input delivery, not completion of SQLite persistence.
    await page.getByRole("button", { name: "删除模板 已重命名模板" }).waitFor({ state: "hidden", timeout: 15_000 });
    assert.deepEqual(JSON.parse((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "read_imported_template_catalog"))).payloadJson), []);
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke(
      "bootstrap_template_activity", { legacyJson: "{}" })).length === 0);
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    assert.deepEqual(JSON.parse((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "read_imported_template_catalog"))).payloadJson), [], "deleted catalog stays empty after reloading the actual workspace");
    await page.getByRole("button", { name: "简历编辑" }).click();

    // R15：PDF 导出走统一引擎编译 + 原生保存对话框；文件由宿主写入磁盘。
    phase = "PDF export";
    // 纸面显示的是姓名而非工作区标题；基本信息默认折叠，先展开再填姓名并等待落盘。
    await page.locator("button[aria-label='展开基本信息']").click();
    await page.getByLabel("姓名", { exact: true }).fill("王测试");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    // UI 点击确实进入原生对话框；取消后应用恢复。PDF 字节与写盘另见 test:webview-export。
    await page.getByRole("button", { name: "导出", exact: false }).first().click();
    await page.getByRole("menuitem", { name: /PDF 文档/ }).click();
    await exerciseUiPdfPicker(page, child.pid);
    if (verifyWorkerJobCleanup) {
      let renderWorkerProcessId = await waitForRenderWorkerProcessId(executable);
      assert.ok(renderWorkerProcessId, "UI export must start a hidden render worker");
      if (exerciseWorkerCrashRecovery) {
        const crashedWorkerProcessId = renderWorkerProcessId;
        const workerKiller = spawn("taskkill.exe", ["/PID", String(crashedWorkerProcessId), "/F"], {
          windowsHide: true, stdio: "ignore",
        });
        await new Promise((done) => workerKiller.once("exit", done));
        assert.equal(await waitForProcessExit(crashedWorkerProcessId), true);
        const state = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
        const bundle = await page.evaluate((cursor) =>
          window.__TAURI_INTERNALS__.invoke("render_document_export", { cursor }), state.cursor);
        assert.ok(bundle.data.pdfBase64.length > 2_000, "replacement worker must render the frozen document");
        renderWorkerProcessId = await waitForRenderWorkerProcessId(executable);
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
    const selectedContext = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const state = await invoke("document_state");
      const selected = await invoke("agent_selected_context", {
        expectedCursor: state.cursor, referenceIds: ["basic:name"],
      });
      let rejectedAvatar = false;
      let rejectedStaleCursor = false;
      try {
        await invoke("agent_selected_context", {
          expectedCursor: state.cursor, referenceIds: ["basic:avatar"],
        });
      } catch { rejectedAvatar = true; }
      try {
        await invoke("agent_selected_context", {
          expectedCursor: { ...state.cursor, revision: "0" }, referenceIds: ["basic:name"],
        });
      } catch { rejectedStaleCursor = true; }
      return { selected, rejectedAvatar, rejectedStaleCursor };
    });
    assert.deepEqual(selectedContext.selected.map(({ kind, value }) => [kind, value]), [["basic-field", "王测试"]]);
    assert.equal(JSON.stringify(selectedContext.selected).includes("phone"), false);
    assert.equal(JSON.stringify(selectedContext.selected).includes("avatar"), false);
    assert.equal(selectedContext.rejectedAvatar, false);
    assert.equal(selectedContext.rejectedStaleCursor, true);
    phase = "native model stream";
    if (await page.getByRole("button", { name: "展开聊天" }).count()) {
      await page.getByRole("button", { name: "展开聊天" }).click();
    }
    await page.getByLabel("给 Re:me 助手发送消息").fill("请回复连接状态 ");
    await page.getByLabel("给 Re:me 助手发送消息").pressSequentially("@姓名");
    await page.getByRole("listbox", { name: "选择引用" }).getByRole("option", { name: /姓名/ }).click();
    await page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      window.__agentChatError = null;
      internals.invoke = async (command, args, options) => {
        try {
          return await invoke(command, args, options);
        } catch (error) {
          if (command === "agent_chat") window.__agentChatError = String(error);
          throw error;
        }
      };
    });
    await page.getByRole("button", { name: "发送消息" }).click();
    try {
      await page.locator(".agent-message-assistant").getByText("桌面网关已连接").waitFor({ timeout: 15_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => ({
        agentChatError: window.__agentChatError,
        runs: await window.__TAURI_INTERNALS__.invoke("list_agent_runs"),
        agentAlerts: [...document.querySelectorAll(".agent-inline-error,[role=status]")].map((item) => item.textContent),
      }));
      console.log(`R21 agent diagnostic: ${JSON.stringify(diagnostic)}`);
      throw error;
    }
    assert.equal(modelRequests.length, 4);
    assert.deepEqual(modelRequests.map(({ method, url }) => [method, url]), [
      ["GET", "/v1/models"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/chat/completions"],
    ]);
    assert.ok(modelRequests.every(({ authorization }) => authorization === "Bearer sk-fixture-secret-123456"));
    assert.ok(JSON.parse(modelRequests[2].body).tools?.length === 1);
    const sentAgentRequest = JSON.parse(modelRequests[3].body);
    assert.deepEqual(sentAgentRequest.tools.map(({ function: fn }) => fn.name), [
      "read_selected", "compare_versions", "inspect_template", "local_help", "propose_commands",
    ]);
    assert.equal(sentAgentRequest.messages[0].role, "system");
    assert.ok(sentAgentRequest.messages[0].content.includes("You are the local ZineCV resume assistant."));
    assert.ok(!sentAgentRequest.messages.some(({ content }) => content?.includes("renderer forged system")));
    const sentContext = sentAgentRequest.messages.at(-1).content;
    assert.ok(sentContext.includes('"value":"王测试"'));
    assert.equal(sentContext.includes('"field":"phone"'), false);
    assert.ok(modelRequests[3].body.includes("请回复连接状态"));
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("list_agent_runs"))[0]?.status === "completed");
    const nativeRuns = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"));
    const chatRun = nativeRuns.find(({ status }) => status === "completed");
    assert.ok(chatRun);
    assert.deepEqual(chatRun.referenceIds, ["basic:name"]);
    assert.equal(chatRun.target.documentId, "workspace-default-document");
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
    await page.waitForFunction(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" });
      return state.store.sessions.some((session) => session.messages.some(
        (message) => message.text.includes("待确认建议（尚未应用）")));
    });
    await page.reload({ waitUntil: "commit" });
    await page.locator(".agent-message-assistant").getByText("待确认建议（尚未应用）").waitFor({ timeout: 15_000 });
    const recoveredProposal = page.getByLabel("宿主保存的待审阅提议");
    await recoveredProposal.waitFor({ timeout: 15_000 });
    // 入场动画期间按钮位置不稳定且会被 composer 短暂遮挡；等有限动画收尾后再点。
    await page.evaluate(async () => {
      const finite = document.getAnimations().filter((animation) => animation.effect?.getTiming?.().iterations !== Infinity);
      await Promise.allSettled(finite.map((animation) => animation.finished));
    });
    await recoveredProposal.getByRole("button", { name: "确认所选 1 项" }).click();
    await page.waitForFunction(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("document_state");
      const inbox = await window.__TAURI_INTERNALS__.invoke("list_agent_proposals");
      return state.document.basic.name === "未经确认的新名称" && inbox.undoable.length === 1;
    }, null, { timeout: 15_000 });
    const runsAfterConfirm = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"));
    assert.equal(runsAfterConfirm.find(({ id }) => id === pendingInbox.pending[0].runId)?.lifecycleState, "completed");
    assert.equal(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name), "未经确认的新名称");
    await page.getByRole("button", { name: "撤回这次修改" }).click();
    await page.waitForFunction(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("document_state");
      const inbox = await window.__TAURI_INTERNALS__.invoke("list_agent_proposals");
      return state.document.basic.name === "王测试" && inbox.undoable.length === 0;
    }, null, { timeout: 15_000 });
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs")))[0].status, "completed");
    await page.getByRole("button", { name: "模型设置" }).click();
    await settings.getByRole("button", { name: "退出登录" }).click();
    await settings.getByRole("button", { name: "注册并登录" }).waitFor({ timeout: 15_000 });
    await assert.rejects(page.evaluate(() => window.__TAURI_INTERNALS__.invoke("provider_profile")));
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
    const graphInitial = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const mainBranchId = graphInitial.cursor.branchId;
    const initialHeadId = graphInitial.cursor.headId;
    assert.ok(initialHeadId, "the default branch must begin with its initial commit");
    const mainBranchName = graphInitial.branches.find((branch) => branch.id === mainBranchId)?.name;
    const initialCommit = graphInitial.commits.find((commit) => commit.id === initialHeadId);
    assert.ok(mainBranchName);
    assert.ok(initialCommit);
    const initialName = JSON.parse(initialCommit.snapshotDocumentJson).basic.name;
    await page.getByRole("button", { name: "简历编辑" }).click();
    const expandBasic = page.locator("button[aria-label='展开基本信息']");
    if (await expandBasic.count()) await expandBasic.click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 主线版本");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByLabel("版本说明").fill("R24 主线提交");
    await page.getByRole("button", { name: "提交到当前分支" }).click();
    await page.waitForFunction(async () => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.commits.some((commit) => commit.message === "R24 主线提交");
    }, undefined, { timeout: 20_000 });
    const graphCommitted = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const mainCommit = graphCommitted.commits.find((commit) => commit.message === "R24 主线提交");
    assert.ok(mainCommit);
    assert.equal(mainCommit.parentId, initialHeadId);
    await page.getByLabel("新分支名称").fill("R24 验收支线");
    await page.getByRole("button", { name: "新建分支" }).click();
    await page.waitForFunction(async () => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.branches.some((branch) => branch.name === "R24 验收支线");
    }, undefined, { timeout: 20_000 });
    const graphBranched = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const testBranch = graphBranched.branches.find((branch) => branch.name === "R24 验收支线");
    assert.ok(testBranch);
    assert.notEqual(graphBranched.cursor.branchId, mainBranchId);
    assert.equal(graphBranched.commits.length, graphCommitted.commits.length + 1, "creating a branch also commits its initial snapshot");
    const branchHead = graphBranched.commits.find((commit) => commit.id === testBranch.headCommitId);
    assert.equal(branchHead?.parentId, mainCommit.id);

    // A cancelled dirty branch switch must preserve the branch and current draft.
    await page.getByRole("button", { name: "简历编辑" }).click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 取消切换保留");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByLabel("切换简历分支").click();
    await page.getByRole("option", { name: mainBranchName }).click();
    await page.getByRole("alertdialog").getByRole("heading", { name: /切换到/ }).waitFor();
    await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
    let graphAfterCancel = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    let stateAfterCancel = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(graphAfterCancel.cursor.branchId, testBranch.id);
    assert.equal(stateAfterCancel.document.basic.name, "R24 取消切换保留");

    // Confirm the same switch, then prove loading an older commit changes only the draft.
    await page.getByLabel("切换简历分支").click();
    await page.getByRole("option", { name: mainBranchName }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改并切换" }).click();
    await page.waitForFunction(async (branchId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.cursor.branchId === branchId;
    }, mainBranchId, { timeout: 20_000 });
    const mainHeadBeforeLoad = (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))).cursor.headId;
    await page.locator(`.branch-tree-node[data-version-commit-id="${initialHeadId}"]`).click();
    await page.getByRole("button", { name: "载入", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "载入此版本" }).click();
    await page.waitForFunction(async (expectedName) => {
      const state = await window.__TAURI_INTERNALS__.invoke("document_state");
      return state.document.basic.name === expectedName;
    }, initialName, { timeout: 20_000 });
    const graphAfterHistoryLoad = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.equal(graphAfterHistoryLoad.cursor.headId, mainHeadBeforeLoad, "loading history must not move the branch head");

    // Deleting a commit reconnects its child to the former parent; deleting the
    // branch then keeps that shared ancestor available to the main branch.
    await page.getByRole("button", { name: "简历编辑" }).click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 删除 head 前的草稿");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    const mainCommitNode = page.locator(`.branch-tree-node[data-version-commit-id="${mainCommit.id}"]`);
    await mainCommitNode.click();
    assert.equal(await page.locator(".branch-tree-node.selected").getAttribute("data-version-commit-id"), mainCommit.id);
    assert.equal(await page.locator(".branch-node-detail strong").textContent(), mainCommit.message);
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "删除当前版本" }).click();
    await page.waitForFunction(async (commitId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return !graph.commits.some((commit) => commit.id === commitId);
    }, mainCommit.id, { timeout: 20_000 });
    let graphAfterDeleteCommit = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.ok(graphAfterDeleteCommit.commits.some((commit) => commit.id === initialHeadId));
    const reconnectedBranchHead = graphAfterDeleteCommit.commits.find((commit) => commit.id === branchHead.id);
    assert.equal(reconnectedBranchHead?.parentId, initialHeadId);
    await page.waitForFunction(async expectedName => (await window.__TAURI_INTERNALS__.invoke("document_state"))
      .document.basic.name === expectedName, initialName, { timeout: 15_000 });
    await page.locator(".version-storage-status").getByText("已保存到本机数据库").waitFor({ timeout: 15_000 });
    await page.reload({ waitUntil: "commit" });
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByText("简历版本管理").first().waitFor({ timeout: 15_000 });
    await page.waitForFunction((branchName) =>
      document.querySelector(".branch-toolbar .themed-select-trigger")?.textContent?.includes(branchName) === true,
    mainBranchName, { timeout: 20_000 });
    await page.getByLabel("切换简历分支").click();
    await page.getByRole("option", { name: "R24 验收支线" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改并切换" }).click();
    await page.waitForFunction(async (branchId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.cursor.branchId === branchId;
    }, testBranch.id, { timeout: 20_000 });
    await page.waitForFunction((branchName) =>
      document.querySelector(".branch-toolbar .themed-select-trigger")?.textContent?.includes(branchName) === true,
    "R24 验收支线", { timeout: 20_000 });
    await page.getByRole("button", { name: "删除当前分支" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "删除分支" }).click();
    await page.waitForFunction(async (branchId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return !graph.branches.some((branch) => branch.id === branchId);
    }, testBranch.id, { timeout: 20_000 });
    await page.waitForFunction((branchName) =>
      document.querySelector(".branch-toolbar .themed-select-trigger")?.textContent?.includes(branchName) === true,
    mainBranchName, { timeout: 20_000 });
    const graphAfterDeleteBranch = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.ok(graphAfterDeleteBranch.commits.some((commit) => commit.id === initialHeadId), "shared ancestors must survive branch deletion");
    assert.ok(graphAfterDeleteBranch.branches.some((branch) => branch.id === mainBranchId));
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    const graphAfterVersionRestart = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.deepEqual(
      graphAfterVersionRestart.branches.map((branch) => [branch.id, branch.headCommitId]).sort(),
      graphAfterDeleteBranch.branches.map((branch) => [branch.id, branch.headCommitId]).sort(),
    );
    assert.deepEqual(
      graphAfterVersionRestart.commits.map((commit) => [commit.id, commit.parentId]).sort(),
      graphAfterDeleteBranch.commits.map((commit) => [commit.id, commit.parentId]).sort(),
    );
    await page.getByRole("button", { name: "版本管理" }).first().click();

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
    const sourcePath = join(profile, "synthetic-versions.json");
    const modules = ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"];
    const basic = Object.fromEntries([
      "name", "phone", "email", "city", "wechat", "birth", "website", "linkedin",
      "gender", "height", "weight", "ethnicity", "birthplace", "politicalStatus",
      "maritalStatus", "zodiac", "mbti", "avatar",
    ].map((key) => [key, key === "name" ? "迁移验收合成" : ""]));
    basic.ageMode = "age";
    const legacySnapshot = {
      schemaVersion: 2,
      resumeTitle: "迁移验收合成简历",
      summaryTitle: "自我评价",
      resume: {
        basic,
        ...Object.fromEntries(modules.map((key) => [key, []])),
        summary: "",
      },
      moduleOrder: ["education", "skills", "work", "projects", "orgs", "summary"],
      moduleNames: Object.fromEntries(modules.map((key) => [key, key])),
      presentation: { templateId: "legacy-v1", templateVersion: 1, densityPreset: "standard", overrides: {} },
      layout: {
        font: "宋体", fontSize: "13", lineHeight: "16", moduleSpacing: "8", pageMargin: "30",
        theme: "#000000", dateFormat: "2021年1月", titleFormat: "单行标题",
        separator: "使用分隔符号", textAlign: "两端对齐",
      },
      importedTemplate: null,
    };
    const sourceJson = JSON.stringify({
      currentBranchId: "main",
      branches: [{
        id: "main", name: "R20 合成迁移分支",
        createdAt: "2026-01-01T00:00:00.000Z", headCommitId: "legacy-commit-1",
      }],
      commits: [{
        id: "legacy-commit-1", branchId: "main", parentId: null,
        message: "R20 合成迁移提交", createdAt: "2026-01-01T00:00:00.000Z",
        snapshot: legacySnapshot,
      }],
    });
    await writeFile(sourcePath, sourceJson, "utf8");
    const sourceHashBefore = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const graphBefore = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const documentBefore = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    await page.evaluate(() => {
      window.__migrationNotices = [];
      window.__migrationIpc = [];
      const internals = window.__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke.bind(internals);
      internals.invoke = (command, ...args) => {
        const pending = originalInvoke(command, ...args);
        window.__migrationIpc.push({ command, state: "started" });
        Promise.resolve(pending).then(
          () => window.__migrationIpc.push({ command, state: "resolved" }),
          (error) => window.__migrationIpc.push({ command, state: "rejected", error: String(error?.message ?? error) }),
        );
        return pending;
      };
      new MutationObserver(() => {
        const notice = document.querySelector(".notice-toast")?.textContent?.trim();
        if (notice) window.__migrationNotices.push(notice);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const chooserOpened = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "导入旧版数据" }).click();
      await (await chooserOpened).setFiles(sourcePath);
      const inputDiagnostic = await page.getByLabel("选择旧版浏览器导出数据文件").evaluate((input) => ({
        value: input.value,
        files: Array.from(input.files ?? []).map((file) => ({ name: file.name, size: file.size })),
      }));
      console.log(`Migration input event state: ${JSON.stringify(inputDiagnostic)}`);
      const dialog = page.getByRole("alertdialog");
      try {
        await dialog.getByRole("heading", { name: "审阅并导入旧版数据？" }).waitFor({ timeout: 20_000 });
      } catch (error) {
        const pageText = (await page.locator("body").innerText().catch(() => "unavailable")).slice(-2_000);
        const diagnostics = await page.evaluate(() => ({
          notices: window.__migrationNotices,
          ipc: window.__migrationIpc,
        })).catch(() => ({ notices: [], ipc: [] }));
        throw new Error(`Migration review did not open. Visible page text: ${pageText}; diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error });
      }
      const description = await dialog.locator("#confirm-description").textContent();
      assert.match(description ?? "", /将追加 1 个分支、1 次提交/);
      assert.match(description ?? "", /旧 Key 不迁入，需重新输入/);
      await dialog.getByRole("button", { name: "确认并原子导入" }).click();
      await page.getByText(/旧版迁移已原子提交：新增 1 个分支、1 次提交/).waitFor({ timeout: 20_000 });
    }
    const graphAfter = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const documentAfter = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    const sourceHashAfter = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    assert.equal(graphAfter.branches.length, graphBefore.branches.length + 1);
    assert.equal(graphAfter.commits.length, graphBefore.commits.length + 1);
    assert.ok(graphAfter.commits.some((commit) => commit.message === "R20 合成迁移提交"));
    assert.equal(documentAfter.document.title, documentBefore.document.title, "versions-only import must not replace the current draft");
    assert.equal(sourceHashAfter, sourceHashBefore, "migration must leave original source bytes unchanged");

    assert.ok((await stat(join(profile, "ZineCVData", "zinecv.sqlite3"))).size >= 4096);
    assert.equal(new URL(page.url()).protocol, "http:");

    // R24: extend the fixed graph with an ancestor outside the 1000 snapshot window.
    phase = "R24 1001-commit graph interaction and lazy history detail";
    const graphFixture = JSON.parse(await readFile(resolve(root, "fixtures/remaining/version-graph-1000.json"), "utf8"));
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
    const denseGraphBeforeExport = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.equal(denseGraphBeforeExport.commits.length, 1001);
    assert.equal(denseGraphBeforeExport.cursor.headId, "commit-0999", "history load must not move HEAD");
    await page.getByLabel("附带当前未提交草稿").check();
    const denseBackupDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出版本备份", exact: true }).click();
    const completeDenseBackupPath = join(profile, "r24-version-backup-1001-complete.json");
    await (await denseBackupDownload).saveAs(completeDenseBackupPath);
    const completeDenseBackup = JSON.parse(await readFile(completeDenseBackupPath, "utf8"));
    assert.equal(completeDenseBackup.format, "resume-diy-version-backup");
    assert.equal(completeDenseBackup.store.commits.length, denseGraphBeforeExport.commits.length);
    const nativeMainId = `main:${restoredLazy.document.documentId}`;
    const portableBranchId = id => id === nativeMainId ? "main" : id;
    assert.equal(completeDenseBackup.store.currentBranchId, portableBranchId(denseGraphBeforeExport.cursor.branchId));
    assert.deepEqual(completeDenseBackup.store.branches.map(branch => [branch.id, branch.headCommitId]).sort(),
      denseGraphBeforeExport.branches.map(branch => [portableBranchId(branch.id), branch.headCommitId]).sort());
    assert.deepEqual(completeDenseBackup.store.commits.map(commit =>
      [commit.id, commit.branchId, commit.parentId, commit.message, commit.createdAt]).sort(),
    denseGraphBeforeExport.commits.map(commit =>
      [commit.id, portableBranchId(commit.originBranchId), commit.parentId, commit.message, commit.createdAt]).sort());
    for (const commit of completeDenseBackup.store.commits) {
      assert.ok(commit.snapshot?.resume && commit.snapshot.layout && commit.snapshot.moduleOrder,
        `JSON backup must include a complete snapshot for ${commit.id}`);
    }
    assert.equal(completeDenseBackup.store.commits.find(commit => commit.id === "r24-lazy-ancestor")
      .snapshot.resume.basic.name, "R24 按需历史快照");
    assert.equal(completeDenseBackup.draft.snapshot.resume.basic.name, "R24 按需历史快照",
      "included draft must preserve the loaded history content");
    assert.deepEqual(graphSignature(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))),
      graphSignature(denseGraphBeforeExport), "complete backup must preserve all branch/head/parent relations");

    // Empty graph remains a valid durable state and renders without stale nodes.
    const emptyBackupPath = join(profile, "r24-empty-version-graph.json");
    await writeFile(emptyBackupPath, JSON.stringify({
      format: versionBackup.format,
      formatVersion: versionBackup.formatVersion,
      exportedAt: new Date().toISOString(),
      store: {
        currentBranchId: "main",
        branches: [{ id: "main", name: "main", createdAt: new Date().toISOString(), headCommitId: null }],
        commits: [],
      },
    }), "utf8");
    await page.getByLabel("选择版本备份文件", { exact: true }).setInputFiles(emptyBackupPath);
    await page.getByText("已读取版本备份", { exact: true }).waitFor({ timeout: 15_000 });
    await page.locator(".version-import-preview").getByRole("button", { name: "替换当前版本库" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认替换版本库" }).click();
    await page.getByText("版本库已替换，当前工作内容未自动变更", { exact: true }).waitFor({ timeout: 20_000 });
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.length === 0, null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll(".branch-tree-node").length === 0, null, { timeout: 20_000 });
    assert.equal(await page.locator(".branch-tree-node").count(), 0);
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.length === 0, null, { timeout: 20_000 });
    assert.equal(await page.locator(".branch-tree-node").count(), 0);

    phase = "close flush";
    await page.evaluate(() => {
      window.originalFetch = window.fetch;
      window.fetch = (url, ...args) => String(url).includes("/apply_document_command")
        ? Promise.resolve(new Response("fixture disk write failure", {
          headers: { "Tauri-Response": "error", "Content-Type": "text/plain" },
        })) : window.originalFetch(url, ...args);
    });
    await page.getByRole("button", { name: "简历编辑" }).click();
    await page.locator(".resume-title").click();
    await page.getByLabel("简历名称", { exact: true }).fill("关闭前最后修改");
    await page.getByLabel("简历名称", { exact: true }).press("Tab");
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }));
    await page.locator(".save-state").getByText(/保存失败/).waitFor({ timeout: 15_000 });
    assert.equal(child.exitCode, null, "failed save must keep the desktop window open");
    await page.evaluate(() => { window.fetch = window.originalFetch; });
    if (verifyWorkerJobCleanup) {
      await page.locator(".resume-title").click();
      const retryTitleInput = page.getByLabel("简历名称", { exact: true });
      await retryTitleInput.fill("关闭前最后修改-重试");
      await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
      await retryTitleInput.fill("关闭前最后修改");
      await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    } else {
      const exited = new Promise((done) => child.once("exit", done));
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }));
      await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
      assert.notEqual(child.exitCode, null, "close must finish after flushing the draft");
    }
    const { stdout } = await promisify(execFile)("python", ["-c",
      "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.loads(c.execute('SELECT document_json FROM drafts').fetchone()[0])['title'])",
      join(profile, "ZineCVData", "zinecv.sqlite3")]);
    assert.equal(stdout.trim(), "关闭前最后修改");
    if (verifyWorkerJobCleanup) {
      const exited = new Promise((done) => child.once("exit", done));
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((done) => killer.once("exit", done));
      await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
      assert.notEqual(child.exitCode, null, "simulated host process must terminate");
      assert.equal(await waitForProcessExit(renderWorkerProcessId), true, "Windows job close must reap the worker after abrupt host exit");
      console.log(`R09 host PID=${child.pid} terminated; worker PID=${renderWorkerProcessId} was reaped without taskkill /T`);
    }
  } catch (error) {
    console.error(`WebView failure phase: ${phase}`);
    if (page) {
      console.error(`WebView status at failure: ${await page.locator(".save-state").textContent().catch(() => "unavailable")}`);
    }
    testError = error;
  } finally {
    await new Promise((done) => modelServer.close(done));
    if (peerBrowser) await Promise.race([
      peerBrowser.close(),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    if (peerChild?.exitCode === null) {
      const peerExited = new Promise((done) => peerChild.once("exit", done));
      await new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(peerChild.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
      });
      if (peerChild.exitCode === null) peerChild.kill();
      if (peerChild.exitCode === null) await Promise.race([
        peerExited,
        new Promise((done) => setTimeout(done, 5_000)),
      ]);
    }
    if (browser) await Promise.race([
      browser.close(),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    if (child.exitCode === null) {
      const childExited = new Promise((done) => child.once("exit", done));
      await new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
      });
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null) await Promise.race([
        childExited,
        new Promise((done) => setTimeout(done, 5_000)),
      ]);
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
