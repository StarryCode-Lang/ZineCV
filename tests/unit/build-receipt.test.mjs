import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkBuildReceipt, recordBuildReceipt, discoverVisualStudioRoot } from "../../tools/build-receipt.mjs";

test("receipt proves content identity and invalidates mutations/deletions without treating tests as compiler inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinecv-build-receipt-"));
  const options = { identity: { rustc: "synthetic compiler", msvc: "synthetic linker", flags: [] } };
  const put = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
  const stage = "build:native";
  try {
    await put("src-tauri/src/lib.rs", "synthetic native source");
    await put("src-tauri/Cargo.toml", "synthetic profile");
    await put("Cargo.toml", "synthetic workspace");
    await put("Cargo.lock", "synthetic lock");
    await put(".cargo/config.toml", "synthetic jobs=2");
    await put("src/main-desktop.tsx", "synthetic UI");
    await put("dist/index.html", "synthetic embedded UI");
    await put("src-tauri/target/release/zinecv-desktop.exe", "synthetic executable, not run");
    await put("src-tauri/target/release/zinecv_desktop.pdb", "synthetic symbols");
    await put("tools/with-msvc.ps1", "synthetic driver");
    assert.equal((await checkBuildReceipt(root, stage, options)).reusable, false, "mere exe existence cannot prove a build");
    await recordBuildReceipt(root, stage, options);
    assert.equal((await checkBuildReceipt(root, stage, options)).reusable, true);
    const production = { ...options, environment: {
      ZINECV_UPDATER_ENDPOINT: "https://updates.example.invalid/latest.json",
      ZINECV_UPDATER_PUBKEY: "synthetic public key",
      TAURI_SIGNING_PRIVATE_KEY: "synthetic private value must not enter receipts",
    } };
    assert.equal((await checkBuildReceipt(root, stage, production)).reason, "build_identity_changed", "production updater configuration cannot reuse an unconfigured executable");
    await recordBuildReceipt(root, stage, production);
    assert.equal((await checkBuildReceipt(root, stage, production)).reusable, true);
    for (const key of ["ZINECV_UPDATER_ENDPOINT", "ZINECV_UPDATER_PUBKEY"]) {
      assert.equal((await checkBuildReceipt(root, stage, { ...production, environment: { ...production.environment, [key]: "changed public configuration" } })).reason,
        "build_identity_changed", `${key} must invalidate the embedded updater configuration`);
    }
    const { readFile } = await import("node:fs/promises");
    assert.ok(!(await readFile(join(root, ".artifacts/build-receipts/build-native.json"), "utf8")).includes(production.environment.TAURI_SIGNING_PRIVATE_KEY), "private signing material must never be recorded");
    await recordBuildReceipt(root, stage, options);
    await put("tests/unit/new-test.mjs", "test changes do not change compiler inputs");
    await put("docs/SLICE_20261002.md", "documentation changes");
    assert.equal((await checkBuildReceipt(root, stage, options)).reusable, true);
    await put("src-tauri/examples/engine_render.rs", "synthetic validation tool");
    await put("src-tauri/target/release/examples/engine_render.exe", "synthetic validation executable, not run");
    await recordBuildReceipt(root, "build:engine-render", options);
    await put("src-tauri/examples/engine_render.rs", "changed validation tool");
    assert.equal((await checkBuildReceipt(root, stage, options)).reusable, true, "example-only changes do not compile into the desktop host");
    assert.equal((await checkBuildReceipt(root, "build:engine-render", options)).reusable, false, "the validation executable must rebuild for example changes");
    for (const [path, changed] of [
      ["crates/zinecv-engine/src/lib.rs", "changed shared engine"],
      ["crates/zinecv-storage/Cargo.toml", "changed shared storage dependency"],
      ["Cargo.toml", "changed workspace"],
      ["src-tauri/src/lib.rs", "changed Rust"], ["src/main-desktop.tsx", "changed UI"],
      ["Cargo.lock", "changed lock"], ["NOTICE.txt", "changed installed ownership notice"],
      ["docs/licenses/dependency-notices.txt", "changed installed dependency notice"], [".cargo/config.toml", "changed config"],
      ["src-tauri/Cargo.toml", "changed profile/features"], ["tools/with-msvc.ps1", "changed driver"],
      ["src-tauri/permissions/test.toml", "changed ACL permission"],
      ["dist/index.html", "tampered frontendDist"], ["src-tauri/target/release/zinecv-desktop.exe", "tampered executable"],
      ["src-tauri/target/release/zinecv_desktop.pdb", "tampered PDB"],
    ]) {
      await put(path, changed);
      assert.equal((await checkBuildReceipt(root, stage, options)).reusable, false, path);
      await recordBuildReceipt(root, stage, options);
      assert.equal((await checkBuildReceipt(root, stage, options)).reusable, true, `${path} re-record`);
    }
    await unlink(join(root, "src-tauri/src/lib.rs"));
    assert.equal((await checkBuildReceipt(root, stage, options)).reusable, false, "source deletion invalidates");
    await recordBuildReceipt(root, stage, options);
    assert.equal((await checkBuildReceipt(root, stage, { identity: { ...options.identity, rustc: "changed compiler" } })).reusable, false);
    assert.equal((await checkBuildReceipt(root, "build:native-hooks", options)).reusable, false, "different profile/features are never shared");
    await unlink(join(root, "src-tauri/target/release/zinecv-desktop.exe"));
    assert.equal((await checkBuildReceipt(root, stage, options)).reusable, false, "missing artifact invalidates");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty VS discovery falls back to an actual installed toolchain and fails closed when none exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinecv-vs-discovery-"));
  try {
    await assert.rejects(discoverVisualStudioRoot(root, ["", "  "], join(root, "missing")), /Cannot identify/);
    const installed = join(root, "Microsoft Visual Studio", "2022", "BuildTools");
    const vcvars = join(installed, "VC", "Auxiliary", "Build", "vcvars64.bat");
    await mkdir(dirname(vcvars), { recursive: true });
    await writeFile(vcvars, "synthetic discovery fixture, not executed");
    assert.equal(await discoverVisualStudioRoot(root, ["", "  "], join(root, "missing")), installed);
    assert.equal(await discoverVisualStudioRoot(root, [installed]), installed);
    await unlink(vcvars);
    await assert.rejects(discoverVisualStudioRoot(root, [installed]), /Cannot identify/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
