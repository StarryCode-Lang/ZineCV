// Real updater integration test. --remote-manifest-url verifies the compiled
// production source without injecting updater overrides or running HTTP locally.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
export function parseFlags(args = process.argv.slice(2)) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.match(args[index], /^--[a-z-]+$/, "Expected a named argument");
    assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `Missing value for ${args[index]}`);
    flags[args[index].slice(2)] = args[index + 1];
  }
  return flags;
}
export function runExecutable(executable, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    child.stdout?.on("data", bytes => { stdout += bytes; });
    child.stderr?.on("data", bytes => { stderr += bytes; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? done(stdout.trim()) : reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`)));
  });
}
export const runPowerShell = command => runExecutable("powershell.exe", ["-NoProfile", "-Command", `$ErrorActionPreference='Stop'; ${command}`]);
export async function waitForValue(read, predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)}`);
}
export const installedExecutable = directory => ["zinecv-desktop.exe", "ZineCV UpdTest.exe"].map(name => join(directory, name)).find(existsSync);
export const readProductVersion = executable => runPowerShell(`(Get-Item -LiteralPath ${literal(executable)}).VersionInfo.ProductVersion`);

async function installProcesses(installDir) {
  const paths = ["zinecv-desktop.exe", "ZineCV UpdTest.exe"].map(name => literal(join(installDir, name))).join(",");
  const text = await runPowerShell(`@((Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -in @(${paths}) }) | Select-Object ProcessId,ParentProcessId,@{n='StartedAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`);
  const value = text ? JSON.parse(text) : [];
  return Array.isArray(value) ? value : [value];
}
async function freePort() {
  const server = createPortServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function connectPage(port, isAlive) {
  const deadline = Date.now() + 60_000;
  let browser;
  while (Date.now() < deadline) {
    assert.ok(await isAlive(), "The expected app process exited before CDP initialization");
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; }
    catch { await delay(100); }
  }
  assert.ok(browser, "Expected app did not expose its isolated CDP port");
  try {
    const page = await waitForValue(async () => browser.contexts().flatMap(context => context.pages())[0], Boolean, 20_000, "app page");
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}
async function productionRegistrations() {
  const text = await runPowerShell(`@((Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'ZineCV' }) | Select-Object PSChildName,InstallLocation,UninstallString) | ConvertTo-Json -Compress`);
  const value = text ? JSON.parse(text) : [];
  return Array.isArray(value) ? value : [value];
}
// Opt-in bootstrap refuses existing registrations and shortcuts rather than
// overwriting a real installation. The owned installation is uninstalled finally.
async function bootstrapInstaller(installer, installDir, expectedVersion, markOwned) {
  assert.ok(!installedExecutable(installDir), "Bootstrap requires an empty isolated installation directory");
  assert.equal((await productionRegistrations()).length, 0, "A production ZineCV registration already exists; bootstrap refuses to overwrite it");
  const folders = JSON.parse(await runPowerShell(`@{desktop=[Environment]::GetFolderPath('Desktop');programs=[Environment]::GetFolderPath('Programs')} | ConvertTo-Json -Compress`));
  const shortcuts = [join(folders.desktop, "ZineCV.lnk"), join(folders.programs, "ZineCV.lnk"), join(folders.programs, "ZineCV", "ZineCV.lnk")];
  assert.ok(shortcuts.every(path => !existsSync(path)), "An existing production shortcut must not be overwritten");
  await mkdir(installDir, { recursive: true });
  markOwned({ shortcuts });
  await runExecutable(resolve(installer), ["/S", `/D=${installDir}`]);
  const executable = installedExecutable(installDir);
  assert.ok(executable, "Bootstrap installer did not install into the requested directory");
  assert.equal(await readProductVersion(executable), expectedVersion, "Bootstrap installed the wrong A version");
}

export async function createUpdaterHarness({ installDir, expectedVersion, endpoint, pubkey, remote = false, bootstrap }) {
  installDir = resolve(installDir);
  const owned = { bootstrap: null, child: null, browsers: [], profile: null, startedAt: Date.now(), spawnError: null };
  const cleanup = async () => {
    for (const browser of owned.browsers) await browser.close().catch(() => {});
    if (owned.child) {
      const ownProcesses = (await installProcesses(installDir)).filter(process => Date.parse(process.StartedAt) >= owned.startedAt - 1000);
      for (const process of ownProcesses) await runExecutable("taskkill.exe", ["/PID", String(process.ProcessId), "/T", "/F"]).catch(async error => {
        if ((await installProcesses(installDir)).some(item => item.ProcessId === process.ProcessId)) throw error;
      });
      assert.equal((await installProcesses(installDir)).filter(process => Date.parse(process.StartedAt) >= owned.startedAt - 1000).length, 0, "Owned app processes survived cleanup");
    }
    if (owned.bootstrap) {
      const uninstaller = join(installDir, "uninstall.exe");
      assert.ok(existsSync(uninstaller), "Isolated installation uninstaller is missing; preserve installation for inspection");
      await runExecutable(uninstaller, ["/S", `_?=${installDir}`]);
      assert.ok(!installedExecutable(installDir), "Isolated app executable survived uninstall");
      for (const shortcut of owned.bootstrap.shortcuts) if (existsSync(shortcut)) await unlink(shortcut);
      assert.equal((await productionRegistrations()).length, 0, "Isolated production registration survived uninstall");
    }
    if (owned.profile) {
      const path = resolve(owned.profile), relativePath = relative(resolve(tmpdir()), path);
      assert.ok(relativePath && !relativePath.startsWith("..") && path.startsWith(resolve(tmpdir()) + sep), "Unexpected isolated profile cleanup path");
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  };
  try {
    assert.equal((await installProcesses(installDir)).length, 0, "An app already runs from install-dir; ownership is ambiguous");
    if (bootstrap) await bootstrapInstaller(bootstrap, installDir, expectedVersion, value => { owned.bootstrap = value; });
    const executable = installedExecutable(installDir);
    assert.ok(executable, "A executable is missing from install-dir");
    assert.equal(await readProductVersion(executable), expectedVersion, "A identity differs from --from-version");
    owned.profile = await mkdtemp(join(tmpdir(), "zinecv-updater-e2e-"));
    const port = await freePort();
    const environment = { ...process.env, APPDATA: join(owned.profile, "Roaming"), LOCALAPPDATA: join(owned.profile, "Local"),
      ZINECV_DATA_DIR: join(owned.profile, "Data"), WEBVIEW2_USER_DATA_FOLDER: join(owned.profile, "WebView2"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling` };
    delete environment.ZINECV_UPDATER_ENDPOINT;
    delete environment.ZINECV_UPDATER_PUBKEY;
    if (!remote) Object.assign(environment, { ZINECV_UPDATER_ENDPOINT: endpoint, ZINECV_UPDATER_PUBKEY: pubkey });
    owned.startedAt = Date.now();
    owned.child = spawn(executable, ["--updater-e2e"], { cwd: installDir, env: environment, windowsHide: true, stdio: "ignore" });
    owned.child.once("error", error => { owned.spawnError = error; });
    const connection = await connectPage(port, async () => !owned.spawnError && owned.child.exitCode === null && owned.child.signalCode === null);
    owned.browsers.push(connection.browser);
    return { page: connection.page, executable, profile: owned.profile, port, child: owned.child, cleanup,
      async restarted(targetVersion) {
        await waitForValue(async () => owned.child.exitCode !== null || owned.child.signalCode !== null, Boolean, 60_000, "A exit");
        await waitForValue(async () => {
          const current = installedExecutable(installDir);
          return current ? { version: await readProductVersion(current), processes: await installProcesses(installDir) } : null;
        }, value => value?.version === targetVersion && value.processes.some(process => process.ProcessId !== owned.child.pid && Date.parse(process.StartedAt) >= owned.startedAt), 80_000, "new B executable and restarted process");
        const restarted = await connectPage(port, async () => (await installProcesses(installDir)).some(process => process.ProcessId !== owned.child.pid && Date.parse(process.StartedAt) >= owned.startedAt));
        owned.browsers.push(restarted.browser);
        return restarted.page;
      } };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Updater initialization and cleanup failed"); }
    throw error;
  }
}
export async function writePersistenceMarker(page) {
  const name = `合成更新验证-${randomUUID().slice(0, 12)}`;
  const expand = page.getByRole("button", { name: "展开基本信息", exact: true });
  if (await expand.count()) await expand.click();
  await page.getByLabel("姓名", { exact: true }).fill(name);
  await page.getByLabel("姓名", { exact: true }).press("Tab");
  await page.waitForFunction(async name => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name === name, name, { timeout: 20_000 });
  await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 20_000 });
  const document = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state")).then(state => state.document);
  const storage = { key: "zinecv-updater-persistence-marker", value: randomUUID() };
  await page.evaluate(marker => localStorage.setItem(marker.key, marker.value), storage);
  return { document, storage };
}
export async function assertPersistenceMarker(page, marker) {
  assert.equal(await page.evaluate(marker => localStorage.getItem(marker.key), marker.storage), marker.storage.value, "localStorage marker did not survive update");
  assert.deepEqual(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state")).then(state => state.document), marker.document, "Native business document changed across update");
}

export async function runUpdaterE2e(flags = parseFlags()) {
  for (const name of ["endpoint-dir", "payload", "signature", "version", "install-dir", "from-version"]) assert.ok(flags[name], `Missing --${name}`);
  const targetVersion = flags["target-version"] ?? flags.version;
  assert.equal(targetVersion, flags.version, "A successful test must announce the expected B version");
  assert.notEqual(flags["from-version"], targetVersion, "A and B must differ");
  const remote = flags["remote-manifest-url"];
  if (!remote) assert.ok(flags.pubkey, "Local updater test requires --pubkey");
  await mkdir(resolve(flags["endpoint-dir"]), { recursive: true });
  const payload = await readFile(flags.payload), signature = (await readFile(flags.signature, "utf8")).trim();
  const results = {}, failures = [];
  let server, harness;
  const note = (key, value) => { results[key] = value; console.log(`[e2e] ${key} = ${JSON.stringify(value)}`); };
  try {
    let endpoint;
    if (remote) {
      assert.equal(new URL(remote).protocol, "https:", "Production manifest must use HTTPS");
      const response = await fetch(remote, { signal: AbortSignal.timeout(60_000), cache: "no-store" });
      assert.ok(response.ok, `Production manifest HTTP ${response.status}`);
      assert.equal(new URL(response.url).protocol, "https:");
      const manifest = await response.json(), platform = manifest.platforms?.["windows-x86_64"];
      assert.equal(manifest.version, targetVersion, "Online manifest version differs from B");
      assert.equal(platform?.signature?.trim(), signature, "Online signature differs from local signed B");
      assert.equal(new URL(platform.url).protocol, "https:");
      const download = await fetch(platform.url, { signal: AbortSignal.timeout(240_000), cache: "no-store" });
      assert.ok(download.ok, `Production payload HTTP ${download.status}`);
      assert.equal(new URL(download.url).protocol, "https:");
      assert.equal(sha256(Buffer.from(await download.arrayBuffer())), sha256(payload), "Online payload differs from signed local B");
      note("productionSource", { endpoint: remote, payloadUrl: platform.url, sha256: sha256(payload), runtimeOverrides: false });
    } else {
      const manifest = { version: targetVersion, notes: "更新说明 <img src=x onerror=alert(1)>", pub_date: new Date().toISOString(), platforms: { "windows-x86_64": { signature, url: "" } } };
      server = createServer((request, response) => {
        if (request.url === "/latest.json") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
        else if (request.url === "/payload.exe") response.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length }).end(payload);
        else response.writeHead(404).end();
      });
      await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
      manifest.platforms["windows-x86_64"].url = `http://127.0.0.1:${server.address().port}/payload.exe`;
      endpoint = `http://127.0.0.1:${server.address().port}/latest.json`;
      await writeFile(join(flags["endpoint-dir"], "latest.json"), JSON.stringify(manifest, null, 2));
    }
    harness = await createUpdaterHarness({ installDir: flags["install-dir"], expectedVersion: flags["from-version"], endpoint,
      pubkey: flags.pubkey ? (await readFile(flags.pubkey, "utf8")).trim() : null, remote: Boolean(remote), bootstrap: flags["bootstrap-installer"] });
    note("aLaunched", true);
    const marker = await writePersistenceMarker(harness.page);
    note("nativeDocumentMarkerWritten", true);
    const panel = harness.page.locator(".update-menu");
    await harness.page.locator("button.update-trigger").click();
    await panel.waitFor({ timeout: 10_000 });
    assert.equal((await panel.locator(".download-menu-heading span").first().textContent())?.trim(), `当前版本 ${flags["from-version"]}`);
    note("versionA", flags["from-version"]);
    await panel.getByRole("button", { name: /检查更新/ }).click();
    await panel.locator(".update-target").waitFor({ timeout: 30_000 });
    assert.equal((await panel.locator(".update-target strong").first().textContent())?.trim(), `新版本 ${targetVersion}`);
    note("targetAnnounced", targetVersion);
    assert.equal(await panel.locator(".update-notes img").count(), 0, "Release notes must not parse untrusted markup");
    if (!remote) assert.ok((await panel.locator(".update-notes").textContent()).includes("<img"), "Test notes must remain visible as text");
    note("notesNotParsedAsHtml", true);
    await panel.getByRole("button", { name: /^下载 / }).click();
    await panel.getByRole("button", { name: "安装并重启" }).waitFor({ timeout: 240_000 });
    note("downloaded", true);
    await panel.getByRole("button", { name: "安装并重启" }).click();
    note("installRequested", true);
    const bPage = await harness.restarted(targetVersion);
    note("aExited", true);
    note("installedProductVersion", await readProductVersion(installedExecutable(resolve(flags["install-dir"]))));
    await assertPersistenceMarker(bPage, marker);
    note("nativeDocumentAndLocalStoragePreserved", true);
    note("bRelaunched", true);
  } catch (error) { failures.push(String(error.stack ?? error)); }
  finally {
    try { await harness?.cleanup(); note("cleanupVerified", true); } catch (error) { failures.push(`cleanup: ${error.stack ?? error}`); }
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await writeFile(join(flags["endpoint-dir"], "updater-e2e-result.json"), JSON.stringify({ results, failures, date: new Date().toISOString() }, null, 2));
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runUpdaterE2e().catch(error => { console.error(error); process.exitCode = 1; });
