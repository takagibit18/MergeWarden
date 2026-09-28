import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parsePrediction} from '../eval/intent-router/parse.mjs';
import {MODEL_CONFIG,legalPlans} from '../eval/intent-router/contracts.mjs';
import {SYSTEM_PROMPT,userPrompt} from '../eval/intent-router/prompt.mjs';
import {buildUnits,projectInput,replayPrefix} from '../eval/intent-router/input.mjs';
import {executionSession,executePrediction} from '../eval/intent-router/execute.mjs';
import {targetReached,primaryMetrics,cleanCost} from '../eval/intent-router/scoring.mjs';
import {SemanticIntentRuntime} from '../eval/intent-router/runtime.mjs';
import {save,hash} from '../eval/candidate-dataset-context.mjs';
import {emptyCoverage} from '../src/graph/contracts.ts';
import {ProgressiveInvestigation} from '../src/engine/investigation-service.ts';
import {LocAgentRetrieval} from '../src/experiments/locagent/retrieval.ts';
const pair={changeUnitId:'CU01',intent:'CALLER_CHECK',rationale:'Check callers'},allowed=['CU01','CU02'];
const parse=investigations=>parsePrediction(JSON.stringify({investigations}),allowed);
test('intent 01: empty investigations valid',()=>assert.equal(parse([]).status,'OK'));
test('intent 02: one valid pair',()=>assert.equal(parse([pair]).status,'OK'));
test('intent 03: two distinct valid pairs including same unit different intent',()=>assert.equal(parse([pair,{...pair,intent:'RELATIONSHIP_CHECK'}]).status,'OK'));
test('intent 04: third plan rejected',()=>assert.equal(parse([pair,{...pair,changeUnitId:'CU02'},{...pair,intent:'RELATIONSHIP_CHECK'}]).status,'FORMAT_FAILURE'));
test('intent 05: unknown ChangeUnit rejected',()=>assert.equal(parse([{...pair,changeUnitId:'unknown'}]).status,'FORMAT_FAILURE'));
test('intent 06: duplicate pair rejected despite distinct rationale',()=>assert.equal(parse([pair,{...pair,rationale:'different'}]).status,'FORMAT_FAILURE'));
test('intent 07: unknown intent rejected',()=>assert.equal(parse([{...pair,intent:'ESCALATE'}]).status,'FORMAT_FAILURE'));
test('intent 08: strict JSON and exact keys, rationale limit',()=>{
  for(const raw of ['```json\n{"investigations":[]}\n```','{}','{"investigations":[],"path":"x"}','{"investigations":[],}'])assert.equal(parsePrediction(raw,allowed).status,'FORMAT_FAILURE');
  assert.equal(parse([{...pair,entityId:'forged'}]).status,'FORMAT_FAILURE');assert.equal(parse([{...pair,rationale:'x'.repeat(241)}]).status,'FORMAT_FAILURE');
});
const symbol=(id,path)=>({id,snapshotId:'s',kind:'function',path,name:id,qualifiedName:path+':'+id,startLine:1,endLine:4,startColumn:0,endColumn:0});
function fixture(){
  const symbols=[symbol('work','app.py'),symbol('caller','caller.py')],relations=[{id:'edge',snapshotId:'s',fromId:'caller',toId:'work',relation:'CALLS',resolution:'resolved_scoped',sourcePath:'caller.py',sourceLine:2,sourceEndLine:2,sourceColumn:0,sourceEndColumn:4,siteId:'site',resolverVersion:'v4'}];
  const data={snapshotId:'s',generationId:'g',generationState:'ready',graphScope:'core',symbols,relations,sources:{},coverage:emptyCoverage(),warnings:[]};
  const event={ordinal:1,toolName:'read_diff',toolCallId:'diff',input:{path:'app.py'},result:{snapshotId:'s',status:'ok',path:'app.py',offset:0,totalLines:3,lines:['@@ -2,1 +2,1 @@','-    return 0','+    return 1']}};
  const prefix={caseId:'PRIVATE_ORIGINAL_ID',snapshotId:'s',changedPaths:['app.py'],observations:[event]};
  const built=buildUnits(prefix,symbols),units=built.units.map((u,i)=>({...u,hostChangeUnitId:u.changeUnitId,changeUnitId:'CU0'+(i+1)}));
  const text='def f():\n    return 1\n    pass\n    pass';
  const store={text:async()=>text,source:async(revision,path,startLine,endLine)=>({status:'ok',snapshotId:'s',revision,path,startLine,endLine,text:text.split('\n').slice(startLine-1,endLine).join('\n'),contentSha256:hash(text.split('\n').slice(startLine-1,endLine).join('\n'))})};
  const options={caseId:'SR01',snapshotId:'s',generationId:'g',changedPaths:['app.py'],units,data,store};
  return {prefix,built,units,options,event};
}
async function inputFixture(){const f=fixture(),replay=await replayPrefix(f.prefix);return {f,replay,input:projectInput('SR01',f.prefix,replay,f.built.units)};}
test('intent 09: prompt deterministic and narrow intent schema',async()=>{const {input}=await inputFixture();assert.equal(userPrompt(input),userPrompt(structuredClone(input)));assert.match(SYSTEM_PROMPT,/untrusted data/);assert.doesNotMatch(userPrompt(input),/PRIVATE_ORIGINAL_ID/);});
test('intent 10: public hash and ChangeUnits deterministic under independent replay',async()=>{const {f,replay,input}=await inputFixture();const second=await replayPrefix(f.prefix);assert.equal(hash(replay),hash(second));assert.equal(hash(input),hash(projectInput('SR01',f.prefix,second,f.built.units)));assert.equal(hash(f.built),hash(buildUnits(f.prefix,f.options.data.symbols)));});
test('intent 11: Node permission denies private target in public process',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'intent-permission-'));t.after(()=>rm(dir,{recursive:true,force:true}));await save(join(dir,'private.json'),{target:'hidden'});
  const child=spawnSync(process.execPath,['--permission','--input-type=module','--eval',`import {readFileSync} from 'node:fs';try{readFileSync(${JSON.stringify(join(dir,'private.json'))});process.exit(2)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e}`],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
});
test('intent 12: prediction freeze refuses overwrite',async t=>{const dir=await mkdtemp(join(tmpdir(),'intent-freeze-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'prediction-freeze.json');await save(path,{frozen:true});await assert.rejects(save(path,{frozen:false}),{code:'EEXIST'});assert.equal(JSON.parse(await readFile(path)).frozen,true);});
test('intent 13: oracle legal kind pairs only; class CALLS supported; stable bound explicit',()=>{const units=[{changeUnitId:'CU01',kind:'function',resolution:'resolved'},{changeUnitId:'CU02',kind:'class',resolution:'resolved'},{changeUnitId:'CU03',kind:'file',resolution:'resolved'},{changeUnitId:'CU04',kind:'class',resolution:'ambiguous'}];const p=legalPlans(units);assert.equal(p.plans.length,7);assert.ok(p.plans.some(x=>x.changeUnitId==='CU02'&&x.intent==='CALLER_CHECK'));assert.ok(!p.plans.some(x=>x.changeUnitId==='CU01'&&x.intent==='IMPORT_CHECK'));assert.equal(legalPlans(units,3).oraclePlansOmitted,4);assert.equal(legalPlans(units,3).confidence,'LIMITED');});
test('intent 14: target uses exact snapshot/path and full range containment',()=>{const catalog=[{entity:{snapshotId:'s',path:'caller.py',startLine:1,endLine:4}}],target={snapshotId:'s',path:'caller.py',startLine:2,endLine:3};assert.equal(targetReached(catalog,[target],'s'),true);for(const t of [{...target,snapshotId:'other'},{...target,path:'other.py'},{...target,endLine:5}])assert.equal(targetReached(catalog,[t],'s'),false);});
test('intent 15: non-actionable defects excluded from opportunity denominator',()=>{const m=primaryMetrics([{actionable:true,reached:true},{actionable:false,reached:false}],[],{format:0,provider:0});assert.equal(m.ActionableDefectCount,1);assert.equal(m.RecoveredActionableDefects,1);assert.equal(m.OpportunityRecall,1);});
test('intent 16: clean investigation is cost, never an invented correctness label',()=>{const c=cleanCost([{planCount:1,metrics:{structuralOps:2,edgeInspections:3,catalogItems:1,catalogBytes:100,sourceReads:1}}]);assert.equal(c.CleanInvestigationRate,1);assert.equal(c.MeanInvestigationsPerClean,1);assert.equal(c.accuracy,undefined);assert.equal(c.falsePositive,undefined);});
test('intent 17: two predicted plans share episode and structural call limits',async()=>{const f=fixture(),pred={investigations:[pair,{...pair,intent:'RELATIONSHIP_CHECK'}]};const limited=await executePrediction(f.options,pred,{maxStructuralCallsTotal:3});assert.equal(limited.plans[1].status,'B0_BUDGET_EXHAUSTED');assert.equal(limited.metrics.structuralOps,2);const full=await executePrediction(f.options,pred);assert.equal(full.metrics.structuralOps,4);assert.equal(full.metrics.episodes,2);assert.equal(full.metrics.sourceReads,2);assert.ok(full.plans.every(p=>p.metrics.packageBytes<=24576));});
test('intent 18: shared host execution matches product service root/catalog bytes',async()=>{
  const f=fixture(),seen=[],session=executionSession({...f.options,onOperation:n=>seen.push(n)}),actual=await session.execute(pair),retrieval=new LocAgentRetrieval(f.options.data);
  const service=new ProgressiveInvestigation({runId:'SR01',snapshotId:'s',changedPaths:['app.py'],signal:new AbortController().signal,promote(){},source:(...a)=>f.options.store.source('head',...a),operation:async(name,input)=>{
    if(name==='resolve_change_units')return retrieval.resolveChangeUnits(input);if(name==='read_source')return f.options.store.source('head',input.path,input.startLine,input.endLine);
    const r=retrieval.investigate(input);r.previews=Object.fromEntries(r.pool.eligible.map(c=>[c.terminalEntityId,'def f():']));return r;
  }});service.observe(f.event);const pack=await service.dispatch({routeId:JSON.stringify(['CU01','CALLER_CHECK']),routeType:'CALLER_CHECK',path:'app.py',targetHint:'work',reason:'shadow_semantic_intent',toolName:'read_diff',toolCallId:'diff'});
  assert.deepEqual(actual.catalog,pack.investigations[0].candidateCatalog);assert.deepEqual(seen,['resolve_change_units','host_structural_investigation','read_source']);const repeat=await executionSession(f.options).execute(pair);assert.equal(hash(actual),hash(repeat));
});
test('intent 19: candidate bodies and Graph metadata cannot leak into projected input',async()=>{const {f,replay}=await inputFixture();f.prefix.observations.push({toolName:'read_source',input:{},result:{path:'untouched.py',text:'SECRET_BODY'},candidateCatalog:['SECRET_CANDIDATE']},{toolName:'search_text',input:{query:'caller'},result:{items:[{path:'caller.py',line:1,text:'SECRET_BODY'}]}});const input=projectInput('SR01',f.prefix,replay,f.built.units);assert.doesNotMatch(JSON.stringify(input),/SECRET_BODY|SECRET_CANDIDATE/);assert.equal(input.observedContext.omittedUntouchedSources,1);});
test('intent 20: previous model prediction and private provenance not projected',async()=>{const {f,replay}=await inputFixture();f.prefix.previousPrediction={rationale:'SECRET_PREVIOUS'};f.prefix.observations[0].provenance={gold:'SECRET_GOLD'};assert.doesNotMatch(JSON.stringify(projectInput('SR01',f.prefix,replay,f.built.units)),/SECRET_PREVIOUS|SECRET_GOLD/);});
test('intent runtime: existing Pi HTTP adapter once, no tools, independent prompt, credential redacted',async()=>{
  const {input}=await inputFixture(),key='intent-fixture-secret',runtime=await SemanticIntentRuntime.create(MODEL_CONFIG,{MERGEWARDEN_API_KEY:key});let calls=0;
  const result=await runtime.predict(input,{fetch:async(url,init)=>{calls++;const req=new Request(url,init),body=await req.json();assert.equal(req.headers.get('authorization'),'Bearer '+key);assert.equal(body.messages.length,2);assert.equal(body.tools,undefined);assert.equal(body.reasoning_effort,'low');assert.equal(body.temperature,0);assert.equal(body.top_p,1);const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{content:'{"investigations":[]}'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}};return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
  assert.equal(calls,1);assert.equal(result.parsed.status,'OK');assert.equal(result.usage.totalTokens,30);assert.doesNotMatch(JSON.stringify(result),new RegExp(key));
});
test('intent runtime: retryable provider errors remain one failure without repair',async()=>{const {input}=await inputFixture(),key='intent-error-secret',runtime=await SemanticIntentRuntime.create(MODEL_CONFIG,{MERGEWARDEN_API_KEY:key});let calls=0;const r=await runtime.predict(input,{fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:key}}),{status:429,headers:{'Content-Type':'application/json'}});}});assert.equal(calls,1);assert.equal(r.parsed.status,'PROVIDER_FAILURE');assert.doesNotMatch(JSON.stringify(r),new RegExp(key));});
