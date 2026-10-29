import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, sep } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";
import { installIpcInterceptor } from "./ipc-interceptor.mjs";

const evidenceRoot = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/R15/session4-export");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function closeDialogWindow(hostPid) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ZineDialog {
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
$dialogClock = [System.Diagnostics.Stopwatch]::StartNew()
do {
  $hwnd = [ZineDialog]::Find(${hostPid})
  if ($hwnd -ne [IntPtr]::Zero) {
    [ZineDialog]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    "closed"
    return
  }
  Start-Sleep -Milliseconds 50
} while ($dialogClock.ElapsedMilliseconds -lt 15000)
"not-found"
`;
  return promisify(execFile)("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000, windowsHide: true });
}

test("unified engine export writes pdf, pages and long image with mapped save errors", { timeout: 180_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  let host, passed = false;
  const report = { fixture: "synthetic isolated production WebView2 / unified engine export", profile };
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;
    const data = await host.page.evaluate(async () => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      const state = () => invoke("document_state");
      const command = (current, payload) => invoke("apply_document_command", { envelope: {
        protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId,
        contextId: current.cursor.contextId, expectedRevision: current.cursor.revision,
        expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload,
      } });
      let current = await state();
      const summary = current.document.sections.find(section => section.kind === "summary");
      await command(current, { type: "setSectionVisibility", section_id: summary.id, visible: true });
      current = await state();
      await command(current, { type: "setSummaryBody", section_id: summary.id, body: [{ type: "paragraph", children: [{
        type: "text", text: "统一导出同冻结修订：中文路径与错误反馈。".repeat(200), marks: [],
      }] }] });
      current = await state();
      const frozen = await state();
      const exportBundle = await invoke("render_document_export", { cursor: frozen.cursor });
      const repeat = await invoke("render_document_export", { cursor: frozen.cursor });
      return { frozen, exportBundle, repeat };
    });
    const bundle = data.exportBundle;
    const pdfBytes = Buffer.from(bundle.data.pdfBase64, "base64");
    const document = data.frozen.document;
    const summary = document.sections.find(section => section.kind === "summary");
    const marker = summary.body[0].children[0].text.slice(0, 24);
    report.export = {
      pageCount: bundle.data.pageCount,
      pdfSha256: bundle.data.pdfSha256,
      recomputedPdfSha256: sha256(pdfBytes),
      pngPages: bundle.data.pngPages.map(page => ({ page: page.page, width: page.width, height: page.height })),
      longImageLimited: bundle.data.longImageLimited,
      longPng: bundle.data.longPng ? { width: bundle.data.longPng.width, height: bundle.data.longPng.height } : null,
      dpi: bundle.data.dpi,
      textMapContainsMarker: bundle.data.textMap.logicalText.includes(marker),
      repeatPdfSha256: data.repeat.data.pdfSha256,
    };
    assert.ok(report.export.pageCount > 1);
    assert.ok(pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-");
    assert.equal(bundle.data.pdfSha256, report.export.recomputedPdfSha256);
    assert.equal(bundle.data.pngPages.length, bundle.data.pageCount);
    for (const page of bundle.data.pngPages) {
      assert.equal(page.width, 1588);
      assert.equal(page.height, 2246);
      const png = Buffer.from(page.dataBase64, "base64");
      assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
    }
    assert.ok(bundle.data.longPng && !bundle.data.longImageLimited);
    assert.equal(bundle.data.longPng.height, 2246 * bundle.data.pageCount);
    assert.ok(report.export.textMapContainsMarker);
    assert.equal(bundle.data.pdfSha256, report.export.repeatPdfSha256);

    const outputRoot = join(profile, "导出 中文 目录");
    await mkdir(outputRoot, { recursive: true });
    const pdfTarget = join(outputRoot, "简历 测试.pdf");
    const pdfWrite = await host.page.evaluate(async ({ path, base64 }) => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      return invoke("write_export_file", { path, dataBase64: base64 });
    }, { path: pdfTarget, base64: bundle.data.pdfBase64 });
    const pdfOnDisk = await readFile(pdfTarget);
    report.pdfWrite = { target: pdfTarget, bytes: pdfWrite.bytes, sha256: pdfWrite.sha256, diskSha256: sha256(pdfOnDisk) };
    assert.equal(pdfWrite.bytes, pdfBytes.length);
    assert.equal(pdfWrite.sha256, sha256(pdfBytes));
    assert.equal(pdfWrite.sha256, report.pdfWrite.diskSha256);

    const longTarget = join(outputRoot, "简历 测试.png");
    const longWrite = await host.page.evaluate(async ({ path, base64 }) => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      return invoke("write_export_file", { path, dataBase64: base64 });
    }, { path: longTarget, base64: bundle.data.longPng.dataBase64 });
    const longOnDisk = await readFile(longTarget);
    report.longWrite = { target: longTarget, bytes: longWrite.bytes, diskStartsWithPng: longOnDisk.subarray(0, 8).equals(PNG_SIGNATURE) };
    assert.equal(longWrite.bytes, longOnDisk.length);
    assert.ok(report.longWrite.diskStartsWithPng);

    const readOnlyTarget = join(outputRoot, "只读.pdf");
    await writeFile(readOnlyTarget, Buffer.from("keep"));
    await chmod(readOnlyTarget, 0o444);
    const errors = await host.page.evaluate(async ({ readOnlyTarget, missingDir, exportBase64 }) => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      // Payloads are built in-page: the oversized case must never cross CDP.
      const attempt = async (label, path, base64) => {
        try {
          await invoke("write_export_file", { path, dataBase64: base64 });
          return { label, code: null };
        } catch (error) {
          return { label, code: error?.code ?? "UNKNOWN", message: String(error?.message ?? "").slice(0, 120) };
        }
      };
      const results = [];
      results.push(await attempt("relativePath", "relative/out.pdf", exportBase64));
      results.push(await attempt("parentPath", joinPath(readOnlyTarget, "..", "bad.pdf"), exportBase64));
      results.push(await attempt("badBase64", readOnlyTarget, "!!!not base64!!!"));
      results.push(await attempt("missingDirectory", missingDir, exportBase64));
      results.push(await attempt("readOnlyFile", readOnlyTarget, exportBase64));
      // The 64 MiB decoded-size cap is asserted at unit level (decode_export_payload);
      // an over-cap payload cannot cross the WebView2 IPC channel without killing
      // the renderer, so it is deliberately not exercised through automation.
      return results;
      function joinPath(...parts) { return parts.join("\\"); }
    }, {
      readOnlyTarget,
      missingDir: join(outputRoot, "不存在", "out.pdf"),
      exportBase64: bundle.data.pdfBase64,
    });
    report.errors = Object.fromEntries(errors.map(entry => [entry.label, entry]));
    assert.equal(report.errors.relativePath?.code, "VALIDATION");
    assert.equal(report.errors.parentPath?.code, "VALIDATION");
    assert.match(report.errors.parentPath?.message ?? "", /\.\./);
    assert.equal(report.errors.badBase64?.code, "VALIDATION");
    assert.match(report.errors.badBase64?.message ?? "", /导出数据无效/);
    assert.equal(report.errors.missingDirectory?.code, "NOT_FOUND");
    assert.equal(report.errors.readOnlyFile?.code, "PERMISSION");
    assert.ok(!report.errors.oversized, "oversized payload is unit-level only");
    assert.equal((await readFile(readOnlyTarget)).toString(), "keep");
    await chmod(readOnlyTarget, 0o644).catch(() => {});

    const stateAfter = await host.page.evaluate(async () => window.__TAURI_INTERNALS__.invoke("document_state"));
    report.cursorUnchanged = stateAfter.cursor.revision === data.frozen.cursor.revision;
    assert.ok(report.cursorUnchanged);

    passed = true;
  } finally {
    report.functionalityPassed = passed;
    report.cleanupVerified = false;
    try {
      if (host) await stopNativeHost(host);
      if (passed) {
        await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
        report.cleanupVerified = true;
      } else {
        report.keptProfile = "failed run keeps the isolated profile for diagnosis";
      }
    } catch (error) {
      report.cleanupFailure = String(error.stack ?? error);
      throw error;
    } finally {
      report.passed = passed && report.cleanupVerified;
      await writeFile(join(evidenceRoot, "export-evidence.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    }
  }
});

test("injected native write faults preserve input, clear partials and restore export controls", { timeout: 240_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "write-faults-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  const faultFile = join(profile, "export-fault.txt");
  const outputRoot = join(profile, "outputs");
  await mkdir(outputRoot);
  const target = join(outputRoot, "existing.pdf");
  const original = Buffer.from("preserved existing export");
  const report = { fixture: "test-hooks bounded write/flush/replace injection; real production UI + native write IPC; picker selection supplied by test", scenarios: [] };
  let host, passed = false;
  try {
    host = await startNativeHost(profile, { buildProfile: "hooks", env: { ZINECV_TEST_EXPORT_FAULT_FILE: faultFile } });
    const page = host.page;
    report.executableSha256 = sha256(await readFile(resolve(import.meta.dirname, "../../src-tauri/target/hooks/zinecv-desktop.exe")));
    await page.locator("button[aria-label='展开基本信息']").click();
    const name = page.getByLabel("姓名", { exact: true });
    await name.fill("导出故障输入保留");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name === "导出故障输入保留");
    // Keep the product's render/write/error/finally path intact. Dialog cancellation
    // is tested separately above; only deterministic path selection is supplied.
    await installIpcInterceptor(page);
    await page.evaluate(target => {
      window.__zinecvTestInvoke = (command, args, invoke) =>
        command === "pick_export_path" ? Promise.resolve(target) : invoke(command, args);
    }, target);
    const exportButton = page.getByRole("button", { name: "导出", exact: false }).first();
    const clickExport = async (format) => {
      await exportButton.click();
      const action = page.getByRole("menuitem", { name: format === "PDF" ? /PDF 文档/ : /PNG/ });
      assert.ok(await action.isEnabled(), `${format} action must be restored after the previous export`);
      await action.click();
      const review = page.getByRole("dialog", { name: "投递前检查" });
      await review.waitFor();
      const proceed = review.getByRole("button", { name: /^(已核对建议，)?继续导出$/ });
      assert.ok(await proceed.isEnabled(), "synthetic input must pass required preflight errors");
      await proceed.click();
    };
    for (const format of ["PDF", "PNG"]) {
    for (const [fault, code, retryable, message] of [
      ["storage-full", "STORAGE_FULL", true, "磁盘空间不足"],
      ["permission", "PERMISSION", false, "拒绝写入"],
      ["occupied", "PERMISSION", true, "占用"],
      ["interrupted", "VALIDATION", true, "写入失败"],
      ["sync", "VALIDATION", true, "写入失败"],
    ]) {
      const before = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      await writeFile(target, original);
      await writeFile(faultFile, fault);
      const error = await page.evaluate(async target => {
        try { await window.__TAURI_INTERNALS__.invoke("write_export_file", { path: target, dataBase64: btoa("bounded payload") }); return null; }
        catch (error) { return error; }
      }, target);
      assert.equal(error?.code, code);
      assert.equal(error?.retryable, retryable);
      assert.match(error.message, new RegExp(message));
      assert.deepEqual(await readFile(target), original);
      assert.deepEqual(await readdir(outputRoot), ["existing.pdf"]);
      await clickExport(format);
      try {
        await page.locator(".export-notice").filter({ hasText: "导出未完成" }).waitFor({ timeout: 30_000 });
      } catch (error) {
        report.failedFault = fault;
        report.lastNotice = await page.locator(".export-notice").allTextContents();
        throw error;
      }
      assert.ok(await exportButton.isEnabled());
      assert.equal(await name.inputValue(), "导出故障输入保留");
      const after = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      assert.deepEqual(after, before);
      assert.deepEqual(await readFile(target), original);
      assert.deepEqual(await readdir(outputRoot), ["existing.pdf"]);
      await writeFile(faultFile, "");
      await clickExport(format);
      await page.locator(".export-notice").filter({ hasText: "已保存：" }).waitFor({ timeout: 30_000 }).catch(async error => {
        report.savedWaitNotice = await page.locator(".export-notice").allTextContents();
        report.savedWaitReview = await page.evaluate(() => document.querySelector("dialog.export-review[open]")?.textContent?.slice(0, 500) ?? null);
        throw error;
      });
      const saved = await readFile(target);
      if (format === "PDF") assert.equal(saved.subarray(0, 5).toString(), "%PDF-");
      else assert.deepEqual(saved.subarray(0, 8), PNG_SIGNATURE);
      const afterSave = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      assert.deepEqual(afterSave.cursor, before.cursor);
      assert.deepEqual(afterSave.document, before.document);
      assert.equal(afterSave.recentExports.length, before.recentExports.length + 1);
      assert.equal(afterSave.recentExports[0].artifact.sha256, sha256(saved));
      assert.equal(afterSave.recentExports[0].cursor.documentId, before.cursor.documentId);
      assert.equal(await name.inputValue(), "导出故障输入保留");
      assert.deepEqual(await readdir(outputRoot), ["existing.pdf"]);
      report.scenarios.push({ format, fault, code, retryable, originalPreserved: true, partialsRemoved: true, inputPreserved: true, buttonRecovered: true, retrySha256: sha256(saved) });
    }
    }
    passed = true;
  } finally {
    report.passed = passed;
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "write-faults-evidence.json"), JSON.stringify(report, null, 2) + "\n");
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("native save dialog cancel returns null and leaves the host responsive", { timeout: 120_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "dialog-"));
  let host, passed = false;
  const report = { fixture: "real IFileDialog cancel via WM_CLOSE", profile };
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;
    const dialogPromise = host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("pick_export_path", {
      kind: "pdf", defaultName: "取消验证.pdf",
    }));
    // One PowerShell/Add-Type startup; polling stops as soon as the real dialog
    // exists. The prior loop compiled the same helper on every 500 ms retry.
    const outcome = await closeDialogWindow(host.child.pid);
    const dialogFound = outcome.stdout?.trim() === "closed";
    report.dialogFound = dialogFound;
    assert.ok(dialogFound, "save dialog window never appeared");
    const picked = await dialogPromise;
    report.picked = picked;
    assert.equal(picked, null);
    const responsive = await host.page.evaluate(async () => window.__TAURI_INTERNALS__.invoke("document_state"));
    report.hostResponsiveAfterCancel = Boolean(responsive?.cursor);
    assert.ok(report.hostResponsiveAfterCancel);
    passed = true;
  } finally {
    report.functionalityPassed = passed;
    report.cleanupVerified = false;
    try {
      if (host) await stopNativeHost(host);
      if (passed) {
        await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
        report.cleanupVerified = true;
      } else {
        report.keptProfile = "failed run keeps the isolated profile for diagnosis";
      }
    } catch (error) {
      report.cleanupFailure = String(error.stack ?? error);
      throw error;
    } finally {
      report.passed = passed && report.cleanupVerified;
      await writeFile(join(evidenceRoot, "dialog-cancel-evidence.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    }
  }
});
