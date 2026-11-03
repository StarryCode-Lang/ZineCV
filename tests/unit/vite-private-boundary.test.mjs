import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "vite";

test("development server blocks private exports and isolated profiles while serving application code", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const name = `boundary-${randomUUID()}.json`;
  const privateDir = join(root, ".migration-private");
  const runtimeDir = join(root, ".artifacts", "runtime-tmp");
  const files = [join(privateDir, name), join(runtimeDir, name)];
  await Promise.all([mkdir(privateDir, { recursive: true }), mkdir(runtimeDir, { recursive: true })]);
  await Promise.all(files.map((file) => writeFile(file, '{"fixture":"synthetic"}')));
  let server;
  try {
    server = await createServer({ configFile: join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(typeof address, "object");
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of [
      `/.migration-private/${name}`,
      `/.artifacts/runtime-tmp/${name}`,
      `/@fs/${files[0].replaceAll("\\", "/")}`,
      "/.git/config",
    ]) assert.equal((await fetch(base + route)).status, 403, route);
    assert.equal((await fetch(`${base}/src/platform/legacyImport.ts`)).status, 200);
    assert.ok(server.config.server.watch.ignored.includes("**/.migration-private/**"));
  } finally {
    await server?.close();
    await Promise.all(files.map((file) => rm(file, { force: true })));
  }
});
