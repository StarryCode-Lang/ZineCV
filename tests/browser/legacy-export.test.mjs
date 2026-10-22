import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("old-origin export reads only app keys after a click and leaves storage unchanged", async () => {
  const html = await readFile(resolve(import.meta.dirname, "../../public/legacy-export.html"), "utf8");
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await page.route("http://127.0.0.1:5173/legacy-export.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("http://127.0.0.1:5173/legacy-export.html");
    await page.evaluate(() => {
      localStorage.setItem("resume-diy-state", '{"summary":"中文 草稿"}');
      localStorage.setItem("resume-diy-agent-sessions-v2:account-1", '{"sessions":[]}');
      localStorage.setItem("another-app-secret", "exclude-this");
    });
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.length), 3);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载浏览器数据" }).click(),
    ]);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(exported.format, "zinecv-legacy-browser-export");
    assert.equal(exported.version, 1);
    assert.equal(exported.origin, "http://127.0.0.1:5173");
    assert.deepEqual(exported.entries, [
      ["resume-diy-agent-sessions-v2:account-1", '{"sessions":[]}'],
      ["resume-diy-state", '{"summary":"中文 草稿"}'],
    ]);
    assert.equal(exported.sourceHash, createHash("sha256").update(JSON.stringify(exported.entries)).digest("hex"));
    assert.equal(await page.evaluate(() => localStorage.getItem("another-app-secret")), "exclude-this");
    assert.equal(await page.evaluate(() => localStorage.length), 3);

    const wrongOrigin = await context.newPage();
    await wrongOrigin.route("http://127.0.0.1:5174/legacy-export.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await wrongOrigin.goto("http://127.0.0.1:5174/legacy-export.html");
    assert.equal(await wrongOrigin.getByRole("button", { name: "下载浏览器数据" }).isDisabled(), true);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("parallel browser leases isolate same-origin storage and survive peer teardown", async () => {
  const first = await launchBrowserTestChromium({ headless: true });
  const second = await launchBrowserTestChromium({ headless: true });
  try {
    const a = await first.newContext(), b = await second.newContext();
    const url = "http://127.0.0.1:5173/owned-isolation.html";
    for (const context of [a, b]) await context.route(url, route => route.fulfill({ contentType: "text/html", body: "<title>owned isolation</title>" }));
    const x = await a.newPage(), y = await b.newPage();
    await Promise.all([x.goto(url), y.goto(url)]);
    await x.evaluate(() => { localStorage.setItem("owned", "first"); document.cookie = "owned=first"; });
    assert.equal(await y.evaluate(() => localStorage.getItem("owned")), null);
    assert.equal(await y.evaluate(() => document.cookie), "");
    await first.close();
    await y.evaluate(() => localStorage.setItem("owned", "second"));
    assert.equal(await y.evaluate(() => localStorage.getItem("owned")), "second");
  } finally { await first.close(); await second.close(); }
});
