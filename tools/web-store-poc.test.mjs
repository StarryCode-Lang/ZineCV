import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { launchBrowserTestChromium } from "../tests/browser/fixtures/browser-test-server.mjs";

const root = resolve(import.meta.dirname, "..");
const evidence = resolve(root, process.env.ZINECV_WEB_EVIDENCE_OUT_DIR ?? ".artifacts/remaining/closure-optimization-20261008/web");
await mkdir(evidence, { recursive: true });
const mime = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

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
