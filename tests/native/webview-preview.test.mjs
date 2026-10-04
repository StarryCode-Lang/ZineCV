import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { PNG } from "pngjs";
import { DatabaseSync } from "node:sqlite";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = join(root, ".artifacts/remaining/R12/session3-preview");
test("real worker preview freezes avatar and cursor, hashes pages and preserves SQLite state", { timeout: 120_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  const report = { fixture: "synthetic isolated production WebView2 and render worker" };
  let host, passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPid = host.child.pid;
    await host.page.exposeFunction("previewLeaseCount", () => {
      const database = new DatabaseSync(join(profile, "Data/zinecv.sqlite3"), { readOnly: true });
      try { return database.prepare("SELECT COUNT(*) AS count FROM resource_leases").get().count; }
      finally { database.close(); }
    });
    const source = await readFile(join(root, "src/preview/enginePreview.ts"), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      .replace('import { nativeInvoke } from "../platform/ipc";', 'const nativeInvoke = window.__TAURI_INTERNALS__.invoke;')
      .replace(/^export /gm, "");
    const selectionCode = ts.transpileModule(await readFile(join(root, "src/preview/textSelection.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^export /gm, "");
    const png = new PNG({ width: 8, height: 8 });
    png.data.fill(180);
    const image = "data:image/png;base64," + PNG.sync.write(png).toString("base64");
    const data = await host.page.evaluate(async ({ code, selectionCode, image }) => {
      const { verifyPreview, EnginePageCache } = new Function(code + "; return { verifyPreview, EnginePageCache };")();
      const { offsetAtPoint, selectedText } = new Function(selectionCode + "; return { offsetAtPoint, selectedText };")();
      const invoke = async (command, args) => {
        try { return await window.__TAURI_INTERNALS__.invoke(command, args); }
        catch (error) { throw new Error(`${command}: ${JSON.stringify(error)}`); }
      };
      const initial = await invoke("document_state");
      const asset = await invoke("store_avatar_asset", { cursor: initial.cursor, dataUrl: image, previousHash: null });
      const edit = async (state, name, avatarAssetId) => invoke("apply_document_command", { envelope: {
        protocolVersion: 1, commandId: crypto.randomUUID(), documentId: state.cursor.documentId,
        contextId: state.cursor.contextId, expectedRevision: state.cursor.revision,
        expectedBranchId: state.cursor.branchId, expectedHeadId: state.cursor.headId,
        payload: { type: "updateBasic", patch: { name, avatarAssetId } },
      } });
      await edit(initial, "合成冻结预览", asset.hash);
      const before = await invoke("document_state");
      const beforeLeases = await window.previewLeaseCount();
      const first = await invoke("render_document_preview", { cursor: before.cursor });
      await verifyPreview(first, before.cursor);
      const repeated = await invoke("render_document_preview", { cursor: before.cursor });
      await verifyPreview(repeated, before.cursor);
      const after = await invoke("document_state");
      const afterLeases = await window.previewLeaseCount();
      const cache = new EnginePageCache();
      const firstLease = cache.acquire(first.data.pages[0]);
      const repeatLease = cache.acquire(repeated.data.pages[0]);
      const sharedObjectUrl = firstLease.url === repeatLease.url;
      const imageNode = new Image(); imageNode.src = firstLease.url; await imageNode.decode();
      const decodedSize = [imageNode.naturalWidth, imageNode.naturalHeight];
      firstLease.release(); repeatLease.release(); cache.dispose();
      await edit(after, "合成新修订", asset.hash);
      const next = await invoke("document_state");
      const changed = await invoke("render_document_preview", { cursor: next.cursor });
      await verifyPreview(changed, next.cursor);
      let staleCode;
      try { await window.__TAURI_INTERNALS__.invoke("render_document_preview", { cursor: before.cursor }); }
      catch (error) { staleCode = error.code; }
      const malformed = await invoke("store_avatar_asset", { cursor: next.cursor, previousHash: null,
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9xoAAAAASUVORK5CYII=" });
      await edit(next, "合成失败路径", malformed.hash);
      const failedState = await invoke("document_state");
      const failureBeforeLeases = await window.previewLeaseCount();
      let failureCode;
      try { await window.__TAURI_INTERNALS__.invoke("render_document_preview", { cursor: failedState.cursor }); }
      catch (error) { failureCode = error.code; }
      const failureAfterLeases = await window.previewLeaseCount();
      await edit(failedState, "合成恢复路径", asset.hash);
      const recoveryState = await invoke("document_state");
      const recovered = await invoke("render_document_preview", { cursor: recoveryState.cursor });
      await verifyPreview(recovered, recoveryState.cursor);
      const summary = recoveryState.document.sections.find(section => section.kind === "summary");
      if (!summary) throw new Error("Synthetic native document needs a summary section");
      const command = async payload => {
        const state = await invoke("document_state");
        await invoke("apply_document_command", { envelope: { protocolVersion:1,commandId:crypto.randomUUID(),documentId:state.cursor.documentId,contextId:state.cursor.contextId,expectedRevision:state.cursor.revision,expectedBranchId:state.cursor.branchId,expectedHeadId:state.cursor.headId,payload } });
      };
      await command({type:"setSectionVisibility",section_id:summary.id,visible:true});
      const longText = "原生跨页链接合成内容 ".repeat(1000);
      await command({type:"setSummaryBody",section_id:summary.id,body:[{type:"paragraph",children:[{type:"link",href:"https://example.invalid/native-cross-page",children:[{type:"text",text:longText,marks:[]}]}]},{type:"paragraph",children:[{type:"text",text:"中文 A אבג 123 ד E",marks:[]}]}]});
      const longState = await invoke("document_state");
      const crossPage = await invoke("render_document_preview",{cursor:longState.cursor});
      await verifyPreview(crossPage,longState.cursor);
      const link = crossPage.data.textMap.links.find(link=>link.href==="https://example.invalid/native-cross-page");
      if (!link) throw new Error("Native preview lost its canonical link destination");
      const clusters = crossPage.data.textMap.clusters.filter(cluster=>cluster.sourceNodeId===link.sourceNodeId);
      const firstCluster=clusters[0],lastCluster=clusters.at(-1);
      const anchor=offsetAtPoint(crossPage.data.textMap,firstCluster.page,firstCluster.xPt+firstCluster.widthPt*.25,firstCluster.yPt+firstCluster.heightPt*.5);
      const focus=offsetAtPoint(crossPage.data.textMap,lastCluster.page,lastCluster.xPt+lastCluster.widthPt*.75,lastCluster.yPt+lastCluster.heightPt*.5);
      const copied=selectedText(crossPage.data.textMap,{anchor:link.startUtf16,focus:link.endUtf16});
      const pointerCopied=selectedText(crossPage.data.textMap,{anchor,focus});
      const clusterText=cluster=>crossPage.data.textMap.logicalText.slice(cluster.startUtf16,cluster.endUtf16);
      const hebrew=crossPage.data.textMap.clusters.filter(cluster=>['א','ב','ג'].includes(clusterText(cluster)));
      if(hebrew.length!==3 || !hebrew.every(cluster=>cluster.rtl)) throw new Error('Native mixed-direction clusters are incomplete');
      const rtlAnchor=offsetAtPoint(crossPage.data.textMap,hebrew[0].page,hebrew[0].xPt+hebrew[0].widthPt*.75,hebrew[0].yPt+hebrew[0].heightPt*.5);
      const rtlFocus=offsetAtPoint(crossPage.data.textMap,hebrew[2].page,hebrew[2].xPt+hebrew[2].widthPt*.25,hebrew[2].yPt+hebrew[2].heightPt*.5);
      const bidiCopy=selectedText(crossPage.data.textMap,{anchor:rtlAnchor,focus:rtlFocus});
      const bidiReverseCopy=selectedText(crossPage.data.textMap,{anchor:rtlFocus,focus:rtlAnchor});
      return { before, after, first, repeated, changed, staleCode, sharedObjectUrl, decodedSize,
        beforeLeases, afterLeases, failureBeforeLeases, failureAfterLeases, failureCode, recovered: recovered.data.textMap.logicalText,
        crossPage,link,longText,copied,pointerCopied,anchor,focus,linkPages:[...new Set(clusters.map(cluster=>cluster.page))],longStateUnchanged:JSON.stringify(await invoke("document_state"))===JSON.stringify(longState),bidiCopy,bidiReverseCopy,rtlAnchor,rtlFocus,hebrew };
    }, { code, selectionCode, image });
    assert.deepEqual(data.after, data.before, "preview must not mutate the draft or cursor");
    assert.deepEqual(data.first, data.repeated, "same frozen input must be deterministic");
    assert.equal(data.sharedObjectUrl, true);
    assert.ok(data.decodedSize.every(value => value > 0));
    assert.equal(data.staleCode, "CONFLICT");
    assert.equal(data.afterLeases, data.beforeLeases, "successful previews release temporary avatar leases");
    assert.equal(data.failureCode, "ENGINE_FAILURE");
    assert.equal(data.failureAfterLeases, data.failureBeforeLeases, "failed previews release temporary avatar leases");
    assert.match(data.recovered, /合成恢复路径/);
    assert.notEqual(data.first.renderKey, data.changed.renderKey);
    assert.notEqual(data.first.data.pages[0].pageHash, data.changed.data.pages[0].pageHash);
    assert.match(data.changed.data.textMap.logicalText, /合成新修订/);
    assert.ok(data.linkPages.length > 1, "actual native link spans multiple compiled pages");
    assert.equal(data.copied,data.longText);
    assert.equal(data.anchor,data.link.startUtf16);
    assert.equal(data.pointerCopied,data.longText.slice(0,data.focus-data.link.startUtf16));
    assert.equal(data.longStateUnchanged,true);
    assert.equal(data.bidiCopy,'אבג');assert.equal(data.bidiReverseCopy,'אבג');
    assert.ok(data.hebrew[0].xPt>data.hebrew[1].xPt && data.hebrew[1].xPt>data.hebrew[2].xPt);
    for (const frame of [data.first, data.changed, data.crossPage]) for (const page of frame.data.pages) {
      assert.equal(createHash("sha256").update(page.svg).digest("hex"), page.pageHash);
    }
    await writeFile(join(evidenceRoot, "first-preview.json"), JSON.stringify(data.first, null, 2));
    await writeFile(join(evidenceRoot, "changed-preview.json"), JSON.stringify(data.changed, null, 2));
    await writeFile(join(evidenceRoot, "cross-page-link-preview.json"), JSON.stringify(data.crossPage, null, 2));
    Object.assign(report, { status: "passed", frozenStateUnchanged: true, deterministic: true,
      avatarAssetId: data.before.document.basic.avatarAssetId, staleCode: data.staleCode,
      sharedObjectUrl: data.sharedObjectUrl, decodedSize: data.decodedSize,
      leaseCounts: { before: data.beforeLeases, after: data.afterLeases, failureBefore: data.failureBeforeLeases, failureAfter: data.failureAfterLeases },
      failureCode: data.failureCode, recoveredAfterFailure: true,
      renderKeys: [data.first.renderKey, data.changed.renderKey], pageHashes: data.first.data.pages.map(page => page.pageHash),
      crossPageLink: { href:data.link.href,sourceNodeId:data.link.sourceNodeId,pages:data.linkPages,utf16Units:data.copied.length,exactDomainCopy:true,pointerCopy:true,frozenStateUnchanged:data.longStateUnchanged },
      bidi: { copied:data.bidiCopy,reverseCopied:data.bidiReverseCopy,anchor:data.rtlAnchor,focus:data.rtlFocus,clusters:data.hebrew } });
    passed = true;
  } catch (error) {
    report.status = "failed"; report.failure = String(error.stack ?? error);
    throw error;
  } finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "preview-evidence.json"), JSON.stringify(report, null, 2));
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
