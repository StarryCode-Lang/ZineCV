import {spawn,spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir, readFile, writeFile, readdir, lstat, rename, rm, cp} from 'node:fs/promises';
import {finished} from 'node:stream/promises';
import {resolve, join, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {safetyStages} from './verify-project.mjs';
const root=resolve(import.meta.dirname,'..'), out=resolve(root,process.env.ZINECV_CLOSURE_BATCH_OUT_DIR??'.artifacts/acceptance-runs/'+new Date().toISOString().replaceAll(':','-'));
const remainingOnly=process.env.ZINECV_ACCEPT_REMAINING==='1';
const verificationSuite=remainingOnly?'remaining':'full';
const verificationStage=remainingOnly?'remaining-regression':'full-34';
if(process.argv.includes('--plan')){
 const planEnv={...process.env};delete planEnv.ZINECV_VERIFY_ONLY;delete planEnv.ZINECV_VERIFY_PLAN;
 const planned=spawnSync(process.execPath,['tools/verify-project.mjs','--suite',verificationSuite,'--plan'],{cwd:root,env:planEnv,encoding:'utf8',windowsHide:true});
 if(planned.status!==0)throw new Error(planned.stderr||'Cannot plan verification');
 console.log(JSON.stringify({mode:remainingOnly?'remaining-only':'complete',verification:JSON.parse(planned.stdout),
  safetyPreflight:safetyStages,
  additional:['wasm-check','platform-reference','web-build','web-core','web-product','platform-parity','windows-package','memory-standard','memory-extended'],
  measurements:{standard:'120s x 3',extended:'30min x 3'},
  scope:remainingOnly?'Complement of regression plus platform/package/measurements; not a standalone full acceptance or proof of an earlier regression run.':'Complete execution chain; external human qualifications remain separate.'},null,2));
 process.exit(0);
}
if(remainingOnly&&(process.env.ZINECV_ACCEPT_RESUME_BATCH||process.env.ZINECV_ACCEPT_REUSE_STANDARD_BATCH))throw new Error('Remaining-only mode does not reuse legacy full checkpoints or measurements');
if(process.platform!=='win32') throw new Error('This acceptance entry verifies the Windows host only');
if(!out.startsWith(root+sep))throw new Error('Batch output escapes workspace');
if(await lstat(join(out,'batch.json')).then(()=>true,()=>false))throw new Error('Refuse overwriting an existing batch; use a fresh output directory');
await mkdir(out,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env={...process.env,CARGO_BUILD_JOBS:'1',
 ZINECV_NATIVE_EVIDENCE_OUT_DIR:join(out,'native-evidence'),
 ZINECV_WEB_EVIDENCE_OUT_DIR:join(out,'web'),ZINECV_PLATFORM_PARITY_OUT_DIR:join(out,'platform-parity'),
 ZINECV_MULTIPAGE_OUT_DIR:join(out,'native-multipage'),ZINECV_ENGINE_PARITY_OUT_DIR:join(out,'engine-parity'),
 ZINECV_BACKUP_NATIVE_PARITY:'1'};
// An inherited diagnostic selection/plan must never turn manual qualification into a no-op.
delete env.ZINECV_VERIFY_ONLY;delete env.ZINECV_VERIFY_PLAN;
const record={schemaVersion:1,startedAt:new Date().toISOString(),status:'running',
 coverageMode:remainingOnly?'remaining-only':'complete',verificationSuite,
 policy:'Frozen source; preflight before build; functional gates and package before measurements; full retains 34 stages; native/browser/memory/build workloads serial; excluded platforms untouched',stages:[]};
const save=()=>writeFile(join(out,'batch.json'),JSON.stringify(record,null,2)+'\n');
async function resumeFullCheckpoint(previousDirectory) {
 const previous=resolve(root,previousDirectory);await assertDirectory(previous);
 const prior=JSON.parse(await readFile(join(previous,'batch.json')));
 if(prior.status!=='failed'||prior.stages.at(-1)?.name!=='platform-reference'||prior.stages.at(-1)?.status!=='passed')
  throw new Error('Resume requires a failed batch interrupted after platform-reference');
 const before=JSON.parse(await readFile(join(previous,'source-before-full.json'))),after=JSON.parse(await readFile(join(previous,'source-after-full.json')));
 const current=JSON.parse(await readFile(join(out,'source-before-batch.json')));
 const inputs=source=>source.files.filter(file=>file.path!=='tools/accept-project.mjs');
 if(before.sourceDigest!==after.sourceDigest||before.head!==current.head||before.matrixSha256!==current.matrixSha256||
  JSON.stringify(inputs(before))!==JSON.stringify(inputs(current)))throw new Error('Full checkpoint product, tests or matrix changed');
 const fullLog=await readFile(join(previous,'full-34.log'),'utf8');
 const match=fullLog.match(/Verification passed; report=([^\r\n]+)/);
 if(!match)throw new Error('Full checkpoint has no verifier report');
 const runPath=resolve(match[1]);if(!runPath.startsWith(root+sep))throw new Error('Verifier report escapes workspace');
 const runBytes=await readFile(runPath),run=JSON.parse(runBytes);
 if(run.status!=='passed'||run.suite!=='full'||!run.fullCoverage||run.stages.length!==34||
  new Set(run.stages.map(stage=>stage.script)).size!==34||run.stages.some(stage=>stage.status!=='passed'||stage.exitCode!==0)||
  run.inputs.matrixSha256!==current.matrixSha256||sha(await readFile(join(root,run.releaseArtifact.path)))!==run.releaseArtifact.sha256)
  throw new Error('Full checkpoint is incomplete or its executable changed');
 const nativeManifest=JSON.parse(await readFile(join(previous,'native-dist-manifest.json')));
 await assertDirectory(join(root,'dist'));
 if((await tree(join(root,'dist'))).digest!==nativeManifest.digest)throw new Error('Checkpoint native frontend changed');
 for(const name of ['preflight','native-build','full-34']){
  const entry=prior.stages.find(stage=>stage.name===name);
  if(!entry||entry.status!=='passed'||entry.exitCode!==0)throw new Error('Incomplete checkpoint stage: '+name);
  const logPath=resolve(root,entry.log);if(!logPath.startsWith(previous+sep))throw new Error('Checkpoint log escapes previous batch');
  record.stages.push({...entry,mode:'reused',recordedAt:new Date().toISOString(),proof:{logSha256:sha(await readFile(logPath)),
   fullReport:relative(root,runPath).split(sep).join('/'),fullReportSha256:sha(runBytes),sourceComparison:'Identical product, tests and matrix; only this orchestration entry may differ'}});
 }
 record.resumedFrom=relative(root,previous).split(sep).join('/');record.testEvidence=prior.testEvidence;
 await save();console.log('REUSED preflight/native-build/full-34: complete frozen-source checkpoint');
}
async function stage(name,command,args) {
 const entry={name,command,args,startedAt:new Date().toISOString(),status:'running',log:relative(root,join(out,name+'.log')).split(sep).join('/')};
 record.stages.push(entry); await save(); console.log('START '+name);
 const log=createWriteStream(resolve(root,entry.log));
 const child=spawn(command,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',bytes=>log.write(bytes));child.stderr.on('data',bytes=>log.write(bytes));
 let code;
 try{code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',value=>done(value??1));});}
 finally{log.end();await finished(log);}
 Object.assign(entry,{endedAt:new Date().toISOString(),exitCode:code,status:code===0?'passed':'failed'});await save();
 console.log(entry.status.toUpperCase()+' '+name);
 if(code!==0)throw new Error(name+' failed; see '+entry.log);
}
const node=(name,args)=>stage(name,process.execPath,args);
const native=(name,task)=>stage(name,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tools/with-msvc.ps1',task]);
async function tree(directory) {
 const files=[];
 async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){
  const target=join(path,entry.name);if(entry.isSymbolicLink())throw new Error('Unexpected build junction: '+target);
  if(entry.isDirectory())await walk(target);else files.push({path:relative(directory,target).split(sep).join('/'),sha256:sha(await readFile(target))});
 }}
 await walk(directory);files.sort((a,b)=>a.path.localeCompare(b.path));return {files,digest:sha(Buffer.from(JSON.stringify(files)))};
}
async function assertDirectory(path) {
 if(!path.startsWith(root+sep))throw new Error('Build path escapes workspace');
 const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Unexpected build directory: '+path);
}
async function archiveTestEvidence() {
 const source=join(root,'.artifacts/runtime-tmp/test-evidence'), destination=join(out,'test-evidence');
 if(!await lstat(source).then(()=>true,()=>false))return;
 await assertDirectory(source);
 if(await lstat(destination).then(()=>true,()=>false))throw new Error('Refuse overwriting archived test evidence');
 const original=await tree(source);
 await cp(source,destination,{recursive:true,force:false,errorOnExist:true});
 if((await tree(destination)).digest!==original.digest)throw new Error('Archived test evidence hash mismatch');
 const manifest={...original,archivedAt:new Date().toISOString(),
  scope:'Preserves runtime outputs, including any inherited files; full-34 logs establish which tests ran. Copying does not confer a passing status.'};
 await writeFile(join(out,'test-evidence-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 record.testEvidence={path:relative(root,destination).split(sep).join('/'),files:original.files.length,digest:original.digest};
 await save();
}
const snapshot=name=>node(name,['tools/bind-acceptance-evidence.mjs','--snapshot',join(out,name+'.json')]);
function peMetadataFields(bytes) {
 const bounded=(offset,length)=>{if(!Number.isInteger(offset)||offset<0||offset+length>bytes.length)throw new Error('Malformed PE bounds');return offset;};
 const u16=offset=>bytes.readUInt16LE(bounded(offset,2)),u32=offset=>bytes.readUInt32LE(bounded(offset,4));
 if(bytes.subarray(0,2).toString()!=='MZ')throw new Error('Missing DOS header');
 const pe=u32(0x3c);if(bytes.subarray(bounded(pe,4),pe+4).toString()!=='PE\0\0')throw new Error('Missing PE signature');
 const coff=pe+4,optional=coff+20,optionalSize=u16(coff+16),magic=u16(optional);
 if(![0x10b,0x20b].includes(magic))throw new Error('Unsupported PE optional header');
 const directories=optional+(magic===0x20b?112:96),debugEntry=directories+6*8;
 if(debugEntry+8>optional+optionalSize)throw new Error('Missing debug directory');
 const debugRva=u32(debugEntry),debugSize=u32(debugEntry+4),sectionTable=optional+optionalSize;
 let debug;
 for(let i=0;i<u16(coff+2);i++){
  const section=sectionTable+i*40,rva=u32(section+12),rawSize=u32(section+16);
  if(debugRva>=rva&&debugRva+debugSize<=rva+rawSize)debug=u32(section+20)+debugRva-rva;
 }
 if(debug===undefined||debugSize!==84)throw new Error('Unexpected PE debug directory');
 bounded(debug,debugSize);
 const timestamps=[coff+4],types=[],guids=[];
 for(let offset=debug;offset<debug+debugSize;offset+=28){
  timestamps.push(offset+4);const type=u32(offset+12);types.push(type);
  if(type===2){const raw=u32(offset+24);if(u32(offset+16)<24||bytes.subarray(bounded(raw,24),raw+4).toString()!=='RSDS')throw new Error('Missing RSDS record');guids.push(raw+4);}
 }
 if(types.join(',')!=='2,12,13'||guids.length!==1||new Set(timestamps.map(u32)).size!==1)throw new Error('Unexpected PE metadata layout');
 return {timestamps,guid:guids[0]};
}
function validateBundleMutation(original,packaged) {
 if(original.length!==packaged.length)throw new Error('Bundle changed executable size');
 const fields=peMetadataFields(original),after=peMetadataFields(packaged);
 if(JSON.stringify(fields)!==JSON.stringify(after))throw new Error('Bundle changed PE field boundaries');
 const ranges=[...fields.timestamps.map(from=>({from,length:4,name:'TimeDateStamp'})),{from:fields.guid,length:16,name:'CodeView GUID'}];
 let changes=0;
 for(let index=0;index<original.length;index++)if(original[index]!==packaged[index]){
  if(!ranges.some(range=>index>=range.from&&index<range.from+range.length))throw new Error('Unexpected bundle executable mutation at '+index);
  changes++;
 }
 return {changes,ranges,originalTimestamp:original.readUInt32LE(fields.timestamps[0]),packagedTimestamp:packaged.readUInt32LE(fields.timestamps[0])};
}
async function reuseStandard(previousDirectory) {
 const previous=resolve(root,previousDirectory);
 if(!previous.startsWith(root+sep))throw new Error('Reuse evidence escapes workspace');
 const oldSource=JSON.parse(await readFile(join(previous,'source-before-batch.json')));
 const currentSource=JSON.parse(await readFile(join(out,'source-before-batch.json')));
 const measuredInputs=files=>files.filter(file=>file.path!=='tools/accept-project.mjs');
 if(JSON.stringify(measuredInputs(oldSource.files))!==JSON.stringify(measuredInputs(currentSource.files)))throw new Error('Measured product or test inputs changed; standard reuse refused');
 const prior=JSON.parse(await readFile(join(previous,'batch.json')));
 if(!prior.stages.some(entry=>entry.name==='memory-standard'&&entry.status==='passed'))throw new Error('Previous standard stage did not pass');
 const directory=join(previous,'memory-standard');
 const names=(await readdir(directory)).filter(name=>/^unified-standard-[1-3]\.json$/.test(name)).sort();
 if(names.length!==3)throw new Error('Standard reuse requires three raw run records');
 const executableHash=sha(await readFile(join(root,'src-tauri/target/release/zinecv-desktop.exe'))),proof=[];
 for(const name of names){
  const path=join(directory,name),bytes=await readFile(path),run=JSON.parse(bytes);
  if(run.run.status!=='passed'||run.soak.requestedMs!==120000||run.soak.actualMs<120000||run.soak.failures.length||
   run.binary.before.sha256!==executableHash||run.binary.after.sha256!==executableHash||!run.binary.stableAcrossRun||
   !run.cleanup.cleanupVerified||!run.cleanup.profileDeleted||run.cleanup.ownPidsStillAlive.length)throw new Error('Incomplete or source-mismatched standard run: '+name);
  proof.push({path:relative(root,path).split(sep).join('/'),sha256:sha(bytes),actualMs:run.soak.actualMs});
 }
 record.stages.push({name:'memory-standard',status:'passed',mode:'reused',recordedAt:new Date().toISOString(),
  executableSha256:executableHash,sourceComparison:'All snapshot inputs identical except this orchestration entry; product and measurement unchanged',proof});
 await save();console.log('REUSED memory-standard: three complete source-matched runs');
}
try {
 await snapshot('source-before-batch');
 const resume=process.env.ZINECV_ACCEPT_RESUME_BATCH;
 if(resume)await resumeFullCheckpoint(resume);
 else {
  await node('preflight',['tools/verify-project.mjs','--only',safetyStages.join(','),'--fail-fast']);
  await native('native-build','build');
 }
 await snapshot('source-before-full');
 if(!resume){
  try {await node(verificationStage,['tools/verify-project.mjs','--suite',verificationSuite,'--fail-fast']);}
  finally {await archiveTestEvidence();}
 }
 await snapshot('source-after-full');
 const before=JSON.parse(await readFile(join(out,'source-before-full.json'))),after=JSON.parse(await readFile(join(out,'source-after-full.json')));
 if(before.sourceDigest!==after.sourceDigest)throw new Error('Source changed during full verification');
 await native('wasm-check','wasm-check');
 await native('platform-reference','platform-reference');
 const dist=join(root,'dist'), parking=join(out,'native-dist-cache');
 await assertDirectory(dist);const originalTree=await tree(dist);
 await writeFile(join(out,'native-dist-manifest.json'),JSON.stringify(originalTree,null,2)+'\n');
 if(await lstat(parking).then(()=>true,()=>false))throw new Error('Refuse overwriting parked native dist');
 for(let attempt=0;;attempt++){
  try {await rename(dist,parking);break;}
  catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=5)throw error;
   await new Promise(done=>setTimeout(done,200*(attempt+1)));}
 }
 let webPassed=false;
 try {
  await node('web-build',['tools/build-web.mjs']);
  await node('web-core',['--test','--test-concurrency=1','tools/web-core-poc.test.mjs','tools/web-store-poc.test.mjs','tools/web-agent-poc.test.mjs']);
  await node('web-product',['--test','tools/web-product.test.mjs']);
  await node('platform-parity',['--test','tools/platform-parity.test.mjs']);
  await writeFile(join(out,'web-dist-manifest.json'),JSON.stringify(await tree(dist),null,2)+'\n');
  webPassed=true;
 } finally {
  if(await lstat(dist).then(()=>true,()=>false)){
   await assertDirectory(dist);
   if(webPassed)await rm(dist,{recursive:true,force:true});
   else await rename(dist,join(out,'web-dist-failure'));
  }
  await assertDirectory(parking);await rename(parking,dist);
  if((await tree(dist)).digest!==originalTree.digest)throw new Error('Native frontend restoration hash mismatch');
 }
 const executable=join(root,'src-tauri/target/release/zinecv-desktop.exe'),nativeBytes=await readFile(executable);
 const backup=join(out,'pre-bundle.exe');await writeFile(backup,nativeBytes,{flag:'wx'});
 try {
  await native('windows-package','bundle');
  const packaged=await readFile(executable),mutation=validateBundleMutation(nativeBytes,packaged);
  await writeFile(join(out,'bundle-marker.json'),JSON.stringify({originalSha256:sha(nativeBytes),packagedSha256:sha(packaged),...mutation},null,2)+'\n');
 } finally {
  await writeFile(executable,nativeBytes);
  const restoredSha256=sha(await readFile(executable));
  if(restoredSha256!==sha(nativeBytes))throw new Error('Pre-bundle executable restoration failed; backup retained');
  await writeFile(join(out,'bundle-restore.json'),JSON.stringify({originalSha256:sha(nativeBytes),restoredSha256,restored:true},null,2)+'\n');
 }
 await rm(backup);
 // Expensive measurements only begin once all functional/build gates pass.
 // Standard and extended remain three independent runs with their original budgets.
 if(process.env.ZINECV_ACCEPT_REUSE_STANDARD_BATCH)await reuseStandard(process.env.ZINECV_ACCEPT_REUSE_STANDARD_BATCH);
 else await node('memory-standard',['tools/lightweight/measure-memory.mjs','--preset','standard','--diagnostics','--out',join(out,'memory-standard'),'--label','unified-standard']);
 await node('memory-extended',['tools/lightweight/measure-memory.mjs','--preset','extended','--diagnostics','--out',join(out,'memory-extended'),'--label','unified-extended']);
 await snapshot('source-after-batch');
 const finalSource=JSON.parse(await readFile(join(out,'source-after-batch.json')));
 if(finalSource.sourceDigest!==before.sourceDigest)throw new Error('Source changed during unified batch');
 Object.assign(record,{status:'passed',endedAt:new Date().toISOString(),sourceDigest:finalSource.sourceDigest,
  scope:remainingOnly?'Remaining-only gates passed; common regression is excluded and not imported. This is not standalone full acceptance. External criteria still require review.':'Execution gates only; feature criteria, RAM trend, package contents, documentation and cleanup still require review'});await save();
}catch(error){Object.assign(record,{status:'failed',endedAt:new Date().toISOString(),error:String(error.stack)});await save();console.error(error.stack);process.exitCode=1;}
