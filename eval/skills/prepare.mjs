// Curator-only materialization. No model or reviewed-project execution.
import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile,realpath } from 'node:fs/promises';
import { join,resolve,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTask,freezeTask,objectGit,skillRepositoryKeyForTask } from '../real/adapter.mjs';
import { isolatedState,sha256,writeJson } from '../../src/infrastructure/files.ts';
const output=await isolatedState(resolve(process.argv[2]),fileURLToPath(new URL('../..',import.meta.url))),spec=JSON.parse(await readFile(join(output,'selection.json'),'utf8'));
const gate=JSON.parse(await readFile(join(output,'stage-a.json'),'utf8'));assert.equal(gate.status,'PASS');
const receipts=new Map((await readFile(spec.sourceAudit,'utf8')).trim().split('\n').map(JSON.parse).map(r=>[r.id,r]));
const root=join(output,'corpus'),resume=process.argv.includes('--resume');await mkdir(root,{recursive:resume});for(const path of [join(root,'public'),join(root,'private'),join(output,'objects'),join(root,'private','audit')])await mkdir(path,{recursive:true});
const tasks=spec.entries.map(e=>receipts.get(e.id).task),hashes=tasks.map(t=>sha256(JSON.stringify(t)));assert.equal(new Set(tasks.map(t=>t.repository+':'+t.reviewed_sha)).size,tasks.length);
const inventory=[];
for(const entry of spec.entries) {
 const r=receipts.get(entry.id),task=r.task,cache=await realpath(join(spec.objectCache,task.repository.replace('/','--'))),directory=join(output,'objects',task.case_id);
 assert.equal((await objectGit(cache,['remote','get-url','origin'])).toString().trim(),task.repository_url);
 const caches=[cache,...(spec.additionalObjectCaches??[]).map(parent=>join(parent,task.repository.replace('/','--')))];const alternates=[];
 for(const candidate of caches){assert.equal((await objectGit(candidate,['remote','get-url','origin'])).toString().trim(),task.repository_url);const objects=(await objectGit(candidate,['rev-parse','--git-path','objects'])).toString().trim();alternates.push(resolve(candidate,objects).replaceAll('\\','/'));}
 // A host-controlled read-only alternate reuses exact objects. No commit is recreated.
 try{await mkdir(directory);await objectGit(directory,['init','--template=','--object-format=sha1']);await objectGit(directory,['remote','add','origin',task.repository_url]);}catch(e){if(e.code!=='EEXIST'||!resume)throw e;const prior=JSON.parse(await readFile(join(directory,'.git','real-task.json'),'utf8'));assert.deepEqual(prior.task,task);}
 await writeFile(join(directory,'.git','objects','info','alternates'),alternates.join('\n')+'\n');
 await writeJson(join(directory,'.git','real-task.json'),{taskSha256:sha256(JSON.stringify(task)),task});
 await prepareTask(task,directory);
 const scope=await skillRepositoryKeyForTask(task,directory,hashes);
 const store=await freezeTask(task,{repositoryPath:directory,stateDir:join(output,'prepared'),configuration:{provider:'openai-codex',modelId:'gpt-5.6-luna',policy:'final_only',promptVersion:1},hiddenDirectory:join(root,'private')});
 const diff=await objectGit(directory,['diff','--no-ext-diff','--no-textconv','--unified=12',task.base_sha,task.reviewed_sha]);
 const dir=join(root,'private','audit',entry.id);await mkdir(dir,{recursive:resume});await writeFile(join(dir,'change.diff'),diff);
 const anchors=[...(r.pythonAnchors??[]),...(r.contextEvidence??[])],pages=[];
 for(const a of anchors) {
  const exact=await store.source('head',a.path,a.startLine,a.endLine);assert.equal(exact.contentSha256,a.contentSha256,'Reviewed anchor drift');
  const head=await store.source('head',a.path,Math.max(1,a.startLine-20),Math.min(a.endLine+30,a.startLine+150));
  let base;try{base=await store.source('base',a.path,Math.max(1,a.startLine-20),Math.min(a.endLine+30,a.startLine+150));}catch{base=null;}
  pages.push({exact,head,base});
 }
 await writeJson(join(dir,'source.json'),pages);await writeJson(join(dir,'prior-receipt.json'),r);
 inventory.push({...entry,task,repositoryPath:directory,skillRepositoryKey:scope,snapshotId:store.manifest.identity.id,changedPaths:store.manifest.changedPaths,diffSha256:sha256(diff),anchorCount:anchors.length,source:r.source,label:r.label,committedAt:r.scopeAudit.reviewedCommit.committedAt,priorAnnotation:r.annotation.rationale,contaminationGroup:task.repository+':pr:'+r.source.prNumber,seen_in_prior_dev:true,humanReviewed:false});
 console.log(JSON.stringify({caseId:entry.id,split:entry.split,status:'MATERIALIZED',changedPaths:store.manifest.changedPaths.length}));
}
await writeFile(join(root,'public','tasks.jsonl'),tasks.map(t=>JSON.stringify(t)).join('\n')+'\n');await writeJson(join(root,'private','inventory.json'),inventory);await writeJson(join(root,'private','splits.json'),spec.entries);await writeFile(join(root,'private','episodes.jsonl'),spec.episodes.map(e=>JSON.stringify(e)).join('\n')+'\n');
await writeJson(join(root,'private','feedback-policy.json'),spec.commentPolicy);
await writeJson(join(root,'preparation.json'),{status:'MATERIALIZED_NOT_FROZEN',cases:inventory.length,sourceReviewRequired:true,rowsRequireSeparateVerification:true});
