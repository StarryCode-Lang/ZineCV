import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(process.argv[2] ?? "D:/Desktop/ZineCV");
const executable = join(root, "src-tauri", "target", "release", "zinecv-desktop.exe");
const profile = await mkdtemp(join(root, ".artifacts", "probe-"));
const roaming = join(profile, "Roaming");
const local = join(profile, "Local");
await Promise.all([mkdir(roaming), mkdir(local)]);
const server = createServer();
await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
const port = server.address().port;
server.close();
const child = spawn(executable, [], {
  cwd: root, windowsHide: true, stdio: "ignore",
  env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local,
    ZINECV_DATA_DIR: join(profile, "ZineCVData"),
    WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port },
});
let browser;
for (let i = 0; i < 40; i++) {
  if (child.exitCode !== null) { console.log("EXITED", child.exitCode); process.exit(1); }
  try { browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, { timeout: 1000 }); break; }
  catch { await new Promise((d) => setTimeout(d, 250)); }
}
const page = browser.contexts().flatMap((c) => c.pages())[0];
page.on("console", (msg) => console.log("[console]", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
await new Promise((d) => setTimeout(d, 6000));
console.log("URL:", page.url());
console.log("SAVE_STATE:", await page.locator(".save-state").textContent().catch(() => "MISSING"));
console.log("SHELL:", await page.locator(".app-shell").count());
console.log("TITLE_BTN:", await page.locator(".resume-title").textContent().catch(() => "MISSING"));
console.log("LOCALSTORAGE_KEYS:", await page.evaluate(() => Object.keys(localStorage).length));
await browser.close().catch(() => {});
spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
await new Promise((d) => setTimeout(d, 1500));
process.exit(0);
