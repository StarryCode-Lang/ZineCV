import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { launchBrowserTestChromium } from "../tests/browser/fixtures/browser-test-server.mjs";

const root = resolve(import.meta.dirname, "..");
const evidence = resolve(root, process.env.ZINECV_WEB_EVIDENCE_OUT_DIR ?? ".artifacts/remaining/closure-optimization-20261008/web");
const mime = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

test("Rust WASM → synchronous SQLite JS → OPFS survives reopen and interrupted transaction without COOP/COEP", async () => {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") return response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>ZineCV core POC</title>");
    const allowed = ["/tests/browser/fixtures/", "/.artifacts/wasm-bindings/", "/node_modules/@sqlite.org/sqlite-wasm/dist/"];
    if (!allowed.some(prefix => pathname.startsWith(prefix))) return response.writeHead(404).end();
    const path = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!path.startsWith(root + sep)) return response.writeHead(403).end();
    try { response.writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream" }).end(await readFile(path)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const directory = `/zinecv-poc-${crypto.randomUUID()}`;
  const start = async () => {
    await page.goto(origin);
    await page.evaluate(() => {
      const pending = new Map();
      let sequence = 0;
      window.pocWorker = new Worker("/tests/browser/fixtures/web-core-poc-worker.mjs", { type: "module" });
      window.pocWorker.onmessage = ({ data }) => {
        const handler = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) handler.reject(new Error(`${data.error}\n${data.stack ?? ""}`));
        else handler.resolve(data.result);
      };
      window.pocWorker.onerror = event => {
        for (const handler of pending.values()) handler.reject(new Error(event.message));
        pending.clear();
      };
      window.poc = request => new Promise((resolveResult, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve: resolveResult, reject });
        window.pocWorker.postMessage({ ...request, id });
      });
    });
    return page.evaluate(directory => window.poc({ action: "open", directory }), directory);
  };
  const call = request => page.evaluate(request => window.poc(request), request);
  try {
    const opened = await start();
    assert.equal(opened.crossOriginIsolated, false);
    assert.equal(opened.opfs, true);
    assert.equal(opened.synchronous, true);
    const envelope = { protocolVersion: 1, commandId: "poc-command", documentId: opened.cursor.documentId,
      contextId: opened.cursor.contextId, expectedRevision: opened.cursor.revision,
      expectedBranchId: opened.cursor.branchId, expectedHeadId: opened.cursor.headId,
      payload: { type: "setDocumentTitle", title: "WASM persistent résumé 中文" } };
    const edited = await call({ action: "edit", envelope });
    assert.equal(edited.document.title, envelope.payload.title);
    const replay = await call({ action: "edit", envelope });
    assert.deepEqual(replay.result, edited.result);
    await assert.rejects(call({ action: "edit", envelope: { ...envelope, commandId: "stale-command" } }), /CONFLICT|Stale authority cursor/);
    const rejected = await call({ action: "promise-rejected" });
    assert.equal(rejected.rejected, true);
    await call({ action: "close" });
    await page.evaluate(() => window.pocWorker.terminate());
    const reopened = await start();
    assert.equal(reopened.persisted, true);
    assert.equal(reopened.document.title, edited.document.title);
    await call({ action: "rollback-crash" });
    await page.evaluate(() => window.pocWorker.terminate());
    const recovered = await start();
    assert.equal(recovered.document.title, edited.document.title);
    const rendered = await call({ action: "render" });
    assert.ok(rendered.preview.pages.length > 0);
    assert.equal(Buffer.from(rendered.pdf).subarray(0, 5).toString(), "%PDF-");
    assert.ok(rendered.preview.textMap);
    assert.deepEqual(errors, []);
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, "web-core-poc.json"), JSON.stringify({ schemaVersion: 1,
      checkedAt: new Date().toISOString(), host: process.platform, sqliteVersion: opened.version,
      syncBridge: "passed", promiseRejected: true, persistedReopen: true, interruptedTransaction: "rolled back",
      coopCoepRequired: false, wasmDomainCAS: "passed", engineWasmRuntime: "passed",
      pages: rendered.preview.pages.length, pdfBytes: rendered.pdf.length }, null, 2));
    await call({ action: "close" });
  } finally {
    await context.close();
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
