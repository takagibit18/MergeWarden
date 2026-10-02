// Separate compatibility replay, never an input to the fixed-pool A/B prediction.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {graphData,indexed,exactTelemetry,hash,read} from './frontier-data.mjs';
import {deferredWalk} from '../src/experiments/locagent/deferred-frontier.ts';
import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {retainStructuralPaths} from '../src/experiments/locagent/path-retention.ts';
import {selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
const out=resolve(process.argv[2]),ids=await read(join(out,'frozen-inputs.json')),protocol=await read(join(out,'protocol.json'));
const get=async suffix=>read(ids.find(i=>i.path.replaceAll('\\','/').endsWith(suffix)).path);
const previous=await get('/arm-b-traces/candidate-replay.json'),checks=[];
for(const plan of protocol.cases){
 const old=await get('/arm-b-traces/'+plan.id+'.json'),c=previous.find(r=>r.id===plan.id),{retrieval:r,access}=indexed(await graphData(plan));
 let searches,traceIdentical=null,inputIdentical=null;
 if(plan.request.template==='STRUCTURAL_ESCALATION'){
  const observations=[],prepared=r.prepareTraversal(plan.queries[0]);
  const search={...prepared,...deferredWalk(prepared.roots,STRUCTURAL_PATTERNS,protocol.exploration,protocol.beamWidth,access,undefined,e=>observations.push(e))};
  const t=exactTelemetry(observations,search);searches=[search];traceIdentical=JSON.stringify(t.trace)===JSON.stringify(old.trace);
  inputIdentical=JSON.stringify({snapshotId:plan.snapshotId,generationId:plan.generationId,...t.input})===JSON.stringify(old.input);
 }else searches=plan.queries.map(q=>r.walkGraph(q));
 const retention=retainStructuralPaths(old.input),selection=selectCandidateSet(c.pool.eligible,c.context,c.selection.selected.map(s=>s.candidate.terminalEntityId));
 const row={id:plan.id,searchesIdentical:JSON.stringify(searches)===JSON.stringify(old.searches),traceIdentical,inputIdentical,retentionIdentical:JSON.stringify(retention)===JSON.stringify(c.retained),selectorAIdentical:JSON.stringify(selection)===JSON.stringify(c.selection),maxParentsPerState:retention.metrics.maxParentsPerState,relationIndexBuildCount:r.stats().relationIndexBuildCount};
 assert.ok(row.searchesIdentical&&row.traceIdentical!==false&&row.inputIdentical!==false&&row.retentionIdentical&&row.selectorAIdentical&&row.maxParentsPerState<=2);checks.push(row);
}
const unchanged=[];for(const i of ids)unchanged.push({...i,unchanged:hash(await readFile(i.path))===i.sha256});
assert.ok(unchanged.every(i=>i.unchanged));
await writeFile(join(out,'frozen-contract-validation.json'),JSON.stringify({pass:true,scope:'Independent compatibility graph reads only; excluded from primary A/B inputs',checks,unchanged,sourceReads:0,realModelCalls:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pass:true,cases:checks.length}));
