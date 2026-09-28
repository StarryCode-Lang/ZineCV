import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
    await page.locator(".resume-title").click();
    const titleInput = page.getByLabel("简历名称", { exact: true });
    await titleInput.waitFor();
    await titleInput.fill("桌面保存测试");
    await titleInput.press("Tab");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });

    // 重启回路：刷新页面重新引导，标题必须从 SQLite 读回。
    await page.reload({ waitUntil: "commit" });
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page
      .locator(".save-state")
      .getByText(/草稿已保存|已从本地数据库恢复|保存失败/)
      .waitFor({ timeout: 20_000 });
    await page.locator(".resume-title").click();
    await page.getByLabel("简历名称", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("简历名称", { exact: true }).inputValue(), "桌面保存测试");

    // 版本面板接真实版本图：初始提交在列表中可见。
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByText("简历版本管理").first().waitFor({ timeout: 15_000 });
    await page.getByText("初始版本").first().waitFor({ timeout: 15_000 });

    assert.ok((await stat(join(profile, "ZineCVData", "zinecv.sqlite3"))).size >= 4096);
    assert.equal(new URL(page.url()).protocol, "http:");
  } catch (error) {
    if (page) {
      console.error(`WebView status at failure: ${await page.locator(".save-state").textContent().catch(() => "unavailable")}`);
    }
    testError = error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      await new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
      });
      if (child.exitCode === null) child.kill();
      await new Promise((done) => child.once("exit", done));
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
