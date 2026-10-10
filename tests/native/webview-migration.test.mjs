import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { chromium } from "playwright";
import { installAsyncWait, waitForFirstPage } from "./async-wait.mjs";
import { DatabaseSync } from "node:sqlite";
import { installIpcInterceptor } from "./ipc-interceptor.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = join(root, ".artifacts/remaining/R20/session3-identity");
const phase = process.env.ZINECV_TEST_MIGRATION_PHASE;
if (phase) assert.ok(["before-commit", "after-commit"].includes(phase));
const exe = join(root, phase ? "src-tauri/target/hooks/zinecv-desktop.exe" : "src-tauri/target/release/zinecv-desktop.exe");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM90AAAAASUVORK5CYII=";
const avatarBytes = Buffer.from(avatar.split(',')[1], 'base64');
const avatarHash = hash(avatarBytes);

async function launch(profile, extraEnv = {}) {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const child = spawn(exe, [], { cwd: root, windowsHide: true, stdio: "ignore", env: {
    ...process.env, ...extraEnv, APPDATA: join(profile, "Roaming"), LOCALAPPDATA: join(profile, "Local"),
    ZINECV_DATA_DIR: join(profile, "Data"), WEBVIEW2_USER_DATA_FOLDER: join(profile, "WebView2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  } });
  let browser;
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      assert.equal(child.exitCode, null);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; }
      catch { await sleep(250); }
    }
    assert.ok(browser);
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

async function close(host) {
  await host.browser.close();
  if (host.child.exitCode === null && host.child.signalCode === null) {
    const exited = new Promise((done) => host.child.once("exit", done));
    host.child.kill();
    await exited;
  }
  assert.ok(host.child.exitCode !== null || host.child.signalCode !== null);
}

test(`reviewed browser identity import survives real host restart${phase ? ` killed ${phase}` : ""}`, { timeout: 100_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(resolve(evidenceRoot) + sep));
  const salt = "synthetic-migration-salt";
  const account = { id: "webview-migration-account", email: "webview-migration@example.com", salt,
    passwordHash: scryptSync("fixture-password", salt, 64).toString("hex"),
    provider: { name: "Synthetic provider", baseUrl: "https://example.com", model: "synthetic-model", apiKey: "synthetic-legacy-secret" } };
  const entries = [
    ["resume-diy-agent-accounts", JSON.stringify({ version: 1, accounts: [account], sessions: [{ tokenHash: "excluded-synthetic-token" }] })],
    [`resume-diy-agent-sessions-v2:${account.id}`, JSON.stringify({ activeId: "fixture-chat", sessions: [{
      id: "fixture-chat", title: "迁移合成会话", createdAt: 1000, updatedAt: 2000, status: "running",
      messages: [{ id: "fixture-message", role: "assistant", text: "重启后应保留的合成消息" }],
    }] })],
    ["resume-diy-title", "P02 合成迁移草稿"],
    ["resume-diy-imported-templates-v1", JSON.stringify([{
      id: "webview-migration-template", name: "迁移图片合成模板", sourceName: "fixture.png",
      sourceType: "image", createdAt: "2026-10-08T00:00:00Z", accent: "#123456",
      formatId: "legacy-v1", layout: "single-column", analysis: "synthetic only", previewDataUrl: avatar,
    }])],
    ["resume-diy-state", JSON.stringify({ basic: { name: "", phone: "", email: "", city: "", wechat: "", birth: "", ageMode: "age", avatar }, summary: "",
      ...Object.fromEntries(["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"].map((key) => [key, []])) })],
  ];
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const source = JSON.stringify({ format: "zinecv-legacy-browser-export", version: 1,
    origin: "http://127.0.0.1:5173", sourceHash: hash(JSON.stringify(entries)), entries });
  const sourcePath = join(profile, "synthetic-browser-export.json");
  await writeFile(sourcePath, source);
  const report = { startedAt: new Date().toISOString(), fixture: "synthetic only", sourceSha256: hash(source), executableSha256: hash(await readFile(exe)), hostPids: [] };
  let host;
  let passed = false;
  try {
    const marker = join(profile, "migration-pause.txt");
    host = await launch(profile, phase ? { ZINECV_TEST_MIGRATION_PAUSE_PHASE: phase, ZINECV_TEST_MIGRATION_PAUSE_MARKER: marker } : {});
    report.hostPids.push(host.child.pid);
    const before = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    await host.page.getByRole("button", { name: "版本管理" }).first().click();
    await host.page.getByText("简历版本管理").first().waitFor();
    await installIpcInterceptor(host.page);
    await host.page.evaluate(() => {
      window.__migrationReceipts = [];
      window.__migrationErrors = [];
      window.__migrationCalls = [];
      window.__migrationNotices = [];
      new MutationObserver(() => {
        const notice = document.querySelector(".notice-toast")?.textContent;
        if (notice) window.__migrationNotices.push(notice);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__zinecvTestInvoke = async (command, args, forward) => {
        window.__migrationCalls.push(command);
        try {
          const result = await forward();
          if (command === "commit_legacy_migration") window.__migrationReceipts.push(result);
          return result;
        } catch (error) {
          window.__migrationErrors.push({ command, error });
          throw error;
        }
      };
    });
    for (let attempt = 0; attempt < (phase ? 1 : 3); attempt++) {
      if (attempt > 0) await host.page.getByRole("button", { name: "版本管理" }).first().click();
      const chooser = host.page.waitForEvent("filechooser");
      await host.page.getByRole("button", { name: "导入旧版数据" }).click();
      await (await chooser).setFiles(sourcePath);
      const dialog = host.page.getByRole("alertdialog");
      await dialog.getByRole("heading", { name: "审阅并导入旧版数据？" }).waitFor({ timeout: 20_000 });
      assert.match(await dialog.locator("#confirm-description").innerText(), /1 个账户、1 个公开连接配置、1 个 Agent 会话/);
      await dialog.getByRole("button", { name: "确认并原子导入" }).click();
      if (phase) {
        let markerText;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { markerText = await readFile(marker, "utf8"); break; } catch { await sleep(50); }
        }
        assert.equal(markerText, `${host.child.pid}:${phase}`);
        report.publicationMarker = markerText;
        if (phase === "before-commit") {
          // The UI flushes its pending draft before beginning migration. Read
          // that committed old state through a separate WAL reader while the
          // migration transaction is paused, rather than an earlier UI sample.
          const reader = new DatabaseSync(join(profile, "Data/zinecv.sqlite3"), { readOnly: true });
          try {
            const draft = reader.prepare("SELECT document_json FROM drafts WHERE document_id=? AND context_id=? AND branch_id=?").get(before.cursor.documentId, before.cursor.contextId, before.cursor.branchId);
            before.document = JSON.parse(draft.document_json);
            before.cursor.revision = String(reader.prepare("SELECT revision FROM documents WHERE id=?").get(before.cursor.documentId).revision);
            report.oldCommittedDocumentSha256 = hash(draft.document_json);
          } finally { reader.close(); }
        }
        break;
      }
      await host.page.waitForFunction(count => window.__migrationReceipts.length === count, attempt + 1, { timeout: 20_000 });
      await host.page.getByText(/旧版迁移已原子提交：.*账户 1 个、连接 1 个、会话 1 个，1 个连接需重输 Key/).waitFor({ timeout: 20_000 });
    }
    report.confirmedImportCount = phase ? 1 : 3;
    report.notices = await host.page.evaluate(() => window.__migrationNotices);
    report.receipts = await host.page.evaluate(() => window.__migrationReceipts);
    if (!phase) assert.deepEqual(report.receipts.map(receipt => receipt.idempotentReplay), [false, true, true]);
    await close(host);
    host = undefined;
    const database = new DatabaseSync(join(profile, "Data/zinecv.sqlite3"), { readOnly: true });
    try {
      report.tableCounts = Object.fromEntries(["accounts", "provider_profiles", "agent_sessions", "agent_messages", "secrets", "account_sessions", "legacy_migration_batches"].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
      report.avatarResourceCount = database.prepare('SELECT COUNT(*) AS count FROM resources WHERE hash=?').get(avatarHash).count;
      report.templateResourceOwners = database.prepare("SELECT COUNT(*) AS count FROM resource_refs WHERE resource_hash=? AND owner_kind='retained-template' AND owner_id='webview-migration-template'").get(avatarHash).count;
      report.remainingCategories = database.prepare('SELECT receipt_json FROM legacy_migration_batches').all().map((row) => JSON.parse(row.receipt_json).remainingCategories);
      if (phase === "before-commit") {
        const draft = database.prepare("SELECT document_json FROM drafts WHERE document_id=? AND context_id=? AND branch_id=?").get(before.cursor.documentId, before.cursor.contextId, before.cursor.branchId);
        assert.deepEqual(JSON.parse(draft.document_json), before.document);
        report.persistedOldStatePreserved = true;
      }
    } finally { database.close(); }
    const importedCount = phase === "before-commit" ? 0 : 1;
    assert.equal(report.avatarResourceCount, importedCount, 'avatar resource publication must be atomic and deduplicated');
    assert.equal(report.templateResourceOwners, importedCount, 'template image owner must share the atomic migration');
    for (const remaining of report.remainingCategories) assert.ok(!remaining.includes('assets'), 'verified template and avatar assets close the asset inventory');
    for (const table of ["accounts", "provider_profiles", "agent_sessions", "agent_messages", "legacy_migration_batches"]) assert.equal(report.tableCounts[table], importedCount);
    assert.equal(report.tableCounts.secrets, 0);
    assert.equal(report.tableCounts.account_sessions, 0);
    host = await launch(profile);
    report.hostPids.push(host.child.pid);
    assert.notEqual(report.hostPids[0], report.hostPids[1]);
    if (phase === "before-commit") {
      const after = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      assert.deepEqual(after.document, before.document);
      report.completeRestartDocumentPreserved = true;
      const login = await host.page.evaluate(async ({ email }) => {
        try { await window.__TAURI_INTERNALS__.invoke("login_account", { email, password: "fixture-password" }); return "unexpected success"; }
        catch (error) { return error.code; }
      }, { email: account.email });
      assert.notEqual(login, "unexpected success");
      report.restored = { oldStatePreserved: true, loginErrorCode: login };
      report.status = "passed";
      passed = true;
      return;
    }
    report.restored = await host.page.evaluate(async ({ email, password }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const account = await invoke("login_account", { email, password });
      const provider = await invoke("provider_profile");
      const state = await invoke("bootstrap_agent_sessions", { legacyJson: "null" });
      const document = await invoke("document_state");
      const avatarAsset = await invoke('read_avatar_asset', { hash: document.document.basic.avatarAssetId });
      const templateCatalog = await invoke('read_imported_template_catalog');
      const template = JSON.parse(templateCatalog.payloadJson).find((item) => item.id === 'webview-migration-template');
      const templateAsset = await invoke('read_avatar_asset', { hash: template.previewAssetId });
      return { account, provider, state, title: document.document.title, avatarAsset, template, templateAsset, legacyAvatarRemoved: !('legacyAvatar' in document.document.legacyExtensions) };
    }, { email: account.email, password: "fixture-password" });
    assert.equal(report.restored.account.id, account.id);
    assert.equal(report.restored.provider.apiKeyNeedsReentry, true);
    assert.equal(report.restored.provider.hasApiKey, false);
    assert.equal(report.restored.state.store.sessions.length, 1);
    assert.equal(report.restored.state.store.sessions[0].messages[0].text, "重启后应保留的合成消息");
    assert.equal(report.restored.title, "P02 合成迁移草稿");
    assert.equal(report.restored.avatarAsset.hash, avatarHash);
    assert.equal(report.restored.avatarAsset.dataUrl, avatar);
    assert.equal(report.restored.legacyAvatarRemoved, true);
    assert.equal(report.restored.template.previewAssetId, avatarHash);
    assert.equal(report.restored.template.previewDataUrl, undefined);
    assert.equal(report.restored.templateAsset.dataUrl, avatar);
    assert.equal(hash(await readFile(sourcePath)), report.sourceSha256);
    report.status = "passed";
    passed = true;
  } catch (error) {
    report.status = "failed";
    report.failure = String(error.stack ?? error);
    if (host) report.diagnostics = await host.page.evaluate(() => ({ text: document.body.innerText, errors: window.__migrationErrors, calls: window.__migrationCalls, notices: window.__migrationNotices })).catch(() => null);
    throw error;
  }
  finally {
    if (host) await close(host);
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceRoot, phase ? `${phase}-restart-evidence.json` : "restart-evidence.json"), JSON.stringify(report, null, 2));
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
