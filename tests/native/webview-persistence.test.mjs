import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const evidenceRoot = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/R26/session3-persistence");
test("real restart preserves catalog, empty graph, preferences and React conflict recovery", { timeout: 150_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  const report = { fixture: "synthetic isolated shared database, two real WebView2 processes", hostPids: [] };
  let host, peer, passed = false;
  try {
    host = await startNativeHost(join(profile, "first"), { dataDir: join(profile, "Data") });
    report.hostPids.push(host.child.pid);
    await host.page.getByRole("button", { name: "编辑简历名称", exact: true }).click();
    await host.page.getByLabel("简历名称", { exact: true }).fill("P06 重启基线");
    await host.page.getByLabel("简历名称", { exact: true }).press("Enter");
    await host.page.locator(".save-state").getByText("草稿已保存").waitFor();
    await host.page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const catalog = await invoke("read_imported_template_catalog");
      await invoke("write_imported_template_catalog", { expectedRevision: catalog.revision, payloadJson: JSON.stringify([{ id: "p06-template", name: "P06 重启模板", sourceName: "fixture.png", sourceType: "image", createdAt: "2026-01-01T00:00:00.000Z", accent: "#2563eb", formatId: "legacy-v1", layout: "single-column", analysis: "synthetic" }]) });
      const state = await invoke("document_state");
      await invoke("replace_version_store", { cursor: state.cursor, replacement: { currentBranchId: state.cursor.branchId, branches: [{ id: state.cursor.branchId, name: "P06 空版本分支", headCommitId: null, createdAt: "2026-01-01T00:00:00.000Z" }], commits: [] } });
      await invoke("write_setting", { key: "resume-diy-active-workspace-view-v1", value: "templates" });
      await invoke("write_setting", { key: "resume-diy-agent-mode-v1", value: "bot" });
    });
    report.before = await host.page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return { document: (await invoke("document_state")).document, catalog: await invoke("read_imported_template_catalog"), graph: await invoke("version_graph_detailed") };
    });
    await stopNativeHost(host); host = undefined;
    host = await startNativeHost(join(profile, "first"), { dataDir: join(profile, "Data") });
    report.hostPids.push(host.child.pid);
    await host.page.getByText("P06 重启模板", { exact: true }).waitFor();
    await host.page.locator(".agent-mode-bot").waitFor();
    report.after = await host.page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return { document: (await invoke("document_state")).document, catalog: await invoke("read_imported_template_catalog"), graph: await invoke("version_graph_detailed") };
    });
    assert.deepEqual(report.after, report.before);
    assert.equal(report.after.graph.commits.length, 0);
    report.restartCompleteStateEqual = true;
    peer = await startNativeHost(join(profile, "peer"), { dataDir: join(profile, "Data") });
    report.hostPids.push(peer.child.pid);
    const editTitle = async (page, title) => {
      await page.getByRole("button", { name: "编辑简历名称", exact: true }).click();
      await page.getByLabel("简历名称", { exact: true }).fill(title);
      await page.getByLabel("简历名称", { exact: true }).press("Enter");
    };
    await editTitle(host.page, "P06 窗口 A 已保存");
    await host.page.locator(".save-state").getByText("草稿已保存").waitFor();
    await editTitle(peer.page, "P06 窗口 B 未保存输入");
    await peer.page.getByText("其他窗口已更新草稿；本窗口修改尚未保存").waitFor();
    const durable = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(durable.document.title, "P06 窗口 A 已保存");
    await peer.page.getByRole("button", { name: "重新载入最新草稿" }).click();
    await peer.page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
    // M3 起文档切换器触发按钮与简历标题同名，定位限定标题元素本身。
    await peer.page.locator("button.resume-title").filter({ hasText: "P06 窗口 B 未保存输入" }).waitFor();
    report.conflictCancelPreservesInput = true;
    await peer.page.getByRole("button", { name: "重新载入最新草稿" }).click();
    await peer.page.getByRole("alertdialog").getByRole("button", { name: "放弃本窗口修改并重新载入" }).click();
    await peer.page.locator("button.resume-title").filter({ hasText: "P06 窗口 A 已保存" }).waitFor();
    await editTitle(peer.page, "P06 冲突恢复后保存");
    await peer.page.locator(".save-state").getByText("草稿已保存").waitFor();
    assert.equal((await peer.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"))).document.title, "P06 冲突恢复后保存");
    report.conflictReloadAndSubsequentSave = true;
    report.status = "passed"; passed = true;
  } catch (error) {
    report.status = "failed"; report.failure = String(error.stack ?? error);
    const page = peer?.page ?? host?.page;
    if (page) { report.visibleText = (await page.locator("body").innerText()).slice(-6000); await page.screenshot({ path: join(evidenceRoot, "failed.png") }); }
    throw error;
  } finally {
    if (peer) await stopNativeHost(peer);
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "restart-conflict-evidence.json"), JSON.stringify(report, null, 2));
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
