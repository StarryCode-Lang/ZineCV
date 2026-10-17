import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startNativeHost, stopNativeHost } from './host-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, process.env.ZINECV_NATIVE_EVIDENCE_OUT_DIR ?? '.artifacts/runtime-tmp/test-evidence', 'editor-contracts');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invoke = (page, name, args = {}) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args).catch(error => { throw new Error(name + ': ' + JSON.stringify(error)); }), { name, args });
const state = page => invoke(page, 'document_state');
const saved = page => page.locator('.save-state').getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
async function edit(page, payload) {
  const current = await state(page);
  return invoke(page, 'apply_document_command', { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId, contextId: current.cursor.contextId, expectedRevision: current.cursor.revision, expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload } });
}
async function selectText(editor, text) {
  await editor.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, start = node.textContent.indexOf(text);
      if (start < 0) continue;
      root.focus();
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return;
    }
    throw new Error('Selection text missing: ' + text);
  }, text);
}
async function changed(page, action) {
  const before = (await state(page)).cursor.revision;
  await action();
  await page.waitForFunction(async previous => (await window.__TAURI_INTERNALS__.invoke('document_state')).cursor.revision !== previous && document.querySelector('.save-state')?.textContent.includes('草稿已保存'), before);
}
async function openEditor(page) {
  const minimize = page.getByRole('button', { name: '最小化到 Bot', exact: true });
  if (await minimize.isVisible()) await minimize.click();
  await page.getByRole('button', { name: '简历编辑', exact: true }).click();
}

test('production rich-text tools, history boundaries, entry ordering and finite layout/export combinations survive native restart', { timeout: 600_000 }, async () => {
  await mkdir(out, { recursive: true });
  const profile = await mkdtemp(join(out, 'profile-'));
  const report = { passed: false, scope: 'Real Windows WebView2; owned synthetic input; 3 templates x 3 densities x 2 avatar states. Finite contract coverage, not human IME/visual acceptance or all arbitrary input combinations.', rich: [], ordering: [], layouts: [], pageErrors: [] };
  let host;
  try {
    host = await startNativeHost(profile); let page = host.page;
    const watch = page => page.on('pageerror', error => report.pageErrors.push(error.message)); watch(page);
    let current = await state(page);
    for (const section of current.document.sections) await edit(page, { type: 'setSectionVisibility', section_id: section.id, visible: section.kind === 'summary' || section.kind === 'work' });
    const summaryId = current.document.sections.find(s => s.kind === 'summary').id;
    const workId = current.document.sections.find(s => s.kind === 'work').id;
    const paragraph = text => ({ type: 'paragraph', children: [{ type: 'text', text, marks: [] }] });
    await edit(page, { type: 'setSummaryBody', section_id: summaryId, body: [paragraph('粗体 斜体 下划线 删除线 链接目标 清除格式 原生正文')] });
    const fixture = JSON.parse(await readFile(join(root, 'fixtures/remaining/documents/one-page.json'), 'utf8'));
    const sourceEntry = fixture.sections.find(s => s.kind === 'work').entries[0];
    for (let i = 0; i < 4; i++) await edit(page, { type: 'addEntry', section_id: workId, entry: { ...sourceEntry, id: 'native-order-' + i, title: '同名合成经历', role: '超长职位用于双行标题与日期组合验证'.repeat(2), start: '2001-01', end: '2026-10', body: [paragraph('独立正文' + i)] } });
    await page.reload({ waitUntil: 'commit' }); await saved(page); await openEditor(page);
    const summary = page.locator('[data-editor-module="summary"]');
    if (!await summary.locator('[contenteditable="true"]').isVisible()) await summary.getByRole('button', { name: '展开自我评价', exact: true }).first().click();
    const rich = summary.locator('[contenteditable="true"]'), toolbar = summary.locator('.rich-toolbar');
    for (const [label, tag] of [['粗体', '(?:b|strong)'], ['斜体', '(?:i|em)'], ['下划线', 'u'], ['删除线', '(?:s|strike|del)']]) {
      await selectText(rich, label);
      await changed(page, () => toolbar.getByRole('button', { name: label, exact: true }).click());
      assert.match(await rich.innerHTML(), new RegExp(`<${tag}>${label}</${tag}>`)); report.rich.push(label);
    }
    const beforeUndo = structuredClone((await state(page)).document);
    await changed(page, () => toolbar.getByRole('button', { name: '撤销', exact: true }).click());
    assert.doesNotMatch(await rich.innerHTML(), /<(?:s|strike|del)>删除线/);
    await changed(page, () => toolbar.getByRole('button', { name: '重做', exact: true }).click());
    assert.deepEqual((await state(page)).document, beforeUndo);
    for (const label of ['编号列表', '项目符号']) {
      await selectText(rich, '原生正文');
      await changed(page, () => toolbar.getByRole('button', { name: label, exact: true }).click());
      assert.match(await rich.innerHTML(), label === '编号列表' ? /<ol>/ : /<ul>/);
      await changed(page, () => toolbar.getByRole('button', { name: '撤销', exact: true }).click()); report.rich.push(label);
    }
    await selectText(rich, '清除格式');
    await changed(page, () => toolbar.getByRole('button', { name: '粗体', exact: true }).click());
    await changed(page, () => toolbar.getByRole('button', { name: '清除格式', exact: true }).click());
    assert.doesNotMatch(await rich.innerHTML(), /<(?:b|strong)>清除格式/);
    await selectText(rich, '链接目标'); await toolbar.getByRole('button', { name: '插入链接', exact: true }).click();
    await page.getByLabel('链接地址', { exact: true }).fill('javascript:alert(1)'); await page.getByRole('button', { name: '保存链接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '请输入有效' }).waitFor();
    await page.getByLabel('链接地址', { exact: true }).fill('https://example.invalid/native');
    await changed(page, () => page.getByRole('button', { name: '保存链接', exact: true }).click());
    assert.match(await rich.innerHTML(), /href="https:\/\/example.invalid\/native"/);
    await selectText(rich, '原生正文'); await toolbar.getByRole('button', { name: '插入链接', exact: true }).click();
    await page.getByLabel('链接地址', { exact: true }).fill('https://discarded.invalid'); await page.getByLabel('链接地址', { exact: true }).press('Escape');
    await page.getByRole('dialog', { name: '插入或编辑链接' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '原生正文');
    assert.doesNotMatch(await rich.innerHTML(), /discarded.invalid/);
    await rich.press('Control+End');
    await changed(page, () => rich.evaluate(root => { const data = new DataTransfer(); data.setData('text/html', '<p onclick="window.pastePwned=true">合成粘贴<b>加粗</b><a href="javascript:alert(1)">危险链接</a><img src=x onerror="window.pastePwned=true"></p><ul><li><p>列表组合正文</p></li></ul><ol start="4"><li><p>编号组合正文</p></li></ol>'); root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }));
    assert.doesNotMatch(await rich.innerHTML(), /javascript:|<img|onclick|onerror/); assert.equal(await page.evaluate(() => window.pastePwned), undefined);
    assert.match(await rich.innerHTML(), /<ul>/); assert.match(await rich.innerHTML(), /<ol start="4">/);
    await rich.press('Control+End');
    await changed(page, () => rich.evaluate(root => { const data = new DataTransfer(); data.setData('text/plain', '纯文本第一行\n纯文本第二行'); root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }));
    assert.match(await rich.innerHTML(), /纯文本第一行<br>纯文本第二行/);
    report.rich.push('undo-redo-durable', 'remove-format', 'link-validation-and-cancel-selection', 'sanitized-paste', 'plain-text-paste', 'retained-nested-format-lists');

    const richDocument = (await state(page)).document;
    await page.getByRole('button', { name: '版本管理', exact: true }).first().click(); await page.getByLabel('版本说明').fill('原生富文本边界');
    await page.getByRole('button', { name: '提交到当前分支', exact: true }).click();
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke('version_graph_detailed')).commits.some(c => c.message === '原生富文本边界'));
    const commit = (await invoke(page, 'version_graph_detailed')).commits.find(c => c.message === '原生富文本边界');
    await openEditor(page);
    await changed(page, () => rich.fill('不应跨历史恢复的合成临时编辑'));
    await page.getByRole('button', { name: '版本管理', exact: true }).first().click(); await page.locator(`[data-version-commit-id="${commit.id}"].branch-tree-node`).click();
    await page.getByRole('button', { name: '载入', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '载入此版本', exact: true }).click();
    await page.waitForFunction(async expected => JSON.stringify((await window.__TAURI_INTERNALS__.invoke('document_state')).document) === JSON.stringify(expected), richDocument);
    await openEditor(page);
    if (!await rich.isVisible()) await summary.getByRole('button', { name: '展开自我评价', exact: true }).first().click();
    await toolbar.getByRole('button', { name: '撤销', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await saved(page);
    assert.deepEqual((await state(page)).document, richDocument, 'undo cannot cross history-load boundary');
    report.rich.push('history-load-resets-local-undo');

    const work = page.locator('[data-editor-module="work"]');
    if (await work.locator('.module-collapse-button').getAttribute('aria-expanded') === 'false') await work.locator('.module-collapse-button').click();
    const handles = work.getByRole('button', { name: '拖动经历排序', exact: true });
    const baseEntries = (await state(page)).document.sections.find(s => s.kind === 'work').entries;
    await changed(page, () => handles.first().press('ArrowDown'));
    assert.equal((await state(page)).document.sections.find(s => s.kind === 'work').entries[1].id, baseEntries[0].id);
    const first = work.locator('[data-editor-entry-id]').first(), second = work.locator('[data-editor-entry-id]').nth(1);
    await first.scrollIntoViewIfNeeded(); const a = await first.getByRole('button', { name: '拖动经历排序', exact: true }).boundingBox(), b = await second.boundingBox();
    await changed(page, async () => { await page.mouse.move(a.x+8,a.y+8); await page.mouse.down(); await page.mouse.move(b.x+50,b.y+b.height*.85); await page.mouse.up(); });
    const finalEntries = (await state(page)).document.sections.find(s => s.kind === 'work').entries;
    assert.deepEqual(finalEntries.map(e => e.id), baseEntries.map(e => e.id), 'pointer moves the keyboard-swapped entry back');
    assert.deepEqual([...finalEntries].sort((a,b)=>a.id.localeCompare(b.id)), [...baseEntries].sort((a,b)=>a.id.localeCompare(b.id)));
    report.ordering.push({ keyboardAndPointer: true, entries: finalEntries.map(e => e.id), completeContentsPreserved: true });

    // The matrix exhausts these three finite dimensions. Other controls are
    // varied across rows; the existing controls gate tests every allowed value.
    for (const templateId of ['legacy-v1', 'clear-single-v1', 'compact-single-v1']) for (const density of ['comfortable', 'standard', 'compact']) for (const avatar of [false, true]) {
      await openEditor(page);
      const basicExpand = page.getByRole('button', { name: '展开基本信息', exact: true }); if (await basicExpand.count()) await basicExpand.click();
      const basic = page.locator('.basic-form');
      if (avatar) {
        await changed(page, () => basic.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNwbLpEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEeTVFuQ1+SNAAAAAElFTkSuQmCC', 'base64') }));
      } else {
        const remove = basic.getByRole('button', { name: '移除头像', exact: true }); if (await remove.count()) await changed(page, () => remove.click());
      }
      const index = report.layouts.length;
      const presentation = { ...(await state(page)).document.presentation, templateId, density, fontSizePt: (10 + index % 9)*.75, lineHeightPt: (19 + index % 9)*.75, pageMarginPt: (20 + index % 3*15)*.75, moduleGapPt: index%3*11.25, theme: ['#000000','#4183ff','#ca3832'][index%3], dateFormat: index%2 ? '2021.01' : '2021年1月', titleFormat: index%2 ? '双行标题' : '单行标题', separator: index%2 ? '不使用分隔符号' : '使用分隔符号', textAlign: index%2 ? '系统默认' : '两端对齐' };
      // Seed a consistent canonical/legacy pair, as the UI bridge writes it.
      presentation.legacyOverrides = { headingFontSize: String(presentation.headingSizePt/.75), paragraphSpacing: String(presentation.paragraphGapPt/.75), listSpacing: String(presentation.listGapPt/.75), ...Object.fromEntries(Object.entries({ font: presentation.fontSetId.replace(/^legacy-font:/, ''), fontSize: String(presentation.fontSizePt/.75), lineHeight: String(presentation.lineHeightPt/.75), moduleSpacing: String(presentation.moduleGapPt/.75), pageMargin: String(presentation.pageMarginPt/.75), theme: presentation.theme, dateFormat: presentation.dateFormat, titleFormat: presentation.titleFormat, separator: presentation.separator, textAlign: presentation.textAlign }).map(([key,value]) => ['legacyLayout.'+key,value])) };
      await edit(page, { type: 'setLayout', presentation });
      await page.reload({ waitUntil: 'commit' }); await saved(page); await openEditor(page); await page.evaluate(() => document.fonts.ready);
      const frozen = await state(page);
      assert.deepEqual(frozen.document.presentation, presentation);
      assert.equal(Boolean(frozen.document.basic.avatarAssetId), avatar);
      const preview = await invoke(page, 'render_document_preview', { cursor: frozen.cursor });
      const pdf = await invoke(page, 'render_document_export', { cursor: frozen.cursor, product: 'pdf' });
      const png = await invoke(page, 'render_document_export', { cursor: frozen.cursor, product: 'png', dpi: [72,192,300][index%3] });
      assert.equal(pdf.data.pageCount, preview.data.pages.length); assert.equal(png.data.pageCount, pdf.data.pageCount);
      assert.ok(Buffer.from(pdf.data.pdfBase64, 'base64').subarray(0,5).equals(Buffer.from('%PDF-')));
      const logical = pdf.data.textMap.logicalText.replace(/\s/g,'');
      for (const token of ['粗体','斜体','下划线','删除线','链接目标','合成粘贴','列表组合正文','编号组合正文','纯文本第一行','纯文本第二行','独立正文0','独立正文1','独立正文2','独立正文3']) assert.ok(logical.includes(token), token);
      const dom = await page.locator('.paper-frame .paper').evaluateAll(nodes => nodes.map(node => ({ width: parseFloat(getComputedStyle(node).width), height: parseFloat(getComputedStyle(node).height), text: node.innerText })));
      assert.equal(dom.length, pdf.data.pageCount);
      for (const p of dom) { assert.ok(Math.abs(p.width-794)<=1); assert.ok(Math.abs(p.height-1123)<=1); }
      assert.ok(dom.map(p=>p.text).join('').replace(/\s/g,'').includes('独立正文3'));
      assert.deepEqual(await state(page), frozen, 'preview/PDF/PNG must preserve frozen source');
      report.layouts.push({ templateId, density, avatar, presentation, cursor: frozen.cursor, pages: pdf.data.pageCount, pdfSha256: sha(Buffer.from(pdf.data.pdfBase64,'base64')), pngDpi: [72,192,300][index%3], geometry: dom.map(({width,height})=>({width,height})) });
    }
    const beforeRestart = (await state(page)).document;
    await page.screenshot({ path: join(out, 'editor.png'), animations: 'disabled' });
    await stopNativeHost(host); host = undefined; host = await startNativeHost(profile); page = host.page; watch(page);
    assert.deepEqual((await state(page)).document, beforeRestart);
    const restartedSummary = page.locator('[data-editor-module="summary"]');
    if (!await restartedSummary.locator('[contenteditable="true"]').isVisible()) await restartedSummary.getByRole('button', { name: '展开自我评价', exact: true }).first().click();
    await restartedSummary.getByRole('button', { name: '撤销', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await saved(page);
    assert.deepEqual((await state(page)).document, beforeRestart, 'restart cannot resurrect an old editor undo stack');
    assert.deepEqual(report.pageErrors, []);
    report.restartPreservesDocument = true; report.executableSha256 = sha(await readFile(join(root, 'src-tauri/target/release/zinecv-desktop.exe'))); report.passed = true;
  } catch (error) { report.error = error.stack; if (host) report.visibleText = await host.page.locator('body').innerText().catch(()=> ''); throw error; }
  finally { if (host) await stopNativeHost(host); report.fixtureSha256 = sha(await readFile(import.meta.filename)); await writeFile(join(out, 'report.json'), JSON.stringify(report,null,2)+'\n'); if (report.passed) await rm(profile,{recursive:true,force:true,maxRetries:15,retryDelay:200}); }
});
