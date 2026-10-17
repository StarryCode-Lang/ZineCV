import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { startNativeHost, stopNativeHost } from './host-fixture.mjs';

test('production PNG resolution, exact page order and bounded long-image fallback', { timeout: 180000 }, async () => {
const dir = resolve(import.meta.dirname, '../..', process.env.ZINECV_NATIVE_EVIDENCE_OUT_DIR ?? '.artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-current', 'png-boundary');
await mkdir(dir, { recursive: true });
const profile = await mkdtemp(join(dir, 'png-boundary-profile-'));
const report = { scope: 'Real production PNG DPI, white background, page concatenation and limits', passed: false, cases: [] };
let host;
try {
  host = await startNativeHost(profile);
  const seed = async count => host.page.evaluate(async count => {
    const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
    let current = await invoke('document_state');
    const section = current.document.sections.find(section => section.kind === 'summary');
    for (const payload of [
      { type: 'setSectionVisibility', section_id: section.id, visible: true },
      { type: 'setSummaryBody', section_id: section.id, body: Array.from({ length: count }, (_, index) => ({ type: 'paragraph', children: [{ type: 'text', text: `顺序段落${String(index).padStart(3, '0')} 中文 Alpha 42`, marks: [] }] })) },
    ]) {
      await invoke('apply_document_command', { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId, contextId: current.cursor.contextId, expectedRevision: current.cursor.revision, expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload } });
      current = await invoke('document_state');
    }
    return current;
  }, count);
  let frozen = await seed(75);
  const render = async dpi => host.page.evaluate(async ({ cursor, dpi }) => window.__TAURI_INTERNALS__.invoke('render_document_export', { cursor, dpi, product: 'png' }), { cursor: frozen.cursor, dpi });
  const rejectedRender = async dpi => host.page.evaluate(async ({ cursor, dpi }) => {
    try {
      await window.__TAURI_INTERNALS__.invoke('render_document_export', { cursor, dpi, product: 'png' });
      return { rejected: false };
    } catch (error) {
      return { rejected: true, error };
    }
  }, { cursor: frozen.cursor, dpi });
  for (const dpi of [72, 192, 300]) {
    const response = await render(dpi);
    const data = response.data;
    assert.equal(data.dpi, dpi);
    assert.ok(data.pageCount >= 2);
    assert.equal(data.pngPages.length, data.pageCount);
    assert.equal(data.longImageLimited, false);
    const pages = data.pngPages.map(item => PNG.sync.read(Buffer.from(item.dataBase64, 'base64')));
    const long = PNG.sync.read(Buffer.from(data.longPng.dataBase64, 'base64'));
    assert.equal(long.width, pages[0].width);
    assert.equal(long.height, pages.reduce((sum, page) => sum + page.height, 0));
    let offset = 0;
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      assert.equal(data.pngPages[index].page, index + 1);
      assert.deepEqual([...page.data.subarray(0, 4)], [255, 255, 255, 255]);
      assert.deepEqual(long.data.subarray(offset, offset + page.data.length), page.data);
      offset += page.data.length;
    }
    assert.equal(pages[0].width, dpi === 192 ? 1588 : Math.ceil(210 / 25.4 * dpi));
    report.cases.push({ dpi, pageCount: data.pageCount, width: long.width, height: long.height, exactConcatenation: true, whiteBackground: true });
  }
  for (const dpi of [71, 301]) {
    const rejection = await rejectedRender(dpi);
    assert.equal(rejection.rejected, true);
    assert.match(JSON.stringify(rejection.error), /DPI must be between 72 and 300/);
    report.cases.push({ dpi, ...rejection });
  }
  frozen = await seed(210);
  const limited = (await render(300)).data;
  report.limitedPageCount = limited.pageCount;
  assert.ok(limited.pageCount >= 4 && limited.pageCount <= 7);
  assert.equal(limited.longImageLimited, true);
  assert.equal(limited.longPng, null);
  assert.equal(limited.pngPages.length, limited.pageCount);
  report.cases.push({ dpi: 300, pageCount: limited.pageCount, longImageLimited: true, selectedPageImagesPreserved: true });
  frozen = await seed(600);
  const rejection = await rejectedRender(300);
  assert.equal(rejection.rejected, true);
  assert.match(JSON.stringify(rejection.error), /budget|pixels|limit|预算|上限/i);
  report.cases.push({ dpi: 300, excessiveSelectedPixelsRejected: true, error: rejection.error });
  assert.deepEqual(await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('document_state')), frozen);
  report.executableSha256 = createHash('sha256').update(await readFile(resolve('src-tauri/target/release/zinecv-desktop.exe'))).digest('hex');
  report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  if (host) await stopNativeHost(host);
  await writeFile(join(dir, 'png-boundary-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

});
