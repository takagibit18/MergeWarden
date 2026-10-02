import assert from 'node:assert/strict';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../integrations/pi/src/structural-routing.ts';
import {detectStructuralSignals} from '../integrations/pi/src/structural-signals.ts';
import {ROUTING_THRESHOLDS} from '../src/engine/routing-contracts.ts';
import {read,prefixObservations} from './candidate-dataset-context.mjs';

export async function replayRoute(plan) {
  const events=[],checkpoints=[],handlers=new Map(),detector=[],pressures=[];let dispatchTrigger=null;
  const routing=createStructuralRouting({snapshotId:plan.snapshotId,changedPaths:plan.changedPaths,variant:'pi_structural_v2_investigate',onBlockedCall:()=>{throw Error('Unexpected graph call');},dispatch:{observe:()=>{},providerPayload:()=>{},queued:()=>{throw Error('No delivery');},dispatch:async trigger=>{dispatchTrigger=trigger;}}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]));
  let active=[...TEXT_TOOLS];routing.extension({on:(n,f)=>handlers.set(n,f),appendEntry:(_n,data)=>checkpoints.push(data),getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:x=>{active=x;},sendMessage:()=>{throw Error('No dispatch package');}});
  await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
  const blocks=plan.prefixPath?(await read(plan.prefixPath)).blocks:null;
  const source=blocks?(async function*(){for(const b of blocks)yield {toolName:b.tool,toolCallId:b.toolCallId,input:b.input,result:b.result,isError:false,provenance:b.provenance};})():prefixObservations(plan);
  for await(const e of source) {
    assert.ok(['read_diff','read_source','search_text'].includes(e.toolName));assert.equal(e.result.snapshotId,plan.snapshotId);
    events.push({ordinal:events.length+1,...e});
    await handlers.get('tool_call')({toolName:e.toolName,toolCallId:e.toolCallId,input:e.input});
    const before=checkpoints.at(-1);
    const paths=[...new Set((e.result.items??[]).map(i=>i.path))];
    if(e.toolName==='search_text')pressures.push({ordinal:events.length,searchCountBefore:before.searches,searchCountAtDecision:before.searches+1,distinctPaths:paths.length,symbolQuery:/^[A-Za-z_]\w*(?:\.\w+)*$/.test(e.input.query??''),reached:before.searches+1>=ROUTING_THRESHOLDS.searchPressure||(/^[A-Za-z_]\w*(?:\.\w+)*$/.test(e.input.query??'')&&(e.result.truncated===true||paths.length>=ROUTING_THRESHOLDS.distinctPaths))});
    await handlers.get('tool_result')({...e,content:[{type:'text',text:JSON.stringify(e.result)}]});
    const state=checkpoints.at(-1);
    if(e.toolName==='read_diff') {const page=state.pages[e.result.path];if(page&&Object.keys(page.lines).length===page.total)detector.push({path:e.result.path,ordinal:events.length,lines:Array.from({length:page.total},(_,i)=>page.lines[i]),signals:detectStructuralSignals(e.result.path,Array.from({length:page.total},(_,i)=>page.lines[i]))});}
    if(dispatchTrigger)break;
  }
  const state=checkpoints.at(-1),metrics=routing.metrics(),summary={triggered:metrics.triggered,activated:metrics.activated,firstActivationToolOrdinal:metrics.firstActivationToolOrdinal??null,routes:state.routes.map(r=>({routeType:r.routeType,reason:r.reason,triggerOrdinal:r.triggerToolOrdinal,activationOrdinal:r.activationOrdinal??null,suppressionReason:r.suppressionReason??null}))};
  return {caseId:plan.caseId,events,checkpoints,detectorInputs:detector,detectedSignals:detector.flatMap(d=>d.signals.map(s=>({...s,path:d.path,ordinal:d.ordinal}))),weakSignals:state.weakSignals,highSignals:detector.flatMap(d=>d.signals.filter(s=>s.strength==='high')),searchPressure:pressures,searchPressureReached:pressures.some(p=>p.reached),routeTriggered:metrics.triggered>0,routeActivated:metrics.activated>0,routeTypes:summary.routes.map(r=>r.routeType),routeReasons:summary.routes.map(r=>r.reason),triggerOrdinal:summary.routes[0]?.triggerOrdinal??null,suppressionReasons:summary.routes.map(r=>r.suppressionReason).filter(Boolean),currentSearchCount:state.searches,textVerified:state.textVerified,seenPaths:state.seenPaths,routeHistory:state.routes,summary,historicalMatch:plan.historicalExpected?JSON.stringify(plan.historicalExpected)===JSON.stringify(summary):null,prefixBoundary:dispatchTrigger?'first_dispatch_trigger_inclusive':'end_of_available_pre_route_prefix',graphRequests:0,sourceDeliveryReads:0};
}
