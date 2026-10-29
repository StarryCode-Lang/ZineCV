import { syntheticScannedPdfBytes } from "../browser/fixtures/synthetic-scanned-pdf.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { syntheticComplexDocx } from "../browser/fixtures/synthetic-docx.mjs";
import { syntheticTwoColumnPdf } from "../browser/fixtures/synthetic-two-column-pdf.mjs";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = join(root, ".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-closure");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const invoke = (page, name, args = {}) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
const saved = page => page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
async function minimize(page) {
  const button = page.getByRole("button", { name: "最小化到 Bot", exact: true });
  if (await button.isVisible()) await button.click();
}
async function image(page, rotated = false, small = false) {
  return page.evaluate(({ rotated, small }) => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 500;
    const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 900, 500);
    context.fillStyle = "black"; context.font = "38px Arial";
    if (rotated) { context.translate(900, 0); context.rotate(Math.PI / 2); }
    ["OWNED OCR FIXTURE", "Education", "Example University", "Skills", "JavaScript Python"].forEach((line, i) => context.fillText(line, 40, 80 + i * 65));
    const output = document.createElement("canvas");
    output.width = small ? 360 : canvas.width; output.height = small ? 200 : canvas.height;
    output.getContext("2d").drawImage(canvas, 0, 0, output.width, output.height);
    return output.toDataURL("image/png");
  }, { rotated, small });
}

test("Windows file import reviews owned complex DOCX, sideways and low-resolution OCR without overwriting the draft", { timeout: 360_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "import-profile-"));
  const report = { passed: false, checks: [], scope: "Actual release UI file controls, parser workers, native import drafts and cancellation; owned synthetic corpus" };
  let host;
  try {
    host = await startNativeHost(profile);
    const { page } = host;
    await minimize(page);
    const docx = syntheticComplexDocx();
    const scanBytes = await page.evaluate(syntheticScannedPdfBytes);
    const fixtures = [
      { name: "owned-two-column.pdf", mimeType: "application/pdf", buffer: syntheticTwoColumnPdf(), pattern: /Example University|JavaScript/ },
      { name: "owned-scanned.pdf", mimeType: "application/pdf", buffer: Buffer.from(scanBytes), pattern: /SCANNED OWNER|SECOND PAGE Python/, scanned: true },
      { name: "owned-complex.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx, pattern: /OWNED|TABLE/ },
      { name: "owned-sideways.png", mimeType: "image/png", buffer: Buffer.from((await image(page, true)).split(",")[1], "base64"), pattern: /Example University|JavaScript/ },
      { name: "owned-low-resolution.png", mimeType: "image/png", buffer: Buffer.from((await image(page, false, true)).split(",")[1], "base64"), pattern: /Example University|JavaScript/ },
    ];
    const baseline = await invoke(page, "document_state");
    await page.getByRole("button", { name: "模板", exact: true }).click();
    for (const fixture of fixtures) {
      await page.locator('input[type="file"]').setInputFiles({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer });
      await page.getByRole("button", { name: "提取并审阅候选", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "审阅导入内容", exact: true });
      await dialog.waitFor({ timeout: 120_000 });
      const database = new DatabaseSync(join(profile, "Data/zinecv.sqlite3"), { readOnly: true });
      let row;
      try { row = database.prepare("SELECT id FROM import_drafts WHERE status='review_required' ORDER BY created_at DESC LIMIT 1").get(); }
      finally { database.close(); }
      assert.ok(row);
      const draft = await invoke(page, "get_import_draft", { draftId: row.id });
      assert.match(JSON.stringify(draft.candidates), fixture.pattern);
      if (fixture.scanned) assert.ok(JSON.stringify(draft).includes("逐页 OCR"), "native review retains scanned-PDF warning");
      // M5 起 document_state 携带 pendingImportCount：审阅中的草稿计数必须 +1，其余状态与基线一致。
      const duringReview = await invoke(page, "document_state");
      assert.equal(duringReview.pendingImportCount, baseline.pendingImportCount + 1);
      assert.deepEqual({ ...duringReview, pendingImportCount: baseline.pendingImportCount }, baseline);
      await page.screenshot({ path: join(evidenceRoot, fixture.name + ".png"), animations: "disabled" });
      await page.getByRole("button", { name: "取消导入审阅", exact: true }).click();
      await page.waitForFunction(async id => (await window.__TAURI_INTERNALS__.invoke("get_import_draft", { draftId: id })).status === "cancelled", row.id);
      assert.deepEqual(await invoke(page, "document_state"), baseline);
      report.checks.push({ name: fixture.name, fixtureSha256: hash(fixture.buffer), candidates: draft.candidates, warnings: draft.warnings, cancelledAndDocumentUnchanged: true });
    }
    const confirmedFixture = fixtures.find(item => item.scanned);
    await page.locator('input[type="file"]').setInputFiles({ name: confirmedFixture.name, mimeType: confirmedFixture.mimeType, buffer: confirmedFixture.buffer });
    await page.getByRole("button", { name: "提取并审阅候选", exact: true }).click();
    const review = page.getByRole("dialog", { name: "审阅导入内容", exact: true });
    await review.waitFor({ timeout: 120_000 });
    const boxes = review.getByRole("checkbox");
    assert.ok(await boxes.count() > 0);
    for (let index = 0; index < await boxes.count(); index++) await boxes.nth(index).uncheck();
    await boxes.first().check();
    await review.getByRole("button", { name: "确认应用 1 项", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "简历编辑", exact: true }).click();
    await saved(page);
    const applied = await invoke(page, "document_state");
    assert.ok(applied.cursor.revision > baseline.cursor.revision);
    const expandBasic = page.getByRole("button", { name: "展开基本信息", exact: true });
    if (await expandBasic.isVisible()) await expandBasic.click();
    await page.getByLabel("姓名", { exact: true }).fill("人工校正合成姓名");
    await page.getByLabel("姓名", { exact: true }).press("Tab");
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name === "人工校正合成姓名");
    const corrected = await invoke(page, "document_state");
    assert.deepEqual(corrected.document.sections, applied.document.sections);
    report.confirmation = { singleSelectedCandidateApplied: true, editorCorrectionSaved: true, otherSectionsUnchanged: true };
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack);
    if (host) report.visibleText = await host.page.locator("body").innerText().catch(() => "");
    throw error;
  } finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "complex-import.json"), JSON.stringify(report, null, 2));
    if (report.passed) await rm(profile, { recursive: true, maxRetries: 15, retryDelay: 200 });
  }
});

test("Windows source PDF overlay follows A4, exits after content/layout changes and exports editable content", { timeout: 180_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "overlay-profile-"));
  const report = { passed: false, checks: [], scope: "Owned actual PDF through production file recognition, catalog resource persistence, overlay exit and editable PDF export" };
  let host;
  try {
    host = await startNativeHost(profile);
    const { page } = host;
    await minimize(page);
    const pdfBytes = syntheticTwoColumnPdf();
    report.sourcePdfSha256 = hash(pdfBytes);
    await page.getByRole("button", { name: "模板", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "owned-overlay.pdf", mimeType: "application/pdf", buffer: pdfBytes });
    await page.getByRole("button", { name: "识别并保存", exact: true }).click();
    await page.waitForFunction(async () => JSON.parse((await window.__TAURI_INTERNALS__.invoke("read_imported_template_catalog")).payloadJson).some(template => template.sourceName === "owned-overlay.pdf"), undefined, { timeout: 60_000 });
    const catalog = await invoke(page, "read_imported_template_catalog");
    const imported = JSON.parse(catalog.payloadJson).find(template => template.sourceName === "owned-overlay.pdf");
    assert.equal(imported.sourceType, "pdf");
    assert.ok(imported.previewAssetId, "real PDF parser preview must persist as a catalog-owned resource");
    report.importedTemplate = { id: imported.id, name: imported.name, previewAssetId: imported.previewAssetId };
    await page.reload({ waitUntil: "commit" }); await saved(page);
    const select = async () => {
      await page.getByRole("button", { name: "模板", exact: true }).click();
      await page.locator(".template-library-select").filter({ hasText: imported.name }).click();
      await page.getByRole("button", { name: "简历编辑", exact: true }).click();
      await page.locator("[data-imported-source-preview]").waitFor(); await saved(page);
    };
    await select();
    const geometry = await page.evaluate(() => {
      const bounds = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { overlay: bounds(document.querySelector("[data-imported-source-preview]")), paper: bounds(document.querySelector(".paper-frame .paper")) };
    });
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(geometry.overlay[key] - geometry.paper[key]) <= 1);
    await page.screenshot({ path: join(evidenceRoot, "source-overlay.png"), animations: "disabled" });
    const expand = page.getByRole("button", { name: "展开基本信息", exact: true }); if (await expand.isVisible()) await expand.click();
    await page.getByLabel("姓名", { exact: true }).fill("EDITABLE OWNER"); await page.getByLabel("姓名", { exact: true }).press("Tab");
    await page.locator("[data-imported-source-preview]").waitFor({ state: "detached" }); await saved(page);
    const state = await invoke(page, "document_state");
    assert.equal(state.document.basic.name, "EDITABLE OWNER");
    await select();
    await page.getByRole("button", { name: "间距", exact: true }).click();
    const spacing = page.getByRole("dialog", { name: "间距设置" });
    const previousMargin = await spacing.getByLabel("四边页距").inputValue();
    await spacing.getByLabel("四边页距").selectOption(previousMargin === "40" ? "30" : "40");
    await spacing.getByRole("button", { name: "关闭设置" }).click();
    await page.locator("[data-imported-source-preview]").waitFor({ state: "detached" }); await saved(page);
    const frozen = await invoke(page, "document_state");
    const exported = await invoke(page, "render_document_export", { cursor: frozen.cursor, product: "pdf" });
    assert.ok(exported.data.textMap.logicalText.includes("EDITABLE OWNER"));
    assert.deepEqual(await invoke(page, "document_state"), frozen);
    report.checks = [{ geometry, editedContentExits: true, repeatedOpen: true, layoutChangeExits: true, exportedEditableText: true, pdfSha256: exported.data.pdfSha256 }];
    report.passed = true;
  } catch (error) { report.error = String(error.stack); throw error; }
  finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "source-overlay.json"), JSON.stringify(report, null, 2));
    if (report.passed) await rm(profile, { recursive: true, maxRetries: 15, retryDelay: 200 });
  }
});

