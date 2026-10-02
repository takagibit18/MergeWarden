import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {objectGit,validateTask} from './adapter.mjs';
import {sha256} from '../../src/infrastructure/files.ts';

// Object-only repository cache. No target checkout, hooks, filters or execution.
export async function repositoryCache(root,repository,{signal}={}) {
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||repository.split('/').some(x=>x==='.'||x==='..'))throw Error('Invalid repository');
 const directory=resolve(root,repository.replace('/','--')),url=`https://github.com/${repository}.git`;
 await mkdir(directory,{recursive:true});
 try {await readFile(join(directory,'.git','config'));}
 catch(e){if(e.code!=='ENOENT')throw e;await objectGit(directory,['init','--template=','--object-format=sha1'],signal);await objectGit(directory,['remote','add','origin',url],signal);}
 if((await objectGit(directory,['remote','get-url','origin'],signal)).toString().trim()!==url)throw Error('Cache origin drift');
 return directory;
}
export async function ensureObjects(directory,repository,shas,{signal,offline=false,depth=2}={}) {
 const missing=[];
 for(const sha of [...new Set(shas)]) {
  if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Exact SHA required');
  try {await objectGit(directory,['cat-file','-e',sha+'^{commit}'],signal);}catch{signal?.throwIfAborted();missing.push(sha);}
 }
 if(missing.length&&offline)throw Error('missing_git_object: '+missing.join(','));
 for(let i=0;i<missing.length;i+=12)await objectGit(directory,['fetch','--no-tags','--no-recurse-submodules','--depth='+depth,`https://github.com/${repository}.git`,...missing.slice(i,i+12)],signal);
 for(const sha of shas)if((await objectGit(directory,['rev-parse',sha+'^{commit}'],signal)).toString().trim()!==sha)throw Error('Object identity drift');
}
export async function commitFacts(directory,sha,signal) {
 const body=(await objectGit(directory,['cat-file','-p',sha],signal)).toString();
 const header=body.split('\n\n')[0],match=header.match(/^committer .* (\d+) ([+-]\d+)$/m);
 return {sha,parents:[...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m=>m[1]),committedAt:match?new Date(Number(match[1])*1000).toISOString():null,contentSha256:sha256(body)};
}
export class RealCorpusAdapter {
 constructor({cache,stateDir,configuration}){this.cache=cache;this.stateDir=stateDir;this.configuration=configuration;}
 async materialize(task,{signal,offline=true}={}) {
  validateTask(task);
  const repositoryPath=await repositoryCache(this.cache,task.repository,{signal});
  await ensureObjects(repositoryPath,task.repository,[task.base_sha,task.reviewed_sha],{signal,offline});
  // SnapshotStore needs a valid HEAD to identify the repository; commits input is explicit.
  await objectGit(repositoryPath,['update-ref','refs/heads/cache',task.reviewed_sha],signal);
  await objectGit(repositoryPath,['symbolic-ref','HEAD','refs/heads/cache'],signal);
  const {freezeTask}=await import('./adapter.mjs');
  const store=await freezeTask(task,{repositoryPath,stateDir:this.stateDir,configuration:this.configuration,signal});
  return {repositoryPath,store};
 }
}
