import {join,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {SnapshotStore} from '../src/snapshot/store.ts';
import {ProgressiveInvestigation} from '../src/engine/investigation-service.ts';
import {declarationPreview} from '../src/engine/candidate-catalog.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
import {createStructuralRouting,TEXT_TOOLS,STRUCTURAL_TOOLS} from '../integrations/pi/src/structural-routing.ts';
import {graphData} from './frontier-data.mjs';
import {identity,hash,checkIdentities} from './candidate-dataset-context.mjs';
const out=resolve(process.argv[2]),freeze=JSON.parse(await readFile(join(out,'input-freeze.json'),'utf8')),rows=[],files=[];
assert(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);assert.equal(process.permission.has('child'),false);await checkIdentities(freeze.files);
for(const p of freeze.plans){
 if(p.duplicate){rows.push({caseId:p.caseId,status:'DUPLICATE',publiclyEligible:false});continue;}
 const old=JSON.parse(await readFile(p.contextPath,'utf8')),data=await graphData(p),retrieval=new LocAgentRetrieval(data),store=await SnapshotStore.load(p.state,p.snapshotId);
 async function generate(){
  let pack,active=[...TEXT_TOOLS];const handlers=new Map(),blocks=[],events=[];
  const service=new ProgressiveInvestigation({runId:p.caseId,snapshotId:p.snapshotId,changedPaths:old.changedPaths,signal:new AbortController().signal,promote(){},source:(path,start,end)=>store.source('head',path,start,end),operation:async(name,input)=>{
   if(name==='read_source')return store.source('head',input.path,input.startLine,input.endLine);
   if(name==='resolve_change_units')return retrieval.resolveChangeUnits(input);
   assert.equal(name,'host_structural_investigation');const result=retrieval.investigate(input);
   for(const c of result.pool.eligible){const preview=declarationPreview(await store.text('head',c.terminalPath),c.terminalEntity.startLine,c.entityKind);if(preview)result.previews[c.terminalEntityId]=preview;}
   return result;
  }});service.setRecorder(e=>events.push(e));
  const bridge={observe:e=>service.observe(e),providerPayload(){},queued(){},async dispatch(trigger){pack=await service.dispatch(trigger);}};
  const routing=createStructuralRouting({snapshotId:p.snapshotId,changedPaths:old.changedPaths,variant:'pi_structural_v2_investigate',dispatch:bridge,onBlockedCall(){throw Error('Unexpected graph call')}},new Set([...TEXT_TOOLS,...STRUCTURAL_TOOLS]));
  routing.extension({on:(n,f)=>handlers.set(n,f),appendEntry(){},getAllTools:()=>[...TEXT_TOOLS,...STRUCTURAL_TOOLS].map(name=>({name})),getActiveTools:()=>active,setActiveTools:x=>active=x,sendMessage(){}});
  await handlers.get('session_start')({}, {sessionManager:{getBranch:()=>[]}});
  for(const b of old.blocks){blocks.push(b);const event={toolName:b.tool,toolCallId:b.toolCallId,input:b.input,content:[{type:'text',text:JSON.stringify(b.result)}]};await handlers.get('tool_call')(event);await handlers.get('tool_result')(event);if(pack)break;}
  const inv=pack?.investigations[0],catalog=inv?.candidateCatalog??[],realDiff=blocks.some(b=>b.tool==='read_diff'&&b.result.lines?.some(l=>/^[+-](?![+-])/.test(l)));
  const status=!realDiff?'NO_REAL_DIFF':!pack?'ROUTE_NOT_TRIGGERED':!inv.rootsResolved?'ROOT_UNRESOLVED':catalog.length<4||catalog.length>30?'POOL_OUTSIDE_4_30':'PUBLICLY_ELIGIBLE';
  const input={caseId:p.caseId,snapshotId:p.snapshotId,generationId:p.generationId,reviewContext:blocks,investigation:inv??null,candidateCatalog:catalog};
  return {input,baseline:{selector:'existing deterministic catalog priority',selectedCandidateIds:catalog.slice(0,3).map(c=>c.candidateRefId)},status,routeTriggered:!!pack,rootsResolved:inv?.rootsResolved??0,poolSize:catalog.length,realDiff,sourcePrefetchCount:pack?.sources.length??0,events};
 }
 const a=await generate(),b=await generate();assert.equal(hash(a),hash(b),'Candidate input is not deterministic');
 const dest=join(out,'phase-a',p.caseId+'.json');await writeFile(dest,JSON.stringify(a,null,2));files.push(await identity(dest));
 rows.push({caseId:p.caseId,status:a.status,publiclyEligible:a.status==='PUBLICLY_ELIGIBLE',routeTriggered:a.routeTriggered,rootsResolved:a.rootsResolved,poolSize:a.poolSize,inputSha256:hash(a.input),baselineSha256:hash(a.baseline),deterministic:true});console.log(JSON.stringify(rows.at(-1)));
}
const eligible=rows.filter(r=>r.publiclyEligible).length;
const result={identity:freeze.identity,status:eligible<freeze.minimumValid?'ADMISSION_FAILED':'PUBLIC_INPUTS_READY',publicValidUpperBound:eligible,minimumValid:freeze.minimumValid,
  baselineHits:null,baselineMisses:null,necessaryFactCovered:null,privateScoring:'NOT_RUN',modelCalls:0,armB:'NOT_RUN',armC:'NOT_RUN',gate3:'NOT_RUN',rows};
await writeFile(join(out,'phase-a/admission.json'),JSON.stringify(result,null,2));files.push(await identity(join(out,'phase-a/admission.json')));
await checkIdentities(freeze.files);await writeFile(join(out,'phase-a/generation-freeze.json'),JSON.stringify({identity:freeze.identity,files,privateScorerAccess:false,modelCalls:0},null,2));console.log(JSON.stringify({status:result.status,publicValidUpperBound:eligible,minimumValid:freeze.minimumValid}));
