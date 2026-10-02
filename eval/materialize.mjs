import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { safePath } from '../src/infrastructure/files.ts';
const exec=promisify(execFile);
/** Deterministic Git object construction. Never executes fixture Python or checkout hooks. */
export async function materializeCase(item, directory) {
 await mkdir(directory,{recursive:true});
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_AUTHOR_NAME:'MergeWarden Golden',GIT_AUTHOR_EMAIL:'golden@example.invalid',GIT_COMMITTER_NAME:'MergeWarden Golden',GIT_COMMITTER_EMAIL:'golden@example.invalid',GIT_AUTHOR_DATE:'2026-09-20T00:00:00Z',GIT_COMMITTER_DATE:'2026-09-20T00:00:00Z'};
 const git=async(...args)=>(await exec('git',['-c','core.autocrlf=false','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-C',resolve(directory),...args],{env,windowsHide:true})).stdout.trim();
 await git('init','--object-format=sha1');
 // Only trusted frozen JSON is written; no checkout or source execution is needed.
 const work=join(directory,'.git','materialized');await mkdir(work,{recursive:true});
 async function commit(files,parent) {
  await git('read-tree','--empty');
  for(const [path,source] of Object.entries(files).sort(([a],[b])=>a.localeCompare(b))) {
   safePath(path);const dest=join(work,path);await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,source);
   const oid=await git('hash-object','-w','--no-filters',dest);await git('update-index','--add','--cacheinfo',`100644,${oid},${path}`);
  }
  const tree=await git('write-tree');return git('commit-tree',tree,...(parent?['-p',parent]:[]),'-m',`${item.id}:${parent?'head':'base'}`);
 }
 const base=await commit(item.baseFiles);const head=await commit(item.headFiles,base);
 if(item.baseSha && (item.baseSha!==base || item.headSha!==head))throw Error(`Frozen commit mismatch: ${item.id}`);
 await git('update-ref','refs/heads/golden',head);await git('symbolic-ref','HEAD','refs/heads/golden');
 return {base,head};
}
