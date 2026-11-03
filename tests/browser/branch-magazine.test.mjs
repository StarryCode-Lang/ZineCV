import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("magazine graph keeps lazy history, protects the main branch and anchors actions", async () => {
  const detailModule = `export async function loadCommitDetail(id) {
    if (id === "head") await new Promise(resolve => setTimeout(resolve, 150));
    return { importedTemplate: null, presentation: { templateId: id === "head" ? "legacy-v1" : "clear-single-v1" } };
  }`;
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."), {
    sourceOverrides: new Map([["src/platform/versionDetails.ts", detailModule]]),
  });
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/branch-magazine.tsx"));
    await page.getByText("空分支").waitFor();
    assert.equal(await page.locator("[data-version-commit-id]").count(), 2);
    assert.equal(await page.locator(".branch-fork-path").count(), 1);
    await page.locator('[data-version-commit-id="head"]').click();
    let popover = page.locator(".branch-node-popover");
    await popover.waitFor();
    assert.equal(await popover.getByRole("button", { name: "载入" }).isDisabled(), true);
    assert.equal(await popover.getByRole("button", { name: "删除分支" }).count(), 0);
    await page.locator('[data-version-commit-id="fork-head"]').click();
    await popover.getByText("清晰单栏", { exact: false }).waitFor();
    await popover.getByRole("button", { name: "删除分支" }).click();
    assert.deepEqual(await page.evaluate(() => window.branchActions), ["branch:fork"]);
    await page.getByRole("button", { name: "分支图全屏" }).click();
    assert.equal(await page.locator(".branch-tree-expanded").count(), 1);
    await page.getByRole("button", { name: "退出分支图全屏" }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
