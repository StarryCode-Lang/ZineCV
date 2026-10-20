import { createHash } from "node:crypto";
import { readFile, readdir, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const engineBuildCommand = "cargo build --manifest-path src-tauri\\Cargo.toml --locked --release --example typst_poc --example engine_render";
const definitions = {
  "build:native": { task: "build", frontend: true, command: "node_modules\\.bin\\tauri.cmd build --no-bundle", output: "src-tauri/target/release/zinecv-desktop.exe", profile: "release", features: "tauri/custom-protocol" },
  "build:native-hooks": { task: "hooks-build", frontend: true, command: "npm.cmd run build && cargo build --manifest-path src-tauri\\Cargo.toml --locked --profile hooks --features test-hooks,tauri/custom-protocol --bin zinecv-desktop", output: "src-tauri/target/hooks/zinecv-desktop.exe", profile: "hooks", features: "test-hooks,tauri/custom-protocol" },
  "build:engine-poc": { task: "poc-release", frontend: false, command: engineBuildCommand, output: "src-tauri/target/release/examples/typst_poc.exe", profile: "release", features: "" },
  "build:engine-render": { task: "engine-render-release", frontend: false, command: engineBuildCommand, output: "src-tauri/target/release/examples/engine_render.exe", profile: "release", features: "" },
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const slash = path => path.split(sep).join("/");
const receiptPath = (root, stage) => join(root, ".artifacts/build-receipts", `${stage.replaceAll(":", "-")}.json`);
function definition(stage) { const value = definitions[stage]; if (!value) throw new Error(`Unsupported build receipt stage ${stage}`); return value; }
async function list(root, path) {
  try {
    const info = await stat(join(root, path));
    if (!info.isDirectory()) return [path];
    const files = [];
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Build input symlink requires explicit handling: ${path}/${entry.name}`);
      files.push(...await list(root, `${path}/${entry.name}`));
    }
    return files;
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function manifest(root, paths) {
  const files = [...new Set((await Promise.all(paths.map(path => list(root, path)))).flat())].sort();
  return Promise.all(files.map(async path => ({ path, sha256: digest(await readFile(join(root, path))) })));
}
function commandText(command, args) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot verify build identity: ${command}`);
  return result.stdout.trim();
}
async function hashedExternal(path) { return { path, sha256: digest(await readFile(path)) }; }
export async function discoverVisualStudioRoot(programFiles, discovered = [], environmentRoot) {
  const candidates = [environmentRoot, ...discovered].filter(value => typeof value === "string" && value.trim());
  const installedRoot = join(programFiles, "Microsoft Visual Studio");
  for (const version of await readdir(installedRoot, { withFileTypes: true }).catch(() => [])) {
    if (!version.isDirectory()) continue;
    const versionRoot = join(installedRoot, version.name);
    candidates.push(versionRoot);
    for (const product of await readdir(versionRoot, { withFileTypes: true })) {
      if (product.isDirectory()) candidates.push(join(versionRoot, product.name));
    }
  }
  for (const candidate of candidates) {
    const path = candidate.trim();
    if (await stat(join(path, "VC/Auxiliary/Build/vcvars64.bat")).then(info => info.isFile(), () => false)) return path;
  }
  throw new Error("Cannot identify the installed MSVC x64 Build Tools");
}
export async function compilerIdentity() {
  const identity = { node: process.version, architecture: process.arch, platform: process.platform,
    rustc: commandText("rustc", ["-Vv"]), cargo: commandText("cargo", ["-V"]) };
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const discovered = commandText(join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe"), ["-latest", "-products", "*", "-property", "installationPath"]).split(/\r?\n/);
    const vs = await discoverVisualStudioRoot(programFiles, discovered, process.env.VSINSTALLDIR);
    const version = (await readFile(join(vs, "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"), "utf8")).trim();
    const compiler = join(vs, "VC/Tools/MSVC", version, "bin/Hostx64/x64");
    identity.msvc = { version, vcvars: await hashedExternal(join(vs, "VC/Auxiliary/Build/vcvars64.bat")),
      cl: await hashedExternal(join(compiler, "cl.exe")), link: await hashedExternal(join(compiler, "link.exe")) };
    const sdkRoot = join(programFiles, "Windows Kits/10/bin");
    const sdkVersions = (await readdir(sdkRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
      .map(entry => entry.name).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const sdkVersion = sdkVersions.at(-1);
    if (!sdkVersion) throw new Error("Windows SDK identity cannot be verified");
    identity.windowsSdk = { version: sdkVersion, rc: await hashedExternal(join(sdkRoot, sdkVersion, "x64/rc.exe")) };
  }
  const flags = Object.entries(process.env).filter(([key]) => /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_TARGET|CARGO_PROFILE_.*)$/.test(key)).sort(([a], [b]) => a.localeCompare(b));
  identity.flags = flags;
  return identity;
}
export async function buildInputManifest(root, stage) {
  const def = definition(stage);
  const paths = ["Cargo.toml", "Cargo.lock", "crates", "src-tauri/src", "src-tauri/Cargo.toml", "src-tauri/build.rs",
    "src-tauri/capabilities", "src-tauri/permissions", "src-tauri/icons", ".cargo/config.toml", "rust-toolchain.toml", "rust-toolchain",
    "public/fonts", "contracts/poc-contract-v1.json", "src-tauri/tauri.conf.json", "src-tauri/tauri.conf.offline.json"];
  if (def.frontend) paths.push("src", "public", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.platform.json", "package.json", "package-lock.json", "docs/licenses");
  else paths.push("src-tauri/examples");
  // Test scripts and documentation are not compiler inputs; editing them must not force LTO.
  return manifest(root, paths);
}
async function signature(root, stage, options = {}) {
  const def = definition(stage);
  const inputs = await buildInputManifest(root, stage);
  const identity = options.identity ?? await compilerIdentity();
  const installedTools = def.frontend ? await manifest(root, ["node_modules/@tauri-apps/cli/package.json", "node_modules/@tauri-apps/cli-win32-x64-msvc/tauri.exe", "node_modules/vite/package.json"]) : [];
  const buildDriver = await manifest(root, ["tools/with-msvc.ps1", "tools/build-receipt.mjs"]);
  const build = { stage, profile: def.profile, features: def.features, command: def.command, fontSource: def.frontend ? "engine" : null, targetDirectory: resolve(root, "src-tauri/target") };
  return { inputDigest: digest(JSON.stringify(inputs)), identityDigest: digest(JSON.stringify({ identity, installedTools, buildDriver, build })), inputs, identity, installedTools, buildDriver, build };
}
async function outputs(root, stage) {
  const def = definition(stage);
  const executable = { path: def.output, sha256: digest(await readFile(join(root, def.output))) };
  const symbols = await manifest(root, [def.output.replace(/[^/]+\.exe$/, name => name.replaceAll("-", "_").replace(/\.exe$/, ".pdb"))]);
  const frontend = def.frontend ? await manifest(root, ["dist"]) : [];
  if (def.frontend && !frontend.some(file => file.path === "dist/index.html")) throw new Error("frontendDist missing index.html");
  return { executable, symbols, frontendDigest: def.frontend ? digest(JSON.stringify(frontend)) : null, frontend };
}
export async function checkBuildReceipt(root, stage, options = {}) {
  try {
    if (process.env.ZINECV_FORCE_BUILD === "1") return { reusable: false, reason: "force_build" };
    const receipt = JSON.parse(await readFile(receiptPath(root, stage), "utf8"));
    if (receipt.schemaVersion !== 1 || receipt.stage !== stage || receipt.provenance?.successfulBuild !== true) return { reusable: false, reason: "unproven_receipt" };
    const current = await signature(root, stage, options);
    if (current.inputDigest !== receipt.inputDigest) return { reusable: false, reason: "compiler_inputs_changed" };
    if (current.identityDigest !== receipt.identityDigest) return { reusable: false, reason: "build_identity_changed" };
    const actual = await outputs(root, stage);
    if (JSON.stringify(actual) !== JSON.stringify(receipt.outputs)) return { reusable: false, reason: "artifact_missing_or_modified" };
    return { reusable: true, reason: "content_and_provenance_match", provenance: { receipt: slash(relative(root, receiptPath(root, stage))),
      recordedAt: receipt.recordedAt, inputDigest: receipt.inputDigest, identityDigest: receipt.identityDigest,
      executable: actual.executable, frontendDigest: actual.frontendDigest, ...receipt.provenance } };
  } catch (error) { return { reusable: false, reason: error.code === "ENOENT" ? "receipt_or_artifact_missing" : `unverifiable: ${error.message}` }; }
}
export async function recordBuildReceipt(root, stage, options = {}) {
  const current = await signature(root, stage, options);
  const record = { schemaVersion: 1, stage, recordedAt: new Date().toISOString(), ...current, outputs: await outputs(root, stage),
    provenance: { successfulBuild: true, command: definition(stage).command, exitCode: 0, ...(options.provenance ?? {}) } };
  const path = receiptPath(root, stage); await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(record, null, 2) + "\n"); await rename(temporary, path);
  return { receipt: slash(relative(root, path)), recordedAt: record.recordedAt, inputDigest: record.inputDigest, identityDigest: record.identityDigest, executable: record.outputs.executable, ...record.provenance };
}
async function main() {
  const args = process.argv.slice(2), stage = args[1], root = resolve(import.meta.dirname, "..");
  if (args.length === 1 && args[0] === "--identity") { console.log(JSON.stringify(await compilerIdentity(), null, 2)); return 0; }
  if (args[0] !== "--run" || args.length !== 2) throw new Error("Use --run build:native|build:native-hooks|build:engine-poc|build:engine-render");
  const def = definition(stage), cached = await checkBuildReceipt(root, stage);
  if (cached.reusable) { console.log(`BUILD_RECEIPT reused task=${def.task} proven_artifact=${cached.provenance.executable.sha256}`); return 0; }
  console.log(`BUILD_RECEIPT rebuild task=${def.task} reason=${cached.reason}`);
  const before = await signature(root, stage);
  const code = await new Promise((done, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", def.command], { cwd: root, stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject); child.once("close", code => done(code ?? 1));
  });
  if (code !== 0) return code;
  const after = await signature(root, stage);
  if (before.inputDigest !== after.inputDigest || before.identityDigest !== after.identityDigest) throw new Error("Compiler inputs changed during build; refusing reusable receipt");
  const producedStages = stage.startsWith("build:engine-") ? ["build:engine-poc", "build:engine-render"] : [stage];
  for (const producedStage of producedStages) {
    const provenance = await recordBuildReceipt(root, producedStage);
    console.log(`BUILD_RECEIPT recorded stage=${producedStage} artifact=${provenance.executable.sha256}`);
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
