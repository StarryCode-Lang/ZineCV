import{readFile,writeFile,mkdir}from'node:fs/promises';import{spawn}from'node:child_process';import{resolve,join}from'node:path';import{createHash}from'node:crypto';import assert from'node:assert/strict';import{checkBuildReceipt}from'../../tools/build-receipt.mjs';
const root=process.cwd(),out=resolve(process.env.ZINECV_CLOSEOUT_OUT_DIR, 'package-offline');await mkdir(out,{recursive:true});const sha=b=>createHash('sha256').update(b).digest('hex'),exe=resolve('src-tauri/target/release/zinecv-desktop.exe'),pdb=resolve('src-tauri/target/release/zinecv_desktop.pdb');
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

const before=await checkBuildReceipt(root,'build:native');assert.ok(before.reusable,JSON.stringify(before));const original=await readFile(exe),symbols=await readFile(pdb);await writeFile(join(out,'pre-bundle.exe'),original,{flag:'wx'});await writeFile(join(out,'pre-bundle.pdb'),symbols,{flag:'wx'});let bundleLog='';const report={variant:'offline-webview2',command:'tauri bundle --bundles nsis --config src-tauri/tauri.conf.offline.json',startedAt:new Date().toISOString(),originalSha256:sha(original),originalPdbSha256:sha(symbols)};
try{const code=await new Promise((done,reject)=>{const p=spawn('cmd.exe',['/d','/s','/c','node_modules\\.bin\\tauri.cmd bundle --bundles nsis --config src-tauri/tauri.conf.offline.json'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of[p.stdout,p.stderr])stream.on('data',b=>{bundleLog+=b;process.stdout.write(b)});p.on('error',reject);p.on('close',done);});assert.equal(code,0);const packaged=await readFile(exe);report.mutation=validateBundleMutation(original,packaged);report.packagedSha256=sha(packaged);const installer=resolve('src-tauri/target/release/bundle/nsis/ZineCV_2.0.0-alpha.0_x64-setup.exe');report.installer={path:installer,sha256:sha(await readFile(installer))};report.status='passed';}catch(e){report.status='failed';report.error=String(e.stack??e);process.exitCode=1;}finally{await writeFile(exe,original);await writeFile(pdb,symbols);report.executableRestored=sha(await readFile(exe))===sha(original);report.symbolsRestored=sha(await readFile(pdb))===sha(symbols);assert.ok(report.executableRestored&&report.symbolsRestored);report.receiptAfter=await checkBuildReceipt(root,'build:native');assert.ok(report.receiptAfter.reusable,JSON.stringify(report.receiptAfter));report.endedAt=new Date().toISOString();await writeFile(join(out,'bundle.log'),bundleLog);await writeFile(join(out,'package.json'),JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify({status:report.status,installer:report.installer,executableRestored:report.executableRestored,symbolsRestored:report.symbolsRestored,error:report.error}));
