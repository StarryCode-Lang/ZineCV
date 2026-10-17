import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";
const root = resolve(import.meta.dirname, "../..");
const directory = join(root, ".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-controls");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const state = page => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
const saved = page => page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();

test("Windows layout controls persist all supported values and preserve content, A4, zoom and restart", { timeout: 360_000 }, async () => {
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(join(directory, "profile-"));
  const report = { passed: false, values: [], geometry: [], source: "Actual production controls; all numeric values, synthetic editable content; no human/VM acceptance" };
  let host;
  try {
    host = await startNativeHost(profile); let page = host.page;
    const minimize = page.getByRole("button", { name: "最小化到 Bot", exact: true }); if (await minimize.isVisible()) await minimize.click();
    await page.getByRole("button", { name: "展开基本信息", exact: true }).click();
    await page.getByLabel("姓名", { exact: true }).fill("布局控件验收");
    await page.getByLabel("电话", { exact: true }).fill("13800000000");
    await page.getByLabel("电话", { exact: true }).press("Tab"); await saved(page);
    const baseline = await state(page);
    const content = document => ({ title: document.title, basic: document.basic, sections: document.sections });
    const beforeContent = content(baseline.document);
    // The two toolbar buttons can share the current px label. Locate by title.
    await page.locator('button[title="调整正文基准字号"]').click();
    let dialog = page.getByRole("dialog", { name: "正文字号", exact: true });
    for (let value = 10; value <= 18; value++) {
      await dialog.getByRole("button", { name: value + "px", exact: true }).click();
      await page.waitForFunction(async value => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.fontSizePt === value * .75, value);
      report.values.push({ control: "fontSize", value });
    }
    await dialog.getByRole("button", { name: baseline.document.presentation.fontSizePt / .75 + "px", exact: true }).click();
    await page.waitForFunction(async value => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.fontSizePt === value, baseline.document.presentation.fontSizePt);
    await dialog.getByRole("button", { name: "关闭设置" }).click();
    await page.getByRole("button", { name: "间距", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "间距设置" });
    for (const [label, field, from, to] of [["正文行距", "lineHeightPt", 12, 28], ["模块间距", "moduleGapPt", 0, 30], ["四边页距", "pageMarginPt", 20, 50]]) {
      for (let value = from; value <= to; value++) {
        await dialog.getByLabel(label).selectOption(String(value));
        const expected = field === "lineHeightPt" ? Math.max(value, baseline.document.presentation.fontSizePt / .75) : value;
        await page.waitForFunction(async ({ field, value }) => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation[field] === value * .75, { field, value: expected });
        report.values.push({ control: field, value, applied: expected, readableFloor: expected !== value });
      }
      await dialog.getByLabel(label).selectOption(String(baseline.document.presentation[field] / .75));
      await page.waitForFunction(async ({field,value}) => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation[field] === value, {field,value:baseline.document.presentation[field]});
    }
    await dialog.getByRole("button", { name: "关闭设置" }).click();
    await page.locator('button[title="选择简历字体"]').click();
    dialog = page.getByRole("dialog", { name: "简历字体" });
    for (const font of ["宋体", "雅黑", "黑体", "楷体", "仿宋"]) {
      await dialog.getByRole("button", { name: font, exact: true }).click();
      await page.waitForFunction(async font => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.fontSetId === "legacy-font:" + font, font);
      assert.equal(await dialog.getByRole("button", { name: font, exact: true }).getAttribute("aria-pressed"), "true");
      report.values.push({ control: "font", value: font, presentation: (await state(page)).document.presentation });
    }
    await dialog.getByRole("button", { name: baseline.document.presentation.fontSetId.replace("legacy-font:", ""), exact: true }).click();
    await page.waitForFunction(async value => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.fontSetId === value, baseline.document.presentation.fontSetId);
    await dialog.getByRole("button", { name: "关闭设置" }).click();
    await page.getByRole("button", { name: "格式", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "格式与颜色" });
    for (const value of ["2021.01", "2021年1月", "单行标题", "双行标题", "不使用分隔符号", "使用分隔符号", "系统默认", "两端对齐"]) {
      const button = dialog.getByRole("button", { name: value, exact: true });
      await button.click();
      const field = value.startsWith("2021") ? "dateFormat" : value.endsWith("标题") ? "titleFormat" : value.includes("分隔") ? "separator" : "textAlign";
      await page.waitForFunction(async ({field,value}) => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation[field] === value,{field,value});
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      report.values.push({ control: "format", value, presentation: (await state(page)).document.presentation });
    }
    for (const color of ["#000000", "#ca3832", "#ee8732", "#4183ff", "#9c5bde", "#6db557"]) {
      await dialog.getByRole("button", { name: "使用颜色 " + color }).click();
      await page.waitForFunction(async color => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.theme === color, color);
      report.values.push({ control: "theme", value: color });
    }
    for (const field of ["dateFormat", "titleFormat", "separator", "textAlign"]) {
      await dialog.getByRole("button", { name: baseline.document.presentation[field], exact: true }).click();
      await page.waitForFunction(async ({field,value}) => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation[field] === value,{field,value:baseline.document.presentation[field]});
    }
    await dialog.getByRole("button", { name: "使用颜色 " + baseline.document.presentation.theme }).click();
    await page.waitForFunction(async value => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.presentation.theme === value,baseline.document.presentation.theme);
    await dialog.getByRole("button", { name: "关闭设置" }).click(); await saved(page);
    report.restoredControls = true;
    assert.deepEqual(content((await state(page)).document), beforeContent, "appearance controls must not rewrite any content");
    const beforeZoom = await state(page);
    for (const zoom of [20, 100, 200]) {
      await page.getByLabel("预览缩放百分比").fill(String(zoom)); await page.getByLabel("预览缩放百分比").press("Enter");
      await page.waitForFunction(expected => Number(document.querySelector('[aria-label="预览缩放百分比"]').value) === expected, zoom);
      const geometry = await page.locator(".paper-frame .paper").first().evaluate(node => {
        const style = getComputedStyle(node); const r = node.getBoundingClientRect();
        return { cssWidth: parseFloat(style.width), cssHeight: parseFloat(style.height), width: r.width, height: r.height };
      });
      assert.ok(Math.abs(geometry.cssWidth - 794) <= 1);
      assert.ok(Math.abs(geometry.cssHeight - 1123) <= 1);
      await page.screenshot({ path: join(directory, "zoom-" + zoom + ".png"), animations: "disabled" });
      report.geometry.push({ zoom, ...geometry });
    }
    assert.deepEqual(await state(page), beforeZoom);
    await page.getByRole("button", { name: "全屏预览", exact: true }).click();
    await page.getByRole("button", { name: "退出全屏预览", exact: true }).waitFor();
    await page.getByRole("button", { name: "退出全屏预览", exact: true }).click();
    await page.getByRole("button", { name: "全屏预览", exact: true }).waitFor();
    assert.deepEqual(await state(page), beforeZoom);
    const frozen = await state(page);
    await stopNativeHost(host); host = undefined;
    host = await startNativeHost(profile); page = host.page;
    assert.deepEqual(await state(page), frozen, "real host restart restores all appearance and content");
    report.restarted = true;
    report.documentSha256 = sha(Buffer.from(JSON.stringify(frozen.document)));
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack);
    if (host) report.visibleText = await host.page.locator("body").innerText().catch(() => "");
    throw error;
  } finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(directory, "controls.json"), JSON.stringify(report, null, 2));
    if (report.passed) await rm(profile, { recursive: true, maxRetries: 15, retryDelay: 200 });
  }
});
