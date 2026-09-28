import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {cp,copyFile,mkdir,readFile,readdir} from 'node:fs/promises';
import {read,save,hash,identity,probe,publicPrompt} from '../microeval/common.mjs';
import {graphCacheDir} from '../../src/graph/sqlite-store.ts';
const previous=resolve(process.argv[2]),out=resolve(process.argv[3]),repo=resolve(import.meta.dirname,'../..'),state=join(out,'state');
assert.notEqual(previous,out);const old=await read(join(previous,'run-config.json')),cases=[],mapping=[],admissions=[];
for(const [index,id] of ['D1','D2','C1'].entries()){
 const input=await read(old.cases.find(c=>c.id===id).path),c=input.case,original=c.state,snapshot=await read(join(original,'snapshots',c.snapshotId+'.json'));
 assert.equal(hash(await readFile(join(original,'snapshots',c.snapshotId+'.json'))),c.snapshotSha256);
 await mkdir(join(state,'snapshots'),{recursive:true});await copyFile(join(original,'snapshots',c.snapshotId+'.json'),join(state,'snapshots',c.snapshotId+'.json'));
 await mkdir(join(state,'blobs'),{recursive:true});for(const blob of new Set([...Object.values(snapshot.base),...Object.values(snapshot.head)].filter(f=>f.status==='text').map(f=>f.hash))){const path=join(original,'blobs',blob);assert.equal(hash(await readFile(path)),blob);await copyFile(path,join(state,'blobs',blob));}
 await cp(graphCacheDir(original,c.snapshotId),graphCacheDir(state,c.snapshotId),{recursive:true,errorOnExist:true,force:false});
 await mkdir(join(state,'runs',c.seedId),{recursive:true});await copyFile(join(original,'runs',c.seedId,'run.json'),join(state,'runs',c.seedId,'run.json'));
 c.state=state;c.id=`Q0${index+1}`;input.prompt=publicPrompt(c,input.prefix);delete c.caseId;
 const path=join(out,'public',c.id+'.json');await save(path,input);cases.push({id:c.id,path});mapping.push({id:c.id,previousId:id,previous,description:['changed estimator capability contract','cross-file consumer contract','connection-close control'][index]});
 const admission=await probe(c,input.prefix);admissions.push({id:c.id,terminal:admission.pack.terminal,candidates:admission.pack.investigations.reduce((n,i)=>n+i.candidateCatalog.length,0),sources:admission.pack.sources.length});
}
await save(join(out,'private/selection.json'),mapping);await save(join(out,'admission.json'),admissions);
let runOrder=[{id:'Q01',arm:'A'},{id:'Q01',arm:'B'},{id:'Q02',arm:'B'},{id:'Q02',arm:'A'},{id:'Q03',arm:'A'},{id:'Q03',arm:'B'}];
if(process.argv[4]){const prior=resolve(process.argv[4]),batch=await read(join(prior,'runs-completed.json'));assert(batch.batchStopped);assert(batch.completed.some(j=>j.mechanicalBlocker));runOrder=runOrder.filter(j=>!batch.completed.some(p=>p.id===j.id&&p.arm===j.arm));assert.deepEqual(runOrder,batch.notRun);await save(join(out,'prior-attempts.json'),{path:prior,index:await identity(join(prior,'runs-completed.json')),completed:batch.completed,policy:'Retain failed attempts; run only previously unattempted case/arm pairs after the observer contract repair.'});}
await save(join(out,'run-config.json'),{identity:'controlled-e2e-20260927',model:old.model,endpoint:old.endpoint,temperature:0,top_p:1,thinking:old.thinking,thinkingLevel:'low',maxTokens:32768,timeoutMs:600000,maxToolCalls:100,maxRuns:runOrder.length,firstAttemptOnly:true,providerRetries:0,agentRetries:0,autoCompaction:false,cases,runOrder});
await save(join(out,'protocol.json'),{purpose:'execution and observability admission, not a blinded accuracy estimate',createdAt:new Date().toISOString(),predecessor:previous,runs:runOrder,retries:0,policy:'Existing final-only evidence policy; no semantic steering, source edits, runtime tuning or case replacement after freeze.',stop:'Stop remaining batch on transport, request-audit, durable-journal, extension or context-delivery faults. A valid budget-limited or incomplete review is retained and does not trigger a retry. At most six first attempts.',missingUsage:'Missing or interrupted provider usage is null; known totals are lower bounds, never a zero-cost claim.',preflight:'Synthetic responses run the exact frozen engine and observer, but are isolated in preflight artifacts and excluded from live metrics.'});
const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(await identity(p));}}
for(const n of ['protocol.json','run-config.json'])files.push(await identity(join(out,n)));
if(process.argv[4])files.push(await identity(join(out,'prior-attempts.json')));
for(const n of ['package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json','eval/frontier-data.mjs','eval/intent-router/input.mjs'])files.push(await identity(join(repo,n)));
for(const d of ['src','integrations/pi/src','integrations/tree-sitter/src','eval/microeval','eval/controlled-e2e'])await walk(join(repo,d));
for(const d of ['public','state/snapshots','state/graphs','state/blobs'])await walk(join(out,d));
for(const item of cases){const {case:c}=await read(item.path);files.push(await identity(join(state,'runs',c.seedId,'run.json')));}
await save(join(out,'input-freeze.json'),{createdAt:new Date().toISOString(),files,denied:[join(out,'private'),join(out,'admission.json'),previous]});
console.log(JSON.stringify({prepared:out,frozenFiles:files.length,admissions}));
