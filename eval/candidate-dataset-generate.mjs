import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../integrations/pi/src/structural-routing.ts';
import {ObservedAnchors} from '../src/engine/dispatch-anchors.ts';
import {DISPATCH_LIMITS,DISPATCH_VERSION} from '../src/engine/dispatch-contracts.ts';
import {ROUTING_VERSION} from '../src/engine/routing-contracts.ts';
import {retrieveStructure} from '../src/engine/dispatch-retrieval.ts';
import {deferredWalk} from '../src/experiments/locagent/deferred-frontier.ts';
import {STRUCTURAL_PATTERNS} from '../src/experiments/locagent/patterns.ts';
import {retainStructuralPaths,explanationStateId} from '../src/experiments/locagent/path-retention.ts';
import {candidateUnits} from '../src/experiments/locagent/path-candidates.ts';
import {describeCandidates,selectCandidateSet} from '../src/experiments/locagent/candidate-set.ts';
import {graphData,indexed,exactTelemetry} from './frontier-data.mjs';
import {retentionTraceFromFrozen} from './path-retention-replay.mjs';
import {hash,read,save,identity,checkIdentities,prefixObservations} from './candidate-dataset-context.mjs';

export function opaqueSlate(pool,experiment,caseId) {
  return [...pool].sort((a,b)=>hash([experiment,caseId,a.terminalEntityId]).localeCompare(hash([experiment,caseId,b.terminalEntityId])))
    .map((candidate,i)=>({candidateId:'C'+String(i+1).padStart(2,'0'),...candidate}));
}

// One-hop control explanations preserve actual visited directions. This is a
// trace adapter, not a new inheritance traversal or new relation pattern.
export function controlRetention(searches,queries,request,calls,pack) {
  if(request.template==='IMPORT_CHECK') return retentionTraceFromFrozen({searches,calls,pack},{queries,request,snapshotId:request.snapshotId,generationId:request.generationId}).input;
  const states=new Map(),links=[];
  for(const [i,s] of searches.entries()) {
    assert.equal(queries[i].maxHops,1);
    for(const d of s.discoveries.filter(d=>d.depth===1&&d.via)) {
      if(!['resolved_scoped','resolved_import_alias'].includes(d.via.resolution)) continue;
      const parent=s.discoveries[d.parentStateId],patternId=request.template+'/'+d.direction;
      const a={entity:parent.entity,rootEntityId:parent.entity.id,patternId,stepIndex:0,direction:d.direction};
      const b={entity:d.entity,rootEntityId:parent.entity.id,patternId,stepIndex:1,direction:d.direction};
      const previousStateId=explanationStateId(a),stateId=explanationStateId(b);states.set(previousStateId,a);states.set(stateId,b);
      links.push({previousStateId,stateId,edge:d.via,direction:d.direction});
    }
  }
  return {snapshotId:request.snapshotId,generationId:request.generationId,states:[...states.values()],links};
}

export async function generateCase(plan,protocol,observations=()=>prefixObservations(plan),loadGraph=()=>graphData(plan)) {
  const reviewContext={caseId:plan.caseId,snapshotId:plan.snapshotId,changedPaths:plan.changedPaths,prefixKind:plan.prefixKind,blocks:[]};
  const anchors=new ObservedAnchors(plan.changedPaths), handlers=new Map(), routeTrace=[],calls=[],searches=[],queries=[],inspectionTrace=[];
  let request,pack,retained,pool={eligible:[],rejected:[]},selection=null,selected=[],error=null;
  const bridge={observe:e=>anchors.observe(e),providerPayload:()=>{},queued:()=>{throw Error('Dataset cannot deliver a package');},dispatch:async trigger=>{
    if(request) throw Error('Only first dispatch may enter this dataset prefix');
    const runId=plan.caseId,requestId='dispatch_'+hash([runId,trigger.routeId]);
    request={...trigger,requestId,runId,snapshotId:plan.snapshotId,strategyVersion:DISPATCH_VERSION,anchors:anchors.complete(trigger),changedPaths:plan.changedPaths,template:trigger.routeType,budget:{...DISPATCH_LIMITS}};
    pack={version:DISPATCH_VERSION,origin:'host_dispatch',requestId,runId,snapshotId:plan.snapshotId,template:request.template,relations:[],sources:[],omitted:[],limitations:[],terminal:'no_definite_relation'};
    if(anchors.limited){pack.terminal='anchor_ambiguous';return;}
    try {
      const data=await loadGraph(),{retrieval:r,access}=indexed(data);
      if(data.generationState!=='ready'||data.coverage.failedFiles||data.coverage.omittedChangedFiles) throw Error('Graph coverage unusable');
      let exact;
      const operation=async(name,input)=>{
        assert.ok(calls.length<DISPATCH_LIMITS.maxStructuralCallsPerEpisode&&calls.length<DISPATCH_LIMITS.maxStructuralCallsTotal);
        let result;
        if(name==='locate_entity') result=r.locate(input);
        else {
          assert.equal(name,'traverse_graph'); queries.push(input);
          const budget={maxVisitedNodes:input.maxNodes,maxVisitedEdges:200,maxExpandedStates:200};let search;
          if(request.template==='STRUCTURAL_ESCALATION') {
            const observed=[],prepared=r.prepareTraversal(input);
            search={...prepared,...deferredWalk(prepared.roots,STRUCTURAL_PATTERNS,budget,4,access,undefined,e=>observed.push(e))};
            exact=exactTelemetry(observed,search);inspectionTrace.push(...exact.trace);
          } else {
            // Instrument array reads without changing order or consuming neighbors.
            const restores=[],traceStart=inspectionTrace.length;
            for(const dir of input.direction==='both'?['downstream','upstream']:[input.direction]) {
              const index=dir==='upstream'?r.incomingByEntity:r.outgoingByEntity;
              for(const rootId of input.startEntities){const list=index.get(rootId);if(!list)continue;restores.push([index,rootId,list]);index.set(rootId,new Proxy(list,{get(target,k){if(typeof k==='string'&&/^\d+$/.test(k)&&target[k])inspectionTrace.push({queryIndex:queries.length-1,parentEntityId:rootId,direction:dir,neighborOrdinal:Number(k)+1,edge:target[k],decision:'INSPECTED'});return Reflect.get(target,k);}}));}
            }
            try{search=r.walkGraph(input,budget);}finally{for(const [index,id,list]of restores)index.set(id,list);}
            // The bounded walker obtains one array element before checking the
            // inspection cap. A cursor peek is not an inspected edge.
            inspectionTrace.length=traceStart+search.visitedEdges;
          }
          searches.push(search);
          // Original bounded rendering remains the dispatch control-flow input;
          // candidate pool uses the complete exploration trace independently.
          result=r.renderTraversal(input,search,true);
        }
        calls.push({name,input,result});return result;
      };
      const delivered=await retrieveStructure(request,pack,operation);
      if(!pack.anchor)return;
      const fullCalls=calls.map(c=>{
        if(c.name!=='traverse_graph')return c;
        const i=queries.indexOf(c.input),edges=[...new Map(searches[i].discoveries.filter(d=>d.via).map(d=>[d.via.id,d.via])).values()];
        return {...c,result:{...c.result,edges}};
      });
      const input=exact?{snapshotId:plan.snapshotId,generationId:plan.generationId,...exact.input}:controlRetention(searches,queries,request,fullCalls,pack);
      retained=retainStructuralPaths(input);
      const context={snapshotId:plan.snapshotId,generationId:plan.generationId,route:request.template,changedPaths:plan.changedPaths,visibleRanges:reviewContext.blocks.filter(b=>b.tool==='read_source'&&b.result.revision==='head').map(b=>({path:b.result.path,startLine:b.result.startLine,endLine:b.result.endLine}))};
      pool=describeCandidates(candidateUnits(retained),retained,context);
      selection=selectCandidateSet(pool.eligible,context,delivered.map(e=>e.entityId));
    } catch(e) {error=String(e);}
  }};
  const routing=createStructuralRouting({snapshotId:plan.snapshotId,changedPaths:plan.changedPaths,variant:'pi_structural_v2_investigate',dispatch:bridge,onBlockedCall:()=>{throw Error('Unexpected blocked graph tool');}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]));
  let active=[...TEXT_TOOLS];
  routing.extension({on:(name,fn)=>handlers.set(name,fn),appendEntry:(_type,data)=>routeTrace.push(data),getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:tools=>{active=tools;},sendMessage:()=>{throw Error('No source delivery');}});
  await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
  try {
    for await(const e of observations()) {
      const ordinal=reviewContext.blocks.length+1;
      reviewContext.blocks.push({tool:e.toolName,toolCallId:e.toolCallId,snapshotId:e.result.snapshotId,path:e.result.path??null,range:e.result.startLine===undefined?e.result.offset===undefined?null:{offset:e.result.offset,count:e.result.lines.length}:{startLine:e.result.startLine,endLine:e.result.endLine},ordinal,input:e.input,result:e.result,provenance:e.provenance});
      await handlers.get('tool_call')({toolName:e.toolName,toolCallId:e.toolCallId,input:e.input});
      await handlers.get('tool_result')({...e,content:[{type:'text',text:JSON.stringify(e.result)}]});
      if(request)break;
    }
  } catch(e) {error=String(e);}
  const slate=opaqueSlate(pool.eligible,protocol.identity,plan.caseId);
  selected=(selection?.selected??[]).map(s=>({candidateId:slate.find(c=>c.terminalEntityId===s.candidate.terminalEntityId).candidateId,entityId:s.candidate.terminalEntityId,reason:s.selectedBecause}));
  const baseline={selector:protocol.selector,selected,obligations:selection?.obligations??null};
  const input={caseId:plan.caseId,sourceCaseId:plan.sourceCaseId,derivedFromCaseId:plan.sourceCaseId,repository:plan.repository,baseSha:plan.baseSha,reviewedSha:plan.reviewedSha,snapshotId:plan.snapshotId,graphGenerationId:plan.generationId,runtimeCommit:protocol.runtimeCommit,retrievalImplementationSHA:protocol.retrievalImplementationSHA,routingVersion:ROUTING_VERSION,dispatchVersion:DISPATCH_VERSION,retrievalVersion:'Gate2B-deferred-cap2',selectorVersion:protocol.selector.version,reviewContext,investigation:request??null,candidateSlots:3,slate};
  const realContext=reviewContext.blocks.some(b=>b.tool==='read_diff'&&b.result.status==='ok'&&b.result.lines.some(l=>/^[+-](?![+-])/.test(l)));
  const status=!realContext?'NO_REAL_CONTEXT':!request?'ROUTE_NOT_TRIGGERED':error?'GRAPH_DEGRADED':!pack?.anchor?'ANCHOR_FAILED':null;
  return {caseId:plan.caseId,sourceCaseId:plan.sourceCaseId,phase:plan.phase,reviewContext,slate,input,baseline,status,error,realContext,routeTriggered:!!request,anchorResolved:!!pack?.anchor,poolSize:slate.length,reviewContextHash:hash(reviewContext),candidatePoolHash:hash(slate),candidateChoiceInputHash:hash(input),baselineSelectionHash:hash(baseline),diagnostics:{request,pack,calls,searches,inspectionTrace,retained,poolRejections:pool.rejected,routeTrace,routingMetrics:routing.metrics(),graphBackendRequests:calls.length,edgeInspections:searches.reduce((n,s)=>n+s.visitedEdges,0),reachedEntities:[...new Map(searches.flatMap(s=>s.discoveries.map(d=>[d.entity.id,d.entity]))).values()],retainedPaths:retained?.metrics.retainedPaths??0,deliverySourceReads:0,realModelCalls:0}};
}

export async function runGeneration(out) {
  const protocol=await read(join(out,'protocol.json')),implementation=await read(join(out,'implementation-freeze.json')),{plans}=await read(join(out,'universe.json'));
  assert.ok(process.permission,'Blind generation must run with Node permissions');
  for(const path of implementation.privatePaths)assert.equal(process.permission.has('fs.read',path),false,'Private input accessible during Phase A');
  await checkIdentities(implementation.files);protocol.retrievalImplementationSHA=hash(implementation.files);
  const rows=[],files=[];let phase2=false;
  for(const plan of plans) {
    if(plan.phase===2&&!phase2)phase2=rows.filter(r=>r.phase===1&&!r.status&&r.poolSize>=4&&r.poolSize<=30).length<6;
    if(plan.duplicate||plan.phase===2&&!phase2){rows.push({caseId:plan.caseId,sourceCaseId:plan.sourceCaseId,phase:plan.phase,status:plan.duplicate?'DUPLICATE_UNDERLYING_CASE':'PHASE_2_NOT_ACTIVATED'});continue;}
    const first=await generateCase(plan,protocol),second=await generateCase(plan,protocol);
    const keys=['reviewContextHash','candidatePoolHash','candidateChoiceInputHash','baselineSelectionHash'];
    const stable=keys.every(k=>first[k]===second[k])&&hash(first.diagnostics)===hash(second.diagnostics);
    if(!stable)first.status='NONDETERMINISTIC_GENERATION';
    first.determinism={replays:2,stable,replayHashes:keys.map(k=>({field:k,first:first[k],second:second[k]})),traceHashes:[hash(first.diagnostics),hash(second.diagnostics)]};
    for(const [dir,key]of [['review-contexts','reviewContext'],['candidate-pools','slate'],['candidate-choice-inputs','input'],['baseline-selections','baseline'],['raw-traces','diagnostics']]) {
      const path=join(out,'phase-a',dir,plan.caseId+'.json');await save(path,first[key]);files.push(await identity(path));
    }
    const {reviewContext,slate,input,baseline,diagnostics,...summary}=first;rows.push(summary);
    console.log(JSON.stringify({id:plan.sourceCaseId,status:first.status,pool:first.poolSize,route:first.routeTriggered,stable}));
  }
  const statusPath=join(out,'phase-a/case-generation.json');await save(statusPath,{phase2Activated:phase2,rows});files.push(await identity(statusPath));
  files.push(await identity(join(out,'protocol.json')),await identity(join(out,'universe.json')),await identity(join(out,'implementation-freeze.json')));
  await checkIdentities(implementation.files);
  await save(join(out,'phase-a/generation-freeze.json'),{identity:protocol.identity,frozenAt:new Date().toISOString(),files,implementation,allActivatedCasesComplete:true,privateScorerRead:false,realModelCalls:0});
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))await runGeneration(resolve(process.argv[2]));
