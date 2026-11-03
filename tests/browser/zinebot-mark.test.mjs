import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("ZineBot marks have isolated gradients and respect reduced motion", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/zinebot-mark.tsx"));
    await page.locator(".agent-mark").first().waitFor();
    const evidence = await page.evaluate(() => {
      const ids = [...document.querySelectorAll(".agent-mark defs [id]")].map(node => node.id);
      return { count: document.querySelectorAll(".agent-mark").length, ids, animation: getComputedStyle(document.querySelector(".agent-mark.is-running .agent-mark-body")).animationName };
    });
    assert.equal(evidence.count, 2);
    assert.equal(new Set(evidence.ids).size, evidence.ids.length);
    assert.equal(evidence.animation, "none");
  } finally { await browser.close(); await server.close(); }
});
