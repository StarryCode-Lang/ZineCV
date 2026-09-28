import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "typescript";
import { chromium } from "playwright";

function exportFile(entries, overrides = {}) {
  return JSON.stringify({
    format: "zinecv-legacy-browser-export",
    version: 1,
    origin: "http://127.0.0.1:5173",
    exportedAt: "2026-09-28T00:00:00.000Z",
    sourceHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
    ...overrides,
  });
}

test("browser export inspection verifies source hash and rejects malformed or foreign records", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../../src/bridge/legacyBrowserExport.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("http://127.0.0.1:5173/__legacy-inspect-test__", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>isolated inspect test</title>" }));
    await page.goto("http://127.0.0.1:5173/__legacy-inspect-test__");
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try { window.inspectLegacyBrowserExport = (await import(url)).inspectLegacyBrowserExport; }
      finally { URL.revokeObjectURL(url); }
    }, compiled);
    const inspect = (raw) => page.evaluate((value) => window.inspectLegacyBrowserExport(value), raw);
    const entries = [["resume-diy-agent-sessions-v2:account-1", "{}"], ["resume-diy-state", '{"summary":"中文"}']];
    const valid = await inspect(exportFile(entries));
    assert.equal(valid.valid, true);
    assert.equal(valid.readyForMigration, true);
    assert.deepEqual(valid.entries, entries);
    assert.equal(valid.sourceHash, createHash("sha256").update(JSON.stringify(entries)).digest("hex"));

    const unknown = await inspect(exportFile([["resume-diy-future-key", "keep"]]));
    assert.equal(unknown.valid, true);
    assert.equal(unknown.readyForMigration, false);
    assert.equal(unknown.issues[0].issueType, "unrecognizedAppKey");
    assert.deepEqual(unknown.entries, [["resume-diy-future-key", "keep"]]);

    for (const raw of [
      exportFile(entries, { sourceHash: "0".repeat(64) }),
      exportFile(entries, { origin: "https://other.example" }),
      exportFile([["resume-diy-state", "one"], ["resume-diy-state", "two"]]),
      exportFile([["another-app-secret", "not our key"]]),
      exportFile([["resume-diy-state", "one"], ["resume-diy-agent-mode-v1", "bot"]]),
      "{not json}",
    ]) {
      const result = await inspect(raw);
      assert.equal(result.valid, false);
      assert.equal(result.entries, null);
      assert.ok(result.issues.some((issue) => issue.severity === "error"));
    }
  } finally {
    await context.close();
    await browser.close();
  }
});
