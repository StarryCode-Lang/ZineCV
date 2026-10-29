import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, process.env.ZINECV_NATIVE_EVIDENCE_OUT_DIR ?? ".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/font-selection", "selected-fonts");
const norm = value => value.replace(/#[0-9a-f]{2}/gi, escape => String.fromCharCode(parseInt(escape.slice(1), 16))).replace(/[^a-z0-9]/gi, "").toLowerCase();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("unified font choices reach the PDF worker; legacy selections map to the unified fonts; Hebrew fallback has visible glyphs", { timeout: 240_000 }, async () => {
  await mkdir(out, { recursive: true });
  const profile = await mkdtemp(join(out, "profile-"));
  const report = { passed: false, cases: [], scope: "Actual UI platform font and PDF embedded font identity; no system font redistribution or human visual acceptance" };
  let host;
  try {
    host = await startNativeHost(profile);
    const { page } = host;
    await page.locator(".save-state").getByText("草稿已保存", { exact: true }).waitFor();
    await page.getByRole("button", { name: "展开基本信息", exact: true }).click();
    await page.getByLabel("姓名", { exact: true }).fill("字体核对 Sample");
    await page.getByLabel("姓名", { exact: true }).press("Tab");
    await page.locator(".save-state").getByText("草稿已保存", { exact: true }).waitFor();
    const baseline = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const readUiFonts = async () => {
      await page.evaluate(() => document.fonts.ready);
      const { root: documentRoot } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: documentRoot.nodeId, selector: ".paper-frame .paper h1" });
      return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts;
    };
    const exportPdf = async () => {
      const before = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      const bytes = Buffer.from(await page.evaluate(cursor => window.__TAURI_INTERNALS__.invoke("export_document_pdf", { cursor }), before.cursor));
      const after = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
      assert.deepEqual(after, before, "Export must retain the frozen document and cursor");
      assert.deepEqual(after.document.basic, baseline.document.basic);
      assert.deepEqual(after.document.sections, baseline.document.sections);
      const fonts = [...bytes.toString("latin1").matchAll(/\/BaseFont\s*\/([^\s/<>\[\]()]+)/g)].map(match => match[1]);
      assert.ok(fonts.length, "PDF must expose actual embedded BaseFont names");
      return { before, bytes, fonts };
    };
    for (const [choice, expected] of [["宋体", "SourceHanSerifCN"], ["雅黑", "MicrosoftYaHei"], ["宋体", "SourceHanSerifCN"]]) {
      await page.locator('button[title="选择简历字体"]').click();
      const dialog = page.getByRole("dialog", { name: "简历字体" });
      await dialog.getByRole("button", { name: choice, exact: true }).click();
      await page.waitForFunction(async font => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.fontSetId === "legacy-font:" + font, choice);
      await dialog.getByRole("button", { name: "关闭设置" }).click();
      await page.locator(".save-state").getByText("草稿已保存", { exact: true }).waitFor();
      const uiFonts = await readUiFonts();
      assert.ok(uiFonts.some(font => norm(font.familyName).includes(norm(expected)) && font.glyphCount > 0), JSON.stringify({ choice, uiFonts }));
      const { bytes, fonts, before } = await exportPdf();
      report.cases.push({ choice, expected, uiFonts, pdfFonts: fonts, pdfSha256: sha(bytes), cursor: before.cursor });
      await writeFile(join(out, choice + ".pdf"), bytes);
      assert.ok(fonts.some(font => norm(font).includes(norm(expected))), JSON.stringify({ choice, fonts }));
    }
    assert.equal(new Set(report.cases.slice(0, 3).map(item => item.pdfSha256)).size, 2, "Changing font must change the actual PDF");
    assert.equal(report.cases[0].pdfSha256, report.cases[2].pdfSha256, "Returning to the same font preserves deterministic export");
    // 字体统一后选择器只有两档；历史文档的黑体/楷体/仿宋由引擎映射到
    // 统一栈，PDF 身份必须分别并入雅黑/宋体两档，而不是产生新的字体输出。
    // 旧档不再能从选择器点击产生，改经 apply_document_command 写入旧 fontSetId
    // 并重载水合，等价于打开一份历史文档。
    const legacyCases = [["黑体", "MicrosoftYaHei"], ["楷体", "SourceHanSerifCN"], ["仿宋", "SourceHanSerifCN"]];
    for (const [choice, expected] of legacyCases) {
      await page.evaluate(async font => {
        const state = await window.__TAURI_INTERNALS__.invoke("document_state");
        return window.__TAURI_INTERNALS__.invoke("apply_document_command", { envelope: {
          protocolVersion: 1,
          commandId: `font-legacy-${font}-${Date.now()}`,
          documentId: state.cursor.documentId,
          contextId: state.cursor.contextId,
          expectedRevision: state.cursor.revision,
          expectedBranchId: state.cursor.branchId,
          expectedHeadId: state.cursor.headId,
          payload: { type: "setLayout", presentation: { ...state.document.presentation, fontSetId: "legacy-font:" + font } },
        } });
      }, choice);
      await page.reload();
      await page.locator(".save-state").getByText("草稿已保存", { exact: true }).waitFor();
      await page.waitForFunction(async font => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.fontSetId === "legacy-font:" + font, choice);
      const uiFonts = await readUiFonts();
      assert.ok(uiFonts.some(font => norm(font.familyName).includes(norm(expected)) && font.glyphCount > 0), JSON.stringify({ choice, uiFonts }));
      const { bytes, fonts, before } = await exportPdf();
      report.cases.push({ choice, expected, uiFonts, pdfFonts: fonts, pdfSha256: sha(bytes), cursor: before.cursor });
      await writeFile(join(out, choice + ".pdf"), bytes);
      assert.ok(fonts.some(font => norm(font).includes(norm(expected))), JSON.stringify({ choice, fonts }));
    }
    assert.equal(new Set(report.cases.map(item => item.pdfSha256)).size, 2, "Unified mapping must collapse legacy choices onto the two font identities");
    await page.getByLabel("姓名", { exact: true }).fill("字体核对 אבג");
    await page.getByLabel("姓名", { exact: true }).press("Tab");
    await page.locator(".save-state").getByText("草稿已保存", { exact: true }).waitFor();
    const uiFonts = await readUiFonts();
    const current = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    const pdf = Buffer.from(await page.evaluate(cursor => window.__TAURI_INTERNALS__.invoke("export_document_pdf", { cursor }), current.cursor));
    const pdfFonts = [...pdf.toString("latin1").matchAll(/\/BaseFont\s*\/([^\s/<>\[\]()]+)/g)].map(match => match[1]);
    report.hebrew = { uiFonts, pdfFonts, sha256: sha(pdf) };
    assert.ok(uiFonts.some(font => norm(font.familyName) === "notosanshebrew" && font.glyphCount >= 3));
    assert.ok(pdfFonts.some(font => norm(font).includes("notosanshebrew")));
    await writeFile(join(out, "hebrew.pdf"), pdf);
    await page.locator(".paper-frame").first().screenshot({ path: join(out, "hebrew-paper.png"), animations: "disabled" });
    report.passed = true;
  } catch (error) { report.error = String(error.stack); throw error; }
  finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    if (report.passed) await rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
});
