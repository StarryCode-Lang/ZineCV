import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("update preparation waits for durable completion, freezes input, recovers failed saves and cancels unmounted imports", { timeout: 60_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // A deferred parser makes unmount deterministic without OCR or native data.
    await page.route("**/src/ui/services/template-import.ts*", route => route.fulfill({
      contentType: "application/javascript",
      body: `export const importedTemplateFieldProvenance = () => [];
        export async function recognizeTemplate(_file, _progress, signal) {
          window.importFixtureSignal = signal;
          return await new Promise(resolve => { window.completeImportFixture = () => resolve({
            id: 'cancelled-import', name: 'Synthetic', sourceName: 'fixture.png', sourceType: 'image',
            accent: '#000000', formatId: 'legacy-v1', layout: 'single-column', analysis: 'synthetic'
          }); });
        }`,
    }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    await page.waitForFunction(() => typeof window.$RefreshReg$ === "function");
    await page.evaluate(() => import("/tests/browser/fixtures/mount-update-install.tsx"));
    const draft = page.getByRole("textbox", { name: "Synthetic draft" });
    await draft.fill("latest unsaved synthetic text");
    await page.getByRole("button", { name: "Install fixture update" }).click();
    await page.getByRole("status").filter({ hasText: "Preparing update" }).waitFor();
    const waiting = await page.evaluate(async () => {
      const fixture = window.updateInstallFixture;
      const second = await fixture.install();
      return { events: fixture.events, installs: fixture.installs, second,
        shellLocked: document.querySelector(".app-shell").inert,
        assistantLocked: document.querySelector("[data-agent-portal]").inert };
    });
    assert.equal(waiting.shellLocked, true);
    assert.equal(waiting.assistantLocked, true);
    assert.equal(waiting.installs, 0);
    assert.equal(waiting.second.ok, false);
    assert.deepEqual(waiting.events, ["agent-cancel-requested"]);
    await page.evaluate(() => document.querySelector('[aria-label="Synthetic draft"]').focus());
    await page.keyboard.insertText("MUST NOT BE WRITTEN");
    assert.equal(await draft.inputValue(), "latest unsaved synthetic text");
    await page.evaluate(() => window.updateInstallFixture.releaseAgent());
    await page.waitForFunction(() => !document.querySelector(".app-shell").inert);
    assert.match(await page.getByRole("alert").textContent(), /草稿尚未保存成功/);
    assert.equal(await page.evaluate(() => window.updateInstallFixture.installs), 0);
    await draft.fill("retry preserves newest text");
    await page.evaluate(() => { window.updateInstallFixture.failSave = false; window.updateInstallFixture.holdAgent = false; });
    await page.getByRole("button", { name: "Install fixture update" }).click();
    await page.waitForFunction(() => window.updateInstallFixture.installs === 1);
    assert.deepEqual(await page.evaluate(() => window.updateInstallFixture.saved), ["retry preserves newest text"]);

    await page.locator('input[type="file"]').setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("synthetic parser fixture") });
    await page.getByRole("button", { name: "识别并保存", exact: true }).click();
    await page.waitForFunction(() => window.importFixtureSignal !== undefined);
    await page.evaluate(() => window.updateInstallFixture.unmountTemplate());
    await page.waitForFunction(() => window.importFixtureSignal.aborted);
    await page.evaluate(() => window.completeImportFixture());
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.updateInstallFixture.appliedTemplates), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("resume-diy-imported-templates-v1")), null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close(); await server.close();
  }
});
