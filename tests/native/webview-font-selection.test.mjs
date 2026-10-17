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

test("all five actual Windows font choices reach the PDF worker; Hebrew fallback has visible glyphs", { timeout: 240_000 }, async () => {
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
    for (const [choice, expected] of [["宋体", "SourceHanSerifCN"], ["雅黑", "MicrosoftYaHei"], ["黑体", "SimHei"], ["楷体", "KaiTi"], ["仿宋", "FangSong"], ["宋体", "SourceHanSerifCN"]]) {
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
    assert.equal(new Set(report.cases.slice(0, 5).map(item => item.pdfSha256)).size, 5, "Changing font must change the actual PDF");
    assert.equal(report.cases[0].pdfSha256, report.cases.at(-1).pdfSha256, "Returning to the same font preserves deterministic export");
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
