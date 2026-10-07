import { test } from "node:test";
import { strict as assert } from "node:assert";
import { installAsyncWait } from "../native/async-wait.mjs";
import { installIpcInterceptor } from "../native/ipc-interceptor.mjs";

test("native async wait polls resolved false values, preserves sync predicates and enforces pending timeouts", async () => {
  let evaluated = 0, disposed = 0, delegated = 0;
  const page = {
    waitForFunction: async () => { delegated++; return "original-sync-wait"; },
    evaluateHandle: async fn => { const value = await fn(); evaluated++;
      return { evaluate: async predicate => predicate(value), dispose: async () => { disposed++; }, jsonValue: async () => value }; },
  };
  installAsyncWait(page);
  let calls = 0;
  const result = await page.waitForFunction(async () => ++calls >= 3 ? { durable: true } : false, undefined, { polling: 1, timeout: 1000 });
  assert.deepEqual(await result.jsonValue(), { durable: true });
  assert.equal(evaluated, 3); assert.equal(disposed, 2);
  assert.equal(await page.waitForFunction(() => true), "original-sync-wait"); assert.equal(delegated, 1);
  await assert.rejects(page.waitForFunction(async () => false, undefined, { polling: 1, timeout: 20 }), /timed out/);
  await assert.rejects(page.waitForFunction(async () => new Promise(() => {}), undefined, { timeout: 20 }), /timed out/);
});

test("test transport leaves readonly invoke intact, observes native replies and forwards structured errors", async () => {
  const previous = globalThis.window;
  const api = Object.freeze({ invoke: () => {} });
  const nativeCalls = [];
  globalThis.window = { __TAURI_INTERNALS__: api, fetch: async (input, options) => {
    nativeCalls.push({ input, body: options?.body });
    const error = String(input).endsWith("failure");
    return new Response(JSON.stringify(error ? { code: "STORAGE_FULL", retryable: true } : { durable: true }),
      { headers: { "Content-Type": "application/json", "Tauri-Response": error ? "error" : "ok" } });
  } };
  try {
    await installIpcInterceptor({ evaluate: async fn => fn() });
    window.__zinecvTestInvoke = (command, args, forward) => command === "pick_export_path" ? "synthetic.pdf" : forward();
    const request = command => window.fetch(`http://ipc.localhost/${command}`, { body: JSON.stringify({ id: "synthetic" }) });
    assert.equal(await (await request("pick_export_path")).json(), "synthetic.pdf");
    assert.equal(nativeCalls.length, 0);
    assert.deepEqual(await (await request("document_state")).json(), { durable: true });
    const failure = await request("failure");
    assert.equal(failure.headers.get("Tauri-Response"), "error");
    assert.deepEqual(await failure.json(), { code: "STORAGE_FULL", retryable: true });
    assert.equal(nativeCalls.length, 2); assert.equal(window.__TAURI_INTERNALS__, api);
    assert.equal(Object.getOwnPropertyDescriptor(api, "invoke").writable, false);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
