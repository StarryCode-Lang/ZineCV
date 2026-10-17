import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const evidenceRoot = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp/test-evidence/remaining-20261004/A5-supplemental");
const command = "node --test tests/native/webview-supplemental.test.mjs";

test("supplemental UI sorts, resizes, detects overflow and confirms clear in isolated WebView2", { timeout: 120_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(evidenceRoot + sep));
  const report = { command, fixture: "synthetic isolated native document; overflow is a synthetic oversized DOM block detected by the production guard", checks: {} };
  let host, passed = false;
  try {
    host = await startNativeHost(profile);
    const { page } = host;
    const state = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    // Native commands only seed the fixture. All four acceptance actions use the real UI.
    const seed = await page.evaluate(async () => {
      const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
      const initialDocument = (await invoke("document_state")).document;
      const apply = async payload => {
        const current = await invoke("document_state");
        await invoke("apply_document_command", { envelope: {
          protocolVersion: 1, commandId: crypto.randomUUID(), documentId: current.cursor.documentId,
          contextId: current.cursor.contextId, expectedRevision: current.cursor.revision,
          expectedBranchId: current.cursor.branchId, expectedHeadId: current.cursor.headId, payload,
        } });
      };
      await apply({ type: "updateBasic", patch: { name: "合成 supplemental 验收" } });
      const current = await invoke("document_state");
      const section = current.document.sections.find(item => item.kind === "education");
      if (!section) throw new Error("Education fixture section missing");
      await apply({ type: "setSectionVisibility", section_id: section.id, visible: true });
      const fixtures = [
        { title: "S 旧经历", start: "2018-01", end: "2020-01" },
        { title: "S 同年早开始", start: "2021-01", end: "2025-06" },
        { title: "S 同年晚开始", start: "2023-01", end: "2025-06" },
      ];
      const ids = [];
      for (const fixture of fixtures) {
        const id = crypto.randomUUID(); ids.push(id);
        await apply({ type: "addEntry", section_id: section.id, entry: {
          id, ...fixture, role: "合成专业", department: "本科", city: "", college: null,
          mode: "全日制", body: [{ type: "paragraph", children: [{ type: "text", text: fixture.title, marks: [] }] }],
        } });
      }
      return { ids, initialDocument, document: (await invoke("document_state")).document };
    });
    await page.reload();
    await page.locator(".app-shell").waitFor();
    await page.locator(`[data-editor-entry-id="${seed.ids[0]}"]`).waitFor();
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
    const visibleIds = () => page.locator("[data-editor-entry-id]").evaluateAll(nodes => nodes.map(node => node.dataset.editorEntryId));
    assert.deepEqual((await visibleIds()).filter(id => seed.ids.includes(id)), seed.ids);
    await page.getByRole("button", { name: "格式", exact: true }).click();
    await page.getByRole("button", { name: "按结束时间智能排序经历" }).click();
    const expectedIds = [...seed.ids].reverse();
    await page.waitForFunction(ids => {
      const visible = [...document.querySelectorAll("[data-editor-entry-id]")].map(node => node.dataset.editorEntryId).filter(id => ids.includes(id));
      return JSON.stringify(visible) === JSON.stringify(ids);
    }, expectedIds);
    // A transient native match can precede another queued draft save. Require the UI,
    // durable order and saved status to agree at one revision for consecutive polls.
    await page.evaluate(() => { window.__supplementalSortObservation = { consecutive: 0, revision: null, samples: [] }; });
    let sorted;
    try {
      const settled = await page.waitForFunction(async ids => {
        const current = await window.__TAURI_INTERNALS__.invoke("document_state");
        const orderIds = current.document.sections.find(item => item.kind === "education").entries.map(item => item.id);
        const visible = [...document.querySelectorAll("[data-editor-entry-id]")].map(node => node.dataset.editorEntryId).filter(id => ids.includes(id));
        const saved = document.querySelector(".save-state")?.textContent.includes("草稿已保存") === true;
        const observation = window.__supplementalSortObservation;
        const matches = JSON.stringify(orderIds) === JSON.stringify(ids) && JSON.stringify(visible) === JSON.stringify(ids) && saved;
        observation.consecutive = matches ? observation.revision === current.cursor.revision ? observation.consecutive + 1 : 1 : 0;
        observation.revision = current.cursor.revision;
        observation.samples.push({ revision: current.cursor.revision, orderIds, saved, matches });
        if (observation.samples.length > 30) observation.samples.shift();
        if (observation.consecutive >= 3) { observation.durableState = current; return true; }
        return false;
      }, expectedIds, { polling: 100, timeout: 20_000 });
      sorted = await page.evaluate(() => window.__supplementalSortObservation.durableState);
      await settled.dispose();
    } finally {
      report.sortObservations = await page.evaluate(() => window.__supplementalSortObservation);
      await page.evaluate(() => { delete window.__supplementalSortObservation; });
    }
    const beforeEntries = seed.document.sections.find(item => item.kind === "education").entries;
    assert.deepEqual(sorted.document.sections.find(item => item.kind === "education").entries, [...beforeEntries].reverse(), "sort must preserve entry contents and resolve equal end dates by start date");
    report.checks["S-SMART-SORT"] = { passed: true, beforeIds: seed.ids, afterIds: expectedIds,
      nativeOrderIds: sorted.document.sections.find(item => item.kind === "education").entries.map(item => item.id),
      stableRevision: sorted.cursor.revision, consecutiveSavedObservations: report.sortObservations.consecutive };
    // Toggle the layout popover closed before dragging the actual separator.
    await page.getByRole("button", { name: "格式", exact: true }).click();
    const splitter = page.getByRole("separator", { name: "调整编辑器与预览宽度" });
    const beforeWidth = Number(await splitter.getAttribute("aria-valuenow"));
    const min = Number(await splitter.getAttribute("aria-valuemin"));
    const max = Number(await splitter.getAttribute("aria-valuemax"));
    const bounds = await splitter.boundingBox();
    assert.ok(bounds);
    const delta = beforeWidth + 60 <= max ? 60 : -60;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(100, bounds.height / 2));
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector(".workspace-resizing"));
    await page.mouse.move(bounds.x + bounds.width / 2 + delta, bounds.y + Math.min(100, bounds.height / 2), { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(previous => Number(document.querySelector(".workspace-splitter").getAttribute("aria-valuenow")) !== previous, beforeWidth);
    const afterWidth = Number(await splitter.getAttribute("aria-valuenow"));
    const actualWidth = await page.locator(".editor-pane").evaluate(node => node.getBoundingClientRect().width);
    assert.ok(afterWidth >= min && afterWidth <= max);
    assert.ok(Math.abs(actualWidth - afterWidth) <= 2);
    assert.ok(Math.sign(afterWidth - beforeWidth) === Math.sign(delta));
    assert.deepEqual((await state()).document, sorted.document, "pane resize must preserve resume data");
    const dragToWidth = async (requestedWidth, expectedWidth) => {
      const currentWidth = Number(await splitter.getAttribute("aria-valuenow"));
      const currentBounds = await splitter.boundingBox();
      assert.ok(currentBounds);
      const x = currentBounds.x + currentBounds.width / 2;
      const y = currentBounds.y + Math.min(100, currentBounds.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      try {
        await page.waitForFunction(() => document.querySelector(".workspace-resizing"));
        await page.mouse.move(x + requestedWidth - currentWidth, y, { steps: 12 });
      } finally {
        await page.mouse.up();
      }
      await page.waitForFunction(expected =>
        Number(document.querySelector(".workspace-splitter").getAttribute("aria-valuenow")) === expected,
      Math.round(expectedWidth), { timeout: 3000 }).catch(async error => {
        report.resizeFailure = await page.evaluate(() => ({
          width: document.querySelector(".workspace-splitter").getAttribute("aria-valuenow"),
          maximum: document.querySelector(".workspace-splitter").getAttribute("aria-valuemax"),
          viewportWidth: innerWidth,
          paneWidth: document.querySelector(".editor-pane").getBoundingClientRect().width,
        }));
        report.resizeFailure.requestedWidth = requestedWidth;
        report.resizeFailure.expectedWidth = expectedWidth;
        throw error;
      });
      const ariaWidth = Number(await splitter.getAttribute("aria-valuenow"));
      const measuredWidth = await page.locator(".editor-pane").evaluate(node => node.getBoundingClientRect().width);
      assert.equal(ariaWidth, Math.round(expectedWidth), "drag must clamp to the requested boundary");
      assert.ok(Math.abs(measuredWidth - ariaWidth) <= 2, "actual pane width must match the accessible width");
      assert.deepEqual((await state()).document, sorted.document, "boundary drag must preserve resume data");
      return { requestedWidth, ariaWidth, actualWidth: measuredWidth };
    };
    const belowMinimum = await dragToWidth(min - 100, min);
    const aboveMaximum = await dragToWidth(max + 100, max);
    // Restore the normal width before the subsequent overflow guard fixture.
    const restored = await dragToWidth(beforeWidth, beforeWidth);
    report.checks["S-PANE-RESIZE"] = { passed: true, beforeWidth, afterWidth, actualWidth, min, max,
      belowMinimum, aboveMaximum, restored };
    // The artificial height is explicitly a fixture, never a substitute for the production detection.
    const injection = await page.evaluate(() => {
      const content = document.querySelector(".preview-pages .paper:not(.layout-measure) .paper-content")
        ?? document.querySelector(".paper:not(.layout-measure) .paper-content");
      if (!content) throw new Error("Visible paper missing");
      const block = document.createElement("div");
      block.className = "preview-block"; block.dataset.layoutBlock = "summary";
      block.dataset.supplementalOverflow = "true";
      block.style.height = "3000px"; block.style.minHeight = "3000px";
      block.textContent = "合成超高块：验证实际 A4 溢出检测";
      content.appendChild(block);
      return { height: block.getBoundingClientRect().height, paperHeight: content.closest(".paper").getBoundingClientRect().height };
    });
    const warning = page.locator(".editor-overflow-warning");
    await warning.waitFor();
    const message = await warning.innerText();
    assert.match(message, /超出 A4 可用区域，导出已暂停/);
    assert.ok(injection.height > injection.paperHeight);
    assert.deepEqual((await state()).document, sorted.document, "overflow guard is read-only");
    await page.evaluate(() => document.querySelector("[data-supplemental-overflow]")?.remove());
    await warning.waitFor({ state: "detached" });
    report.checks["S-OVERFLOW-WARNING"] = { passed: true, injection, message, recovered: true, syntheticHeight: true };
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByRole("menuitem", { name: "清空简历" }).click();
    let dialog = page.getByRole("alertdialog", { name: "清空当前简历？" });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual((await state()).document, sorted.document, "cancel clear preserves data");
    // The download menu remains open after cancellation; reopen only if it closed.
    if (!await page.getByRole("menuitem", { name: "清空简历" }).isVisible())
      await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByRole("menuitem", { name: "清空简历" }).click();
    dialog = page.getByRole("alertdialog", { name: "清空当前简历？" });
    await dialog.getByRole("button", { name: "确认清空" }).click();
    await page.waitForFunction(async () => {
      const current = await window.__TAURI_INTERNALS__.invoke("document_state");
      const emptyRichText = node => {
        if (Array.isArray(node)) return node.every(emptyRichText);
        if (!node || typeof node !== "object") return true;
        if (typeof node.text === "string" && node.text.trim()) return false;
        return Object.values(node).every(value => typeof value !== "object" || emptyRichText(value));
      };
      return current.document.basic.name === "" && current.document.sections.every(section =>
        Array.isArray(section.entries) ? section.entries.length === 0 : emptyRichText(section.body));
    });
    const cleared = await state();
    assert.equal(cleared.document.basic.name, "");
    assert.ok(cleared.document.sections.every(section => !section.entries?.length));
    assert.deepEqual(cleared.document.sections.filter(section => section.visible).map(section => ({ kind: section.kind, title: section.title })),
      seed.initialDocument.sections.filter(section => section.visible).map(section => ({ kind: section.kind, title: section.title })), "clear restores the default visible module structure");
    assert.equal(await page.locator("[data-editor-entry-id]").count(), 0);
    report.checks["S-CLEAR-RESUME"] = { passed: true, cancelPreserved: true, basicName: cleared.document.basic.name, sectionKinds: cleared.document.sections.map(section => section.kind) };
    report.environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight } }));
    report.passed = true; passed = true;
  } catch (error) { report.passed = false; report.error = String(error); throw error; }
  finally {
    if (host) await stopNativeHost(host);
    await writeFile(join(evidenceRoot, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
    if (passed) await rm(profile, { recursive: true, maxRetries: 20, retryDelay: 250 });
  }
});
