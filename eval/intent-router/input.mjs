import assert from 'node:assert/strict';
import {InvestigationFocus} from '../../src/engine/investigation-focus.ts';
import {resolveChangeHints,changeUnits} from '../../src/engine/change-resolution.ts';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../../integrations/pi/src/structural-routing.ts';
import {legalIntents} from './contracts.mjs';
const pick=(x,keys)=>Object.fromEntries(keys.filter(k=>x?.[k]!==undefined).map(k=>[k,x[k]]));
export async function replayPrefix(prefix) {
  const handlers=new Map(),checkpoints=[];let active=[...TEXT_TOOLS],trigger=null;
  const routing=createStructuralRouting({snapshotId:prefix.snapshotId,changedPaths:prefix.changedPaths,variant:'pi_structural_v2_investigate',onBlockedCall(){throw Error('Unexpected Graph request');},dispatch:{observe(){},providerPayload(){},queued(){throw Error('Unexpected delivery');},async dispatch(t){trigger=t;}}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]));
  routing.extension({on:(n,f)=>handlers.set(n,f),appendEntry:(_n,d)=>checkpoints.push(d),getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:x=>active=x,sendMessage(){throw Error('Unexpected message');}});
  await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
  for(const event of prefix.observations){assert.ok(['read_diff','read_source','search_text'].includes(event.toolName));assert.equal(event.result.snapshotId,prefix.snapshotId);await handlers.get('tool_call')(event);await handlers.get('tool_result')({...event,content:[{type:'text',text:JSON.stringify(event.result)}]});if(trigger)break;}
  const state=checkpoints.at(-1),metrics=routing.metrics();
  return {triggered:metrics.triggered>0,trigger,state,summary:{triggered:metrics.triggered,activated:metrics.activated,firstActivationToolOrdinal:metrics.firstActivationToolOrdinal??null,routes:state.routes.map(r=>({routeType:r.routeType,reason:r.reason,triggerOrdinal:r.triggerToolOrdinal,activationOrdinal:r.activationOrdinal??null,suppressionReason:r.suppressionReason??null}))}};
}
export function completePages(prefix) {
  const pages=new Map();
  for(const o of prefix.observations)if(o.toolName==='read_diff'&&!o.isError&&o.result.status==='ok'){
    const r=o.result;assert.equal(r.snapshotId,prefix.snapshotId);assert.ok(prefix.changedPaths.includes(r.path));
    const p=pages.get(r.path)??{total:r.totalLines,lines:new Map()};assert.equal(p.total,r.totalLines);
    r.lines.forEach((line,i)=>{const index=r.offset+i;if(p.lines.has(index))assert.equal(p.lines.get(index),line);p.lines.set(index,line);});pages.set(r.path,p);
  }
  return [...pages].map(([path,p])=>({path,total:p.total,complete:Number.isSafeInteger(p.total)&&p.lines.size===p.total&&Array.from({length:p.total},(_,i)=>p.lines.has(i)).every(Boolean),lines:[...p.lines].sort((a,b)=>a[0]-b[0]).map(x=>x[1])}));
}
export function buildUnits(prefix,symbols) {
  const focus=new InvestigationFocus(prefix.snapshotId,prefix.changedPaths);for(const event of prefix.observations)focus.observe(event);
  const hints=focus.freeze({routeId:'semantic-public-focus',routeType:'STRUCTURAL_ESCALATION',reason:'public_change_units',path:'',targetHint:'',toolCallId:'checkpoint',toolName:'read_diff'});
  const resolutions=hints.anchors.length?resolveChangeHints(symbols,prefix.snapshotId,hints.anchors):[];
  return {focus:hints,resolutions,units:hints.anchors.length?changeUnits(prefix.snapshotId,hints.anchors,resolutions):[]};
}
function changedSnippet(unit,pages) {
  const page=pages.find(p=>p.path===unit.path&&p.complete);if(!page)return '';
  let line=0;const selected=[];
  for(const text of page.lines){const h=/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);if(h){line=Number(h[1]);continue;}if(/^(---|\+\+\+|diff |index |\\)/.test(text))continue;
    if(text.startsWith('+')&&unit.changedRanges.some(r=>line>=r.startLine&&line<=r.endLine)&&line>=unit.entity.startLine&&line<=unit.entity.endLine)selected.push({line,text:text.slice(1)});
    if(text.startsWith('+')||text.startsWith(' '))line++;
  }
  return selected;
}
export function projectInput(alias,prefix,replay,resolvedUnits) {
  assert.match(alias,/^SR\d{2}$/);assert.equal(replay.triggered,false);
  const pages=completePages(prefix),diff=[],sources=[],searches=[];let omittedUntouchedSources=0;
  for(const o of prefix.observations){
    if(o.toolName==='read_diff')diff.push(pick(o.result,['path','status','lines','offset','totalLines','truncated']));
    else if(o.toolName==='read_source'){if(prefix.changedPaths.includes(o.result.path))sources.push(pick(o.result,['path','revision','status','text','startLine','endLine','truncated']));else omittedUntouchedSources++;}
    else if(o.toolName==='search_text')searches.push({input:pick(o.input,['query','revision','limit','caseSensitive']),result:{...pick(o.result,['status','revision','truncated']),items:(o.result.items??[]).map(m=>pick(m,['path','line','startLine','endLine','column']))}});
  }
  const cards=resolvedUnits.map((u,i)=>({changeUnitId:'CU'+String(i+1).padStart(2,'0'),path:u.path,kind:u.kind,name:u.entity.name,qualifiedName:u.entity.qualifiedName,changedRanges:u.changedRanges,resolution:u.resolution,changedSnippet:changedSnippet(u,pages),allowedIntents:legalIntents(u.kind)}));
  return {caseId:alias,reviewChange:{changedPaths:prefix.changedPaths,diff},observedContext:{changedSideSource:sources,searchHistory:searches,omittedUntouchedSources,searchSnippets:'Uniformly omitted; only observed query and match metadata retained.'},routerState:{outcome:'NO_ROUTE',highSignals:[],weakSignals:replay.state.weakSignals,searchCount:replay.state.searches,textVerified:replay.state.textVerified,seenPaths:replay.state.seenPaths,state:replay.state.state},changeUnits:cards};
}
