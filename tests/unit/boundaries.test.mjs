import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { createBrowserTestServerPool, createBrowserTestChromiumPool } from "../browser/fixtures/browser-test-server.mjs";
import { installAsyncWait } from "../native/async-wait.mjs";
import { installIpcInterceptor } from "../native/ipc-interceptor.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateAcceptanceIds } from "../../tools/acceptance-matrix.mjs";
import { createHash } from "node:crypto";
import { readRemainingFixture, readRemainingFixtureBytes } from "../../fixtures/remaining.mjs";

// browser-server-lifecycle
{
  test("browser fixture leases share one server/listen per root and suite cleanup closes it", async () => {
    let created = 0, listened = 0, closed = 0;
    const pool = createBrowserTestServerPool(async () => {
      created += 1;
      return { httpServer: { address: () => ({ port: 1234 }) }, async close() { closed += 1; } };
    }, async server => { listened += 1; return server; });
    const [first, second] = await Promise.all([pool.acquire("."), pool.acquire("./")]);
    assert.notEqual(first, second, "tests receive separate leases");
    await Promise.all([pool.listen(first), pool.listen(second)]);
    assert.equal(first.httpServer.address().port, 1234);
    await first.close();
    await second.close();
    assert.deepEqual({ created, listened, closed }, { created: 1, listened: 1, closed: 0 });
    const other = await pool.acquire("./tests");
    await pool.listen(other);
    await pool.close();
    await pool.close();
    assert.deepEqual({ created, listened, closed }, { created: 2, listened: 2, closed: 2 });
  });

  test("browser suite cleanup closes created servers after setup failure and propagates cleanup failure", async () => {
    let closed = 0;
    const pool = createBrowserTestServerPool(async () => ({ async close() { closed += 1; } }), async () => { throw new Error("setup rejected"); });
    const server = await pool.acquire(".");
    await assert.rejects(pool.listen(server), /setup rejected/);
    await assert.rejects(pool.listen(server), /setup rejected/);
    await pool.close();
    assert.equal(closed, 1);
    const badClose = createBrowserTestServerPool(async () => ({ async close() { throw new Error("close rejected"); } }), async server => server);
    await badClose.acquire(".");
    await assert.rejects(badClose.close(), AggregateError);
    const badCreate = createBrowserTestServerPool(async () => { throw new Error("create rejected"); }, async server => server);
    await assert.rejects(badCreate.acquire("."), /create rejected/);
    await badCreate.close();
  });

  test("browser inventory lists every existing file once and retains all 26 tests", async () => {
    const directory = new URL("../browser/", import.meta.url);
    const entry = await readFile(new URL("../../tools/browser-regression.test.mjs", import.meta.url), "utf8");
    const files = (await readdir(directory)).filter(file => file.endsWith(".test.mjs")).sort();
    const registered = [...entry.matchAll(/"([\w-]+\.test\.mjs)"/g)].map(match => match[1]);
    assert.deepEqual(registered, files);
    let count = 0;
    for (const file of files) count += ((await readFile(new URL(file, directory), "utf8")).match(/\btest\(/g) ?? []).length;
    assert.equal(count, 26);
    assert.match(entry, /after\(closeSharedBrowserTestServers\)/);
    const scripts = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).scripts;
    assert.equal(scripts["test:browser"], "node --test --test-concurrency=1 tools/browser-regression.test.mjs");
  });

  test("browser process leases isolate contexts and close only their own resources", async () => {
    let launches = 0, browserCloses = 0, contextCloses = 0;
    const pool = createBrowserTestChromiumPool(async () => {
      launches += 1;
      return { isConnected: () => true, version: () => "synthetic",
        async newContext(options) { return { options, async newPage() { return { context: this }; }, async close() { contextCloses += 1; } }; },
        async close() { browserCloses += 1; } };
    });
    const [a, b] = await Promise.all([pool.acquire({ headless: true }), pool.acquire({ headless: true })]);
    const first = await a.newContext({ locale: "zh-CN" }), second = await b.newContext({ locale: "en-US" });
    assert.notEqual(first, second);
    assert.deepEqual(a.contexts(), [first]); assert.deepEqual(b.contexts(), [second]);
    await a.close(); await a.close();
    assert.equal(a.isConnected(), false); assert.equal(b.isConnected(), true);
    assert.equal(contextCloses, 1); assert.equal(browserCloses, 0);
    await assert.rejects(a.newContext(), /closed/);
    await b.newPage(); await b.close();
    assert.equal(contextCloses, 3);
    await pool.close(); await pool.close();
    assert.equal(launches, 1); assert.equal(browserCloses, 1);
  });

  test("failed browser launch can retry and process cleanup failures are reported", async () => {
    let attempts = 0;
    const pool = createBrowserTestChromiumPool(async () => {
      if (++attempts === 1) throw new Error("launch failed");
      return { async close() { throw new Error("close failed"); } };
    });
    await assert.rejects(pool.acquire({}), /launch failed/);
    await pool.acquire({});
    assert.equal(attempts, 2);
    await assert.rejects(pool.close(), AggregateError);
  });
}

// native-test-transport
{
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
}

// contracts
{
  test("acceptance matrix and shared PoC fixture stay complete", () => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../../tools/verify-contracts.mjs")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /52 mandatory acceptance IDs and 4 supplemental IDs/);
  });

  test("feature matrix keeps every mandatory row and accepts explicitly identified supplements", () => {
    const mandatory = [
      ...Array.from({ length: 44 }, (_, index) => ({ featureId: `F${String(index + 1).padStart(2, "0")}` })),
      ...Array.from({ length: 8 }, (_, index) => ({ featureId: `D${String(index + 1).padStart(2, "0")}` })),
    ];
    const accepted = validateAcceptanceIds([...mandatory, { featureId: "S-IMPORT-EDGE", supplemental: true }]);
    assert.equal(accepted.size, 52);
    assert.throws(() => validateAcceptanceIds([...mandatory, { featureId: "S-IMPORT-EDGE" }]), /supplemental: true/);
    assert.throws(() => validateAcceptanceIds(mandatory.slice(1)), /Missing acceptance item F01/);
  });

  test("synthetic fixture rules validate scenarios and describe current inputs without frozen hashes", async () => {
    const manifest = await readRemainingFixture("manifest.json");
    assert.ok(Object.keys(manifest.fileSha256).length > 0);
    for (const [name, expected] of Object.entries(manifest.fileSha256)) {
      const bytes = await readRemainingFixtureBytes(name);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
    }
    assert.equal(manifest.scenarios.length, 12);
    assert.equal((await readRemainingFixture("version-graph-1000.json")).commits.length, 1000);
  });

  test("fixture readers return isolated values and reject unknown logical inputs", async () => {
    const first = await readRemainingFixture("documents/one-page.json");
    const title = first.title;
    first.title = "not shared";
    assert.equal((await readRemainingFixture("fixtures/remaining.mjs#documents/one-page.json")).title, title);
    const bytes = await readRemainingFixtureBytes("documents/one-page.json");
    bytes.fill(0);
    assert.equal((await readRemainingFixture("documents/one-page.json")).title, title);
    await assert.rejects(readRemainingFixture("../missing.json"), /Unknown synthetic fixture/);
  });
}
