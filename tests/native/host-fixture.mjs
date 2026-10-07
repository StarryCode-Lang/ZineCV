import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { installAsyncWait, waitForFirstPage } from "./async-wait.mjs";

const root = resolve(import.meta.dirname, "../..");
export async function startNativeHost(profile, { dataDir = join(profile, "Data"), buildProfile = "release", executable = join(root, "src-tauri/target", buildProfile, "zinecv-desktop.exe"), env = {} } = {}) {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const child = spawn(executable, [], {
    cwd: root, windowsHide: true, stdio: "ignore", env: { ...process.env,
      ...env,
      APPDATA: join(profile, "Roaming"), LOCALAPPDATA: join(profile, "Local"), ZINECV_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
      // 同 webview.test.mjs：遮挡节流会让依赖 rAF 的 flush 在后台窗口中挂起。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
    },
  });
  let browser;
  try {
    // Keep the previous worst-case startup allowance (80 * (500 + 250) ms),
    // but retry promptly when CDP becomes ready instead of always idling 250 ms.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      assertAlive(child);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; }
      catch { await new Promise((done) => setTimeout(done, Math.min(100, Math.max(0, deadline - Date.now())))); }
    }
    if (!browser) throw new Error("Real WebView2 host did not expose CDP");
    const page = await waitForFirstPage(browser, {
      isAlive: () => child.exitCode === null && child.signalCode === null,
    });
    installAsyncWait(page);
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    return { child, browser, page };
  } catch (error) { await browser?.close(); if (child.exitCode === null && !child.signalCode) child.kill(); throw error; }
}
function assertAlive(child) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native host exited before initialization");
}
export async function stopNativeHost(host) {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    const exited = new Promise((done) => host.child.once("exit", done));
    host.child.kill();
    await exited;
  }
  await host.browser.close();
}
