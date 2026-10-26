import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm, unlink, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { checkBuildReceipt, recordBuildReceipt, discoverVisualStudioRoot } from "../../tools/build-receipt.mjs";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { verifyUpdaterSignature, verifyReleaseHashes, verifyReleaseDirectory } from "../../tools/verify-release.mjs";
import { spawnSync } from "node:child_process";
import { inspectBindings } from "../../tools/verify-bindings.mjs";
import { collectResourceInventory } from "../../tools/generate-resource-license-inventory.mjs";
import { decodeFeatureMatrix, encodeFeatureMatrix, decodeEvidenceBundle, encodeEvidenceBundle } from "../../tools/acceptance-matrix.mjs";

// build-receipt
{
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
}

// release-verification
{
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
}

// validation-policy
{
  const root = resolve(import.meta.dirname, "../..");
  async function sandbox(run) {
    const directory = await mkdtemp(join(tmpdir(), "zinecv-validation-"));
    try { await run(directory); }
    finally { await rm(directory, {recursive:true,force:true}); }
  }

  test("editing generated fixture content requires no pins; broken graphs still fail", async () => sandbox(async directory => {
    const source = await readFile(join(root,"fixtures/remaining.mjs"),"utf8");
    const manual = await readFile(join(root,"fixtures/remaining/manual-scenarios.md"),"utf8");
    const resources = ["crates/zinecv-storage/src/migration.rs",...source.matchAll(/"((?:public\/fonts\/|crates\/zinecv-engine\/|src\/ui\/styles\/)[^"]+)"/g)].map(value=>typeof value === "string" ? value : value[1]);
    for(const resource of new Set(resources)) {
      await mkdir(dirname(join(directory,resource)),{recursive:true});
      await writeFile(join(directory,resource),"synthetic source bytes");
    }
    await mkdir(join(directory,"fixtures/remaining"),{recursive:true});
    await writeFile(join(directory,"fixtures/remaining/manual-scenarios.md"),manual);
    const module=join(directory,"fixtures/remaining.mjs");
    const edited=source.replace("合成验收样本：","可编辑样本：");
    assert.notEqual(edited,source);
    await writeFile(module,edited);
    const check=()=>spawnSync(process.execPath,[module,"--check"],{encoding:"utf8"});
    const valid=check();
    assert.equal(valid.status,0,valid.stderr);
    await writeFile(module,edited.replace('const graph = makeVersionGraph();','const graph = makeVersionGraph(); graph.commits[1].parentId = "missing-parent";'));
    const broken=check();
    assert.notEqual(broken.status,0);
    assert.match(broken.stderr,/missing parent/);
  }));

  test("binding edits need no hash update; missing imports still fail", async () => sandbox(async directory => {
    const bindings = join(directory,"src-tauri/src/domain/bindings");
    await mkdir(bindings,{recursive:true});
    await writeFile(join(bindings,"Value.ts"),'export type Value = { title: string };\n');
    assert.equal((await inspectBindings(directory)).length,1);
    await writeFile(join(bindings,"Value.ts"),'// revised schema\nexport type Value = { title: string; optional?: number };\n');
    assert.equal((await inspectBindings(directory)).length,1);
    await writeFile(join(bindings,"Value.ts"),'import type {Missing} from "./Missing"; export type Value = Missing;');
    await assert.rejects(inspectBindings(directory),/Unresolved binding import/);
  }));

  test("license updates are observations; missing and empty local notices still fail", async () => sandbox(async directory => {
    await mkdir(join(directory,"docs/licenses"),{recursive:true});
    await mkdir(join(directory,"node_modules/sample"),{recursive:true});
    const config = {schemaVersion:1,licenses:[{path:"docs/licenses/sample.txt",source:"node_modules/sample/LICENSE"}],resourceDirectories:[]};
    const saveConfig = () => writeFile(join(directory,"docs/resource-licenses.json"),JSON.stringify(config));
    await saveConfig();
    await writeFile(join(directory,"package.json"),JSON.stringify({dependencies:{sample:"*"}}));
    await writeFile(join(directory,"package-lock.json"),JSON.stringify({packages:{"node_modules/sample":{version:"2",license:"MIT"}}}));
    await writeFile(join(directory,"docs/licenses/sample.txt"),"Notice A");
    await writeFile(join(directory,"node_modules/sample/LICENSE"),"Notice B");
    assert.equal((await collectResourceInventory(directory)).licenses[0].comparison,"different-review-required");
    await writeFile(join(directory,"docs/licenses/sample.txt"),"Notice B");
    assert.equal((await collectResourceInventory(directory)).licenses[0].comparison,"identical");
    await rm(join(directory,"node_modules/sample/LICENSE"));
    assert.equal((await collectResourceInventory(directory)).licenses[0].comparison,"unavailable");
    await writeFile(join(directory,"docs/licenses/sample.txt"),"");
    await assert.rejects(collectResourceInventory(directory),/Empty license/);
    await rm(join(directory,"docs/licenses/sample.txt"));
    await assert.rejects(collectResourceInventory(directory),/Missing local license/);
    config.licenses[0].path="../outside.txt";
    await saveConfig();
    await assert.rejects(collectResourceInventory(directory),/escapes workspace/);
  }));

  test("historical evidence hashes do not freeze today's fixture; failing checks still fail", async () => sandbox(async directory => {
    const copy = async path => {
      await mkdir(dirname(join(directory,path)),{recursive:true});
      await cp(join(root,path),join(directory,path),{recursive:true});
    };
    for (const path of ["tools/verify-contracts.mjs","tools/acceptance-matrix.mjs","docs/feature-parity.json","docs/evidence","contracts/poc-contract-v1.json","package.json","src-tauri/src/lib.rs","src-tauri/src/domain/bindings","src-tauri/capabilities/default.json"]) await copy(path);
    const matrixPath=join(directory,"docs/feature-parity.json");
    const before=await readFile(matrixPath,"utf8");
    const matrix=decodeFeatureMatrix(JSON.parse(before));
    for(const entry of matrix.filter(entry=>entry.status==="passed")) {
      for(const source of entry.implementationPaths) await copy(source.split("#")[0]);
    }
    const passed=matrix.find(entry=>entry.status==="passed");
    const evidencePath=join(directory,passed.evidence[0].split("#")[0]);
    const evidenceData=JSON.parse(await readFile(evidencePath,"utf8"));
    const evidenceBundle=evidenceData.records ? decodeEvidenceBundle(evidenceData) : null;
    const evidence=evidenceBundle?.records[passed.featureId] ?? evidenceData;
    const saveEvidence=()=>writeFile(evidencePath,JSON.stringify(evidenceBundle ? encodeEvidenceBundle({...evidenceBundle,records:{...evidenceBundle.records,[passed.featureId]:evidence}}) : evidence));
    for(const check of evidence.checks) {
      const fixturePath=join(directory,check.fixture.path);
      await mkdir(dirname(fixturePath),{recursive:true});
      await writeFile(fixturePath,'{"updated":true}\n');
    }
    const verify = () => spawnSync(process.execPath,[join(directory,"tools/verify-contracts.mjs")],{encoding:"utf8"});
    const result=verify();
    assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(matrixPath,"utf8"),before);
    evidence.checks[0].exitCode=1;
    evidence.checks[0].result="rejected";
    await saveEvidence();
    const failed=verify();
    assert.notEqual(failed.status,0);
    assert.match(failed.stderr,/incomplete or non-passing/);
    evidence.checks[0].exitCode=0;
    delete evidence.checks[0].result;
    await writeFile(evidencePath,JSON.stringify(encodeEvidenceBundle({...evidenceBundle,schemaVersion:1,records:{...evidenceBundle?.records,[passed.featureId]:evidence}})));
    passed.evidence=[`${passed.evidence[0].split("#")[0]}#${passed.featureId}`];
    await writeFile(matrixPath,JSON.stringify(encodeFeatureMatrix(matrix)));
    const bundled=verify();
    assert.equal(bundled.status,0,bundled.stderr);
  }));

  test("shared feature contexts preserve state and return independently editable rows", () => {
    const rows=[{featureId:"F01",status:"pending",revision:"r1",environment:{os:"isolated"}},
      {featureId:"F02",status:"blocked",revision:"r1",environment:{os:"isolated"}}];
    const encoded=encodeFeatureMatrix(rows);
    assert.equal(Object.keys(encoded.contexts).length,1);
    assert.deepEqual(decodeFeatureMatrix(encoded),rows);
    const decoded=decodeFeatureMatrix(encoded);
    decoded[0].environment.os="edited";
    assert.equal(decoded[1].environment.os,"isolated");
    assert.equal(decodeFeatureMatrix(encoded)[0].environment.os,"isolated");
    encoded.features[0].contextRef="missing";
    assert.throws(()=>decodeFeatureMatrix(encoded),/Unknown feature context/);
    encoded.features[0].contextRef="context-1";
    encoded.contexts["context-1"].status="passed";
    assert.throws(()=>decodeFeatureMatrix(encoded),/Invalid feature context/);
  });

  test("shared evidence checks preserve original records and reject unresolved references", () => {
    const check={kind:"U",stage:"unit",command:"node test",exitCode:0,environment:{os:"isolated"}};
    const original={schemaVersion:1,batch:"historical",records:{
      F01:{schemaVersion:1,featureId:"F01",revision:"old",recordedAt:"2026-10-17",checks:[check],coverageStatus:"partial_unreviewed"},
      F02:{schemaVersion:1,featureId:"F02",revision:"old",recordedAt:"2026-10-17",checks:[structuredClone(check)],coverageStatus:"partial_unreviewed"}}};
    const encoded=encodeEvidenceBundle(original);
    assert.equal(Object.keys(encoded.checks).length,1);
    assert.deepEqual(decodeEvidenceBundle(encoded),original);
    const decoded=decodeEvidenceBundle(encoded);
    decoded.records.F01.checks[0].exitCode=1;
    assert.equal(decoded.records.F02.checks[0].exitCode,0);
    encoded.records.F01.checkRefs=["missing"];
    assert.throws(()=>decodeEvidenceBundle(encoded),/Unknown evidence check/);
  });

  test("evidence bookkeeping emits one shared batch without changing acceptance statuses", async () => sandbox(async directory => {
    // Synthetic records exercise bookkeeping only; no application or acceptance suite runs.
    for (const path of ["tools/bind-acceptance-evidence.mjs","tools/acceptance-matrix.mjs","docs/feature-parity.json","package.json"]) {
      await mkdir(dirname(join(directory,path)),{recursive:true});
      await cp(join(root,path),join(directory,path));
    }
    const env={...process.env,GIT_DIR:join(root,".git"),GIT_WORK_TREE:directory};
    const invoke=(...args)=>{
      const result=spawnSync(process.execPath,[join(directory,"tools/bind-acceptance-evidence.mjs"),...args],{env,encoding:"utf8"});
      assert.equal(result.status,0,result.stderr);
    };
    const matrixPath=join(directory,"docs/feature-parity.json");
    const matrixBefore=await readFile(matrixPath,"utf8");
    await writeFile(join(directory,"Cargo.toml"),"synthetic workspace");
    await writeFile(join(directory,"Cargo.lock"),"synthetic dependency lock");
    invoke("--snapshot",".artifacts/before.json");
    const before=JSON.parse(await readFile(join(directory,".artifacts/before.json"),"utf8"));
    for (const path of ["Cargo.toml", "Cargo.lock"]) assert.ok(before.files.some(file=>file.path===path), `${path} must bind the verification input`);
    const now=new Date().toISOString();
    await writeFile(join(directory,".artifacts/unit.log"),"Synthetic bookkeeping fixture; not an application test result.\n");
    await writeFile(join(directory,".artifacts/run.json"),JSON.stringify({startedAt:now,endedAt:now,status:"passed",revision:{head:before.head},environment:{platform:"synthetic"},stages:[{script:"test:unit",status:"passed",exitCode:0,stdoutPath:".artifacts/unit.log"}]}));
    invoke("--snapshot",".artifacts/after.json");
    await writeFile(join(directory,"Cargo.lock"),"changed after verification");
    const changed=spawnSync(process.execPath,[join(directory,"tools/bind-acceptance-evidence.mjs"),"--run",".artifacts/run.json","--before",".artifacts/before.json","--after",".artifacts/after.json"],{env,encoding:"utf8"});
    assert.notEqual(changed.status,0,"workspace lock mutation must invalidate evidence binding");
    assert.match(changed.stderr,/Source changed before\/during\/after verification/);
    await writeFile(join(directory,"Cargo.lock"),"synthetic dependency lock");
    invoke("--run",".artifacts/run.json","--before",".artifacts/before.json","--after",".artifacts/after.json");
    const {readdir}=await import("node:fs/promises");
    const output=join(directory,".artifacts/evidence/current");
    assert.deepEqual((await readdir(output)).sort(),["records.json","suite-input-manifest.json","summary.json"]);
    const batch=JSON.parse(await readFile(join(output,"records.json"),"utf8"));
    assert.equal(batch.schemaVersion,2);
    assert.equal(Object.keys(decodeEvidenceBundle(batch).records).length,decodeFeatureMatrix(JSON.parse(matrixBefore)).length);
    assert.equal(await readFile(matrixPath,"utf8"),matrixBefore);
  }));
}
