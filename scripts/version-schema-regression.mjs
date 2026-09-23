import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { chromium } from "playwright";
import { preview } from "vite";

import { validateVersionStore } from "../server/version-schema.mjs";
import { versionStoragePlugin } from "../server/version-storage.mjs";
import "./version-storage-contract-regression.mjs";

const output = resolve(".artifacts/version-schema");
await mkdir(output, { recursive: true });
const checks = [];

const snapshot = () => ({
  resume: {},
  moduleOrder: ["education", "summary"],
  moduleNames: { education: "教育经历", summary: "自我评价" },
  summaryTitle: "自我评价",
  resumeTitle: "测试简历",
  layout: {
    font: "宋体",
    fontSize: "13",
    lineHeight: "13",
    moduleSpacing: "0",
    pageMargin: "30",
    theme: "#000000",
    dateFormat: "2021年1月",
    titleFormat: "单行标题",
    separator: "使用分隔符号",
    textAlign: "两端对齐",
  },
});

const validStore = () => ({
  currentBranchId: "main",
  branches: [
    {
      id: "main",
      name: "默认版本",
      createdAt: "2026-09-12T00:00:00.000Z",
      headCommitId: "commit-1",
    },
  ],
  commits: [
    {
      id: "commit-1",
      branchId: "main",
      parentId: null,
      message: "初始版本",
      createdAt: "2026-09-12T00:00:00.000Z",
      snapshot: snapshot(),
    },
  ],
});

const clone = (value) => structuredClone(value);

const addV2Presentation = (target) => {
  target.schemaVersion = 2;
  target.presentation = {
    templateId: "clear-single-v1",
    templateVersion: 1,
    densityPreset: "standard",
    overrides: { paragraphSpacing: 4, listSpacing: "3" },
  };
  return target;
};

function startStaticServer(root) {
  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
    const file = resolve(root, `.${requestPath}`);
    const target = file.startsWith(`${root}${pathSeparator()}`)
      ? file
      : join(root, "index.html");
    const safeTarget =
      target.endsWith("index.html") ||
      target.startsWith(`${root}${pathSeparator()}`)
        ? target
        : join(root, "index.html");
    const selected = safeTarget;
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[selected.slice(selected.lastIndexOf("."))] ||
        "application/octet-stream",
    );
    readFile(selected)
      .then((body) => response.end(body))
      .catch(() => response.end());
  });
  return new Promise((resolveServer) =>
    server.listen(0, "127.0.0.1", () => resolveServer(server)),
  );
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

const schemaCases = [];
{
  const result = validateVersionStore(validStore(), { mode: "write" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  schemaCases.push("valid current store accepted");
}
{
  const v2Store = validStore();
  addV2Presentation(v2Store.commits[0].snapshot);
  assert.equal(validateVersionStore(v2Store, { mode: "write" }).valid, true);

  const missingPresentation = validStore();
  missingPresentation.commits[0].snapshot.schemaVersion = 2;
  assert.equal(validateVersionStore(missingPresentation).valid, false);

  const invalidOverride = clone(v2Store);
  invalidOverride.commits[0].snapshot.presentation.overrides.paragraphSpacing =
    Number.POSITIVE_INFINITY;
  assert.equal(validateVersionStore(invalidOverride).valid, false);
  assert.match(
    validateVersionStore(invalidOverride).errors.join("\n"),
    /有限数字/,
  );
  schemaCases.push(
    "legacy snapshots and paired schema-v2 template metadata validate with unsafe overrides rejected",
  );
}
{
  const missingSnapshot = clone(validStore());
  delete missingSnapshot.commits[0].snapshot;
  assert.equal(validateVersionStore(missingSnapshot).valid, false);
  assert.match(
    validateVersionStore(missingSnapshot).errors.join("\n"),
    /snapshot/,
  );

  const duplicateId = clone(validStore());
  duplicateId.commits.push({ ...clone(duplicateId.commits[0]) });
  assert.equal(validateVersionStore(duplicateId).valid, false);
  assert.match(validateVersionStore(duplicateId).errors.join("\n"), /不能重复/);

  const illegalLayout = clone(validStore());
  illegalLayout.commits[0].snapshot.layout.pageMargin = "Infinity";
  assert.equal(validateVersionStore(illegalLayout).valid, false);
  assert.match(
    validateVersionStore(illegalLayout).errors.join("\n"),
    /有限数字/,
  );
  schemaCases.push(
    "missing snapshot, duplicate commit ID and illegal layout rejected",
  );
}
{
  const brokenParent = clone(validStore());
  brokenParent.commits[0].parentId = "legacy-parent-not-found";
  const result = validateVersionStore(brokenParent, { mode: "read" });
  assert.equal(result.valid, true);
  assert.ok(result.diagnostics.length > 0);

  const missingParent = clone(validStore());
  delete missingParent.commits[0].parentId;
  const missingResult = validateVersionStore(missingParent, { mode: "read" });
  assert.equal(missingResult.valid, true);
  assert.ok(missingResult.diagnostics.length > 0);

  const cycle = clone(validStore());
  cycle.commits.push({
    id: "commit-2",
    branchId: "main",
    parentId: "commit-1",
    message: "循环节点",
    createdAt: "2026-09-12T00:01:00.000Z",
    snapshot: snapshot(),
  });
  cycle.commits[0].parentId = "commit-2";
  const cycleResult = validateVersionStore(cycle, { mode: "write" });
  assert.equal(cycleResult.valid, false);
  assert.match(cycleResult.errors.join("\n"), /循环/);
  schemaCases.push(
    "broken and missing legacy parents diagnose without rejection; cycles reject",
  );
}

let viteServer;
let storageDirectory;
let staticServer;
let browser;
try {
  storageDirectory = await mkdtemp(join(output, "data-"));
  viteServer = await preview({
    configFile: false,
    plugins: [versionStoragePlugin({ directory: storageDirectory })],
    preview: { host: "127.0.0.1", port: 0, open: false },
  });
  const base = `http://127.0.0.1:${viteServer.httpServer.address().port}`;
  const requestWithHost = (method, host, body, origin) =>
    new Promise((resolveRequest, rejectRequest) => {
      const request = httpRequest(new URL(`${base}/api/resume-versions`), {
        method,
        headers: {
          host,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(origin !== undefined ? { Origin: origin } : {}),
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolveRequest({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      request.on("error", rejectRequest);
      if (body) request.write(body);
      request.end();
    });
  const initial = await fetch(`${base}/api/resume-versions`);
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.store, null);
  assert.equal(initialBody.revision, "empty");
  const rebindingRead = await requestWithHost(
    "GET",
    "attacker.example",
  );
  assert.equal(rebindingRead.status, 403);
  checks.push("version GET rejects rebinding Host headers without Origin");

  const validBody = JSON.stringify({ store: validStore(), revision: "empty" });
  const saved = await fetch(`${base}/api/resume-versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: validBody,
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  const originalFile = await readFile(
    join(storageDirectory, "versions.json"),
    "utf8",
  );
  const rebindingWrite = await requestWithHost(
    "POST",
    "attacker.example",
    validBody,
  );
  assert.equal(rebindingWrite.status, 403);
  const opaqueOrigin = await requestWithHost(
    "POST",
    `127.0.0.1:${viteServer.httpServer.address().port}`,
    validBody,
    "null",
  );
  assert.equal(opaqueOrigin.status, 403);
  assert.equal(
    await readFile(join(storageDirectory, "versions.json"), "utf8"),
    originalFile,
  );
  checks.push("version POST rejects spoofed Host and malformed Origin");

  const invalid = clone(validStore());
  delete invalid.commits[0].snapshot;
  const rejected = await fetch(`${base}/api/resume-versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ store: invalid, revision: savedBody.revision }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(
    await readFile(join(storageDirectory, "versions.json"), "utf8"),
    originalFile,
  );

  const cycle = clone(validStore());
  cycle.commits.push({
    ...clone(cycle.commits[0]),
    id: "commit-2",
    parentId: "commit-1",
  });
  cycle.commits[0].parentId = "commit-2";
  const cycleResponse = await fetch(`${base}/api/resume-versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ store: cycle, revision: savedBody.revision }),
  });
  assert.equal(cycleResponse.status, 400);
  assert.equal(
    await readFile(join(storageDirectory, "versions.json"), "utf8"),
    originalFile,
  );

  const brokenParent = clone(validStore());
  brokenParent.commits[0].parentId = "legacy-parent-not-found";
  const brokenResponse = await fetch(`${base}/api/resume-versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ store: brokenParent, revision: savedBody.revision }),
  });
  assert.equal(brokenResponse.status, 200);
  await writeFile(join(storageDirectory, "versions.json"), "{broken");
  const corruptResponse = await fetch(`${base}/api/resume-versions`);
  assert.equal(corruptResponse.status, 500);
  assert.equal(
    await readFile(join(storageDirectory, "versions.json"), "utf8"),
    "{broken",
  );
  await writeFile(join(storageDirectory, "versions.json"), originalFile);
  checks.push(...schemaCases);
  checks.push("server rejects invalid writes and preserves the original file");
  checks.push("legacy broken parent is accepted and corrupt files fail closed");
} finally {
  if (viteServer?.httpServer.listening)
    await new Promise((resolveServer) =>
      viteServer.httpServer.close(resolveServer),
    );
}

// 独立静态上下文验证：坏掉的浏览器缓存不会被自动替换成空版本库。
const invalidCache = clone(validStore());
delete invalidCache.commits[0].snapshot;
const invalidCacheRaw = JSON.stringify(invalidCache);
staticServer = await startStaticServer(resolve("dist"));
browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript((raw) => {
  localStorage.setItem("resume-diy-version-store-v1", raw);
}, invalidCacheRaw);
try {
  await page.goto(`http://127.0.0.1:${staticServer.address().port}`);
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page
    .getByText("浏览器版本库主缓存结构无效", { exact: false })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("resume-diy-version-store-v1"),
    ),
    invalidCacheRaw,
  );
  assert.deepEqual(pageErrors, []);
  checks.push(
    "invalid browser cache remains unchanged and reports an understandable error",
  );

  const result = { status: "PASS", checks, pageErrors };
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolveServer) => staticServer.close(resolveServer));
}
