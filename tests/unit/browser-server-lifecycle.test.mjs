import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { createBrowserTestServerPool } from "../browser/fixtures/browser-test-server.mjs";

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

test("browser entry registers every existing file once in sorted order and retains all 22 tests", async () => {
  const directory = new URL("../browser/", import.meta.url);
  const entry = await readFile(new URL("../../tools/browser-regression.test.mjs", import.meta.url), "utf8");
  const files = (await readdir(directory)).filter(file => file.endsWith(".test.mjs")).sort();
  const registered = [...entry.matchAll(/"([\w-]+\.test\.mjs)"/g)].map(match => match[1]);
  assert.deepEqual(registered, files);
  let count = 0;
  for (const file of files) count += ((await readFile(new URL(file, directory), "utf8")).match(/\btest\(/g) ?? []).length;
  assert.equal(count, 22);
  assert.match(entry, /after\(closeSharedBrowserTestServers\)/);
  const scripts = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).scripts;
  assert.equal(scripts["test:browser"], "node --test --test-concurrency=1 tools/browser-regression.test.mjs");
});
