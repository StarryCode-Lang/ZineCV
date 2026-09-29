import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../..");
const executable = join(root, "src-tauri", "target", "release", "examples", "typst_poc.exe");

test("bounded Typst worker sample reuses one process and rejects stale requests", { timeout: 30_000 }, async () => {
  const generation = randomUUID();
  const installLikeDirectory = await mkdtemp(join(tmpdir(), "zinecv-worker-install-"));
  assert.ok(resolve(installLikeDirectory).startsWith(`${resolve(tmpdir())}\\`));
  assert.ok(basename(installLikeDirectory).startsWith("zinecv-worker-install-"));
  const copiedExecutable = join(installLikeDirectory, "typst_poc.exe");
  await copyFile(executable, copiedExecutable);
  const child = spawn(copiedExecutable, ["--worker", generation], { cwd: installLikeDirectory, windowsHide: true, shell: false });
  const exited = new Promise((done) => child.once("exit", done));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const next = async () => {
    const item = await lines.next();
    assert.equal(item.done, false, `Worker exited before responding: ${stderr}`);
    return JSON.parse(item.value);
  };
  const send = (request) => child.stdin.write(`${JSON.stringify(request)}\n`);
  try {
    const hello = await next();
    assert.deepEqual([hello.action, hello.protocolVersion, hello.generation], ["hello", 1, generation]);

    send({ protocolVersion: 1, generation, requestId: "before-init", action: "render", repeatCount: 1 });
    assert.equal((await next()).error, "NOT_INITIALIZED");
    send({ protocolVersion: 2, generation, requestId: "bad-version", action: "init", resources: [] });
    assert.equal((await next()).error, "UNSUPPORTED_PROTOCOL");
    send({ protocolVersion: 1, generation: randomUUID(), requestId: "stale", action: "init", resources: [] });
    assert.equal((await next()).error, "STALE_GENERATION");

    const names = ["source-han-serif-cn-regular.otf", "source-han-serif-cn-heavy.ttf"];
    const resources = await Promise.all(names.map(async (name) => {
      const bytes = await readFile(join(root, "public", "fonts", name));
      return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    }));
    const manifest = resources.map(({ name, sha256, size }) => ({ name, sha256, size }));
    send({ protocolVersion: 1, generation, action: "init", resources: manifest });
    const firstRequest = await next();
    assert.deepEqual([firstRequest.action, firstRequest.name, firstRequest.sha256], ["resourceRequest", resources[0].name, resources[0].sha256]);
    send({ action: "resource", generation, sha256: resources[0].sha256, base64: Buffer.from("corrupt").toString("base64") });
    assert.equal((await next()).error, "RESOURCE_MISMATCH");

    send({ protocolVersion: 1, generation, action: "init", resources: manifest });
    for (const resource of resources) {
      const request = await next();
      assert.deepEqual([request.action, request.generation, request.name, request.sha256, request.size], ["resourceRequest", generation, resource.name, resource.sha256, resource.size]);
      send({ action: "resource", generation, sha256: resource.sha256, base64: resource.bytes.toString("base64") });
    }
    assert.deepEqual(await next(), { action: "initOk", generation });

    send({ protocolVersion: 2, generation, requestId: "render-bad-version", action: "render", repeatCount: 1 });
    assert.equal((await next()).error, "UNSUPPORTED_PROTOCOL");
    send({ protocolVersion: 1, generation: randomUUID(), requestId: "render-stale", action: "render", repeatCount: 1 });
    assert.equal((await next()).error, "STALE_GENERATION");
    send({ protocolVersion: 1, generation, requestId: "oversize", action: "render", repeatCount: 66 });
    assert.equal((await next()).error, "INVALID_REPEAT_COUNT");

    for (const [repeatCount, expectedPages] of [[1, 1], [65, 5]]) {
      const requestId = `render-${repeatCount}`;
      send({ protocolVersion: 1, generation, requestId, action: "render", repeatCount });
      const result = await next();
      assert.equal(result.requestId, requestId);
      assert.equal(result.generation, generation);
      assert.equal(result.pageCount, expectedPages);
      assert.equal(Buffer.from(result.pdfBase64, "base64").subarray(0, 4).toString(), "%PDF");
      assert.match(result.firstPageSvg, /^<svg/);
      assert.deepEqual(Buffer.from(result.firstPagePngBase64, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(result.textGeometrySample.length, expectedPages);
      assert.equal(result.textMapSample.version, 1);
      assert.match(result.textMapSample.logicalText, /^虚构测试简历\n样例人物\n自我评价\n用于排版验证。/);
      assert.ok(result.textMapSample.clusters.length > 0);
      for (const [order, cluster] of result.textMapSample.clusters.entries()) {
        assert.equal(cluster.logicalOrder, order);
        assert.ok(cluster.startUtf16 < cluster.endUtf16);
        assert.ok(cluster.endUtf16 <= result.textMapSample.logicalText.length);
        assert.ok(cluster.page >= 1 && cluster.page <= expectedPages);
        if (order > 0) assert.ok(result.textMapSample.clusters[order - 1].startUtf16 <= cluster.startUtf16);
      }
      for (const [pageIndex, page] of result.textGeometrySample.entries()) {
        assert.equal(page.pageIndex, pageIndex);
        assert.ok(Math.abs(page.widthPt - 595.2756) < 0.01);
        assert.ok(Math.abs(page.heightPt - 841.8898) < 0.01);
        assert.ok(page.runs.length > 0);
        for (const run of page.runs) {
          for (const cluster of run.clusters) {
            assert.ok(cluster.utf16Start < cluster.utf16End);
            assert.ok(cluster.utf16End <= run.text.length);
            assert.ok(Number.isInteger(cluster.sourceByteOffset) && cluster.sourceByteOffset >= 0);
            assert.ok(Number.isFinite(cluster.x) && Number.isFinite(cluster.y));
            assert.equal(cluster.sourceNodeId, run.sourceNodeId);
            const { xPt, yPt, widthPt, heightPt } = cluster.rect;
            assert.ok([xPt, yPt, widthPt, heightPt].every(Number.isFinite));
            assert.ok(widthPt >= 0 && heightPt > 0);
            assert.ok(xPt >= -1 && xPt + widthPt <= page.widthPt + 1);
            assert.ok(yPt >= -1 && yPt + heightPt <= page.heightPt + 1);
          }
        }
      }
      assert.ok(result.textGeometrySample[0].runs.some((run) =>
        run.sourceNodeId === "fixture-document-1:title" && run.text.includes("虚构")));
      if (expectedPages > 1) {
        assert.ok(result.textGeometrySample.at(-1).runs.every((run) =>
          run.sourceNodeId.startsWith("fixture-section-1:body:")));
      }
    }
    assert.equal(child.exitCode, null, "Worker should remain available after sequential renders");
    send({ padding: "x".repeat(4096) });
    assert.equal((await next()).error, "REQUEST_TOO_LARGE");
    await exited;
    assert.equal(child.exitCode, 0);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(installLikeDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test("worker terminates after an oversized host resource response", { timeout: 30_000 }, async () => {
  const generation = randomUUID();
  const installLikeDirectory = await mkdtemp(join(tmpdir(), "zinecv-worker-oversize-"));
  assert.ok(resolve(installLikeDirectory).startsWith(`${resolve(tmpdir())}\\`));
  const copiedExecutable = join(installLikeDirectory, "typst_poc.exe");
  await copyFile(executable, copiedExecutable);
  const child = spawn(copiedExecutable, ["--worker", generation], { cwd: installLikeDirectory, windowsHide: true, shell: false });
  const exited = new Promise((done) => child.once("exit", done));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const item = await lines.next();
    assert.equal(item.done, false, "Worker exited before responding");
    return JSON.parse(item.value);
  };
  const send = (request) => child.stdin.write(`${JSON.stringify(request)}\n`);
  try {
    await next();
    send({ protocolVersion: 1, generation, action: "init", resources: [{ name: "source-han-serif-cn-regular.otf", sha256: "A".repeat(64), size: 20_000_000 }, { name: "source-han-serif-cn-heavy.ttf", sha256: "B".repeat(64), size: 20_000_000 }] });
    const request = await next();
    assert.equal(request.action, "resourceRequest");
    send({ action: "resource", generation, sha256: request.sha256, base64: "A".repeat(30_000_000) });
    assert.equal((await next()).error, "RESOURCE_TOO_LARGE");
    await exited;
    assert.equal(child.exitCode, 0);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(installLikeDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
