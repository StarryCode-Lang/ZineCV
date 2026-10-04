import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("legacy HTML maps to Rust rich blocks without silent semantic loss", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../../src/platform/legacyRichText.ts"), "utf8");
  const golden = JSON.parse(await readFile(resolve(import.meta.dirname, "../../fixtures/legacy-richtext-golden.json"), "utf8"));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try {
        const module = await import(url);
        window.parseLegacyRichHtml = module.parseLegacyRichHtml;
        window.richBlocksToLegacyHtml = module.richBlocksToLegacyHtml;
      }
      finally { URL.revokeObjectURL(url); }
    }, compiled);

    const parsed = await page.evaluate((html) => window.parseLegacyRichHtml(html), golden.html);
    assert.equal(parsed.complete, true);
    assert.deepEqual(parsed.issues, []);
    assert.equal(parsed.rawHtml, golden.html);
    assert.deepEqual(parsed.blocks, golden.blocks);
    const roundTrip = await page.evaluate((blocks) => {
      const html = window.richBlocksToLegacyHtml(blocks);
      return { html, parsed: window.parseLegacyRichHtml(html) };
    }, parsed.blocks);
    assert.equal(roundTrip.parsed.complete, true);
    assert.deepEqual(roundTrip.parsed.blocks, parsed.blocks);

    const blank = await page.evaluate(() => window.parseLegacyRichHtml("<p><br></p>"));
    assert.equal(blank.complete, true);
    assert.deepEqual(blank.blocks, [{ type: "paragraph", children: [{ type: "break" }] }]);

    const unsafe = '<p data-x="1"><span style="font-weight:700">保留文字</span><a href="javascript:alert(1)">不安全链接</a><img src="x"></p>';
    const partial = await page.evaluate((html) => window.parseLegacyRichHtml(html), unsafe);
    assert.equal(partial.complete, false);
    assert.equal(partial.rawHtml, unsafe);
    assert.deepEqual(partial.issues.map((issue) => issue.issueCode), [
      "unsupportedAttribute", "unsupportedAttribute", "invalidLink", "unsupportedTag", "unsupportedAttribute",
    ]);
    assert.equal(partial.blocks[0].children.map((item) => item.text ?? "").join(""), "保留文字不安全链接");

    const movedHead = await page.evaluate(() => window.parseLegacyRichHtml('<meta name="x" content="y"><script>window.bad = true</script><p>正文</p>'));
    assert.equal(movedHead.complete, false);
    assert.ok(movedHead.issues.some((issue) => issue.issueCode === "unsupportedTag" && issue.name === "meta"));
    assert.ok(movedHead.issues.some((issue) => issue.issueCode === "unsupportedTag" && issue.name === "script"));
    assert.equal(movedHead.blocks[0].children[0].text, "正文");

    const whitespace = await page.evaluate(() => window.parseLegacyRichHtml("  "));
    assert.equal(whitespace.complete, false);
    assert.deepEqual(whitespace.issues.map((issue) => issue.issueCode), ["orphanWhitespace"]);
    assert.equal(whitespace.blocks[0].children[0].text, "  ");

    const oversized = await page.evaluate(() => window.parseLegacyRichHtml("x".repeat(1_000_001)));
    assert.equal(oversized.complete, false);
    assert.deepEqual(oversized.issues.map((issue) => issue.issueCode), ["resourceLimit"]);

    const escaped = await page.evaluate(() => window.richBlocksToLegacyHtml([
      { type: "paragraph", children: [{ type: "text", text: '<img src=x onerror="alert(1)">&', marks: [] }] },
    ]));
    assert.equal(escaped, '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;</p>');
    await assert.rejects(page.evaluate(() => window.richBlocksToLegacyHtml([
      { type: "paragraph", children: [{ type: "link", href: "javascript:alert(1)", children: [] }] },
    ])), /unsupported link/);
  } finally {
    await context.close();
    await browser.close();
  }
});
