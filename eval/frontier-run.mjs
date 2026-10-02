import {readFile,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import assert from 'node:assert/strict';
import {graphData,indexed,explanation,exactTelemetry,hash,read} from './frontier-data.mjs';
import {progressiveWalk,STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {explanationStateId} from '../src/experiments/locagent/path-retention.ts';
import {retentionTraceFromFrozen} from './path-retention-replay.mjs';
const out=resolve(process.argv[2]),arm=process.argv[3];assert.ok(['A','B'].includes(arm));if(arm==='B')assert.equal((await read(join(out,'baseline-reproduction.json'))).pass,true);
const protocol=await read(join(out,'protocol.json')),identities=await read(join(out,'frozen-inputs.json')),directory=join(out,arm==='A'?'arm-a-traces':'arm-b-traces'),save=(n,v)=>writeFile(join(directory,n),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const input=async suffix=>{const i=identities.find(i=>i.path.replaceAll('\\','/').endsWith(suffix));assert.ok(i&&i.role!=='post-freeze scorer only');const b=await readFile(i.path);assert.equal(hash(b),i.sha256);return JSON.parse(b);};
const previous=await input('/retrieval-v2/b-pattern/results.json'),inspection=await input('/retrieval-v2/edge-inspection-supplement.json'),run=arm==='A'?progressiveWalk:(await import('../src/experiments/locagent/deferred-frontier.ts')).deferredWalk,rows=[];
for(const plan of protocol.cases){
 const old=previous.find(r=>r.id===plan.id),data=await graphData(plan),{retrieval:r,access}=indexed(data);
 const execute=()=>{
  if(plan.request.template==='STRUCTURAL_ESCALATION'){
   const observations=[],prepared=r.prepareTraversal(plan.queries[0]),search={...prepared,...run(prepared.roots,STRUCTURAL_PATTERNS,protocol.exploration,protocol.beamWidth,access,undefined,e=>observations.push(e))},t=exactTelemetry(observations,search);
   return {searches:[search],...t,input:{snapshotId:plan.snapshotId,generationId:plan.generationId,...t.input}};
  }
  // The unchanged controls only scan roots (maxHops=1); record the actual index access, not inferred lanes.
  const trace=[],searches=[];
  for(const [i,q] of plan.queries.entries()){
   assert.equal(q.maxHops,1);assert.notEqual(q.direction,'both');const index=q.direction==='upstream'?r.incomingByEntity:r.outgoingByEntity,restores=[],raw=[];
   for(const rootId of q.startEntities){const list=index.get(rootId);if(!list)continue;restores.push([rootId,list]);index.set(rootId,new Proxy(list,{get(target,k){if(typeof k==='string'&&/^\d+$/.test(k)&&target[k])raw.push({rootId,neighborOrdinal:Number(k)+1,edge:target[k]});return Reflect.get(target,k);}}));}
   let search;try{search=r.walkGraph(q);}finally{for(const [id,list] of restores)index.set(id,list);}searches.push(search);
   for(const [j,v] of raw.entries()){const root=data.symbols.find(s=>s.id===v.rootId),state={entity:root,rootEntityId:root.id,patternId:'control-query-'+i,stepIndex:0,direction:q.direction},stateId=explanationStateId(state);trace.push({schedulerOrdinal:trace.length+1,inspectionOrdinal:j+1,queryIndex:i,patternId:state.patternId,stepIndex:0,depth:0,direction:q.direction,stateId,parentStateId:stateId,parentEntityId:root.id,entityId:root.id,neighborEntityId:q.direction==='upstream'?v.edge.fromId:v.edge.toId,neighborOrdinal:v.neighborOrdinal,edgeId:v.edge.id,edgeRelation:v.edge.relation,decision:'INSPECTED',edge:v.edge});}
   assert.equal(raw.length,search.visitedEdges);
  }
  const replay=retentionTraceFromFrozen({...old,searches},plan);return {searches,trace,input:replay.input,inferredLaneLinks:0,controlTemplateUnchanged:true};
 };
 let result;const hashes=[],times=[];for(let i=0;i<100;i++){const start=performance.now();const next=execute();times.push(performance.now()-start);hashes.push(hash(JSON.stringify(next)));if(!result)result=next;}
 assert.equal(new Set(hashes).size,1);
 let reproduction=null;
 if(arm==='A'){
  const before=inspection.find(x=>x.id===plan.id),visits=result.trace.filter(t=>t.decision==='INSPECTED').map(t=>({fromStateEntity:t.parentEntityId,direction:t.direction,edge:t.edge}));
  reproduction={searchIdentical:JSON.stringify(result.searches)===JSON.stringify(old.searches),edgeInspectionSequenceIdentical:before?JSON.stringify(visits)===JSON.stringify(before.visits):null,countersIdentical:result.searches.every((s,i)=>['visitedNodes','visitedEdges','expandedStates','stopReason'].every(k=>s[k]===old.searches[i][k])),reachedSequenceIdentical:JSON.stringify(result.searches.flatMap(s=>s.discoveries.map(d=>d.entity.id)))===JSON.stringify(old.searches.flatMap(s=>s.discoveries.map(d=>d.entity.id))),controlsInspectionSequenceEvidence:before?'historical supplement':'exact search object plus actual one-hop query trace; no historical per-edge supplement exists'};
 }
 const unique=new Map(result.input.states.map(s=>[explanationStateId(s),s]));
 const traceCounts=(key)=>Object.fromEntries([...new Set(result.trace.filter(e=>e.decision==='INSPECTED').map(e=>String(e[key])))].sort().map(k=>[k,result.trace.filter(e=>e.decision==='INSPECTED'&&String(e[key])===k).length]));
 const stats={visitedNodes:Math.max(...result.searches.map(s=>s.visitedNodes)),edgeInspections:result.searches.reduce((n,s)=>n+s.visitedEdges,0),expandedStates:result.searches.reduce((n,s)=>n+s.expandedStates,0),stopReasons:result.searches.map(s=>s.stopReason),distinctParentsScheduled:new Set(result.trace.filter(e=>e.decision==='INSPECTED').map(e=>e.parentStateId)).size,distinctPatternsScheduled:new Set(result.trace.filter(e=>e.decision==='INSPECTED').map(e=>e.patternId)).size,edgeInspectionsByParent:traceCounts('parentStateId'),edgeInspectionsByPattern:traceCounts('patternId'),perDepthEdgeInspections:traceCounts('depth'),frontierStateCount:unique.size,frontierDropped:result.searches.reduce((n,s)=>n+(s.frontierDropped??0),0)};
 const pending=[],cursors=[];if(plan.request.template==='STRUCTURAL_ESCALATION')for(const [stateId,s] of unique){const rule=STRUCTURAL_PATTERNS.find(p=>p.id===s.patternId).steps[s.stepIndex];if(!rule)continue;const count=result.trace.filter(e=>e.decision==='INSPECTED'&&e.stateId===stateId).length,remaining=access.neighbors(s.entity.id,rule.direction).length-count,dropped=result.trace.some(e=>e.decision==='FRONTIER_DROPPED'&&e.stateId===stateId);cursors.push({stateId,patternId:s.patternId,entityId:s.entity.id,stepIndex:s.stepIndex,nextNeighborIndex:count,remainingNeighbors:remaining,permanentlyDropped:dropped});if(remaining>0&&!dropped)pending.push({stateId,patternId:s.patternId,entityId:s.entity.id,starved:count===0});}
 stats.pendingAtBudgetStop=result.searches.some(s=>['visited_nodes','visited_edges','expanded_states'].includes(s.stopReason))?pending:[];stats.starvedParents=stats.pendingAtBudgetStop.filter(p=>p.starved);stats.starvedPatterns=STRUCTURAL_PATTERNS.filter(p=>stats.pendingAtBudgetStop.some(s=>s.patternId===p.id)&&!stats.edgeInspectionsByPattern[p.id]).map(p=>p.id);stats.frontierCursorCount=cursors.length;
 const row={id:plan.id,arm,...result,stats,cursors,reproduction,determinism:{repeats:100,byteStable:true,sha256:hashes[0]},relationIndexBuildCount:r.stats().relationIndexBuildCount,graphBuilds:0,sourceReads:0,realModelCalls:0};await save(plan.id+'.json',row);rows.push(row);console.log(JSON.stringify({id:plan.id,arm,reproduction,nodes:stats.visitedNodes,edges:stats.edgeInspections,states:stats.expandedStates}));
}
await save('exploration-freeze.json',{frozenAt:new Date().toISOString(),artifacts:await Promise.all(rows.map(async r=>({name:r.id+'.json',sha256:hash(await readFile(join(directory,r.id+'.json')))}))),auditRead:false});
