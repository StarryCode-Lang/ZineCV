// Fail-closed verification of an already assembled Windows release. No build,
// signing key, network request, target executable or historical pass is reused.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { currentBuildSignature } from "./build-receipt.mjs";

const repository = "StarryCode-Lang/ZineCV";
const endpoint = `https://github.com/${repository}/releases/download/updates/latest.json`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
function decodeBase64(value, label) {
  assert.ok(typeof value === "string" && value.length && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), `${label}: invalid base64`);
  const bytes = Buffer.from(value, "base64");
  assert.equal(bytes.toString("base64"), value, `${label}: noncanonical base64`);
  return bytes;
}
function decodeText(value, label) {
  return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(value, label));
}
// Matches the locked minisign-verify format and Tauri's version-bound policy:
// packet = algorithm(2) + key id(8) + Ed25519 signature(64); ED signs a
// BLAKE2b-512 digest, Ed signs the payload. A second Ed25519 signature binds the
// signature bytes AND the full trusted comment before its version is trusted.
export function verifyUpdaterSignature(payload, encodedSignature, encodedPublicKey, version) {
  const publicLines = decodeText(encodedPublicKey.trim(), "public key").trimEnd().split(/\r?\n/);
  const lines = decodeText(encodedSignature.trim(), "signature").trimEnd().split(/\r?\n/);
  assert.equal(publicLines.length, 2, "Malformed public key envelope");
  assert.ok(publicLines[0].startsWith("untrusted comment:"), "Malformed public key comment");
  assert.equal(lines.length, 4, "Malformed signature envelope");
  assert.ok(lines[0].startsWith("untrusted comment:"), "Malformed signature comment");
  assert.ok(lines[2].startsWith("trusted comment: "), "Missing trusted signature comment");
  const publicPacket = decodeBase64(publicLines[1], "public key packet");
  const packet = decodeBase64(lines[1], "signature packet");
  const globalSignature = decodeBase64(lines[3], "comment signature");
  assert.equal(publicPacket.length, 42, "Malformed public key packet");
  assert.equal(packet.length, 74, "Malformed signature packet");
  assert.equal(globalSignature.length, 64, "Malformed comment signature");
  assert.ok(["Ed", "ED"].includes(publicPacket.subarray(0, 2).toString("ascii")), "Unsupported public key algorithm");
  const algorithm = packet.subarray(0, 2).toString("ascii");
  assert.ok(["Ed", "ED"].includes(algorithm), "Unsupported signature algorithm");
  assert.deepEqual(packet.subarray(2, 10), publicPacket.subarray(2, 10), "Signature key id mismatch");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicPacket.subarray(10)]), format: "der", type: "spki" });
  const signature = packet.subarray(10);
  const message = algorithm === "ED" ? createHash("blake2b512").update(payload).digest() : payload;
  assert.ok(verify(null, message, key, signature), "Payload signature verification failed");
  const comment = lines[2].slice("trusted comment: ".length);
  assert.ok(verify(null, Buffer.concat([signature, Buffer.from(comment, "utf8")]), key, globalSignature), "Trusted comment signature verification failed");
  const versions = comment.split("\t").filter(field => field.startsWith("version:"));
  assert.equal(versions.length, 1, "A unique signed version is required");
  assert.equal(versions[0].slice("version:".length), version, "Signed version differs from the release version");
  return { algorithm, signedVersion: version, payloadSha256: hash(payload) };
}

export function verifyReleaseHashes(text, contents) {
  const names = new Set();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f\d]{64}) {2}([^\\/]+)$/i.exec(line);
    assert.ok(match, "Malformed release SHA256SUMS entry");
    const [, expected, name] = match;
    assert.ok(!names.has(name), `Duplicate release SHA256SUMS entry: ${name}`);
    assert.ok(Object.hasOwn(contents, name), `Unexpected release SHA256SUMS entry: ${name}`);
    assert.equal(hash(contents[name]), expected.toLowerCase(), `Release file hash differs: ${name}`);
    names.add(name);
  }
  assert.deepEqual([...names].sort(), Object.keys(contents).sort(), "Release SHA256SUMS must list exactly the installer, signature and executable");
}
async function executableIdentity(path) {
  const literal = `'${path.replaceAll("'", "''")}'`;
  return new Promise((done, reject) => {
    const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);(Get-Item -LiteralPath ${literal}).VersionInfo | Select-Object ProductName,ProductVersion | ConvertTo-Json -Compress`;
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errorOutput = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { errorOutput += bytes; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) reject(new Error(`Cannot inspect release executable: ${errorOutput}`));
      else { try { done(JSON.parse(output)); } catch (error) { reject(error); } }
    });
  });
}
export async function verifyReleaseDirectory(root, directory, options = {}) {
  root = resolve(root); directory = resolve(directory);
  assert.ok(directory.startsWith(root + sep) && relative(root, directory), "Release directory must be inside the workspace");
  const config = await json(join(root, "src-tauri/tauri.conf.json"));
  assert.equal(config.productName, "ZineCV");
  assert.equal(config.identifier, "com.zinecv.desktop");
  assert.equal(config.plugins?.updater?.requireSignedVersion, true, "Production builds require version-bound signatures");
  assert.deepEqual(config.plugins.updater.endpoints, [endpoint], "Production update endpoint differs");
  const version = config.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "Invalid release version");
  const installerName = `ZineCV_${version}_x64-setup.exe`;
  const names = [installerName, `${installerName}.sig`, "zinecv-desktop.exe"];
  const contents = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(directory, name))])));
  verifyReleaseHashes(await readFile(join(directory, "SHA256SUMS.txt"), "utf8"), contents);
  const identity = await (options.executableIdentity ?? executableIdentity)(join(directory, "zinecv-desktop.exe"));
  assert.equal(identity.ProductName, "ZineCV", "Saved executable is not the production product");
  assert.equal(identity.ProductVersion, version, "Saved executable version differs from current source");
  const receipt = await json(join(directory, "build-native.json"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.stage, "build:native");
  assert.equal(receipt.provenance?.successfulBuild, true);
  assert.equal(receipt.provenance?.exitCode, 0);
  const current = await currentBuildSignature(root, "build:native", options.buildOptions);
  for (const field of ["inputDigest", "identityDigest", "inputs", "identity", "installedTools", "buildDriver", "build"]) {
    assert.deepEqual(receipt[field], current[field], `Saved release receipt does not match current ${field}`);
  }
  assert.equal(receipt.outputs?.executable?.path, "src-tauri/target/release/zinecv-desktop.exe");
  assert.equal(receipt.outputs.executable.sha256, hash(contents["zinecv-desktop.exe"]), "Saved release executable differs from its own receipt");
  const manifest = await json(join(directory, "latest.json"));
  assert.equal(manifest.version, version, "Release manifest version differs");
  assert.ok(Number.isFinite(Date.parse(manifest.pub_date)), "Release manifest publication date is missing");
  const platform = manifest.platforms?.["windows-x86_64"];
  assert.equal(platform?.url, `https://github.com/${repository}/releases/download/v${version}/${installerName}`, "Release payload URL differs from the versioned production asset");
  const signature = contents[`${installerName}.sig`].toString("utf8").trim();
  assert.equal(platform.signature, signature, "Manifest and saved signature differ");
  const cryptographicProof = verifyUpdaterSignature(contents[installerName], signature, config.plugins.updater.pubkey, version);
  // Tie the signed installer to the saved executable's successful packaging,
  // preventing a mix of two valid but different builds with the same version.
  const packaged = await json(join(directory, "package-online/package.json"));
  assert.equal(packaged.status, "passed", "Successful installer packaging evidence is required");
  assert.equal(packaged.originalSha256, hash(contents["zinecv-desktop.exe"]), "Installer packaging used a different executable");
  assert.equal(packaged.installer?.sha256, hash(contents[installerName]), "Signed installer differs from the packaged installer");
  assert.equal(basename(packaged.installer.path), installerName);
  assert.equal(packaged.executableRestored, true);
  assert.equal(packaged.symbolsRestored, true);
  assert.equal(packaged.receiptAfter?.reusable, true);
  assert.equal(packaged.receiptAfter.provenance?.inputDigest, current.inputDigest);
  assert.equal(packaged.receiptAfter.provenance?.identityDigest, current.identityDigest);
  return { status: "passed", version, directory, ...cryptographicProof, executableSha256: hash(contents["zinecv-desktop.exe"]), sourceInputDigest: current.inputDigest, buildIdentityDigest: current.identityDigest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  if (process.argv.length !== 4 || process.argv[2] !== "--release-dir") throw new Error("Usage: node tools/verify-release.mjs --release-dir <saved-release-directory>");
  verifyReleaseDirectory(root, process.argv[3]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
