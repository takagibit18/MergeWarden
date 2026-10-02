import {join,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {SnapshotStore} from '../src/snapshot/store.ts';
import {StructuralDispatch} from '../src/engine/dispatch-service.ts';
import {ProgressiveInvestigation} from '../src/engine/investigation-service.ts';
import {declarationPreview} from '../src/engine/candidate-catalog.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../integrations/pi/src/structural-routing.ts';
import {graphData} from './frontier-data.mjs';
import {forcedRequest} from './route-utility-graph.mjs';
import {hash,identity,checkIdentities} from './candidate-dataset-context.mjs';
const out=resolve(process.argv[2]),freeze=JSON.parse(await readFile(join(out,'input-freeze.json'),'utf8')),rows=[],artifacts=[];
assert(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);assert.equal(process.permission.has('child'),false);
await checkIdentities(freeze.files);
async function activation(prefix){
 const handlers=new Map();let active=[...TEXT_TOOLS],trigger,index=0;
 const dispatch={observe(){},providerPayload(){},queued(){},async dispatch(t){trigger=t;}};
 const routing=createStructuralRouting({snapshotId:prefix.snapshotId,changedPaths:prefix.changedPaths,variant:'pi_structural_v2_investigate',dispatch,onBlockedCall(){throw Error('Unexpected structural call')}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]));
 routing.extension({on:(n,f)=>handlers.set(n,f),appendEntry(){},getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:x=>active=x,sendMessage(){}});
 await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
 for(const e of prefix.observations){index++;await handlers.get('tool_call')({toolName:e.toolName,toolCallId:e.toolCallId,input:e.input});await handlers.get('tool_result')({...e,content:[{type:'text',text:JSON.stringify(e.result)}]});if(trigger)break;}
 return {trigger,index,observations:prefix.observations.slice(0,index),routingMetrics:routing.metrics()};
}
const summarize=(pack,metrics)=>{
 const inv=pack.investigations?.[0],units=inv?.changeUnits??[];
 return {routeTriggered:true,investigationCreated:!!inv,changedRanges:units.reduce((n,u)=>n+u.changedRanges.length,0),changeUnitsResolved:units.filter(u=>u.resolution==='resolved').length,
  changeUnitsAmbiguous:units.filter(u=>u.resolution==='ambiguous').length,changeUnitsMissing:units.filter(u=>['missing','deleted_head_unsupported'].includes(u.resolution)).length,
  rootsResolved:inv?.rootsResolved??(pack.anchor?1:0),rootsExplored:inv?.rootsExplored??(pack.anchor?1:0),rootsOmittedByBudget:inv?.rootsOmittedByBudget??0,
  graphInvestigationStarted:!!(inv?.rootsExplored??pack.anchor),candidateCatalogSize:inv?.candidateCatalog.length??0,prefetchedSourceCount:pack.sources.length,
  structuralOps:metrics.structuralOperations,edgeInspections:metrics.edgeInspections??null,contextBytes:Buffer.byteLength(JSON.stringify(pack)),terminal:pack.terminal,
  anchorStatus:pack.anchor?'resolved':inv?.rootsResolved?(units.some(u=>u.resolution!=='resolved')||inv.rootsOmittedByBudget?'partial':'resolved'):pack.terminal,
  v2RootStatuses:units.map(u=>({id:u.changeUnitId,path:u.path,status:u.resolution})),catalogDelivered:!!inv?.candidateCatalog.length};
};
for(const plan of freeze.plans){
 const prefix=JSON.parse(await readFile(plan.inputPath,'utf8'));assert.equal((await identity(plan.inputPath)).sha256,plan.inputSha256);
 const store=await SnapshotStore.load(plan.state,plan.snapshotId),data=await graphData(plan),retrieval=new LocAgentRetrieval(data),sourceTexts=new Map();
 const immutableText=async path=>{if(!sourceTexts.has(path))sourceTexts.set(path,await store.text('head',path));return sourceTexts.get(path);};
 const source=(path,start,end)=>store.source('head',path,start,end);
 const operation=async(name,input)=>{
  if(name==='read_source')return source(input.path,input.startLine,input.endLine);
  if(name==='locate_entity')return retrieval.locate(input);
  if(name==='traverse_graph')return retrieval.hostTraverse(input);
  if(name==='resolve_change_units')return retrieval.resolveChangeUnits(input);
  assert.equal(name,'host_structural_investigation');const result=retrieval.investigate(input);
  for(const c of result.pool.eligible){const preview=declarationPreview(await immutableText(c.terminalPath),c.terminalEntity.startLine,c.entityKind);if(preview)result.previews[c.terminalEntityId]=preview;}
  return result;
 };
 const execute=async(version,trigger,observations)=>{
  const options={runId:plan.caseId,snapshotId:plan.snapshotId,changedPaths:prefix.changedPaths,signal:new AbortController().signal,operation,source,promote(){}};
  const service=version===1?new StructuralDispatch(options):new ProgressiveInvestigation(options),events=[];service.setRecorder(e=>events.push(e));
  for(const e of observations)service.observe(e);const pack=await service.dispatch(trigger);service.queued(pack);service.providerPayload({content:JSON.stringify(pack)});
  return {pack,events,metrics:service.metrics,performance:{queueSize:Math.max(0,...events.filter(e=>e.type==='operation_result'&&e.name==='host_structural_investigation').map(e=>e.result.metrics.queueSize)),
    catalogBytes:Buffer.byteLength(JSON.stringify(pack.investigations?.flatMap(i=>i.candidateCatalog)??[])),previewBytes:(pack.investigations?.flatMap(i=>i.candidateCatalog)??[]).reduce((n,c)=>n+Buffer.byteLength(c.headerPreview??''),0),packageBytes:Buffer.byteLength(JSON.stringify(pack))}};
 };
 const route=await activation(prefix),diagnosticTrigger=forcedRequest(plan,prefix).trigger;
 const v1d=await execute(1,diagnosticTrigger,prefix.observations);let v2d;const diagnosticLatencies=[];
 for(let i=0;i<(freeze.diagnosticReplays??1);i++){
  const start=performance.now(),next=await execute(2,diagnosticTrigger,prefix.observations);diagnosticLatencies.push(performance.now()-start);v2d??=next;
  assert.equal(hash(next.pack),hash(v2d.pack),'Diagnostic identity/root/catalog/package nondeterminism');
 }
 diagnosticLatencies.sort((a,b)=>a-b);
 let actual=null;const latencies=[];let stable=true,expected;
 if(route.trigger){
  const a=await execute(1,route.trigger,route.observations);let first;
  for(let i=0;i<freeze.replays;i++){const start=performance.now(),b=await execute(2,route.trigger,route.observations);latencies.push(performance.now()-start);first??=b;const digest=hash(b.pack);expected??=digest;stable&&=digest===expected;assert.equal(digest,expected,'Nondeterministic package');}
  actual={activationOrdinal:route.index,trigger:route.trigger,v1:summarize(a.pack,a.metrics),v2:summarize(first.pack,first.metrics),performance:first.performance};
  const dest=join(out,'execution',plan.caseId+'.json');await writeFile(dest,JSON.stringify({caseId:plan.caseId,route,actual,v1:a,v2:first},null,2));artifacts.push(await identity(dest));
 }
 latencies.sort((a,b)=>a-b);
 const row={caseId:plan.caseId,actual,diagnostic:{timing:'forced_END_not_real_route',v1:summarize(v1d.pack,v1d.metrics),v2:summarize(v2d.pack,v2d.metrics),performance:{...v2d.performance,p50:diagnosticLatencies[Math.floor(diagnosticLatencies.length*.5)],p95:diagnosticLatencies[Math.floor(diagnosticLatencies.length*.95)],max:diagnosticLatencies.at(-1)}},determinism:{replays:latencies.length,diagnosticReplays:diagnosticLatencies.length,diagnosticPackageSha256:hash(v2d.pack),stable,packageSha256:expected??null},performance:{p50:latencies[Math.floor(latencies.length*.5)]??null,p95:latencies[Math.floor(latencies.length*.95)]??null,max:latencies.at(-1)??null,heapUsed:process.memoryUsage().heapUsed}};
 rows.push(row);console.log(JSON.stringify({caseId:plan.caseId,actual:actual?[actual.v1.anchorStatus,actual.v2.anchorStatus]:null,diagnostic:[row.diagnostic.v1.anchorStatus,row.diagnostic.v2.anchorStatus]}));
}
const count=(which,arm)=>{const all=rows.map(r=>r[which]?.[arm]).filter(Boolean);return {total:all.length,resolved:all.filter(r=>r.anchorStatus==='resolved').length,partial:all.filter(r=>r.anchorStatus==='partial').length,ambiguous:all.filter(r=>r.anchorStatus==='anchor_ambiguous').length,missing:all.filter(r=>r.anchorStatus==='anchor_missing').length,graphStarted:all.filter(r=>r.graphInvestigationStarted).length,catalogDelivered:all.filter(r=>r.catalogDelivered).length,errors:all.filter(r=>r.terminal==='error').length};};
const diagnostic={v1:count('diagnostic','v1'),v2:count('diagnostic','v2')},actual={v1:count('actual','v1'),v2:count('actual','v2')};
const regressions=rows.filter(r=>r.actual?.v1.rootsResolved&&!r.actual.v2.rootsResolved||r.diagnostic.v1.rootsResolved&&!r.diagnostic.v2.rootsResolved).map(r=>r.caseId);
const passed=diagnostic.v2.ambiguous<=diagnostic.v1.ambiguous/2&&!diagnostic.v2.errors&&!actual.v2.errors&&!regressions.length&&rows.every(r=>r.determinism.stable);
const result={identity:freeze.identity,gate1:passed?'PASS':'FAIL',modelCalls:0,privateScorerAccess:false,actual,diagnostic,regressions,rows};
await writeFile(join(out,'execution/results.json'),JSON.stringify(result,null,2));artifacts.push(await identity(join(out,'execution/results.json')));
await checkIdentities(freeze.files);await writeFile(join(out,'execution/execution-freeze.json'),JSON.stringify({identity:freeze.identity,files:artifacts,inputsUnchanged:true,modelCalls:0},null,2));console.log(JSON.stringify({gate1:result.gate1,actual,diagnostic,regressions}));
