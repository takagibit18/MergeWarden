import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {zstdDecompressSync} from 'node:zlib';
import {repositoryFixture} from '../../../tests/repository-fixture.mjs';
import {SnapshotStore} from '../../../src/snapshot/store.ts';
import {writeJson} from '../../../src/infrastructure/files.ts';
import {SqliteCodeGraph} from '../../../src/graph/sqlite-store.ts';
import {ReviewEngine} from '../../../src/engine/review.ts';
import {createOAuthModelRuntime} from '../src/runtime.ts';
import {abRuntime} from '../../../eval/real/ab-runtime.mjs';
import {model,evaluationFor,pairedPlan,referenceRun} from '../../../eval/real/ab-contract.mjs';
import {executeBatch} from '../../../eval/real/batch.mjs';
import {digest} from '../../../eval/real/open-label.mjs';
for(const arm of ['A','B'])test('paired native Codex max uses automatic routing only in '+arm,async t=>{
 const f=await repositoryFixture(t,{'app.py':'def work(value):\n    return value\n','caller.py':'from app import work\ndef caller():\n    return work(1)\n','second.py':'from app import work\ndef second():\n    return work(2)\n'});
 await f.write('app.py','def work(value, mode):\n    return value\n');const head=await f.commit();
 const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{...model,policy:'final_only',promptVersion:1}});const graph=await SqliteCodeGraph.open(store);graph.graph.close();
 const auth=join(f.state,'offline-auth.json');await writeFile(auth,JSON.stringify({'openai-codex':{type:'oauth',access:`e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline'}})).toString('base64')}.offline`,refresh:'offline',expires:Date.now()+3600000}}));
 const priorFetch=globalThis.fetch,priorSocket=globalThis.WebSocket;globalThis.WebSocket=undefined;t.after(()=>{globalThis.fetch=priorFetch;globalThis.WebSocket=priorSocket;});let turn=0,observations=0,runDir;
 globalThis.fetch=async(url,init)=>{
  const req=new Request(url,init);assert.equal(req.url,'https://chatgpt.com/backend-api/codex/responses');const bytes=Buffer.from(await req.arrayBuffer()),p=JSON.parse((req.headers.get('content-encoding')==='zstd'?zstdDecompressSync(bytes):bytes).toString());assert.equal(p.reasoning.effort,'max');turn++;
  const serialized=JSON.stringify(p);if(turn===1)assert(!serialized.includes('"origin":"host_dispatch"'));if(turn===2)assert.equal(serialized.includes('structural-dispatch-2'),arm==='B');
  const action=turn===1?{name:'read_diff',arguments:{path:'app.py'}}:turn===2?{name:'submit_review',arguments:{summary:'Synthetic protocol check',reviewedPaths:['app.py'],findings:[]}}:null;
  const output=action?[{type:'function_call',id:'fc_'+turn,call_id:'call_'+turn,name:action.name,arguments:JSON.stringify(action.arguments),status:'completed'}]:[{type:'message',id:'done',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done',annotations:[]}]}];
  const events=output.flatMap((item,output_index)=>[{type:'response.output_item.added',item,output_index},{type:'response.output_item.done',item,output_index}]);events.push({type:'response.completed',response:{id:'r'+turn,status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const catalog=await createOAuthModelRuntime(model.provider,auth);
 const seed='00000000-0000-4000-8000-000000000001';await writeJson(join(f.state,'runs',seed,'run.json'),referenceRun(seed,store.manifest.identity.id));
 const result=await new ReviewEngine(async options=>{runDir=options.runDir;return abRuntime(options,catalog,{arm,onPayload:()=>{observations++;}});}).run({repositoryPath:f.repository,stateDir:f.state,rerunId:seed,model,maxToolCalls:30,evaluation:evaluationFor(arm)});
 assert.equal(result.report.status,'completed');assert.equal(observations,turn);assert.equal(turn,3);
 const manifest=JSON.parse(await readFile(join(runDir,'run.json'),'utf8'));assert.equal(manifest.metrics.dispatch?.packagesDelivered??0,arm==='B'?1:0);assert.equal(manifest.runtimeConfiguration.thinkingLevel,'max');assert.equal(manifest.metrics.toolExecuted,2);
});
test('paired checkpoint keeps full plan and never reruns failed first attempts',async t=>{
 const f=await repositoryFixture(t),tasks=Array.from({length:12},(_,i)=>({case_id:'C'+i,repository:'org/repo',repository_url:'https://github.com/org/repo.git',base_sha:'a'.repeat(40),reviewed_sha:'b'.repeat(40),language:'Python',review_context_policy:'repository'})),plan=pairedPlan(tasks),identity={attemptPolicy:'first_attempt'};assert.deepEqual(plan.slice(0,4).map(j=>j.arm),['A','B','B','A']);
 let calls=0;const execute=async job=>{calls++;return {status:job.runKey===plan[0].runKey?'failed':'completed',delivered:job.runKey!==plan[0].runKey};};
 const first=await executeBatch({output:f.state,plan,identity,maxJobs:20,execute});assert.equal(first.length,20);assert.equal(calls,20);
 const second=await executeBatch({output:f.state,plan,identity,resume:true,execute});assert.equal(second.length,24);assert.equal(calls,24);assert.equal(digest(first),digest(second.slice(0,20)));
});

for(const arm of ['A','B'])test('native Pi receives closeout context and preserves submission repairs in '+arm,async t=>{
 const f=await repositoryFixture(t,{'app.py':'def work(value):\n    return value\n','caller.py':'from app import work\ndef caller():\n    return work(1)\n'});
 await f.write('app.py','def work(value, mode):\n    return value\n');const head=await f.commit();
 const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{...model,policy:'final_only',promptVersion:1}});
 const graph=await SqliteCodeGraph.open(store);graph.graph.close();
 const auth=join(f.state,'offline-auth.json');await writeFile(auth,JSON.stringify({'openai-codex':{type:'oauth',access:`e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline'}})).toString('base64')}.offline`,refresh:'offline',expires:Date.now()+3600000}}));
 const priorFetch=globalThis.fetch,priorSocket=globalThis.WebSocket;globalThis.WebSocket=undefined;t.after(()=>{globalThis.fetch=priorFetch;globalThis.WebSocket=priorSocket;});
 let turn=0,closingTurns=0,budgetState,runDir;const phases=[];
 globalThis.fetch=async(url,init)=>{
  const req=new Request(url,init);assert.equal(req.url,'https://chatgpt.com/backend-api/codex/responses');
  const bytes=Buffer.from(await req.arrayBuffer()),p=JSON.parse((req.headers.get('content-encoding')==='zstd'?zstdDecompressSync(bytes):bytes).toString());
  const phase=budgetState().phase;phases.push(phase);assert.equal(p.reasoning.effort,'max');
  const text=JSON.stringify(p.input);assert(text.includes('[Host review budget]'));assert(text.includes(`\\"phase\\":\\"${phase}\\"`));
  const read={name:'read_source',arguments:{revision:'head',path:'app.py',startLine:1,endLine:1}};
  let actions;
  if(++turn===1)actions=[{name:'read_diff',arguments:{path:'app.py'}}];
  else if(phase==='submitted')actions=[];
  else if(phase==='closing'){
   assert(text.includes('Only submit_review may execute'));
   actions=++closingTurns===1?[read,{name:'submit_review',arguments:{summary:'Invalid path must still fail',reviewedPaths:['missing.py'],findings:[]}}]:[{name:'submit_review',arguments:{summary:'Inspected changed diff; no supported finding.',reviewedPaths:['app.py'],findings:[]}}];
  }else actions=[read];
  assert(turn<30,'closeout must terminate');
  const output=actions.length?actions.map((a,i)=>({type:'function_call',id:`fc_${turn}_${i}`,call_id:`call_${turn}_${i}`,name:a.name,arguments:JSON.stringify(a.arguments),status:'completed'})):[{type:'message',id:'done',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done',annotations:[]}]}];
  const events=output.flatMap((item,output_index)=>[{type:'response.output_item.added',item,output_index},{type:'response.output_item.done',item,output_index}]);
  events.push({type:'response.completed',response:{id:'r'+turn,status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const catalog=await createOAuthModelRuntime(model.provider,auth),seed='00000000-0000-4000-8000-000000000001';
 await writeJson(join(f.state,'runs',seed,'run.json'),referenceRun(seed,store.manifest.identity.id));
 const result=await new ReviewEngine(async options=>{budgetState=options.budgetState;runDir=options.runDir;return abRuntime(options,catalog,{arm});}).run({repositoryPath:f.repository,stateDir:f.state,rerunId:seed,model,maxToolCalls:20,evaluation:evaluationFor(arm)});
 assert.equal(result.report.status,'completed');assert.equal(closingTurns,2);assert(phases.includes('warning'));assert(phases.includes('submitted'));
 const manifest=JSON.parse(await readFile(join(runDir,'run.json'),'utf8'));
 assert.equal(manifest.metrics.toolExecuted+(manifest.metrics.dispatch?.operations.executed??0),20);assert.equal(manifest.metrics.toolRejected,1);assert.equal(manifest.metrics.budget.phase,'submitted');
 const journal=await readFile(join(runDir,'session.jsonl'),'utf8');assert(journal.includes('BUDGET_CLOSING'));assert(journal.includes('Unknown reviewed path'));assert(journal.includes('mergewarden.budget-state.v1'));
});
