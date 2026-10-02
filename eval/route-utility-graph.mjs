import assert from 'node:assert/strict';
import {ObservedAnchors} from '../src/engine/dispatch-anchors.ts';
import {DISPATCH_LIMITS,DISPATCH_VERSION} from '../src/engine/dispatch-contracts.ts';
import {retrieveStructure} from '../src/engine/dispatch-retrieval.ts';
import {StructuralDispatch} from '../src/engine/dispatch-service.ts';
import {deferredWalk} from '../src/experiments/locagent/deferred-frontier.ts';
import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {retainStructuralPaths} from '../src/experiments/locagent/path-retention.ts';
import {candidateUnits} from '../src/experiments/locagent/path-candidates.ts';
import {describeCandidates,selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
import {indexed,exactTelemetry} from './frontier-data.mjs';
export const GRAPH_POLICY=Object.freeze({version:'Gate2B-deferred-cap2/candidate-set',maxVisitedNodes:30,maxVisitedEdges:200,maxExpandedStates:200,beamWidth:4,maxAlternativePredecessors:2,...DISPATCH_LIMITS});
export function forcedRequest(plan,prefix){
 const anchors=new ObservedAnchors(prefix.changedPaths);for(const e of prefix.observations)anchors.observe(e);
 const last=prefix.observations.at(-1),trigger={routeId:'offline-utility',routeType:'STRUCTURAL_ESCALATION',reason:'offline_counterfactual',targetHint:'',path:last?.result.path??prefix.changedPaths[0],toolCallId:last?.toolCallId??'none',toolName:last?.toolName??'none'};
 return {limited:anchors.limited,trigger,request:{...trigger,requestId:'utility-'+plan.caseId,runId:plan.caseId,snapshotId:plan.snapshotId,generationId:plan.generationId,strategyVersion:DISPATCH_VERSION,anchors:anchors.complete(trigger),changedPaths:prefix.changedPaths,template:trigger.routeType,budget:{...DISPATCH_LIMITS}},anchors};
}
export async function graphComparator(plan,prefix,store,data){
 const f=forcedRequest(plan,prefix),{request,trigger}=f;
 const pack={version:DISPATCH_VERSION,origin:'host_dispatch',requestId:request.requestId,runId:plan.caseId,snapshotId:plan.snapshotId,template:request.template,relations:[],sources:[],omitted:[],limitations:[],terminal:'no_definite_relation'};
 const {retrieval:r,access}=indexed(data),calls=[],searches=[],traces=[];let retained=null,pool={eligible:[],rejected:[]},selection=null,sourcePack=pack,error=null;
 const operation=async(name,input)=>{
   assert(calls.length<DISPATCH_LIMITS.maxStructuralCallsPerEpisode);let result;
   if(name==='locate_entity')result=r.locate(input);
   else {assert.equal(name,'traverse_graph');const prepared=r.prepareTraversal(input),observed=[],search={...prepared,...deferredWalk(prepared.roots,STRUCTURAL_PATTERNS,{maxVisitedNodes:30,maxVisitedEdges:200,maxExpandedStates:200},4,access,undefined,e=>observed.push(e))};
     const telemetry=exactTelemetry(observed,search);traces.push(...telemetry.trace);searches.push(search);retained=retainStructuralPaths({snapshotId:plan.snapshotId,generationId:plan.generationId,...telemetry.input});result=r.renderTraversal(input,search,true);
   }
   calls.push({name,input,result});return result;
 };
 const sourceCalls=[];
 try {
   if(f.anchors.limited)pack.terminal='anchor_ambiguous';else await retrieveStructure(request,pack,operation);
   if(pack.anchor&&retained){
     const context={snapshotId:plan.snapshotId,generationId:plan.generationId,route:'STRUCTURAL_ESCALATION',changedPaths:prefix.changedPaths,visibleRanges:prefix.observations.filter(e=>e.toolName==='read_source'&&e.result.revision==='head').map(e=>e.result)};
     pool=describeCandidates(candidateUnits(retained),retained,context);selection=selectCandidateSet(pool.eligible,context);
     const chosen=selection.selected.map(s=>s.candidate),chosenIds=new Set(chosen.map(c=>c.terminalEntityId)),edgeIds=new Set(chosen.flatMap(c=>c.retainedPaths.flatMap(p=>p.edgeIds)));
     const edges=[...new Map(retained.states.flatMap(s=>s.predecessorPaths.map(p=>p.edge)).filter(e=>edgeIds.has(e.id)).map(e=>[e.id,e])).values()].sort((a,b)=>a.id<b.id?-1:1);
     // Same frozen-response adapter as candidate-source-replay: no second graph
     // exploration, no target reads, no source page packing implementation fork.
     const service=new StructuralDispatch({runId:plan.caseId,snapshotId:plan.snapshotId,changedPaths:prefix.changedPaths,signal:new AbortController().signal,promote(){throw Error('No model exposure');},operation:async(name,input)=>{
       if(name==='read_source'){const result=await store.source(input.revision,input.path,input.startLine,input.endLine);sourceCalls.push({name,input,result});return result;}
       if(name==='locate_entity')return {status:'ok',revision:'head',snapshotId:plan.snapshotId,generationId:plan.generationId,anchorStatus:'resolved',items:[pack.anchor]};
       assert.equal(name,'traverse_graph');return {status:'ok',revision:'head',snapshotId:plan.snapshotId,generationId:plan.generationId,items:chosen.map(c=>({...c.terminalEntity,entityId:c.terminalEntityId,depth:c.depth})),edges};
     }});
     for(const e of prefix.observations)service.observe(e);sourcePack=await service.dispatch(trigger);assert(sourcePack);assert(sourcePack.sources.every(s=>chosenIds.has(s.entity.entityId)));
   }
 }catch(e){error=String(e);pack.terminal='error';}
 assert(sourceCalls.length<=3);assert(Buffer.byteLength(JSON.stringify(sourcePack))<=24576);
 return {arm:'G',counterfactualGraph:true,version:GRAPH_POLICY.version,request,anchorStatus:pack.anchor?'resolved':pack.terminal,anchor:pack.anchor??null,calls,searches,inspectionTrace:traces,retained,pool,selection,sourceReads:sourceCalls.map(c=>c.result),sourcePack,error,coverage:data.coverage,generationState:data.generationState,stopReason:error?'error':pack.anchor?(searches.at(-1)?.stopReason??sourcePack.terminal):pack.terminal,budgetUsed:{searchCalls:0,graphOps:calls.length,sourceReads:sourceCalls.length,contextBytes:Buffer.byteLength(JSON.stringify(sourcePack)),edgeInspections:searches.reduce((n,s)=>n+s.visitedEdges,0),expandedStates:searches.reduce((n,s)=>n+s.expandedStates,0)},reachedEntities:[...new Map(searches.flatMap(s=>s.discoveries.map(d=>[d.entity.id,d.entity]))).values()],retainedPaths:retained?.metrics.retainedPaths??0,selectedCandidates:selection?.selected.map(s=>s.candidate.terminalEntityId)??[],modelExposure:false};
}
