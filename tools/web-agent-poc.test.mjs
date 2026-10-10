import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { launchBrowserTestChromium } from "../tests/browser/fixtures/browser-test-server.mjs";

const root = resolve(import.meta.dirname, "..");
const evidence = resolve(root, process.env.ZINECV_WEB_EVIDENCE_OUT_DIR ?? ".artifacts/remaining/closure-optimization-20261008/web");
const mime = { ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

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
