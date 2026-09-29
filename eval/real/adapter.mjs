import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {inside,isolatedState,sha256} from '../../src/infrastructure/files.ts';
const exec=promisify(execFile);
const publicKeys=['case_id','repository','repository_url','base_sha','reviewed_sha','language','review_context_policy'];
export function validateTask(task) {
 if(!task||typeof task!=='object'||Object.keys(task).some(k=>!publicKeys.includes(k)))throw Error('Only public task fields are allowed; keep gold outside review inputs');
 if(typeof task.case_id!=='string'||typeof task.repository!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(task.case_id)||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repository)||task.repository.split('/').some(s=>s==='.'||s==='..'))throw Error('Invalid task identity');
 if(task.repository_url!==`https://github.com/${task.repository}.git`)throw Error('Repository URL must match the GitHub identity');
 if(![task.base_sha,task.reviewed_sha].every(s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s))||task.base_sha===task.reviewed_sha)throw Error('Distinct full base/reviewed SHAs required');
 if(task.language!=='Python')throw Error('Real corpus supports Python only');
 return task;
}
/** Scope mapping is admitted by the host's frozen public-task lock, never origin alone. */
export async function skillRepositoryKeyForTask(task,repositoryPath,admittedTaskHashes) {
 validateTask(task);const taskSha256=sha256(JSON.stringify(task));
 if(!Array.isArray(admittedTaskHashes)||!admittedTaskHashes.includes(taskSha256))throw Error('Task is outside the host admission lock');
 const receipt=JSON.parse(await readFile(join(repositoryPath,'.git','real-task.json'),'utf8'));
 if(receipt.taskSha256!==taskSha256||sha256(JSON.stringify(receipt.task))!==taskSha256)throw Error('Task receipt identity drift');
 const origin=(await objectGit(repositoryPath,['remote','get-url','origin'])).toString().trim();
 if(origin!==task.repository_url)throw Error('Origin identity drift');
 for(const sha of [task.base_sha,task.reviewed_sha])await objectGit(repositoryPath,['cat-file','-e',sha+'^{commit}']);
 return 'github:'+task.repository.toLowerCase();
}
/** Controlled Git only; no checkout, filters, hooks, Python or project instructions. */
export async function objectGit(directory,args,signal) {
 signal?.throwIfAborted();
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_LFS_SKIP_SMUDGE:'1'});
 return (await exec('git',['-c','safe.directory=','-c','safe.directory='+directory,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','-C',directory,...args],{env,signal,windowsHide:true,encoding:'buffer',maxBuffer:128*1024*1024,timeout:300000})).stdout;
}
/** A fresh object-backed workspace retains the upstream commit/tree/blob identities.
 * Worktree files are deliberately absent: commits-mode SnapshotStore reads Git blobs.
 */
export async function prepareTask(task,directory,{signal}={}) {
 validateTask(task);directory=resolve(directory);
 const identity=sha256(JSON.stringify(task)),receipt=join(directory,'.git','real-task.json');
 try {await mkdir(directory);} catch(e) {
  if(e.code!=='EEXIST')throw e;
  const previous=JSON.parse(await readFile(receipt,'utf8'));
  if(previous.taskSha256!==identity)throw Error('Refusing to reuse another task workspace');
 }
 try {await readFile(receipt);} catch(e) {
  if(e.code!=='ENOENT')throw e;
  await objectGit(directory,['init','--template=','--object-format=sha1'],signal);
  await objectGit(directory,['remote','add','origin',task.repository_url],signal);
  await writeFile(receipt,JSON.stringify({taskSha256:identity,task}),{flag:'wx'});
 }
 const origin=(await objectGit(directory,['remote','get-url','origin'],signal)).toString().trim();
 if(origin!==task.repository_url)throw Error('Origin identity drift');
 for(const sha of [task.base_sha,task.reviewed_sha]) {
  try {await objectGit(directory,['cat-file','-e',sha+'^{commit}'],signal);}
  catch {signal?.throwIfAborted();await objectGit(directory,['fetch','--no-tags','--no-recurse-submodules','--depth=1',task.repository_url,sha],signal);}
 }
 await objectGit(directory,['update-ref','refs/heads/reviewed',task.reviewed_sha],signal);
 await objectGit(directory,['symbolic-ref','HEAD','refs/heads/reviewed'],signal);
 return directory;
}
export async function freezeTask(task,{repositoryPath,stateDir,configuration,signal,hiddenDirectory}) {
 validateTask(task);
 const root=await realpath(repositoryPath);
 if(hiddenDirectory) {const hidden=await realpath(hiddenDirectory);if(inside(root,hidden)||inside(hidden,root))throw Error('Hidden gold and checkout must be separate');}
 const origin=(await objectGit(root,['remote','get-url','origin'],signal)).toString().trim();
 if(origin!==task.repository_url)throw Error('Origin identity drift');
 await isolatedState(stateDir,root);
 const store=await SnapshotStore.freeze({repositoryPath:root,stateDir,input:{kind:'commits',base:task.base_sha,head:task.reviewed_sha},configuration,signal});
 if(store.manifest.identity.baseCommit!==task.base_sha||store.manifest.identity.headCommit!==task.reviewed_sha)throw Error('Upstream commit identity drift');
 if(store.manifest.changedPaths.length<1||store.manifest.changedPaths.length>200)throw Error('Real task exceeds changed-path admission');
 if(!store.manifest.changedPaths.some(p=>p.endsWith('.py')))throw Error('No Python changes');
 const unsupported=store.manifest.changedPaths.filter(p=>['base','head'].some(r=>store.manifest[r][p]&&store.manifest[r][p].status!=='text'));
 if(unsupported.length)throw Error('Changed paths cannot be fully reviewed as text: '+unsupported.slice(0,10).join(', '));
 return store;
}
