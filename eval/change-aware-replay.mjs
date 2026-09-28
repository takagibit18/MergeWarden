import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {load} from './bounded-structural-data.mjs';
import {SnapshotStore} from '../src/snapshot/store.ts';
import {snapshotChanges} from '../src/engine/snapshot-changes.ts';
import {declarationSignals} from '../src/engine/declarations.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {ProgressiveInvestigation} from '../src/engine/investigation-service.ts';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../integrations/pi/src/structural-routing.ts';
const out=resolve(process.argv[2]),phase=process.argv[3]??'initial',old=resolve('../output/luna-max-ab-20260928-v2'),state=join(old,'state');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const summaries=await read(resolve('../output/budget-observation-fix-20260928/graph-summary.json'));
const {runs}=await read(join(old,'latest.json'));const rows=[];
for(const baseline of summaries){
 const run=runs.find(r=>r.caseId===baseline.caseId&&r.arm==='B');
 const store=await SnapshotStore.load(state,run.snapshotId),frozen=await load(state,run.snapshotId),retrieval=new LocAgentRetrieval(frozen.data);
 const changes=await snapshotChanges(store),events=[],packs=[],routeEvents=[];
 const operation=async(name,input)=>name==='read_source'?store.source('head',input.path,input.startLine,input.endLine)
  :name==='resolve_change_units'?retrieval.resolveChangeUnits(input):await (async()=>{await retrieval.prepareNavigation(input);return retrieval.investigate(input);})();
 const service=new ProgressiveInvestigation({runId:baseline.caseId+'-offline',snapshotId:run.snapshotId,changedPaths:store.manifest.changedPaths,signal:new AbortController().signal,operation,source:(p,s,e)=>store.source('head',p,s,e),promote(){}});
 service.setRecorder(e=>events.push(e));const handlers=new Map();let active=[...TEXT_TOOLS];
 const routing=createStructuralRouting({snapshotId:run.snapshotId,changedPaths:store.manifest.changedPaths,declarationChanges:changes,variant:'pi_structural_v2_investigate',dispatch:service,onBlockedCall(){throw Error('blocked');}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]));
 routing.extension({on:(n,f)=>handlers.set(n,f),appendEntry:(n,e)=>routeEvents.push(e),getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:x=>active=x,sendMessage:m=>{packs.push(JSON.parse(m.content));service.providerPayload(m.content);}});
 await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
 for(const path of store.manifest.changedPaths){let cursor=0;while(true){const page=await store.diff(path,cursor,200),event={toolName:'read_diff',toolCallId:path+':'+cursor,input:{path,cursor},result:page,content:[{type:'text',text:JSON.stringify(page)}]};
 await handlers.get('tool_call')(event);await handlers.get('tool_result')(event);if(!page.truncated)break;cursor=page.nextCursor;}}
 const routes=routeEvents.at(-1)?.routes??[],cards=packs.flatMap(p=>p.investigations.flatMap(i=>i.candidateCatalog));
 const beforeCards=baseline.events.filter(e=>e.type==='investigation_terminal').flatMap(e=>e.investigation?.candidateCatalog??[]);
 const beforeSources=baseline.events.filter(e=>e.type==='operation_result'&&e.name==='read_source').map(e=>e.result);
 const row={caseId:baseline.caseId,snapshotId:run.snapshotId,generationId:frozen.data.generationId,snapshotSha256:frozen.snapshotSha256,graphSha256:frozen.graphSha256,
  baseline:{source:'historical native run at baseline implementation; actual observed text prefix',metrics:baseline.metrics,signals:baseline.routes,prefetch:beforeSources,candidateCount:beforeCards.length,catalogBytes:Buffer.byteLength(JSON.stringify(beforeCards))},
  vNext:{source:'offline complete immutable diff through production routing callbacks; no model',changeUnits:changes,signals:declarationSignals(changes),metrics:service.metrics,routing:routing.metrics(),routes,
   pendingTargets:routes.filter(r=>r.lifecycle==='pending').length,executedTargets:routes.filter(r=>r.activationOrdinal!==undefined).length,terminalReasons:routes.map(r=>r.terminalReason),candidateCount:cards.length,
   prefetch:packs.flatMap(p=>p.sources.map(s=>({path:s.path,startLine:s.startLine,endLine:s.endLine,provenance:cards.find(c=>c.candidateRefId===s.candidateRefId)}))),
   catalogBytes:Buffer.byteLength(JSON.stringify(cards)),sourceBytes:packs.flatMap(p=>p.sources).reduce((n,s)=>n+Buffer.byteLength(s.text),0)},packs,events};
 rows.push(row);console.log(JSON.stringify({caseId:row.caseId,signals:row.vNext.signals.map(s=>[s.targetHint,s.reason,s.change.head?.scope]),metrics:service.metrics,candidates:cards.map(c=>[c.entity.path,c.entity.name,c.structuralPaths]),prefetch:row.vNext.prefetch.map(s=>s.path)}));
}
await writeFile(join(out,'offline-'+phase+'.json'),JSON.stringify({phase,modelCalls:0,rows},null,2),{flag:'wx'});
