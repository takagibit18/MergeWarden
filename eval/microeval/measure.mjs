import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {analyzeInvestigation} from '../../src/eval/provenance/investigation.ts';
import {readReport} from '../../src/engine/reports.ts';
import {read,save,hash,targetInCatalog} from './common.mjs';
const out=resolve(process.argv[2]),freeze=await read(join(out,'prediction-freeze.json'));
assert.equal(freeze.allFirstAttemptsFinished,true);for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256);
const targets=(await read(join(out,'private/targets.json'))).cases,manifest=await read(join(out,'case-manifest.json')),config=await read(join(out,'run-config.json')),rows=[],costs=[],attribution=[];
const strings=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
const sourceKey=s=>JSON.stringify([s.snapshotId,s.revision,s.path,s.startLine,s.endLine,s.contentSha256]);
function covered(pages,target){let end=target.startLine-1;for(const p of pages.filter(p=>p.revision==='head'&&p.path===target.path).sort((a,b)=>a.startLine-b.startLine)){if(p.startLine>end+1)continue;if(p.endLine>end)end=p.endLine;}return end>=target.endLine;}
for(const job of config.runOrder){
 const arm=join(out,job.arm==='A'?'arm-a-text':'arm-b-graph'),raw=join(arm,'raw',job.id),r=await read(join(raw,'result.json')),trace=await read(join(arm,'traces',job.id+'.json'));
 const publicData=await read(config.cases.find(c=>c.id===job.id).path),c=publicData.case,t=targets.find(t=>t.id===c.id);assert.equal(hash(t),manifest.find(m=>m.id===c.id).privateTargetHash);
 const store=await SnapshotStore.load(c.state,c.snapshotId),sources=[],delivered=[],calls=trace.calls;
 const pack=job.arm==='B'?await read(join(arm,'context-packages',c.id+'.json')):null;
 for(const call of calls.filter(c=>['read_source','expand_structural_candidate'].includes(c.name)&&!c.isError&&c.response?.status==='ok'))sources.push({source:call.response,origin:call.name,callEvent:call.callEvent});
 if(pack)for(const source of pack.sources)sources.push({source,origin:'host_prefetch'});
 for(const s of sources){const p=await store.source(s.source.revision,s.source.path,s.source.startLine,s.source.endLine);assert.equal(p.contentSha256,s.source.contentSha256);assert.equal(hash(s.source.text),s.source.contentSha256);assert.equal(s.source.snapshotId,c.snapshotId);}
 const deliveredKeys=new Set(),requests=[];
 for(const name of (await readdir(raw)).filter(n=>/^request-\d+\.json$/.test(n)).sort()){
  const wire=await read(join(raw,name)),ordinal=Number(/\d+/.exec(name)[0]);requests.push(wire);
  assert.equal(wire.model,config.model.modelId);assert.equal(wire.temperature,config.temperature);assert.equal(wire.top_p,config.top_p);assert.deepEqual(wire.thinking,config.thinking);
  const text=strings(wire.messages);assert(text.some(s=>s.includes(publicData.prompt)),'Public prefix/question drift');
  const resultSources=[];
  for(const m of wire.messages.filter(m=>m.role==='tool'))for(const s of strings(m.content)){try{const obj=JSON.parse(s);if(obj.snapshotId===c.snapshotId&&obj.text&&obj.contentSha256)resultSources.push(obj);}catch{}}
  for(const s of sources){if(deliveredKeys.has(sourceKey(s.source)))continue;
   const inWire=s.origin==='host_prefetch'?text.some(v=>v.includes(JSON.stringify(pack))):resultSources.some(p=>sourceKey(p)===sourceKey(s.source)&&p.text===s.source.text);
   if(inWire){deliveredKeys.add(sourceKey(s.source));delivered.push({...s,firstRequest:ordinal});}
  }
 }
 const necessarySourceRead=t.targets.length?t.targets.some(target=>covered(sources.map(s=>s.source),target)):null;
 const necessaryFactCovered=t.targets.length?t.targets.some(target=>covered(delivered.map(s=>s.source),target)):null;
 const catalogDelivered=pack&&requests.some(w=>strings(w.messages).some(s=>s.includes(JSON.stringify(pack))));
 if(job.arm==='A'){assert.equal(r.manifest.metrics.dispatch,undefined);assert.equal(r.manifest.metrics.graphToolCalls,0);assert.equal(r.manifest.metrics.graph.calls,0);}
 if(r.result?.report&&r.manifest.status==='delivered')assert.deepEqual(await readReport(c.state,r.manifest.runId),r.result.report);
 const native=await readFile(join(arm,'traces',c.id+'.jsonl'),'utf8'),a=analyzeInvestigation({runId:r.manifest.runId,snapshotId:c.snapshotId,findings:r.result?.report?.findings??[],jsonl:native});attribution.push({...job,...a});
 const selected=r.result?.report?.findings.flatMap(f=>f.evidence)??[],evidenceIntegrity=selected.every(e=>delivered.some(s=>sourceKey(s.source)===sourceKey(e)));
 const count=name=>calls.filter(c=>c.name===name).length,dispatch=r.manifest.metrics.dispatch;
 const cost={...job,inputTokens:r.manifest.usage?.input??null,outputTokens:r.manifest.usage?.output??null,totalTokens:r.manifest.usage?.total??null,usageMayBeIncomplete:r.result?.report?.status!=='completed',latencyMs:r.latencyMs,reviewLatencyMs:r.manifest.metrics.reviewLatencyMs,providerRequests:r.requests,toolCalls:r.manifest.metrics.toolCalls,searchCalls:count('search_text'),ordinarySourceReadCalls:count('read_source'),untouchedSourceReadCalls:calls.filter(x=>x.name==='read_source'&&!x.isError&&x.response?.status==='ok'&&!c.changedPaths.includes(x.response.path)).length,sourceReads:count('read_source')+(dispatch?.sourceReads??0)+(dispatch?.candidateExpansionReads??0),structuralOps:dispatch?.structuralOperations??0,edgeInspections:dispatch?.edgeInspections??0,catalogItems:pack?.investigations.reduce((n,i)=>n+i.candidateCatalog.length,0)??0,catalogBytes:pack?Buffer.byteLength(JSON.stringify(pack.investigations.flatMap(i=>i.candidateCatalog))):0,prefetchReads:dispatch?.sourceReads??0,candidateExpansions:count('expand_structural_candidate'),candidateExpansionReads:dispatch?.candidateExpansionReads??0};costs.push(cost);
 rows.push({...job,status:r.result?.report?.status,mechanicalBlocker:r.mechanicalBlocker,snapshotId:c.snapshotId,generationId:c.generationId,necessaryTargetReached:t.targets.length?!!(catalogDelivered&&targetInCatalog(pack,t.targets)||necessarySourceRead):null,necessarySourceRead,necessaryFactCovered,catalogDelivered:!!catalogDelivered,evidenceIntegrity,deliveredSources:delivered.map(s=>({origin:s.origin,firstRequest:s.firstRequest,path:s.source.path,startLine:s.source.startLine,endLine:s.source.endLine,contentSha256:s.source.contentSha256,evidenceRefId:s.source.evidenceRefId??s.source._mergewarden?.evidenceRefId})),findings:r.result?.report?.findings??[],summary:r.result?.report?.summary,acceptedSubmissions:calls.filter(c=>c.name==='submit_review'&&!c.isError&&c.response?.accepted===true).length,traceIssues:trace.issues});
}
await save(join(out,'private/mechanical-scoring.json'),rows);await save(join(out,'costs.json'),costs);await save(join(out,'attribution.json'),attribution);
console.log(JSON.stringify(rows.map(({deliveredSources,findings,summary,...r})=>({...r,findingCount:findings.length}))));
