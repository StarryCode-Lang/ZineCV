import {readdir,stat,mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
// Only new synthetic test reports/screenshots; never browser profiles or DBs.
export async function collectCurrentEvidence(root,out,share,startedAt){
 const files=[],skipped=[],since=Date.parse(startedAt);let bytes=0;
 const sources=[join(root,'.artifacts/runtime-tmp/test-evidence'),join(out,'multipage'),join(out,'engine-parity'),join(out,'offline'),join(out,'agent-geometry')];
 async function walk(directory){for(const e of await readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return[];throw error})){
  const source=join(directory,e.name);if(e.isSymbolicLink()){skipped.push({path:relative(root,source),reason:'symlink'});continue}
  if(e.isDirectory()){if(/^(profile(?:-|$)|Data$|WebView2$|Roaming$|Local$|compatible-backup$)/i.test(e.name))continue;await walk(source);continue}
  if(!/\.(json|png|pdf)$/.test(e.name))continue;const info=await stat(source);if(info.mtimeMs<since)continue;
  if(info.size>32*1024*1024||bytes+info.size>128*1024*1024){skipped.push({path:relative(root,source),reason:'share size cap; retained at source'});continue}
  const name=relative(root,source).split(sep).join('/'),target=join(share,'current-test-evidence',name);await mkdir(join(target,'..'),{recursive:true});await copyFile(source,target);bytes+=info.size;files.push({path:name,bytes:info.size,sha256:createHash('sha256').update(await readFile(source)).digest('hex')});
 }}
 for(const source of sources)await walk(source);
 await writeFile(join(share,'evidence-manifest.json'),JSON.stringify({scope:'Only new reports/screenshots from this batch; profiles/databases excluded. Missing or capped files are not implicitly accepted.',files,bytes,skipped},null,2)+'\n');
}
