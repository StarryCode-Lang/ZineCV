import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectBindings } from "../../tools/verify-bindings.mjs";
import { collectResourceInventory } from "../../tools/generate-resource-license-inventory.mjs";
import { decodeFeatureMatrix, encodeFeatureMatrix, decodeEvidenceBundle, encodeEvidenceBundle } from "../../tools/acceptance-matrix.mjs";

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
