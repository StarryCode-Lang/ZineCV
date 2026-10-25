// updater 负面路径 e2e（F2 新增；显式运行，A 需已安装并由调用方传入路径）。
//
// 覆盖 G1 A→B 闭环未包含的场景：
//   S1 同版本清单 → 不提供更新（upToDate）
//   S2 降级清单   → 不提供更新（upToDate）
//   S3 无效签名   → 检查失败回 Idle，错误可见且无下载入口
//   S4 篡改载荷   → 下载期验签失败，错误可见且无"安装并重启"
//   S7 版本绑定不符的有效签名（requireSignedVersion）→ 下载期拒绝：
//        被攻破的更新源无法把旧工件的有效签名与虚假高版本号配对降级用户
//   S5 取消下载   → 传输中取消回 available，可重新下载至 readyToInstall
//   S6 数据保留   → A 内写入的 localStorage 标记在自动重启后的 B 中原样可读，
//                    且安装目录 exe 版本推进到目标版本
// 成功判定与主闭环一致：安装器启动不视为成功，以重启后的 B 版本与数据为准。
// requireSignedVersion 开启后：--signature 必须是 `tauri signer sign
// --app-version <target-version>` 的产物；--wrong-version-signature 是对同一
// 载荷签给别的版本的有效签名（S7 用）。
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createUpdaterHarness, installedExecutable, readProductVersion, writePersistenceMarker, assertPersistenceMarker } from "./updater-e2e.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};
const installDir = flag("install-dir");
const payloadPath = flag("payload");
const signaturePath = flag("signature");
const wrongVersionSignaturePath = flag("wrong-version-signature");
const pubkeyPath = flag("pubkey");
const endpointDir = flag("endpoint-dir");
const targetVersion = flag("target-version") ?? "2.0.0-alpha.2";
const sameVersion = flag("same-version") ?? "2.0.0-alpha.1";
const downgradeVersion = flag("downgrade-version") ?? "2.0.0-alpha.0";

for (const [name, value] of Object.entries({ installDir, payloadPath, signaturePath, pubkeyPath, endpointDir })) {
  if (!value) {
    console.error(`usage: node tools/updater-negative-e2e.mjs --install-dir <a-install-dir> --payload <b-setup.exe> --signature <b.sig> --pubkey <pubkey> --endpoint-dir <dir>`);
    console.error(`missing --${name}`);
    process.exit(2);
  }
}

const payloadBytes = await readFile(payloadPath);
const goodSignature = (await readFile(signaturePath, "utf8")).trim();
const pubkey = (await readFile(pubkeyPath, "utf8")).trim();
// S7 需要对同一载荷"签给错误版本"的有效签名；未提供时 S7 如实记 SKIP。
const wrongVersionSignature = wrongVersionSignaturePath
  ? (await readFile(wrongVersionSignaturePath, "utf8")).trim()
  : null;

const state = { results: {}, failures: [] };
const note = (key, value) => {
  state.results[key] = value;
  console.log(`[neg-e2e] ${key} = ${JSON.stringify(value)}`);
};
const assert = (key, condition, detail) => {
  note(key, condition ? "PASS" : `FAIL ${detail ?? ""}`);
  if (!condition) state.failures.push(key);
};

// ---- 动态清单/载荷服务器 ----
// manifest 由各场景运行时改写；payloadMode 决定载荷端点行为。
let manifest = { version: sameVersion, notes: "", pub_date: new Date().toISOString(), platforms: { "windows-x86_64": { signature: goodSignature, url: "" } } };
let payloadMode = "good"; // good | tampered | slow
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (url.pathname === "/latest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname === "/payload.exe") {
      if (payloadMode === "tampered") {
        const bytes = payloadBytes.subarray(0, Math.min(payloadBytes.length, 1_048_576));
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
        response.end(bytes);
        return;
      }
      if (payloadMode === "slow") {
        const chunkSize = 131_072;
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payloadBytes.length) });
        for (let offset = 0; offset < payloadBytes.length; offset += chunkSize) {
          if (response.destroyed) return;
          response.write(payloadBytes.subarray(offset, Math.min(payloadBytes.length, offset + chunkSize)));
          await delay(200);
        }
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payloadBytes.length) });
      response.end(payloadBytes);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  } catch (error) {
    if (!response.destroyed) {
      response.writeHead(500);
      response.end(String(error));
    }
  }
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const port = server.address().port;
manifest.platforms["windows-x86_64"].url = `http://127.0.0.1:${port}/payload.exe`;
const setManifest = (version, signature, urlPath) => {
  manifest = {
    version,
    notes: `负面路径场景清单 ${version}（不可信输入渲染检查：<img src=x onerror=alert(1)>）`,
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { signature, url: `http://127.0.0.1:${port}${urlPath}` } },
  };
};
await writeFile(join(endpointDir, "updater-negative-manifest.json"), JSON.stringify(manifest, null, 2));
note("manifestPort", port);

let harness;
try {
  harness = await createUpdaterHarness({ installDir, expectedVersion: sameVersion,
    endpoint: `http://127.0.0.1:${port}/latest.json`, pubkey });
  const page = harness.page;
  const panel = page.locator(".update-menu");
  const openPanel = async () => {
    await page.locator("button.update-trigger").click();
    await panel.waitFor({ state: "visible", timeout: 10_000 });
  };
  const clickCheck = async () => {
    await panel.getByRole("button", { name: /检查更新/ }).click();
  };
  const statusText = () => panel.locator(".update-status-line").first().textContent().catch(() => null);
  const hasDownloadButton = () =>
    panel
      .getByRole("button", { name: /^下载 / })
      .count()
      .then((count) => count > 0);
  const hasInstallButton = () =>
    panel
      .getByRole("button", { name: "安装并重启" })
      .count()
      .then((count) => count > 0);

  // Both a real native document and localStorage must survive the upgrade.
  const marker = await writePersistenceMarker(page);
  note("markerWritten", true);
  await openPanel();

  // S1 同版本 → upToDate
  setManifest(sameVersion, goodSignature, "/payload.exe");
  await clickCheck();
  await delay(1500);
  assert("s1SameVersionUpToDate", (await statusText())?.includes("已是最新版本"), `status=${await statusText()}`);

  // S2 降级 → upToDate
  setManifest(downgradeVersion, goodSignature, "/payload.exe");
  await clickCheck();
  await delay(1500);
  assert("s2DowngradeRefused", (await statusText())?.includes("已是最新版本"), `status=${await statusText()}`);

  // S3 无效签名 → 签名验证发生在下载期（插件 check 不验签）：检查呈现
  // 可用更新，点下载时验签失败拒绝，且不进入可安装状态
  setManifest("9.9.9", "INVALID: not a minisign signature", "/payload.exe");
  await clickCheck();
  await panel.getByRole("button", { name: /^下载 / }).waitFor({ timeout: 30_000 });
  await panel.getByRole("button", { name: /^下载 / }).click();
  await panel.locator(".update-error").waitFor({ timeout: 60_000 });
  assert("s3BadSignatureDownloadRejected", true);
  assert("s3NoInstallEntry", !(await hasInstallButton()));

  // S4 篡改载荷（真签名对篡改字节）→ 下载期验签失败
  // Keep the correctly signed version so rejection proves payload integrity,
  // rather than being explained by an unrelated signed-version mismatch.
  setManifest(targetVersion, goodSignature, "/payload.exe");
  payloadMode = "tampered";
  await clickCheck();
  await panel.getByRole("button", { name: /^下载 / }).click();
  await panel.locator(".update-error").waitFor({ timeout: 60_000 });
  assert("s4TamperedPayloadRejected", true);
  assert("s4NoInstallEntry", !(await hasInstallButton()));
  payloadMode = "good";

  // S7 版本绑定不符的有效签名 → requireSignedVersion 在下载期拒绝：
  // 签名本身有效（对真实载荷字节），但 trusted comment 里的版本与清单
  // 版本不一致，说明清单被配对了另一个版本号。未启用该策略或未提供
  // 错误版本签名时如实 SKIP（不能拿无效签名冒充本场景）。
  if (wrongVersionSignature) {
    setManifest("9.9.9", wrongVersionSignature, "/payload.exe");
    await clickCheck();
    await panel.getByRole("button", { name: /^下载 / }).click();
    await panel.locator(".update-error").waitFor({ timeout: 60_000 });
    assert("s7SignedVersionMismatchRejected", true);
    assert("s7NoInstallEntry", !(await hasInstallButton()));
  } else {
    note("s7SignedVersionMismatchRejected", "SKIP no --wrong-version-signature");
  }

  // S5 慢速传输中取消 → 回到 available；重新下载至 readyToInstall
  setManifest(targetVersion, goodSignature, "/payload.exe");
  payloadMode = "slow";
  await clickCheck();
  await panel.getByRole("button", { name: /^下载 / }).click();
  await panel.getByRole("button", { name: "取消下载" }).waitFor({ timeout: 30_000 });
  await delay(1200);
  await panel.getByRole("button", { name: "取消下载" }).click();
  await panel.getByRole("button", { name: /^下载 / }).waitFor({ timeout: 30_000 });
  assert("s5CancelReturnsToAvailable", true);
  payloadMode = "good";
  await panel.getByRole("button", { name: /^下载 / }).click();
  await panel.getByRole("button", { name: "安装并重启" }).waitFor({ timeout: 240_000 });
  assert("s5RedownloadCompletes", true);

  // S6 安装 → A 确实退出 → 新 B 进程与实际版本 → 原生文档和标记保留。
  await panel.getByRole("button", { name: "安装并重启" }).click();
  const bPage = await harness.restarted(targetVersion);
  assert("aExited", true);
  assert("s6InstalledProductVersion", await readProductVersion(installedExecutable(resolve(installDir))) === targetVersion);
  await assertPersistenceMarker(bPage, marker);
  assert("s6DataPreservedAfterUpgrade", true);
  assert("s6NativeDocumentPreservedAfterUpgrade", true);
} catch (error) {
  note("error", String(error));
  state.failures.push("unhandled");
} finally {
  try { await harness?.cleanup(); note("cleanupVerified", true); }
  catch (error) { note("cleanupError", String(error)); state.failures.push("cleanup"); }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  const reportPath = resolve(endpointDir, "updater-negative-e2e-result.json");
  await writeFile(
    reportPath,
    JSON.stringify({ results: state.results, failures: state.failures, date: new Date().toISOString() }, null, 2),
  );
  console.log(`[neg-e2e] report written: ${reportPath}`);
  process.exitCode = state.failures.length ? 1 : 0;
}
