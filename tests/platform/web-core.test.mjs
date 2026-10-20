import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { launchBrowserTestChromium } from "../browser/fixtures/browser-test-server.mjs";

const root = resolve(import.meta.dirname, "../..");
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

await mkdir(evidence, { recursive: true });
test("Shared Rust Store persists authority and receipts and validates full Backup JSON in OPFS", async () => {
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
      window.pocWorker = new Worker("/tests/browser/fixtures/web-store-poc-worker.mjs", { type: "module" });
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
    let [cursor, original] = await start();
    let nativeBackupInterchange = false;
    if (process.env.ZINECV_BACKUP_NATIVE_PARITY === '1') {
      const path = resolve(evidence, 'native-backup.json');
      const native = spawnSync(resolve(root, 'src-tauri/target/release/examples/platform_backup.exe'), [path], { windowsHide: true, encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr || native.error?.message);
      await call({ action: 'restore', payload: JSON.parse(await readFile(path, 'utf8')) });
      [cursor, original] = await call({ action: 'load' });
      assert.equal(original.title, 'Windows native Backup → WASM 中文');
      nativeBackupInterchange = true;
    }
    const envelope = { protocolVersion: 1, commandId: 'store-command', documentId: cursor.documentId,
      contextId: cursor.contextId, expectedRevision: cursor.revision, expectedBranchId: cursor.branchId,
      expectedHeadId: cursor.headId, payload: { type: 'setDocumentTitle', title: 'Shared Rust OPFS 中文' } };
    const result = await call({ action: 'apply', envelope });
    const edited = await call({ action: 'load' });
    assert.equal(edited[1].title, envelope.payload.title);
    assert.ok(edited[0].revision > cursor.revision);
    const backup = await call({ action: 'backup' });
    if (nativeBackupInterchange) {
      const wasmPath = resolve(evidence, 'wasm-backup.json'), nativePath = resolve(evidence, 'native-roundtrip-backup.json');
      await writeFile(wasmPath, JSON.stringify(backup));
      const native = spawnSync(resolve(root, 'src-tauri/target/release/examples/platform_backup.exe'), [nativePath, wasmPath], { windowsHide: true, encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr || native.error?.message);
      await call({ action: 'restore', payload: JSON.parse(await readFile(nativePath, 'utf8')) });
      assert.deepEqual(await call({ action: 'load' }), edited);
    }
    await call({ action: 'close' });
    await page.evaluate(() => window.pocWorker.terminate());
    const reopened = await start();
    assert.deepEqual(reopened, edited);
    assert.deepEqual(await call({ action: 'apply', envelope }), result);
    await assert.rejects(call({ action: 'apply', envelope: { ...envelope, commandId: 'stale' } }), /CONFLICT/);
    await assert.rejects(call({ action: 'restore', payload: { ...backup, databaseSha256: '0'.repeat(64) } }), /STORAGE_CORRUPT/);
    assert.deepEqual(await call({ action: 'load' }), edited);
    const next = { ...envelope, commandId: 'second', expectedRevision: edited[0].revision,
      payload: { type: 'setDocumentTitle', title: 'Restore should remove this' } };
    await call({ action: 'apply', envelope: next });
    await call({ action: 'restore', payload: backup });
    assert.deepEqual(await call({ action: 'load' }), edited);
    await call({ action: 'close' });
    await page.evaluate(() => window.pocWorker.terminate());
    assert.deepEqual(await start(), edited);
    assert.deepEqual(errors, []);
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, 'web-store-poc.json'), JSON.stringify({ schemaVersion: 1,
      checkedAt: new Date().toISOString(), host: process.platform, schema: backup.schemaVersion,
      durableCursor: true, durableCommandReceipt: true, staleRejected: true,
      corruptBackupRejectedWithoutMutation: true, fullBackupRestoreReopen: true,
      implementation: 'zinecv-storage with rusqlite and sqlite-wasm-vfs OPFS SAH pool',
      nativeBackupInterchange, productIntegration: false }, null, 2));
  } finally {
    await context.close();
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});

test("Browser fetch uses shared Rust Agent policy and SSE with tools, cancellation and CORS rejection", async () => {
  const counts = { tools: 0, normal: 0 };
  const blocked = createServer((_request, response) => response.end('CORS denied'));
  await new Promise(resolveListen => blocked.listen(0, '127.0.0.1', resolveListen));
  const server = createServer(async (request, response) => {
    if (request.url.includes('/chat/completions')) {
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes);
      if (request.url.startsWith('/slow/')) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let delta;
      if (request.url.startsWith('/tools/') && !counts.tools++) delta = { tool_calls: [{ index: 0, id: 'call-local-help', function: { name: 'local_help', arguments: '{}' } }] };
      else { counts.normal++; delta = { content: 'Rust 浏览器 reply' }; }
      const frame = 'data: ' + JSON.stringify({ model: 'synthetic-model', choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n';
      const split = Buffer.from(frame);
      response.write(split.subarray(0, 17)); response.end(split.subarray(17)); return;
    }
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
      window.pocWorker = new Worker("/tests/browser/fixtures/web-store-poc-worker.mjs", { type: "module" });
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
    const [cursor] = await start();
    const request = { messages: [{ role: 'user', content: 'Synthetic request' }], selected: [], cursor, runId: 'browser-agent-poc', toolsEnabled: false };
    const reply = await call({ action: 'agent', baseUrl: origin + '/normal/v1', request });
    assert.equal(reply.reply.content, 'Rust 浏览器 reply');
    assert.deepEqual(reply.deltas, ['Rust 浏览器 reply']);
    const tools = await call({ action: 'agent', baseUrl: origin + '/tools/v1', request: { ...request, toolsEnabled: true } });
    assert.equal(tools.modelCalls, 2); assert.equal(tools.toolCalls, 1);
    assert.deepEqual(tools.proposalDrafts, []);
    const slow = call({ action: 'agent', baseUrl: origin + '/slow/v1', request });
    await page.waitForTimeout(100);
    await call({ action: 'cancel-agent' });
    await assert.rejects(slow, /已取消/);
    await assert.rejects(call({ action: 'agent', baseUrl: 'http://127.0.0.1:' + blocked.address().port + '/v1', request }), /CORS/);
    const afterCancel = await call({ action: 'agent', baseUrl: origin + '/normal/v1', request });
    assert.equal(afterCancel.reply.content, reply.reply.content);
    assert.deepEqual(errors, []);
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, 'web-agent-poc.json'), JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(),
      host: process.platform, sharedPolicy: true, sharedSSE: true, toolRoundTrip: true, cancellation: true,
      corsRejected: true, realProviderTested: false, productIntegration: false }, null, 2));
  } finally {
    await context.close();
    blocked.closeAllConnections(); await new Promise(resolveClose => blocked.close(resolveClose));
    server.closeAllConnections();
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
