import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const directory = resolve(".artifacts/runtime-tmp/test-evidence/window-chrome");

test("immersive native header keeps window actions aligned and preserves close-save", async () => {
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp(join(directory, "profile-"));
  const report = { layouts: [], consoleErrors: [] };
  let host = await startNativeHost(profile);
  const windowInvoke = (command) => host.page.evaluate(command =>
    window.__TAURI_INTERNALS__.invoke(`plugin:window|${command}`), command);
  try {
    const { page } = host;
    page.on("pageerror", error => report.consoleErrors.push(error.message));
    assert.equal(await windowInvoke("is_decorated"), false);
    for (const width of [1440, 1050]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => {
        const box = selector => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return { x, y, width, height, right: x + width, center: y + height / 2 };
        };
        return { viewport: innerWidth, header: box(".topbar"), logo: box(".header-brand-logo"), export: box(".export-trigger"),
          controls: box(".window-controls"), minimize: box('[aria-label="最小化"]'),
          close: box('[aria-label="关闭窗口"]'),
          headerColor: getComputedStyle(document.querySelector(".topbar")).backgroundColor,
          legacyBrandBackground: getComputedStyle(document.querySelector(".topbar"), "::before").content,
          railColor: getComputedStyle(document.querySelector(".rail")).backgroundColor };
      });
      assert.equal(geometry.header.y, 0);
      assert.equal(geometry.headerColor, geometry.railColor);
      assert.equal(geometry.legacyBrandBackground, "none");
      assert.ok(geometry.export.right < geometry.controls.x);
      assert.ok(Math.abs(geometry.export.center - geometry.minimize.center) < 1);
      assert.ok(Math.abs(geometry.logo.center - geometry.export.center) < 1);
      assert.ok(geometry.logo.right < geometry.export.x);
      assert.ok(geometry.close.right <= geometry.viewport);
      report.layouts.push({ width, ...geometry });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(directory, "header-1440.png") });
    await page.getByRole("button", { name: "最大化", exact: true }).click();
    await page.getByRole("button", { name: "还原窗口", exact: true }).waitFor();
    assert.equal(await windowInvoke("is_maximized"), true);
    await page.getByRole("button", { name: "还原窗口", exact: true }).click();
    await page.getByRole("button", { name: "最大化", exact: true }).waitFor();
    assert.equal(await windowInvoke("is_maximized"), false);
    report.maximizeRestore = true;

    // Native drag-region double click must use the same maximize state tracking.
    await page.locator(".brand-side").dispatchEvent("mousedown", { button: 0, detail: 2 });
    await page.getByRole("button", { name: "还原窗口", exact: true }).waitFor();
    assert.equal(await windowInvoke("is_maximized"), true);
    await page.getByRole("button", { name: "还原窗口", exact: true }).click();
    report.doubleClickMaximize = true;

    // Existing export portal stays usable on the new dark toolbar.
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.locator(".download-menu").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "编辑简历名称", exact: true }).first().click();
    await page.getByRole("textbox", { name: "简历名称", exact: true }).fill("窗口关闭保存验证");
    await page.getByRole("textbox", { name: "简历名称", exact: true }).press("Enter");
    const exited = once(host.child, "exit", { signal: AbortSignal.timeout(15_000) });
    await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await exited;
    await stopNativeHost(host);
    host = await startNativeHost(profile);
    await host.page.locator(".resume-title").getByText("窗口关闭保存验证", { exact: true }).waitFor();
    report.closeSave = true;
    assert.deepEqual(report.consoleErrors, []);
    assert.equal(await host.page.locator(".window-control-error").count(), 0);
    await host.page.getByRole("button", { name: "最小化", exact: true }).click();
    await host.page.waitForFunction(async () => window.__TAURI_INTERNALS__.invoke("plugin:window|is_minimized"));
    report.minimize = true;
  } finally {
    await stopNativeHost(host);
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  }
});
