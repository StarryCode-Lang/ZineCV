import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const executable = join(root, "src-tauri", "target", "release", "zinecv-desktop.exe");
const artifactRoot = join(root, ".artifacts", "webview-e2e");

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((done) => server.close(done));
  return address.port;
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
    if (payload.tools?.length) {
      const nonce = payload.tools[0].function.parameters.properties.nonce.enum[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
        id: "call-fixture", type: "function", function: {
          name: "zinecv_capability_probe", arguments: JSON.stringify({ nonce }),
        },
      }] } }] }));
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
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  let browser;
  let page;
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
    const pages = browser.contexts().flatMap((context) => context.pages());
    page = pages[0];
    assert.ok(page, "Expected a WebView2 page");
    await page.waitForURL(/tauri\.localhost/, { timeout: 15_000 });
    // React 工作区按旧版结构渲染，引导完成后从 SQLite 恢复并完成首轮草稿同步。
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page
      .locator(".save-state")
      .getByText(/草稿已保存|已从本地数据库恢复|保存失败/)
      .waitFor({ timeout: 20_000 });

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

    // B07：PDF 导出走 Typst 引擎；下载产物必须是含可提取中文文本的矢量 PDF。
    phase = "PDF export";
    // 纸面显示的是姓名而非工作区标题；基本信息默认折叠，先展开再填姓名并等待落盘。
    await page.locator("button[aria-label='展开基本信息']").click();
    await page.getByLabel("姓名", { exact: true }).fill("王测试");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "导出", exact: false }).first().click();
    const pdfDownload = page.waitForEvent("download", { timeout: 30_000 });
    await page.getByRole("menuitem", { name: /PDF 文档/ }).click();
    const download = await pdfDownload;
    const pdfPath = join(profile, "export.pdf");
    await download.saveAs(pdfPath);
    const bytes = await stat(pdfPath);
    assert.ok(bytes.size > 2_000, "exported PDF is too small");
    const pdfHeader = Buffer.from(
      await import("node:fs/promises").then((fs) => fs.readFile(pdfPath)),
    ).subarray(0, 5).toString();
    assert.equal(pdfHeader, "%PDF-", "exported file is not a PDF");
    const extracted = await new Promise((done) => {
      const checker = spawn("python", [
        "-c",
        "import sys, fitz; doc=fitz.open(sys.argv[1]); text=''.join(p.get_text() for p in doc); print(text)",
        pdfPath,
      ], { windowsHide: true });
      let out = "";
      checker.stdout.on("data", (chunk) => { out += chunk; });
      checker.once("exit", () => done(out));
      checker.once("error", () => done(""));
    });
    if (extracted) {
      assert.ok(extracted.includes("王测试"), "PDF text layer misses the basic name");
      assert.ok(extracted.includes("自我评价"), "PDF text layer misses section heading");
    } else {
      console.log("PyMuPDF unavailable; PDF text extraction check skipped (header/size checks still applied)");
    }

    // B11：同一原生窗口的账户、DPAPI 密钥和公开配置读回；UI 不读取明文 Key。
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
    await settings.getByText("连接已加密保存到此账户：可聊天，工具调用尚未开放").waitFor({ timeout: 15_000 });
    await settings.getByRole("button", { name: "检测连接并获取模型" }).click();
    await settings.getByText(/服务返回 1 个模型/).waitFor({ timeout: 15_000 });
    await settings.getByRole("button", { name: "测试连接" }).click();
    await settings.getByText(/结构化工具响应通过（fixture-model）/).waitFor({ timeout: 15_000 });
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
    assert.equal(await settings.getByLabel("连接名称", { exact: true }).inputValue(), "隔离测试连接");
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("provider_profile"))).capability, "structured");
    await settings.getByRole("button", { name: "关闭模型设置" }).click();
    phase = "native model stream";
    await page.getByLabel("给 Re:me 助手发送消息").fill("请回复连接状态");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.locator(".agent-message-assistant").getByText("桌面网关已连接").waitFor({ timeout: 15_000 });
    assert.equal(modelRequests.length, 4);
    assert.deepEqual(modelRequests.map(({ method, url }) => [method, url]), [
      ["GET", "/v1/models"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/chat/completions"],
    ]);
    assert.ok(modelRequests.every(({ authorization }) => authorization === "Bearer sk-fixture-secret-123456"));
    assert.ok(JSON.parse(modelRequests[2].body).tools?.length === 1);
    assert.ok(modelRequests[3].body.includes("请回复连接状态"));
    await page.getByRole("button", { name: "模型设置" }).click();
    await settings.getByRole("button", { name: "退出登录" }).click();
    await settings.getByRole("button", { name: "注册并登录" }).waitFor({ timeout: 15_000 });
    await assert.rejects(page.evaluate(() => window.__TAURI_INTERNALS__.invoke("provider_profile")));
    await settings.getByRole("button", { name: "关闭模型设置" }).click();

    // 版本面板接真实版本图：初始提交在列表中可见。
    phase = "version panel";
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByText("简历版本管理").first().waitFor({ timeout: 15_000 });
    await page.getByText("初始版本").first().waitFor({ timeout: 15_000 });

    assert.ok((await stat(join(profile, "ZineCVData", "zinecv.sqlite3"))).size >= 4096);
    assert.equal(new URL(page.url()).protocol, "http:");
  } catch (error) {
    console.error(`WebView failure phase: ${phase}`);
    if (page) {
      console.error(`WebView status at failure: ${await page.locator(".save-state").textContent().catch(() => "unavailable")}`);
    }
    testError = error;
  } finally {
    await new Promise((done) => modelServer.close(done));
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
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (cleanupError) {
      if (!testError) testError = cleanupError;
      else console.error(`Isolated profile cleanup also failed: ${cleanupError}`);
    }
  }
  if (testError) throw testError;
});
