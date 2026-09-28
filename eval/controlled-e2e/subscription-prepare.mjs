import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {SqliteCodeGraph,publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {buildUnits} from '../intent-router/input.mjs';
import {graphData} from '../frontier-data.mjs';
import {read,save,hash,identity,publicPrompt,probe} from '../microeval/common.mjs';
const previous=resolve(process.argv[2]),out=resolve(process.argv[3]),root=resolve(import.meta.dirname,'../..'),state=join(out,'state');
assert.notEqual(previous,out);
const model={provider:'openai-codex',modelId:'gpt-5.6-sol'},cases=[],receipts=[];
for(const id of ['Q01','Q02','Q03']){
 const old=await read(join(previous,'public',id+'.json')),c=old.case;
 const original=await read(join(c.state,'snapshots',c.snapshotId+'.json'));
 assert.equal(hash(await readFile(join(c.state,'snapshots',c.snapshotId+'.json'))),c.snapshotSha256);
 const store=await SnapshotStore.freeze({repositoryPath:c.repositoryPath,stateDir:state,input:original.input,configuration:{...model,policy:'final_only',promptVersion:1}});
 assert.deepEqual(store.manifest.base,original.base);assert.deepEqual(store.manifest.head,original.head);assert.deepEqual(store.manifest.changedPaths,original.changedPaths);
 const snapshotId=store.manifest.identity.id;
 const built=await SqliteCodeGraph.open(store,{scope:'core'});built.graph.close();
 const hot=await SqliteCodeGraph.openPublishedOnly(store,{scope:'core'});hot.graph.close();
 const next={...c,state,snapshotId,generationId:hot.manifest.generationId,graphSha256:hash(await readFile(await publishedGraphPath(state,snapshotId))),snapshotSha256:hash(await readFile(join(state,'snapshots',snapshotId+'.json')))};
 const prefix=JSON.parse(JSON.stringify(old.prefix).replaceAll(c.snapshotId,snapshotId).replaceAll(c.generationId,next.generationId));
 const data=await graphData(next),matches=buildUnits(prefix,data.symbols).units.filter(u=>u.entity?.qualifiedName===c.unit.entity.qualifiedName&&u.path===c.unit.path);
 assert.equal(matches.length,1);next.unit=matches[0];
 if(c.unit.changeUnitId.startsWith('CU'))next.unit={...next.unit,hostChangeUnitId:next.unit.changeUnitId,changeUnitId:c.unit.changeUnitId};
 assert.deepEqual(next.unit.changedRanges,c.unit.changedRanges);
 const admission=await probe(next,prefix);
 await save(join(state,'runs',c.seedId,'run.json'),{schemaVersion:1,runId:c.seedId,snapshotId,referenceOnly:true});
 const path=join(out,'public',id+'.json');await save(path,{case:next,prefix,prompt:publicPrompt(next,prefix)});cases.push({id,path});
 receipts.push({id,base:original.identity.baseCommit,head:original.identity.headCommit,oldSnapshot:c.snapshotId,snapshotId,sourceMapsIdentical:true,generationId:next.generationId,terminal:admission.pack.terminal,catalogItems:admission.pack.investigations.reduce((n,i)=>n+i.candidateCatalog.length,0)});
 console.log(JSON.stringify({prepared:id,snapshotId}));
}
const config={identity:'subscription-high-three-cases',model,thinkingLevel:'high',maxTokens:32768,outputTokenLimitEnforced:false,samplingOverrides:false,timeoutMs:600000,maxToolCalls:100,firstAttemptOnly:true,providerRetries:0,agentRetries:0,autoCompaction:false,cases,runOrder:[{id:'Q01',arm:'B'},{id:'Q02',arm:'B'},{id:'Q03',arm:'A'}]};
await save(join(out,'run-config.json'),config);
await save(join(out,'protocol.json'),{createdAt:new Date().toISOString(),predecessor:previous,receipts,toolCount:'Host-executed calls only; Pi schema-rejected attempts retained separately in native logs.',requestCount:'Pi before_provider_request observations; not wire-level HTTP/WebSocket attempts.',scope:'Diagnostic first attempts, not blinded quality or equal-token-budget comparison. Same frozen source and public prefix; Q01/B, Q02/B, Q03/A. No private labels provided.',transport:'Pi native OAuth and Codex Responses; no proxy protocol translation.',stop:'Stop on provider, extension, persistence or instrumentation faults. Preserve budget-limited runs; never retry completed attempts.'});
const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(await identity(p));}}
for(const p of ['run-config.json','protocol.json'])files.push(await identity(join(out,p)));
for(const p of ['package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json'])files.push(await identity(join(root,p)));
for(const p of ['src','integrations/pi/src','integrations/tree-sitter/src','eval/microeval','eval/controlled-e2e'])await walk(join(root,p));
for(const p of ['public','state/snapshots','state/blobs','state/graphs'])await walk(join(out,p));
for(const {path} of cases){const {case:c}=await read(path);files.push(await identity(join(state,'runs',c.seedId,'run.json')));}
await save(join(out,'input-freeze.json'),{files,denied:[previous,join(root,'../output/real-route-recall-diagnostic-20260925'),join(root,'../output/full-context-candidate-dataset-20260925')]});
