// 新旧版本预览视觉对照：同一 Chromium、同一虚构夹具数据、同一视口，
// 默认使用受控旧版合成纸面参考，不依赖本机旧版目录；显式维护模式才重录。
// 该比较证明"同一输入在两套构建里的排版输出一致"；WebView2 的原生滚动条
// 差异属于宿主层，另行在真实 exe 验收中覆盖。
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { preview } from "vite";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { visualFixture } from "./visual-parity-fixture.mjs";
import { readRemainingFixture } from "../fixtures/remaining.mjs";

const recordReference = process.argv.includes("--record-reference");
const legacyArgument = process.argv.indexOf("--legacy-root");
const oldRoot = legacyArgument >= 0 ? process.argv[legacyArgument + 1] : null;
if (recordReference && !oldRoot) throw new Error("Reference maintenance requires --legacy-root PATH");
const newRoot = resolve(import.meta.dirname, "..");

async function servePreview(root) {
  const plugins = [];
  {
    // Compare both applications with identical current licensed font inputs.
    // The icon replacement is reviewed separately; this gate still compares
    // all paper pixels using the existing threshold and fixture.
    const manifest = await readRemainingFixture("manifest.json");
    const expectedHashes = manifest.fixedInputs.fontAndTemplateSha256;
    const fontAssets = new Map();
    for (const file of ["source-han-serif-cn-regular.otf", "source-han-serif-cn-heavy.ttf", "wondercv-iconfont.ttf", "wondercv-iconfont.woff2"]) {
      const sourcePath = `public/fonts/${file}`;
      const bytes = await readFile(resolve(newRoot, sourcePath));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, expectedHashes[sourcePath], `Preserved font source hash: ${sourcePath}`);
      fontAssets.set(`/fonts/${file}`, { bytes, sha256, mime: file.endsWith("otf") ? "font/otf" : file.endsWith("woff2") ? "font/woff2" : "font/ttf" });
    }
    plugins.push({
      name: "visual-parity-preserved-fonts",
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const asset = fontAssets.get(request.url ?? "");
          if (!asset) { next(); return; }
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" }).end();
            return;
          }
          response.writeHead(200, { "Content-Type": asset.mime, "Content-Length": asset.bytes.length,
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-ZineCV-Font-SHA256": asset.sha256 });
          response.end(request.method === "HEAD" ? undefined : asset.bytes);
        });
      },
    });
  }
  const server = await preview({
    configFile: false,
    root,
    plugins,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function capturePaper(context, url, storage, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  // 在应用脚本执行前注入夹具：旧版 pagehide 的 flushDraft 会用当前状态覆盖
  // localStorage，必须在首帧之前就位，避免 reload 时被空白状态冲掉。
  await page.addInitScript((entries) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(url, { waitUntil: "networkidle" });
  const paper = page.locator(".paper-frame .paper").first();
  await paper.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600); // 字体加载与动效余量
  await page.evaluate(() => document.fonts.ready);
  const layout = element => ({ width: element.offsetWidth, height: element.offsetHeight,
    transform: getComputedStyle(element).transform,
    text: [...element.querySelectorAll("h1, .preview-title, .preview-contact")].map(node => ({
      left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight,
      font: getComputedStyle(node).font, text: node.textContent })) });
  const before = await paper.evaluate(layout);
  const bounds = await paper.boundingBox();
  assert.ok(bounds);
  // Establish layout at the original viewport first, then extend only capture
  // height so nested scrolling cannot hide the top of A4 behind the sticky bar.
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(bounds.y + bounds.height + 100)) });
  await paper.scrollIntoViewIfNeeded();
  assert.deepEqual(await paper.evaluate(layout), before, "Capture extent must not alter original-viewport paper layout");
  assert.ok(await paper.evaluate(element => {
    const r = element.getBoundingClientRect();
    return [[r.left+2,r.top+2],[r.right-2,r.top+2],[r.left+2,r.bottom-2],[r.right-2,r.bottom-2],[(r.left+r.right)/2,(r.top+r.bottom)/2]]
      .every(([x,y]) => element.contains(document.elementFromPoint(x,y)));
  }), "Complete paper must be visible and unobscured before capture");
  const shot = await paper.screenshot({ animations: "disabled" });
  await page.close();
  return shot;
}

test("old and desktop builds render identical A4 preview pixels from the same fixture", { timeout: 120_000 }, async () => {
  const referenceRoot = resolve(newRoot, "fixtures/visual-parity");
  const oldServer = recordReference ? await servePreview(resolve(oldRoot)) : null;
  if (recordReference) await mkdir(referenceRoot, { recursive: true });
  const newServer = await servePreview(newRoot);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const storage = visualFixture();
    const viewports = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
    const results = [];
    const candidateShots = [];
    const fixtureSha256 = createHash("sha256").update(JSON.stringify(storage)).digest("hex");
    const manifest = await readRemainingFixture("manifest.json");
    const fonts = Object.fromEntries(Object.entries(manifest.fixedInputs.fontAndTemplateSha256).filter(([path]) => path.startsWith("public/fonts/")));
    const reference = recordReference ? { schemaVersion: 1, fixtureSha256, fonts, chromium: browser.version(), scope: "Owned synthetic legacy paper; identical current licensed font inputs; original viewport layout, unchanged layout verified after capture-height extension; complete unobscured A4; 0.2% comparison limit", captures: [] } : JSON.parse(await readFile(resolve(referenceRoot, "reference.json"), "utf8"));
    assert.equal(reference.fixtureSha256, fixtureSha256, "Visual reference synthetic input changed; explicit review/regeneration required");
    assert.deepEqual(reference.fonts, fonts, "Visual reference font inputs changed; explicit review/regeneration required");
    for (const viewport of viewports) {
      const filename = `paper-${viewport.width}x${viewport.height}.png`;
      const oldShot = recordReference ? await capturePaper(context, oldServer.url, storage, viewport) : await readFile(resolve(referenceRoot, filename));
      const sha256 = createHash("sha256").update(oldShot).digest("hex");
      if (recordReference) {
        candidateShots.push({ filename, bytes: oldShot });
        reference.captures.push({ filename, viewport, sha256 });
      } else assert.equal(sha256, reference.captures.find(item => item.filename === filename)?.sha256, "Visual reference bytes differ from reviewed metadata");
      const newShot = await capturePaper(context, newServer.url, storage, viewport);
      const oldPng = PNG.sync.read(oldShot);
      const newPng = PNG.sync.read(newShot);
      assert.equal(oldPng.width, newPng.width, `paper width mismatch at ${viewport.width}`);
      assert.equal(oldPng.height, newPng.height, `paper height mismatch at ${viewport.width}`);
      const diff = new PNG({ width: oldPng.width, height: oldPng.height });
      const mismatched = pixelmatch(oldPng.data, newPng.data, diff.data, oldPng.width, oldPng.height, { threshold: 0.1 });
      const ratio = mismatched / (oldPng.width * oldPng.height);
      results.push({ viewport: `${viewport.width}x${viewport.height}`, width: oldPng.width, height: oldPng.height, mismatchedPixels: mismatched, diffRatio: Number(ratio.toFixed(5)) });
    }
    console.log("VISUAL_PARITY:", JSON.stringify(results));
    // Ordinary test execution never updates the reference. Maintenance still
    // compares both builds before adopting a candidate.
    if (recordReference) {
      assert.ok(results.every(result => result.diffRatio <= 0.002), "Legacy candidate differs from current build; review before adoption");
      for (const shot of candidateShots) await writeFile(resolve(referenceRoot, shot.filename), shot.bytes);
      await writeFile(resolve(referenceRoot, "reference.json"), JSON.stringify(reference, null, 2) + "\n");
    }
    for (const result of results) {
      // 完全相同的组件树、样式与字体下，差异应几乎为零；0.2% 作为报警阈值。
      assert.ok(result.diffRatio <= 0.002, `preview diff ${result.diffRatio} exceeds 0.2% at ${result.viewport}`);
    }
  } finally {
    await context.close();
    await browser.close();
    if (oldServer) await new Promise((done, reject) => oldServer.server.httpServer.close((error) => error ? reject(error) : done()));
    await new Promise((done, reject) => newServer.server.httpServer.close((error) => error ? reject(error) : done()));
  }
});
