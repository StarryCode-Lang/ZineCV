// 原版式导出的真实 UI 交互链：模板目录 → 文档绑定 → 激活模板 →
// 导出按钮 → 投递前检查 → 冻结渲染 → 输出核验 → 保存路径 → 写盘回执 → 导出记录。
// 保存对话框由测试替换为确定路径（真实对话框取消已有独立测试覆盖）。
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "vite";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";
import { installIpcInterceptor } from "./ipc-interceptor.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("source layout export completes the real UI chain with receipts", { timeout: 300_000 }, async () => {
  const evidenceRoot = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/source-layout-ui");
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  const server = await createServer({ server: { host: "127.0.0.1", port: 5174, strictPort: true } });
  await server.listen();
  let host, passed = false;
  const report = { fixture: "isolated production WebView2 / source layout export UI chain", profile };
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;
    const outputRoot = join(profile, "原版式导出目录");
    await mkdir(outputRoot, { recursive: true });
    const bound = await host.page.evaluate(async () => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      const image = document.createElement("canvas"); image.width = 794; image.height = 1123;
      const ctx = image.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 794, 1123);
      ctx.fillStyle = "black"; ctx.font = "18px Arial";
      ctx.fillText("Original name", 50, 80); ctx.fillText("Original role", 50, 110);
      const background = image.toDataURL("image/png");
      const common = { page: 1, x: 50, width: 270, height: 22, fontSize: 18, lineHeight: 22,
        fontFamily: "Arial", fontWeight: "400", fontStyle: "normal", color: "#000", background: "#fff", align: "left" };
      const layout = { version: 1, pages: [{ width: 794, height: 1123, background }],
        boxes: [{ ...common, id: "name", y: 62, text: "Original name" }, { ...common, id: "role", y: 92, text: "Original role" }],
        extractedChars: 26, warnings: [] };
      const oldCatalog = await invoke("read_imported_template_catalog");
      const oldItems = oldCatalog ? JSON.parse(oldCatalog.payloadJson) : [];
      const template = { id: "ui-chain-template", name: "UI 链模板", sourceName: "synthetic.docx", sourceType: "word",
        createdAt: "2026-11-05T00:00:00Z", accent: "#000000", formatId: "legacy-v1", layout: "single-column",
        analysis: "synthetic", sourceLayout: layout };
      await invoke("write_imported_template_catalog", { payloadJson: JSON.stringify([...oldItems, template]), expectedRevision: oldCatalog?.revision ?? 0 });
      const catalog = await invoke("read_imported_template_catalog");
      const saved = JSON.parse(catalog.payloadJson).find(item => item.id === template.id);
      let state = await invoke("document_state");
      await invoke("apply_document_command", { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(),
        documentId: state.cursor.documentId, contextId: state.cursor.contextId, expectedRevision: state.cursor.revision,
        expectedBranchId: state.cursor.branchId, expectedHeadId: state.cursor.headId,
        payload: { type: "setLegacyExtensions", extensions: { ...state.document.legacyExtensions,
          importedTemplate: { id: template.id, name: template.name, revisionHash: saved.revisionHash },
          sourceLayoutEdits: { templateId: template.id, revisionHash: saved.revisionHash, edits: { name: "Edited name" } } } } } });
      return { templateId: template.id, revisionHash: saved.revisionHash };
    });
    // 激活模板走真实初始化路径：localStorage + reload（与用户上次会话恢复一致）。
    await host.page.evaluate(templateId => {
      window.localStorage.setItem("resume-diy-active-imported-template", templateId);
    }, bound.templateId);
    await host.page.reload();
    await host.page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await host.page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });

    const pdfTarget = join(outputRoot, "UI 链 简历.pdf");
    const pngTarget = join(outputRoot, "UI 链 简历.png");
    await installIpcInterceptor(host.page);
    await host.page.evaluate(target => {
      window.__zinecvTestInvoke = (command, args, invoke) =>
        command === "pick_export_path" ? Promise.resolve(target) : invoke(command, args);
    }, pdfTarget);
    const exportButton = host.page.getByRole("button", { name: "导出", exact: false }).first();
    await exportButton.click();
    const pdfAction = host.page.getByRole("menuitem", { name: /PDF 文档/ });
    assert.ok(await pdfAction.isEnabled(), "PDF action must be enabled");
    await pdfAction.click();
    const review = host.page.getByRole("dialog", { name: "投递前检查" });
    await review.waitFor();
    const proceed = review.getByRole("button", { name: /^(已核对建议，)?继续导出$/ });
    assert.ok(await proceed.isEnabled(), "synthetic layout must pass preflight errors");
    await proceed.click();
    await host.page.locator(".export-notice").filter({ hasText: "已保存：" }).waitFor({ timeout: 120_000 }).catch(async error => {
      report.pdfSavedWait = {
        notices: await host.page.locator(".export-notice").allTextContents(),
        review: await host.page.evaluate(() => document.querySelector("dialog.export-review[open]")?.textContent?.slice(0, 800) ?? null),
        identityDebug: await host.page.evaluate(async () => {
          const state = await window.__TAURI_INTERNALS__.invoke("document_state");
          const catalog = await window.__TAURI_INTERNALS__.invoke("read_imported_template_catalog");
          const items = catalog ? JSON.parse(catalog.payloadJson) : [];
          return {
            documentTemplate: state.document.legacyExtensions?.importedTemplate ?? null,
            catalogHashes: items.map(item => ({ id: item.id, revisionHash: item.revisionHash })),
            localStorageActive: window.localStorage.getItem("resume-diy-active-imported-template"),
          };
        }),
      };
      throw error;
    });
    const pdfOnDisk = await readFile(pdfTarget);
    assert.equal(pdfOnDisk.subarray(0, 5).toString("latin1"), "%PDF-");
    const pdfState = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(pdfState.recentExports.length, 1);
    assert.equal(pdfState.recentExports[0].artifact.sha256, sha256(pdfOnDisk));
    assert.equal(pdfState.recentExports[0].cursor.documentId, pdfState.cursor.documentId);
    report.pdf = { bytes: pdfOnDisk.length, sha256: sha256(pdfOnDisk), recorded: true };

    // PNG 长图同链
    await host.page.evaluate(target => {
      window.__zinecvTestInvoke = (command, args, invoke) =>
        command === "pick_export_path" ? Promise.resolve(target) : invoke(command, args);
    }, pngTarget);
    await exportButton.click();
    const pngAction = host.page.getByRole("menuitem", { name: /PNG/ });
    assert.ok(await pngAction.isEnabled(), "PNG action must be restored after PDF export");
    await pngAction.click();
    const pngReview = host.page.getByRole("dialog", { name: "投递前检查" });
    await pngReview.waitFor();
    await pngReview.getByRole("button", { name: /^(已核对建议，)?继续导出$/ }).click();
    await host.page.locator(".export-notice").filter({ hasText: "已保存：" }).waitFor({ timeout: 120_000 });
    const pngOnDisk = await readFile(pngTarget);
    assert.deepEqual(pngOnDisk.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const pngState = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(pngState.recentExports.length, 2);
    assert.equal(pngState.recentExports[0].artifact.sha256, sha256(pngOnDisk));
    report.png = { bytes: pngOnDisk.length, width: pngState.recentExports[0].artifact.width, recorded: true };

    // 取消链：投递前检查点"取消导出"，无新记录。
    const beforeCancel = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    await exportButton.click();
    await host.page.getByRole("menuitem", { name: /PDF 文档/ }).click();
    const cancelReview = host.page.getByRole("dialog", { name: "投递前检查" });
    await cancelReview.waitFor();
    await cancelReview.getByRole("button", { name: "取消导出" }).click();
    await host.page.locator(".export-notice").filter({ hasText: "已取消" }).waitFor({ timeout: 30_000 });
    const afterCancel = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(afterCancel.recentExports.length, beforeCancel.recentExports.length);
    assert.ok(await exportButton.isEnabled());
    report.cancelled = true;
    passed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    report.passed = passed;
    if (host) await stopNativeHost(host);
    await server.close();
    const { writeFile: writeFileAsync } = await import("node:fs/promises");
    await writeFileAsync(join(evidenceRoot, "source-layout-ui-evidence.json"), JSON.stringify(report, null, 2) + "\n");
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
