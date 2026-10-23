import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";
import { resolve } from "node:path";

test("button press feedback has bounded listeners and preserves native activation", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    const address = server.httpServer.address();
    await page.goto(`http://127.0.0.1:${address.port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      const { bindButtonPress } = await import("/src/ui/motion/buttonPress.ts");
      document.body.innerHTML = '<button id="press">Press</button><button id="other">Other</button>';
      window.clicks = 0;
      window.pressChanges = 0;
      const button = document.querySelector("#press");
      button.onclick = () => window.clicks++;
      window.disposePress = bindButtonPress(button, active => {
        window.pressChanges++;
        button.toggleAttribute("data-pressed", active);
      });
    });
    const cdp = await page.context().newCDPSession(page);
    const listenerCounts = async () => {
      const counts = [];
      for (const expression of ['document.querySelector("#press")', 'window']) {
        const { result } = await cdp.send("Runtime.evaluate", { expression });
        const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
        counts.push(listeners.map(listener => listener.type).sort());
        await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
      }
      return counts;
    };
    const before = await listenerCounts();
    await page.evaluate(() => {
      const button = document.querySelector("#press");
      for (let i = 0; i < 1000; i++) {
        button.focus();
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter" }));
        button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
        button.blur();
      }
    });
    assert.deepEqual(await listenerCounts(), before, "focus and Enter cycles never accumulate listeners");
    const button = page.locator("#press");
    await button.focus();
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.down(key);
      assert.equal(await button.getAttribute("data-pressed"), "");
      await page.keyboard.up(key);
      assert.equal(await button.getAttribute("data-pressed"), null);
    }
    assert.equal(await page.evaluate(() => window.clicks), 2, "one native click per keyboard activation");
    await button.hover();
    await page.mouse.down({ button: "right" });
    assert.equal(await button.getAttribute("data-pressed"), null);
    await page.mouse.up({ button: "right" });
    await page.mouse.down();
    assert.equal(await button.getAttribute("data-pressed"), "");
    await page.mouse.move(500, 500);
    await page.mouse.up();
    assert.equal(await button.getAttribute("data-pressed"), null, "release outside clears feedback");
    await button.focus();
    await page.keyboard.down("Space");
    await page.locator("#other").focus();
    assert.equal(await button.getAttribute("data-pressed"), null, "blur cancels keyboard feedback");
    await page.keyboard.up("Space");
    const touch = await page.evaluate(() => {
      const button = document.querySelector("#press");
      const states = [];
      for (const [type, id, primary] of [["pointerdown", 2, false], ["pointerdown", 1, true], ["pointercancel", 2, false], ["pointercancel", 1, true]]) {
        button.dispatchEvent(new PointerEvent(type, { pointerType: "touch", pointerId: id, isPrimary: primary, bubbles: true }));
        states.push(button.hasAttribute("data-pressed"));
      }
      return states;
    });
    assert.deepEqual(touch, [false, true, true, false], "secondary touches cannot start or cancel the primary press");
    const disposal = await page.evaluate(() => {
      const button = document.querySelector("#press");
      button.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", pointerId: 3, button: 0 }));
      const before = window.pressChanges;
      window.disposePress();
      window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", pointerId: 3, button: 0 }));
      return { before, after: window.pressChanges };
    });
    assert.equal(disposal.before, disposal.after, "disposal removes active global handlers without re-entering owner cleanup");
    const after = await listenerCounts();
    assert.deepEqual(after[0], ["click"], "all owned button listeners removed");
    assert.equal(after[1].filter(type => type === "blur").length, before[1].filter(type => type === "blur").length - 1);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("isolated browser opens the React desktop workspace shell", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    // React 工作区外壳按旧版结构渲染，浏览器模式明确降级且不写入任何数据。
    await page.locator(".app-shell").waitFor({ timeout: 20000 });
    await page.getByText("请在桌面应用中运行").waitFor({ timeout: 20000 });
    assert.equal(errors.length, 0, `Unexpected page errors: ${errors.join("; ")}`);
    await page.goto(`http://127.0.0.1:${address.port}/__zinecv_browser_test_page.html`);
    const pane = await page.evaluate(async () => (await import("/tests/browser/fixtures/pane-restore.tsx")).checkPaneRestore());
    assert.equal(pane.restored, 520, "restore saved width without bouncing to startup default");
    assert.deepEqual(pane.restoreWrites, [], "hydration never writes stale widths back");
    assert.equal(pane.keyboard, 536);
    assert.equal(pane.bounded, pane.max, "restored oversized preference obeys current viewport bounds");
    assert.equal(pane.reset, 560);
    assert.deepEqual(pane.writes, [536, 560], "only explicit resize actions persist preferences");
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
