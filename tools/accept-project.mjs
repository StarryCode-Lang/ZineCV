import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir, readFile, writeFile, readdir, lstat, rename, rm} from 'node:fs/promises';
import {finished} from 'node:stream/promises';
import {resolve, join, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'), out=resolve(root,process.env.ZINECV_CLOSURE_BATCH_OUT_DIR??'.artifacts/acceptance-runs/'+new Date().toISOString().replaceAll(':','-'));
if(process.platform!=='win32') throw new Error('This acceptance entry verifies the Windows host only');
if(!out.startsWith(root+sep))throw new Error('Batch output escapes workspace');
if(await lstat(join(out,'batch.json')).then(()=>true,()=>false))throw new Error('Refuse overwriting an existing batch; use a fresh output directory');
await mkdir(out,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env={...process.env,CARGO_BUILD_JOBS:'1',
 ZINECV_WEB_EVIDENCE_OUT_DIR:join(out,'web'),ZINECV_PLATFORM_PARITY_OUT_DIR:join(out,'platform-parity'),
 ZINECV_MULTIPAGE_OUT_DIR:join(out,'native-multipage'),ZINECV_ENGINE_PARITY_OUT_DIR:join(out,'engine-parity'),
 ZINECV_BACKUP_NATIVE_PARITY:'1'};
const record={schemaVersion:1,startedAt:new Date().toISOString(),status:'running',
 policy:'Frozen source; preflight before build; functional gates and package before measurements; full retains 34 stages; native/browser/memory/build workloads serial; excluded platforms untouched',stages:[]};
const save=()=>writeFile(join(out,'batch.json'),JSON.stringify(record,null,2)+'\n');
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
const snapshot=name=>node(name,['tools/bind-acceptance-evidence.mjs','--snapshot',join(out,name+'.json')]);
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
 await node('preflight',['tools/verify-project.mjs','--only','check:ts,verify:contracts,verify:fixtures,verify:licenses,test:unit','--fail-fast']);
 await native('native-build','build');
 await snapshot('source-before-full');
 await node('full-34',['tools/verify-project.mjs','--suite','full','--fail-fast']);
 await snapshot('source-after-full');
 const before=JSON.parse(await readFile(join(out,'source-before-full.json'))),after=JSON.parse(await readFile(join(out,'source-after-full.json')));
 if(before.sourceDigest!==after.sourceDigest)throw new Error('Source changed during full verification');
 await native('wasm-check','wasm-check');
 await native('platform-reference','platform-reference');
 const dist=join(root,'dist'), parking=join(out,'native-dist-cache');
 await assertDirectory(dist);const originalTree=await tree(dist);
 await writeFile(join(out,'native-dist-manifest.json'),JSON.stringify(originalTree,null,2)+'\n');
 if(await lstat(parking).then(()=>true,()=>false))throw new Error('Refuse overwriting parked native dist');
 await rename(dist,parking);
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
 await native('windows-package','bundle');
 const packaged=await readFile(executable);
 if(sha(packaged)!==sha(nativeBytes)){
  const changes=[];if(packaged.length!==nativeBytes.length)throw new Error('Bundle changed executable size');
  for(let i=0;i<packaged.length;i++)if(packaged[i]!==nativeBytes[i])changes.push(i);
  if(changes.length!==3||changes[1]!==changes[0]+1||changes[2]!==changes[0]+2||
   nativeBytes.subarray(changes[0],changes[0]+3).toString()!=='UNK'||packaged.subarray(changes[0],changes[0]+3).toString()!=='NSS')throw new Error('Unexpected bundle executable mutation');
  await writeFile(join(out,'bundle-marker.json'),JSON.stringify({originalSha256:sha(nativeBytes),packagedSha256:sha(packaged),changes,marker:'UNK -> NSS',restored:true},null,2)+'\n');
  await writeFile(executable,nativeBytes);
 }
 // Expensive measurements only begin once all functional/build gates pass.
 // Standard and extended remain three independent runs with their original budgets.
 if(process.env.ZINECV_ACCEPT_REUSE_STANDARD_BATCH)await reuseStandard(process.env.ZINECV_ACCEPT_REUSE_STANDARD_BATCH);
 else await node('memory-standard',['tools/lightweight/measure-memory.mjs','--preset','standard','--diagnostics','--out',join(out,'memory-standard'),'--label','unified-standard']);
 await node('memory-extended',['tools/lightweight/measure-memory.mjs','--preset','extended','--diagnostics','--out',join(out,'memory-extended'),'--label','unified-extended']);
 await snapshot('source-after-batch');
 const finalSource=JSON.parse(await readFile(join(out,'source-after-batch.json')));
 if(finalSource.sourceDigest!==before.sourceDigest)throw new Error('Source changed during unified batch');
 Object.assign(record,{status:'passed',endedAt:new Date().toISOString(),sourceDigest:finalSource.sourceDigest,
  scope:'Execution gates only; feature criteria, RAM trend, package contents, documentation and cleanup still require review'});await save();
}catch(error){Object.assign(record,{status:'failed',endedAt:new Date().toISOString(),error:String(error.stack)});await save();console.error(error.stack);process.exitCode=1;}
