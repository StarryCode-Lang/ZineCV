import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { startNativeHost, stopNativeHost } from './host-fixture.mjs';

test('ten modules and summary preserve contents, identities and native restart state', { timeout: 240_000 }, async () => {
  const directory = resolve(import.meta.dirname, '../../.artifacts/runtime-tmp/test-evidence/finalization-20261005');
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(join(directory, 'modules-profile-'));
  assert.ok(resolve(profile).startsWith(directory + sep));
  const kinds = ['education', 'skills', 'work', 'projects', 'orgs', 'research', 'awards', 'other', 'portfolio', 'custom'];
  const report = { scope: 'Real WebView2 basic fields/avatar and ten-module add/edit/hide/restore/remove-last and restart acceptance', profile, checks: [], passed: false };
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
    // Exercise the actual BasicForm, then include its complete durable state in
    // the existing restart comparison instead of launching a separate host.
    const expandBasic = page.getByRole('button', { name: '展开基本信息', exact: true });
    if (await expandBasic.count()) await expandBasic.click();
    const basicForm = page.locator('.basic-form');
    const fields = [
      ['姓名', 'name', '合成字段验收'], ['电话', 'phone', '+86-13800000000-合成长联系方式'],
      ['邮箱', 'email', 'synthetic-fields@example.invalid'], ['现居城市', 'city', '合成城市'],
      ['微信', 'wechat', 'synthetic-contact'], ['年龄或生日', 'birth', '2000-05'],
      ['个人网站 1', 'website', 'https://example.invalid/synthetic'],
      ['个人网站 2', 'linkedin', 'https://example.invalid/profile'],
      ['性别', 'gender', '合成性别'], ['身高', 'height', '170cm'], ['体重', 'weight', '60kg'],
      ['民族', 'ethnicity', '合成民族'], ['籍贯', 'birthplace', '合成籍贯'],
      ['政治面貌', 'politicalStatus', '合成政治面貌'], ['婚姻状况', 'maritalStatus', '合成婚姻状况'],
      ['星座', 'zodiac', '合成星座'], ['MBTI', 'mbti', 'INTJ'],
    ];
    for (const [label, , value] of fields) {
      if (!await basicForm.getByLabel(label, { exact: true }).count())
        await basicForm.getByRole('button', { name: `＋${label}`, exact: true }).click();
      await basicForm.getByLabel(label, { exact: true }).fill(value);
    }
    await basicForm.getByRole('button', { name: '生日', exact: true }).click();
    const expectedBasic = Object.fromEntries(fields.map(([, key, value]) => [key, value]));
    expectedBasic.ageMode = 'birthday';
    await page.waitForFunction(async expected => {
      const basic = (await window.__TAURI_INTERNALS__.invoke('document_state')).document.basic;
      return Object.entries(expected).every(([key, value]) => basic[key] === value)
        && document.querySelector('.save-state')?.textContent.includes('草稿已保存');
    }, expectedBasic);
    const avatarInput = basicForm.locator('input[type="file"][accept="image/*"]');
    const avatars = [
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO45OhIU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULADN3UEwVZ+UsAAAAAElFTkSuQmCC',
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGNwbLpEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEeTVFuQ1+SNAAAAAElFTkSuQmCC',
    ];
    const uploadAvatar = async (index, previous) => {
      await avatarInput.setInputFiles({ name: `synthetic-avatar-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(avatars[index], 'base64') });
      await basicForm.getByAltText('头像预览', { exact: true }).waitFor();
      await page.waitForFunction(async previous => {
        const hash = (await window.__TAURI_INTERNALS__.invoke('document_state')).document.basic.avatarAssetId;
        return Boolean(hash) && hash !== previous && document.querySelector('.save-state')?.textContent.includes('草稿已保存');
      }, previous);
      return (await state()).document.basic.avatarAssetId;
    };
    const addedAvatar = await uploadAvatar(0, null);
    const replacedAvatar = await uploadAvatar(1, addedAvatar);
    assert.notEqual(replacedAvatar, addedAvatar);
    await basicForm.getByRole('button', { name: '移除头像', exact: true }).click();
    await page.waitForFunction(async () => !(await window.__TAURI_INTERNALS__.invoke('document_state')).document.basic.avatarAssetId
      && document.querySelector('.save-state')?.textContent.includes('草稿已保存'));
    await basicForm.getByAltText('头像预览', { exact: true }).waitFor({ state: 'detached' });
    await uploadAvatar(1, null);
    report.basicFields = { values: expectedBasic, addedAvatar, replacedAvatar, removedThenReadded: true };
    const beforeRestart = (await settled()).document;
    assert.notEqual(beforeRestart.sections.find(section => section.kind === 'education').id, beforeRestart.sections.find(section => section.kind === 'work').id);
    report.distinctSameNamedSections = true;
    report.summaryNameSaved = true;
    await stopNativeHost(host); host = undefined;
    host = await startNativeHost(profile);
    const afterRestart = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('document_state'));
    assert.deepEqual(afterRestart.document, beforeRestart);
    report.basicFields.restartPreservesCompleteBasic = true;
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
