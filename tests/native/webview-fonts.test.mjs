import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = resolve(root, process.env.ZINECV_NATIVE_EVIDENCE_OUT_DIR ?? ".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/native-current", "font-protocol");
const goldenRoot = join(root, "fixtures/native/font-protocol");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function capture(executable, label, protocol, baseline) {
  const profile = await mkdtemp(join(evidenceRoot, `${label}-profile-`));
  let host;
  const diagnostics = { label, executable, stage: "launch", fontState: null,
    transportObservation: "Initial PoC failed: WebView2 CDP emitted no page response for native custom font URL despite successful FontFace load. Byte probe uses native fetch instead." };
  try {
    host = await startNativeHost(profile, { executable });
    const { page } = host;
    const networkAttempts = [];
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["tauri.localhost", "zinecv-font.localhost", "ipc.localhost", "127.0.0.1", "localhost"].includes(url.hostname)
        || ["data:", "blob:", "tauri:", "zinecv-font:"].includes(url.protocol)) await route.continue();
      else { networkAttempts.push(url.href); await route.abort("internetdisconnected"); }
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.setViewportSize(baseline.viewport);
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
    await page.getByRole("button", { name: "展开基本信息", exact: true }).click();
    await page.getByLabel("姓名", { exact: true }).fill(baseline.syntheticInput.name);
    await page.getByLabel("电话", { exact: true }).fill(baseline.syntheticInput.phone);
    diagnostics.stage = "font-face-readiness-with-production-csp";
    const fontState = await page.evaluate(async () => {
      const specifications = ['400 16px "Source Han Serif CN"', '900 16px "Source Han Serif CN"', '16px "iconfont"'];
      const loaded = [];
      for (const specification of specifications) {
        const faces = await document.fonts.load(specification, specification.includes("iconfont") ? "\ue774" : "字体对照林沐言");
        loaded.push({ specification, count: faces.length, ready: document.fonts.check(specification) });
      }
      await document.fonts.ready;
      return { source: document.querySelector("style[data-zinecv-font-source]")?.dataset.zinecvFontSource,
        loaded, faces: [...document.fonts].filter((font) => ["Source Han Serif CN", "iconfont"].includes(font.family))
          .map(({ family, weight, style, status }) => ({ family, weight, style, status })) };
    });
    diagnostics.fontState = fontState;
    for (const result of fontState.loaded) assert.ok(result.ready && result.count > 0, JSON.stringify(result));
    const hashes = {};
    if (protocol) {
      assert.equal(fontState.source, "engine");
      // WebView2 handles custom protocols outside CDP's page response events.
      // Read bytes using fetch separately. The production font-face/CSP checks
      // above remain intact; connect-src intentionally does not permit fetch.
      diagnostics.stage = "protocol-byte-transport-test-csp-bypass";
      await page.locator(".save-state").getByText("草稿已保存").waitFor();
      await cdp.send("Page.setBypassCSP", { enabled: true });
      // WebView2 applies the bypass when creating a document, not retroactively.
      await page.reload();
      await page.locator(".app-shell").waitFor();
      try {
        for (const file of baseline.fontFiles) {
          const response = await page.evaluate(async (file) => {
            const url = window.__TAURI_INTERNALS__.convertFileSrc(file, "zinecv-font");
            const response = await fetch(url, { cache: "no-store" });
            const data = await response.arrayBuffer();
            const base64 = await new Promise((done, reject) => {
              const reader = new FileReader();
              reader.onload = () => done(String(reader.result).split(",", 2)[1]);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(new Blob([data]));
            });
            return { url, status: response.status, mime: response.headers.get("content-type"), base64 };
          }, file);
          assert.equal(response.status, 200);
          assert.equal(response.mime, file.endsWith("otf") ? "font/otf" : "font/ttf");
          hashes[file] = digest(Buffer.from(response.base64, "base64"));
          assert.equal(hashes[file], digest(await readFile(join(root, "public/fonts", file))));
        }
        const unknownStatus = await page.evaluate(async () => {
          const url = window.__TAURI_INTERNALS__.convertFileSrc("not-a-font.ttf", "zinecv-font");
          return (await fetch(url, { cache: "no-store" })).status;
        });
        assert.equal(unknownStatus, 404);
      } finally {
        await cdp.send("Page.setBypassCSP", { enabled: false });
        await page.reload();
        await page.locator(".app-shell").waitFor();
        await page.evaluate(async () => {
          await document.fonts.load('400 16px "Source Han Serif CN"', "字体对照林沐言");
          await document.fonts.load('900 16px "Source Han Serif CN"', "字体对照林沐言");
          await document.fonts.load('16px "iconfont"', "\ue774");
          await document.fonts.ready;
        });
      }
    }
    assert.deepEqual(networkAttempts, [], "Font loading must not require external network");
    await page.locator(".save-state").getByText("草稿已保存").waitFor();
    await page.waitForTimeout(baseline.capture.waitAfterSaveMs);
    diagnostics.stage = "native-paper-screenshot";
    const paper = page.locator(baseline.capture.selector).first();
    const geometry = await paper.evaluate((element) => {
      const bounds = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { paper: bounds(element), text: [...element.querySelectorAll("h1, .preview-title, .preview-contact")].map(bounds) };
    });
    const screenshot = await paper.screenshot({ animations: "disabled" });
    await writeFile(join(evidenceRoot, `${label}-paper.png`), screenshot);
    return { geometry, screenshot, fontState, hashes, networkAttempts };
  } catch (error) {
    await writeFile(join(evidenceRoot, `${label}-failure.json`), JSON.stringify({ schemaVersion: 1,
      passed: false, ...diagnostics, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2));
    throw error;
  } finally {
    if (host) await stopNativeHost(host);
    const resolvedProfile = resolve(profile);
    assert.ok(resolvedProfile.startsWith(resolve(evidenceRoot) + sep));
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

test("native fonts match source bytes offline and preserve baseline paper pixels", { timeout: 180_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const golden = JSON.parse(await readFile(join(goldenRoot, "baseline-paper.metadata.json"), "utf8"));
  const baselinePng = await readFile(join(goldenRoot, golden.goldenPng.file));
  assert.equal(golden.schemaVersion, 1);
  const currentFontHashes = {};
  assert.ok(Array.isArray(golden.fontFiles) && golden.fontFiles.length > 0, "Reference must name the fonts to probe");
  for (const file of golden.fontFiles) {
    currentFontHashes[file] = digest(await readFile(join(root, "public/fonts", file)));
  }
  const candidate = await capture(process.env.ZINECV_TEST_EXE ?? join(root, "src-tauri/target/release/zinecv-desktop.exe"), "candidate", true, golden);
  assert.deepEqual(candidate.hashes, currentFontHashes);
  assert.deepEqual(candidate.geometry, golden.geometry);
  const before = PNG.sync.read(baselinePng);
  const after = PNG.sync.read(candidate.screenshot);
  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  const diff = new PNG({ width: before.width, height: before.height });
  const mismatchedPixels = pixelmatch(before.data, after.data, diff.data, before.width, before.height, golden.comparison.pixelmatch);
  await writeFile(join(evidenceRoot, "paper-diff.png"), PNG.sync.write(diff));
  await writeFile(join(evidenceRoot, "report.json"), JSON.stringify({ schemaVersion: 1,
    baselineFixture: { metadata: "fixtures/native/font-protocol/baseline-paper.metadata.json", png: golden.goldenPng.file, sha256: digest(baselinePng) },
    sourceFonts: candidate.hashes, nativeFontState: candidate.fontState, offline: true,
    byteVerification: "native fetch with test-only CSP bypass after font-face readiness, restored before screenshot",
    transportObservation: "Initial PoC page response event was absent for custom font URLs; not treated as evidence of a missing or successful font response. Native fetch byte hashes verify transport separately.",
    geometry: candidate.geometry, mismatchedPixels, passed: mismatchedPixels === 0 }, null, 2));
  assert.equal(mismatchedPixels, 0, "Native paper must match the preserved golden baseline pixels exactly");
});
