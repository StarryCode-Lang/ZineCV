import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const evidenceRoot = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/R14/session3-fit");
test("production fit freezes input and applies only through authority CAS", { timeout: 120_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  let host, passed = false;
  const report = { fixture: "synthetic isolated production WebView2 / bounded worker fit", profile };
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
        type: "link", href: "https://example.invalid/frozen-fit", children: [{ type: "text", text: "有限候选不改变正文顺序。".repeat(190), marks: [] }],
      }] }] });
      current = await state();
      await command(current, { type: "setLayout", presentation: { ...current.document.presentation, fontSizePt: 14, lineHeightPt: 18, headingSizePt: 16, pageMarginPt: 30, moduleGapPt: 4, paragraphGapPt: 2, listGapPt: 2 } });
      const source = await state();
      const preview = await invoke("render_document_preview", { cursor: source.cursor });
      const started = performance.now();
      const proposal = await invoke("fit_document_one_page", { cursor: source.cursor });
      const elapsedMs = performance.now() - started;
      const afterPlan = await state();
      await command(source, { type: "updateBasic", patch: { name: "合成竞争修订" } });
      const edited = await state();
      let conflict;
      try { await command(source, { type: "setLayout", presentation: proposal.plan.fittedPresentation }); }
      catch (error) { conflict = error.code; }
      const afterConflict = await state();
      const freshProposal = await invoke("fit_document_one_page", { cursor: edited.cursor });
      if (freshProposal.plan.status !== "fitted") throw new Error(`Fixture did not produce a fit: ${freshProposal.plan.status}`);
      await command(edited, { type: "setLayout", presentation: freshProposal.plan.fittedPresentation });
      const fitted = await state();
      const finalPreview = await invoke("render_document_preview", { cursor: fitted.cursor });
      const repeated = await invoke("fit_document_one_page", { cursor: fitted.cursor });
      const afterRepeat = await state();
      await command(fitted, { type: "setLayout", presentation: { ...fitted.document.presentation, fontSizePt: 8 } });
      const small = await state();
      const unreadable = await invoke("fit_document_one_page", { cursor: small.cursor });
      const afterUnreadable = await state();
      return { source, afterPlan, originalPages: preview.data.pages.length, proposal, elapsedMs, edited, afterConflict, conflict,
        freshProposal, fitted, fittedPages: finalPreview.data.pages.length, repeated, afterRepeat, small, unreadable, afterUnreadable };
    });
    assert.ok(data.originalPages > 1);
    assert.equal(data.proposal.plan.status, "fitted");
    assert.ok(data.proposal.plan.attempts.length <= 16);
    assert.deepEqual(data.proposal.cursor, data.source.cursor);
    assert.deepEqual(data.afterPlan, data.source, "planning must not write the draft");
    assert.equal(data.conflict, "CONFLICT");
    assert.deepEqual(data.afterConflict, data.edited, "stale proposal must not overwrite newer data");
    assert.equal(data.fittedPages, 1);
    assert.deepEqual(data.fitted.document.sections, data.edited.document.sections);
    assert.deepEqual(data.fitted.document.basic, data.edited.document.basic);
    assert.equal(data.repeated.plan.status, "alreadyFits");
    assert.equal(data.repeated.plan.attempts.length, 1);
    assert.deepEqual(data.afterRepeat, data.fitted);
    assert.equal(data.unreadable.plan.status, "unreadable");
    assert.deepEqual(data.unreadable.plan.attempts, []);
    assert.equal(data.unreadable.plan.fittedPresentation, null);
    assert.deepEqual(data.afterUnreadable, data.small);
    report.data = data;
    report.passed = true;
    passed = true;
  } catch (error) { report.passed = false; report.error = String(error); throw error; }
  finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
    if (passed) await rm(profile, { recursive: true, maxRetries: 20, retryDelay: 250 });
  }
});
