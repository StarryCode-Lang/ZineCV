import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const output = await mkdtemp(
  join(tmpdir(), "resume-version-storage-contract-"),
);
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const key = "resume-diy-version-store-v1";
const cache = new Map();
const checks = [];

try {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: output,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: resolve("src/services/version-storage.ts"),
        formats: ["es"],
        fileName: () => "version-storage.mjs",
      },
    },
  });
  const { cacheVersions, loadProjectVersions, readVersionStoreResult } =
    await import(pathToFileURL(join(output, "version-storage.mjs")).href);
  globalThis.window = {
    localStorage: {
      getItem: (name) => cache.get(name) ?? null,
      setItem: (name, value) => cache.set(name, String(value)),
    },
  };
  const validStore = {
    currentBranchId: "main",
    branches: [
      {
        id: "main",
        name: "默认版本",
        createdAt: "2026-09-22T00:00:00.000Z",
        headCommitId: null,
      },
    ],
    commits: [],
  };
  const backup = JSON.stringify(validStore);
  cache.set(`${key}-backup`, backup);
  cache.set(key, JSON.stringify({ branches: [], commits: [] }));
  assert.equal(readVersionStoreResult().source, "backup");
  assert.equal(cacheVersions(validStore), true);
  assert.equal(cache.get(`${key}-backup`), backup);
  checks.push("structurally corrupt primary cannot replace the valid backup");

  const nextStore = structuredClone(validStore);
  nextStore.branches[0].name = "更新后的名称";
  assert.equal(cacheVersions(nextStore), true);
  assert.equal(cache.get(`${key}-backup`), backup);
  assert.deepEqual(JSON.parse(cache.get(key)), nextStore);
  checks.push("valid previous primary is still rotated into backup");

  for (const status of [500, 503]) {
    globalThis.fetch = async () =>
      new Response("<html>Project storage unavailable</html>", {
        status,
        headers: { "Content-Type": "text/html" },
      });
    await assert.rejects(loadProjectVersions(), /项目版本文件读取失败/);
  }
  for (const status of [200, 404]) {
    globalThis.fetch = async () =>
      new Response("<html>Static site</html>", {
        status,
        headers: { "Content-Type": "text/html" },
      });
    assert.equal(await loadProjectVersions(), null);
  }
  checks.push(
    "server failures are reported while static hosting stays supported",
  );
  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  await rm(output, { recursive: true, force: true });
}
