import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("output inspection parses actual PDF text, order, links and selected pages, and decodes PNG bytes", { timeout: 60_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const source = await context.newPage();
    await source.setContent('<main style="font:16px Arial"><p>First section.</p><p><a href="https://example.invalid/resume">Reference.</a></p><div style="break-before:page"><p>Second section.</p></div></main>');
    const pdf = await source.pdf({ format: "A4" });
    const selected = await source.pdf({ format: "A4", pageRanges: "2" });
    await source.close();
    const logicalText = "First section.Reference.Second section.";
    const cluster = (start, end, page) => ({ sourceNodeId: "fixture", startUtf16: start, endUtf16: end, logicalOrder: start, page,
      xPt: 10, yPt: 10, widthPt: 100, heightPt: 16, rtl: false });
    const textMap = { version: 1, logicalText, hitRegions: [],
      clusters: [cluster(0, 14, 1), cluster(14, 24, 1), cluster(24, logicalText.length, 2)],
      links: [{ sourceNodeId: "fixture", startUtf16: 14, endUtf16: 24, href: "https://example.invalid/resume" }] };
    const bundle = bytes => ({ cursor: { documentId: "A" }, renderKey: "fixture", data: {
      pdfBase64: bytes.toString("base64"), pdfSha256: createHash("sha256").update(bytes).digest("hex"), pageCount: 2,
      textMap, pngPages: [], longPng: null, longImageLimited: false, dpi: 96, product: "pdf", selectedPages: null,
    } });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const results = await page.evaluate(async ({ full, selected }) => {
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      const valid = await checkExportOutput(full, "pdf");
      const wrongOrder = structuredClone(full); wrongOrder.data.textMap.logicalText = "Wrong section.Reference.Second section.";
      const orderErrors = await checkExportOutput(wrongOrder, "pdf");
      const missingLinks = structuredClone(full); missingLinks.data.textMap.links = [];
      const linkErrors = await checkExportOutput(missingLinks, "pdf");
      const badHash = structuredClone(full); badHash.data.pdfSha256 = "0".repeat(64);
      const hashErrors = await checkExportOutput(badHash, "pdf");
      selected.data.selectedPages = [2];
      const selection = await checkExportOutput(selected, "pdf");
      const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 3;
      canvas.getContext("2d").fillRect(0, 0, 2, 3);
      const encoded = canvas.toDataURL("image/png").split(",")[1];
      const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const png = structuredClone(full); png.data.product = "png"; png.data.pageCount = 1;
      png.data.pngPages = [{ page: 1, width: 2, height: 3, dataBase64: encoded, sha256 }];
      const pngValid = await checkExportOutput(png, "png");
      png.data.pngPages[0].width = 4;
      const pngErrors = await checkExportOutput(png, "png");
      return { valid, orderErrors, linkErrors, hashErrors, selection, pngValid, pngErrors };
    }, { full: bundle(pdf), selected: bundle(selected) });
    assert.deepEqual(results.valid, []);
    assert.ok(results.orderErrors.some(finding => finding.id.startsWith("output-pdf-text")));
    assert.ok(results.linkErrors.some(finding => finding.id.startsWith("output-pdf-links")));
    assert.ok(results.hashErrors.some(finding => finding.id === "output-pdf-hash"));
    assert.deepEqual(results.selection, []);
    assert.deepEqual(results.pngValid, []);
    assert.ok(results.pngErrors.some(finding => finding.id.endsWith("-size")));
    const typstFixture = JSON.parse(gunzipSync(await readFile(new URL("../fixtures/export-pdf-structure.bundle.json.gz", import.meta.url))).toString("utf8"));
    assert.match(typstFixture.origin, /real release render_document_export bundle/);
    const typstFindings = await page.evaluate(async data => {
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      return checkExportOutput({ cursor: { documentId: "fixture" }, renderKey: "fixture", data }, "pdf");
    }, typstFixture.data);
    assert.deepEqual(typstFindings, [], "real Typst frozen PDF must pass the production output inspector");
    const semanticPuaFindings = await page.evaluate(async data => {
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      data.textMap.logicalText = data.textMap.logicalText.replace(/\S/u, "\ue76f");
      return checkExportOutput({ cursor: { documentId: "fixture" }, renderKey: "fixture", data }, "pdf");
    }, typstFixture.data);
    assert.ok(semanticPuaFindings.some(finding => finding.id === "output-pdf-text-0"), "semantic PUA must not be normalized away");
    await page.evaluate(async () => {
      const { React, createRoot, ExportReviewHost, useExportHost, registerPlatformInvoke, nativeClient }
        = await import("/tests/browser/fixtures/export-review-runtime.ts");
      const cursor = { documentId: "A", contextId: "context", branchId: "main", headId: null, revision: "3" };
      registerPlatformInvoke(async command => {
        if (command === "document_state") return { cursor, document: { schemaVersion: 2, documentId: "A" }, epoch: 1 };
        throw new Error(command);
      });
      await nativeClient.load();
      window.__reviewDecisions = []; window.__located = [];
      function Harness() {
        const host = useExportHost();
        const show = async severity => {
          if (!host.begin("pdf")) return;
          const decision = await host.review({ cursor, documentTitle: "A title", branchName: "A branch", format: "pdf", phase: "content", fileName: "A-branch-date",
            findings: [{ id: "fixture", severity, message: "Synthetic finding", field: "basic.email", target: { kind: "basic", fieldLabel: "邮箱" } }],
            recentExports: [{ id: "export:fixture", cursor, filename: "saved.pdf", source: { documentTitle: "Frozen A", branchName: "Frozen branch", templateId: "legacy-v1", templateRevision: "1", frozenAt: "2026-10-29T00:00:00Z" },
              artifact: { format: "pdf", bytes: 3, sha256: "a".repeat(64), page: null }, writtenAt: "2026-10-29T00:00:01Z", dpi: 192, sourcePageCount: 2, selectedPages: null }],
          }, target => window.__located.push(target));
          window.__reviewDecisions.push(decision); host.finish();
        };
        return React.createElement("div", null, ...["error", "suggestion"].map(severity => React.createElement("button", { key: severity, onClick: () => show(severity) }, `Review ${severity}`)));
      }
      const mount = document.createElement("div"); document.body.append(mount);
      createRoot(mount).render(React.createElement(ExportReviewHost, null, React.createElement(Harness)));
    });
    await page.getByRole("button", { name: "Review error" }).click();
    const review = page.getByRole("dialog", { name: "投递前检查" });
    await assert.equal(await review.getByRole("button", { name: "请先处理错误" }).isDisabled(), true);
    await review.getByText("最近已保存的导出（最多 20 条）", { exact: true }).click();
    await assert.equal(await review.getByText("saved.pdf", { exact: true }).isVisible(), true);
    await review.getByRole("button", { name: "定位并返回编辑" }).click();
    await page.waitForFunction(() => window.__reviewDecisions.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__located), [{ kind: "basic", fieldLabel: "邮箱" }]);
    assert.equal((await page.evaluate(() => window.__reviewDecisions[0])).proceed, false);
    await page.getByRole("button", { name: "Review suggestion" }).click();
    await review.getByRole("textbox", { name: "导出文件名" }).fill("Reviewed-name");
    await review.getByRole("button", { name: "已核对建议，继续导出" }).click();
    await page.waitForFunction(() => window.__reviewDecisions.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__reviewDecisions[1]), { proceed: true, fileName: "Reviewed-name" });
    await page.getByRole("button", { name: "Review suggestion" }).click();
    await review.waitFor(); await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__reviewDecisions.length === 3);
    assert.equal((await page.evaluate(() => window.__reviewDecisions[2])).proceed, false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await server.close(); }
});
