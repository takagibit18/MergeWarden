import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewBudget} from '../src/engine/budget.ts';
import {OperationGate} from '../src/engine/operations.ts';
import {ReviewEngine} from '../src/engine/review.ts';
import {MemoryJournal} from '../src/adapters/memory-journal.ts';
import {readRun} from '../src/engine/reports.ts';
import {repositoryFixture} from './repository-fixture.mjs';
import {StructuralDispatch} from '../src/engine/dispatch-service.ts';
import {ProgressiveInvestigation} from '../src/engine/investigation-service.ts';

for(const Service of [StructuralDispatch,ProgressiveInvestigation])test('host dispatch blocked during closeout reports budget, not backend error: '+Service.name,async()=>{
 const gate=new OperationGate({limit:10,signal:new AbortController().signal,available:()=>true,closing:()=>true,exhausted(){assert.fail('hard budget not reached');}});
 const service=new Service({runId:'r',snapshotId:'s',changedPaths:['app.py'],signal:new AbortController().signal,promote(){assert.fail('no source');},source:async()=>assert.fail('no reads'),operation:()=>gate.run('host_dispatch',async()=>assert.fail('no execution'))});
 service.observe({toolName:'read_diff',toolCallId:'diff',input:{path:'app.py'},result:{snapshotId:'s',status:'ok',path:'app.py',offset:0,totalLines:2,lines:['@@ -1 +1 @@','+def work(x): pass']}});
 const pack=await service.dispatch({routeId:'route',routeType:'CALLER_CHECK',targetHint:'work',reason:'signature_change',path:'app.py',toolCallId:'diff',toolName:'read_diff'});
 assert.equal(pack.terminal,'budget_exhausted');assert.equal(gate.used,0);assert.equal(gate.counts.host_dispatch.rejected,1);
});

test('shared model/host closeout reserve is atomic, cannot fund reads, and keeps hard limit',async()=>{
 let now=0;const abort=new AbortController();
 const budget=new ReviewBudget({limit:100,timeoutMs:600000,started:0,now:()=>now,used:()=>gate.used});
 const gate=new OperationGate({limit:100,signal:abort.signal,available:()=>true,closing:()=>budget.state().phase==='closing',exhausted:()=>abort.abort(Error('hard limit'))});
 for(let i=0;i<80;i++)await gate.run(i%2?'host_dispatch':'model',async()=>{});
 assert.equal(budget.state().phase,'warning');assert.equal(budget.state().operationsRemaining,20);
 for(let i=0;i<10;i++)await gate.run('host_dispatch',async()=>{});
 assert.equal(budget.state().phase,'closing');assert.equal(budget.state().reason,'operations');
 for(const origin of ['model','host_dispatch'])await assert.rejects(gate.run(origin,async()=>assert.fail('must not execute')),/BUDGET_CLOSING/);
 assert.equal(gate.used,90);gate.blockedModelCall();assert.equal(gate.used,90);
 for(let i=0;i<10;i++)await gate.run('model',async()=>{},true);
 assert.equal(gate.used,100);await assert.rejects(gate.run('model',async()=>{},true),/Tool budget/);assert(abort.signal.aborted);
});
test('wall-clock closeout does not reset or replenish either budget',()=>{
 let now=420000;const b=new ReviewBudget({limit:100,timeoutMs:600000,started:0,used:()=>2,now:()=>now});
 assert.equal(b.state().phase,'warning');now=510000;assert.equal(b.state().phase,'closing');assert.equal(b.state().reason,'time');
 now=600100;assert.equal(b.state().timeRemainingMs,0);assert.equal(b.state().operationsRemaining,98);
});
for(const tools of ['text-only','text+graph'])test('closeout repairs submission without inventing evidence or relaxing coverage: '+tools,async t=>{
 const f=await repositoryFixture(t),head=await f.change();let state;
 const factory=async o=>({journal:new MemoryJournal(),usage:()=>({input:1,output:1,total:2}),abort:async()=>{},dispose(){},async prompt(){
  const ts=Object.fromEntries(o.tools.map(t=>[t.name,t.execute]));
  await ts.read_diff({path:'app.py'});
  for(let i=1;i<18;i++)await ts.read_source({revision:'head',path:'app.py',startLine:1,endLine:1});
  assert.equal(o.budgetState().phase,'closing');
  await assert.rejects(ts.read_source({revision:'head',path:'app.py',startLine:1,endLine:1}),/BUDGET_CLOSING/);
  await assert.rejects(ts.submit_review({summary:'bad',reviewedPaths:['unread.py'],findings:[]}),/Unknown reviewed path/);
  await ts.submit_review({summary:'Reviewed the diff; no supported finding in the inspected scope.',reviewedPaths:['app.py'],findings:[]});state=o.budgetState();
 }});
 const r=await new ReviewEngine(factory).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},evaluation:{tools},maxToolCalls:20});
 assert.equal(r.report.status,'completed');assert.equal(state.phase,'submitted');assert.equal(state.operationsUsed,20);
 const manifest=await readRun(f.state,r.runId);assert.equal(manifest.metrics.toolExecuted,20);assert.equal(manifest.metrics.toolRejected,1);assert.equal(manifest.termination.reason,'completed');
});
test('closing with uninspected paths stays partial even after a valid final submission',async t=>{
 const f=await repositoryFixture(t),head=await f.change();
 const factory=async o=>({journal:new MemoryJournal(),usage:()=>({input:1,output:1,total:2}),abort:async()=>{},dispose(){},async prompt(){
  const ts=Object.fromEntries(o.tools.map(t=>[t.name,t.execute]));for(let i=0;i<9;i++)await ts.read_source({revision:'head',path:'app.py',startLine:1,endLine:1});
  assert.equal(o.budgetState().phase,'closing');await ts.submit_review({summary:'Diff remains unreviewed; stopping with no supported finding.',reviewedPaths:[],findings:[]});
 }});
 const r=await new ReviewEngine(factory).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'},maxToolCalls:10});
 assert.equal(r.report.status,'partial');assert.equal(r.report.coverage['app.py'],'pending');assert.equal((await readRun(f.state,r.runId)).termination.reason,'incomplete');
});
