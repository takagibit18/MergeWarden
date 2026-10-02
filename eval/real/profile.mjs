import {objectGit,validateTask} from './adapter.mjs';
import {SnapshotStore} from '../../src/snapshot/store.ts';

export async function profileTask(task,{repositoryPath,stateDir,signal}) {
 validateTask(task);
 const files=(await objectGit(repositoryPath,['ls-tree','-rlz',task.reviewed_sha],signal)).toString().split('\0').filter(Boolean).map(x=>{const [meta,path]=x.split('\t');const [mode,type,sha,size]=meta.trim().split(/\s+/);return {path,mode,type,sha,size:Number(size)};});
 const stats=(await objectGit(repositoryPath,['diff','--no-ext-diff','--no-textconv','--no-renames','--numstat','-z',task.base_sha,task.reviewed_sha,'--'],signal)).toString().split('\0').filter(Boolean).map(x=>{const [a,d,path]=x.split('\t');return {path,binary:a==='-',lines:a==='-'?0:Number(a)+Number(d)};});
 const paths=stats.map(x=>x.path);
 const result={baseSha:task.base_sha,reviewedSha:task.reviewed_sha,repoTotalFiles:files.length,repoPythonFiles:files.filter(x=>x.path.endsWith('.py')).length,changedPaths:paths.length,changedPathList:paths,changedPythonPaths:paths.filter(x=>x.endsWith('.py')).length,pythonChangedLines:stats.filter(x=>x.path.endsWith('.py')).reduce((n,x)=>n+x.lines,0),totalChangedLines:stats.reduce((n,x)=>n+x.lines,0),binaryChangedPaths:stats.filter(x=>x.binary).length,generatedOrVendorPaths:paths.filter(p=>/(^|\/)(vendor|vendored|_vendor|third_party|generated|node_modules)(\/|$)|\.min\.js$|\.lock$/.test(p)),largeFiles:files.filter(x=>x.size>1024*1024).map(x=>({path:x.path,bytes:x.size})),minimumDiffPages:null,minimumCoverageToolCalls:null,snapshotMaterializable:false,reviewable:false};
 try {
  await objectGit(repositoryPath,['update-ref','refs/heads/cache',task.reviewed_sha],signal);
  await objectGit(repositoryPath,['symbolic-ref','HEAD','refs/heads/cache'],signal);
  const store=await SnapshotStore.freeze({repositoryPath,stateDir,input:{kind:'commits',base:task.base_sha,head:task.reviewed_sha},configuration:{provider:'bigmodel',modelId:'glm-5.3-flash',policy:'final_only',promptVersion:1},signal});
  result.snapshotMaterializable=true;result.snapshotId=store.manifest.identity.id;
  result.changedPathList=store.manifest.changedPaths;result.changedPaths=result.changedPathList.length;result.changedPythonPaths=result.changedPathList.filter(p=>p.endsWith('.py')).length;
  let pages=0;const unsupported=[];
  for(const path of result.changedPathList){let cursor=0;while(true){signal?.throwIfAborted();const page=await store.diff(path,cursor,200);if(page.status!=='ok'){unsupported.push(path);break;}pages++;if(!page.truncated)break;if(page.nextCursor<=cursor)throw Error('Diff cursor stalled');cursor=page.nextCursor;}}
  result.unsupportedChangedPaths=unsupported;
  if(!unsupported.length){result.minimumDiffPages=pages;result.minimumCoverageToolCalls=pages+1;}
  result.reviewable=!unsupported.length&&result.changedPaths>0&&result.changedPaths<=200&&result.changedPythonPaths>0;
 }catch(error){signal?.throwIfAborted();result.error=String(error.message).slice(0,1000);}
 result.scaleClass=result.changedPaths>=80||result.minimumCoverageToolCalls>=150?'large-pr-stress':'standard';
 return result;
}
