import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewController} from '../src/application/review-controller.ts';
import {MemoryJournal} from '../src/adapters/memory-journal.ts';
import {snapshot,candidate} from './helpers.mjs';
import {ReviewEngine} from '../src/engine/review.ts';
import {repositoryFixture} from './repository-fixture.mjs';
import {history} from '../src/engine/reports.ts';

test('fault proof: legacy multi-event final batch can persist a pending half-accepted batch',async()=>{
 const memory=new MemoryJournal();let decisions=0;
 const journal={readActiveBranch:()=>memory.readActiveBranch(),async append(event){if(event.payload.type==='candidate.decided'&&++decisions===2)throw Error('injected disk fault');await memory.append(event);}};
 const controller=new ReviewController(journal,'run',snapshot);await controller.start('final_only',['unit']);
 await controller.dispatch({type:'candidates.submitted',channel:'final_only',candidates:[candidate('one'),candidate('two')]});
 await controller.dispatch({type:'candidate.decided',candidateId:'one',disposition:'accepted',reason:'Fixture'});
 await assert.rejects(controller.dispatch({type:'candidate.decided',candidateId:'two',disposition:'accepted',reason:'Fixture'}),/persistence failed/);
 assert.equal(controller.state.finalBatchSubmitted,true);assert.equal(controller.state.candidates.one.disposition,'accepted');assert.equal(controller.state.candidates.two.disposition,'pending');assert.equal(controller.state.units.unit,'pending');
 const restored=new ReviewController(memory,'run',snapshot);await restored.restore();assert.deepEqual(restored.state,controller.state);
});

const batch=()=>({type:'final_batch.accepted',candidates:[candidate('one'),candidate('two')],reviewedPaths:['unit'],reason:'Fixture advisory acceptance'});
test('atomic final event accepts all candidates and coverage once and restores identically',async()=>{
 const journal=new MemoryJournal(),c=new ReviewController(journal,'run',snapshot);await c.start('final_only',['unit']);await c.dispatch(batch());
 assert.equal(c.state.finalBatchSubmitted,true);assert.deepEqual(Object.values(c.state.candidates).map(c=>c.disposition),['accepted','accepted']);assert.equal(c.state.units.unit,'done');
 assert.equal((await journal.readActiveBranch()).length,2);await assert.rejects(c.dispatch(batch()),/already submitted/);
 const restored=new ReviewController(journal,'run',snapshot);await restored.restore();assert.deepEqual(restored.state,c.state);
});
test('atomic batch shape failures leave state and journal unchanged; incremental remains separate',async()=>{
 const journal=new MemoryJournal(),c=new ReviewController(journal,'run',snapshot);await c.start('final_only',['unit']);const before=c.state;
 for(const payload of [{...batch(),reviewedPaths:['unknown']},{...batch(),candidates:[candidate('one'),{...candidate('two'),evidence:[]}]},{...batch(),candidates:[candidate('one'),candidate('one')]}])await assert.rejects(c.dispatch(payload));
 assert.deepEqual(c.state,before);assert.equal((await journal.readActiveBranch()).length,1);await c.dispatch(batch());
 const incremental=new ReviewController(new MemoryJournal(),'incremental',snapshot);await incremental.start('incremental_candidates',['unit']);await assert.rejects(incremental.dispatch(batch()),/final_only/);
});
for(const afterWrite of [false,true])test('uncertain atomic persistence poisons controller and forbids duplicate retry, afterWrite='+afterWrite,async()=>{
 const memory=new MemoryJournal();let attempts=0;
 const journal={readActiveBranch:()=>memory.readActiveBranch(),async append(e){if(e.payload.type==='final_batch.accepted'){attempts++;if(afterWrite)await memory.append(e);throw Error('injected');}await memory.append(e);}};
 const c=new ReviewController(journal,'run',snapshot);await c.start('final_only',['unit']);const before=c.state;
 await assert.rejects(c.dispatch(batch()),{code:'PERSISTENCE_FAILURE'});assert.deepEqual(c.state,before);
 await assert.rejects(c.dispatch(batch()),{code:'PERSISTENCE_FAILURE'});assert.equal(attempts,1);
 const recovered=new ReviewController(memory,'run',snapshot);await recovered.restore();assert.equal(recovered.state.finalBatchSubmitted,afterWrite);
 assert.equal(Object.keys(recovered.state.candidates).length,afterWrite?2:0);
});
for(const afterWrite of [false,true])test('Engine persistence fault never delivers or retries final acceptance, afterWrite='+afterWrite,async t=>{
 const f=await repositoryFixture(t),head=await f.change(),memory=new MemoryJournal();let attempts=0,delivered=false,aborted=false;
 const journal={readActiveBranch:()=>memory.readActiveBranch(),async append(e){if(e.payload.type==='final_batch.accepted'){attempts++;if(afterWrite)await memory.append(e);throw Error('injected');}await memory.append(e);}};
 const factory=async options=>({journal,usage:()=>({input:0,output:0,total:0}),dispose(){},async abort(){aborted=true;},async prompt(){
  const tools=Object.fromEntries(options.tools.map(t=>[t.name,t.execute]));await tools.read_diff({path:'app.py'});
  const submission={summary:'Fixture',reviewedPaths:['app.py'],findings:[]};
  await assert.rejects(tools.submit_review(submission),/persistence failed/);
  await assert.rejects(tools.submit_review(submission),/persistence failed/);
 }});
 await assert.rejects(new ReviewEngine(factory,async()=>{delivered=true;throw Error('unexpected delivery');}).run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model:{provider:'fixture',modelId:'offline'}}),/persistence failed/);
 assert.equal(delivered,false);assert.equal(aborted,true);assert.equal(attempts,1);assert.equal((await history(f.state))[0].status,'delivery_failed');
});
