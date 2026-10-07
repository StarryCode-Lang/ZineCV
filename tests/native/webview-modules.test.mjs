import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { startNativeHost, stopNativeHost } from './host-fixture.mjs';

test('ten modules and summary preserve contents, identities and native restart state', { timeout: 240_000 }, async () => {
  const directory = resolve(import.meta.dirname, '../../.artifacts/remaining/finalization-20261005');
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(join(directory, 'modules-profile-'));
  assert.ok(resolve(profile).startsWith(directory + sep));
  const kinds = ['education', 'skills', 'work', 'projects', 'orgs', 'research', 'awards', 'other', 'portfolio', 'custom'];
  const report = { scope: 'Real WebView2 ten-module add/edit/hide/restore/remove-last and restart acceptance', profile, checks: [], passed: false };
  let host;
  try {
    host = await startNativeHost(profile);
    const page = host.page;
    const state = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('document_state'));
    const settled = async () => {
      await page.locator('.save-state').getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
      return state();
    };
    const manager = async () => {
      await page.getByRole('button', { name: '模块管理', exact: true }).click();
      return page.getByRole('dialog', { name: '模块管理' });
    };
    for (const kind of kinds) {
      let current = await state();
      const original = current.document.sections.find(section => section.kind === kind);
      assert.ok(original, kind);
      assert.equal(original.entries.length, 0);
      const label = original.title;
      const card = page.locator(`[data-editor-module="${kind}"]`);
      if (!original.visible) {
        const dialog = await manager();
        await dialog.getByRole('button', { name: `恢复${label}`, exact: true }).click();
      }
      await card.waitFor();
      if (await card.locator('.module-collapse-button').getAttribute('aria-expanded') === 'false')
        await card.locator('.module-collapse-button').click();
      await card.locator('.add-entry').click();
      const entry = card.locator('[data-editor-entry-id]').first();
      await entry.waitFor();
      const id = await entry.getAttribute('data-editor-entry-id');
      const text = `十模块验收-${kind}`;
      if (kind === 'skills') await entry.locator('[contenteditable="true"]').fill(text);
      else await entry.locator('input').first().fill(text);
      await page.waitForFunction(async ({kind, text}) => {
        const current = await window.__TAURI_INTERNALS__.invoke('document_state');
        const entries = current.document.sections.find(section => section.kind === kind).entries;
        return entries.length === 1 && JSON.stringify(entries[0]).includes(text) && document.querySelector('.save-state')?.textContent.includes('草稿已保存');
      }, { kind, text });
      const before = (await settled()).document.sections.find(section => section.kind === kind);
      const dialog = await manager();
      await dialog.getByRole('button', { name: `隐藏${label}`, exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '删除模块', exact: true }).click();
      await card.waitFor({ state: 'detached' });
      await page.waitForFunction(async kind => !(await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections.find(section => section.kind === kind).visible, kind);
      const hidden = (await state()).document.sections.find(section => section.kind === kind);
      assert.deepEqual(hidden.entries, before.entries, 'hide must preserve complete entry contents');
      const restoreDialog = await manager();
      await restoreDialog.getByRole('button', { name: `恢复${label}`, exact: true }).click();
      await card.waitFor();
      await page.waitForFunction(async kind => (await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections.find(section => section.kind === kind).visible, kind);
      const restored = (await state()).document.sections.find(section => section.kind === kind);
      assert.deepEqual(restored.entries, before.entries, 'restore must preserve entry identity and contents');
      await card.getByRole('button', { name: '删除经历', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: '删除经历', exact: true }).click();
      await page.waitForFunction(async kind => (await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections.find(section => section.kind === kind).entries.length === 0, kind);
      assert.equal(await card.locator('[data-editor-entry-id]').count(), 0);
      report.checks.push({ kind, sectionId: original.id, entryId: id, edited: true, hiddenPreservesContents: true, restoredPreservesIdentity: true, lastEntryRemoved: true });
    }
    let current = await state();
    const summarySection = current.document.sections.find(section => section.kind === 'summary');
    if (!summarySection.visible) {
      const dialog = await manager();
      await dialog.getByRole('button', { name: `恢复${summarySection.title}`, exact: true }).click();
    }
    const summaryCard = page.locator('[data-editor-module="summary"]');
    if (!(await summaryCard.locator('[contenteditable="true"]').isVisible()))
      await summaryCard.getByRole('button', { name: '展开自我评价', exact: true }).first().click();
    await summaryCard.locator('[contenteditable="true"]').fill('真实 UI 自我评价验收');
    await page.waitForFunction(async () => JSON.stringify((await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections.find(section => section.kind === 'summary').body).includes('真实 UI 自我评价验收'));
    const summaryBefore = (await state()).document.sections.find(section => section.kind === 'summary');
    let dialog = await manager();
    await dialog.getByRole('button', { name: `隐藏${summarySection.title}`, exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '删除模块', exact: true }).click();
    await summaryCard.waitFor({ state: 'detached' });
    await page.waitForFunction(async () => !(await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections.find(section => section.kind === 'summary').visible);
    assert.deepEqual((await state()).document.sections.find(section => section.kind === 'summary').body, summaryBefore.body);
    dialog = await manager();
    await dialog.getByRole('button', { name: `恢复${summarySection.title}`, exact: true }).click();
    await summaryCard.waitFor();
    if (!(await summaryCard.locator('[contenteditable="true"]').isVisible()))
      await summaryCard.getByRole('button', { name: '展开自我评价', exact: true }).first().click();
    assert.equal(await summaryCard.locator('[contenteditable="true"]').textContent(), '真实 UI 自我评价验收');
    await summaryCard.locator('[contenteditable="true"]').fill('');
    await page.waitForFunction(async () => !(await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections.find(section => section.kind === 'summary').body.some(block => JSON.stringify(block).includes('真实 UI 自我评价验收')));
    report.summary = { edited: true, hiddenPreservesBody: true, restoredPreservesBody: true, emptied: true };
    // Identical user-facing titles must retain distinct stable section identities.
    dialog = await manager();
    for (const kind of ['education', 'work']) {
      const row = dialog.locator(`[data-manager-section="${kind}"]`);
      await row.getByRole('button', { name: /^编辑/ }).click();
      await row.locator('input').fill('同名验收模块');
      await row.locator('input').press('Enter');
    }
    const summaryRow = dialog.locator('[data-manager-section="summary"]');
    await summaryRow.getByRole('button', { name: '编辑自我评价名称', exact: true }).click();
    await summaryRow.locator('input').fill('验收自我评价名称');
    await summaryRow.locator('input').press('Enter');
    await dialog.getByRole('button', { name: '关闭模块管理' }).click();
    await page.waitForFunction(async () => {
      const sections = (await window.__TAURI_INTERNALS__.invoke('document_state')).document.sections;
      return sections.find(section => section.kind === 'education').title === '同名验收模块'
        && sections.find(section => section.kind === 'work').title === '同名验收模块'
        && sections.find(section => section.kind === 'summary').title === '验收自我评价名称';
    });
    const beforeRestart = (await settled()).document;
    assert.notEqual(beforeRestart.sections.find(section => section.kind === 'education').id, beforeRestart.sections.find(section => section.kind === 'work').id);
    report.distinctSameNamedSections = true;
    report.summaryNameSaved = true;
    await stopNativeHost(host); host = undefined;
    host = await startNativeHost(profile);
    const afterRestart = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('document_state'));
    assert.deepEqual(afterRestart.document, beforeRestart);
    report.restartPreservesDocument = true;
    report.executableSha256 = createHash('sha256').update(await readFile(resolve('src-tauri/target/release/zinecv-desktop.exe'))).digest('hex');
    report.passed = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    if (host) await stopNativeHost(host);
    report.fixtureSha256 = createHash('sha256').update(await readFile(import.meta.filename)).digest('hex');
    await writeFile(join(directory, 'modules.json'), JSON.stringify(report, null, 2) + '\n');
    if (report.passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    console.log(JSON.stringify(report));
  }

});
