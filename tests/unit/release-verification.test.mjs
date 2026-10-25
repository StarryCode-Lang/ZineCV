import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { recordBuildReceipt } from "../../tools/build-receipt.mjs";
import { verifyUpdaterSignature, verifyReleaseHashes, verifyReleaseDirectory } from "../../tools/verify-release.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), id = randomBytes(8);
  const publicPacket = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]);
  const encodedPublicKey = Buffer.from(`untrusted comment: synthetic test key\n${publicPacket.toString("base64")}\n`).toString("base64");
  return { encodedPublicKey, sign(payload, version, algorithm = "ED", commentOverride) {
    const message = algorithm === "ED" ? createHash("blake2b512").update(payload).digest() : payload;
    const signature = sign(null, message, privateKey);
    const packet = Buffer.concat([Buffer.from(algorithm), id, signature]);
    const comment = commentOverride ?? `timestamp:1700000000\tfile:synthetic.exe\tversion:${version}`;
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    return Buffer.from(`untrusted comment: synthetic signature\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
  } };
}

test("updater verification authenticates payload, key, trusted comment and unique signed version", () => {
  const key = signer(), payload = Buffer.from("synthetic installer, never executed"), version = "2.0.0-alpha.99";
  for (const algorithm of ["Ed", "ED"]) {
    const signature = key.sign(payload, version, algorithm);
    assert.equal(verifyUpdaterSignature(payload, signature, key.encodedPublicKey, version).algorithm, algorithm);
    assert.throws(() => verifyUpdaterSignature(Buffer.from("tampered installer"), signature, key.encodedPublicKey, version), /Payload signature verification failed/);
    assert.throws(() => verifyUpdaterSignature(payload, signature, signer().encodedPublicKey, version), /key id mismatch/);
    const commentTampered = Buffer.from(Buffer.from(signature, "base64").toString().replace(`version:${version}`, "version:9.9.9")).toString("base64");
    assert.throws(() => verifyUpdaterSignature(payload, commentTampered, key.encodedPublicKey, "9.9.9"), /Trusted comment signature verification failed/);
    assert.throws(() => verifyUpdaterSignature(payload, key.sign(payload, "9.9.9", algorithm), key.encodedPublicKey, version), /Signed version differs/);
    assert.throws(() => verifyUpdaterSignature(payload, key.sign(payload, version, algorithm, "timestamp:1\tfile:synthetic.exe"), key.encodedPublicKey, version), /unique signed version/);
    assert.throws(() => verifyUpdaterSignature(payload, key.sign(payload, version, algorithm, `version:${version}\tversion:${version}`), key.encodedPublicKey, version), /unique signed version/);
  }
});

test("release hash list rejects duplicates, omitted files, unexpected names and content changes", () => {
  const files = { "setup.exe": Buffer.from("a"), "setup.exe.sig": Buffer.from("b"), "zinecv-desktop.exe": Buffer.from("c") };
  const lines = Object.entries(files).map(([name, bytes]) => `${sha(bytes)}  ${name}`);
  verifyReleaseHashes(lines.join("\n"), files);
  assert.throws(() => verifyReleaseHashes([...lines, lines[0]].join("\n"), files), /Duplicate/);
  assert.throws(() => verifyReleaseHashes(lines.slice(1).join("\n"), files), /must list exactly/);
  assert.throws(() => verifyReleaseHashes(lines.join("\n").replace("setup.exe.sig", "unexpected.sig"), files), /Unexpected/);
  assert.throws(() => verifyReleaseHashes(lines.join("\n"), { ...files, "setup.exe": Buffer.from("changed") }), /hash differs/);
});

test("saved release binds its own executable, current source and signed installer even when target is unrelated", async () => {
  const root = await mkdtemp(join(tmpdir(), "zinecv-release-verification-"));
  const key = signer(), version = "2.0.0-alpha.99", name = `ZineCV_${version}_x64-setup.exe`;
  const release = join(root, ".artifacts/releases", version);
  const buildOptions = { identity: { node: "synthetic compiler", flags: [] }, environment: {} };
  const options = { buildOptions, executableIdentity: async () => ({ ProductName: "ZineCV", ProductVersion: version }) };
  const put = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
  const prefix = `.artifacts/releases/${version}/`;
  const executable = Buffer.from("synthetic release executable; never executed");
  let installer = Buffer.from("synthetic NSIS installer; never executed");
  let signature = key.sign(installer, version);
  const writePayload = async () => {
    await put(prefix + name, installer); await put(prefix + name + ".sig", signature + "\n");
    const files = [name, name + ".sig", "zinecv-desktop.exe"];
    await put(prefix + "SHA256SUMS.txt", (await Promise.all(files.map(async path => `${sha(await readFile(join(release, path)))}  ${path}`))).join("\n") + "\n");
    await put(prefix + "latest.json", JSON.stringify({ version, pub_date: "2026-10-25T00:00:00Z", platforms: { "windows-x86_64": {
      signature, url: `https://github.com/StarryCode-Lang/ZineCV/releases/download/v${version}/${name}`,
    } } }));
  };
  try {
    await put("src-tauri/tauri.conf.json", JSON.stringify({ productName: "ZineCV", identifier: "com.zinecv.desktop", version,
      plugins: { updater: { requireSignedVersion: true, pubkey: key.encodedPublicKey, endpoints: ["https://github.com/StarryCode-Lang/ZineCV/releases/download/updates/latest.json"] } } }));
    await put("src-tauri/src/lib.rs", "synthetic source");
    await put("dist/index.html", "synthetic embedded frontend");
    await put("src-tauri/target/release/zinecv-desktop.exe", executable);
    await recordBuildReceipt(root, "build:native", buildOptions);
    const receipt = JSON.parse(await readFile(join(root, ".artifacts/build-receipts/build-native.json"), "utf8"));
    await put(prefix + "zinecv-desktop.exe", executable);
    await put(prefix + "build-native.json", JSON.stringify(receipt));
    await writePayload();
    await put(prefix + "package-online/package.json", JSON.stringify({ status: "passed", originalSha256: sha(executable),
      installer: { path: join(root, "src-tauri/target/release/bundle/nsis", name), sha256: sha(installer) }, executableRestored: true, symbolsRestored: true,
      receiptAfter: { reusable: true, provenance: { inputDigest: receipt.inputDigest, identityDigest: receipt.identityDigest } } }));
    await unlink(join(root, "src-tauri/target/release/zinecv-desktop.exe"));
    assert.equal((await verifyReleaseDirectory(root, release, options)).status, "passed", "target output is not the saved release proof");
    await put("src-tauri/src/lib.rs", "changed after packaging");
    await assert.rejects(verifyReleaseDirectory(root, release, options), /does not match current inputDigest/);
    await put("src-tauri/src/lib.rs", "synthetic source");
    await put(prefix + "zinecv-desktop.exe", "different saved executable");
    await writePayload();
    await assert.rejects(verifyReleaseDirectory(root, release, options), /Saved release executable differs/);
    await put(prefix + "zinecv-desktop.exe", executable);
    installer = Buffer.from("another genuinely signed build with the same version");
    signature = key.sign(installer, version);
    await writePayload();
    await assert.rejects(verifyReleaseDirectory(root, release, options), /differs from the packaged installer/);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
