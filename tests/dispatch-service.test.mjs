import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {StructuralDispatch,packageText} from '../src/engine/dispatch-service.ts';
const hash=x=>createHash('sha256').update(x).digest('hex');
const root={entityId:'root',snapshotId:'s',path:'app.py',name:'work',qualifiedName:'app.work',kind:'function',startLine:1,endLine:2};
const caller={...root,entityId:'caller',path:'caller.py',name:'caller',qualifiedName:'caller.caller',depth:1};
const edge={id:'e',snapshotId:'s',fromId:'caller',toId:'root',relation:'CALLS',resolution:'resolved_scoped',sourcePath:'caller.py',sourceLine:2,sourceEndLine:2,siteId:'site',resolverVersion:'v4'};
function setup({text='return work(1)',signal=new AbortController().signal,budget}={}){
 const operations=[],promoted=[],events=[];
 const service=new StructuralDispatch({runId:'r',snapshotId:'s',changedPaths:['app.py'],signal,budget,promote:s=>promoted.push(s),async operation(name,input){
  operations.push([name,input]);
  if(name==='read_source')return {snapshotId:'s',revision:'head',path:input.path,status:'ok',startLine:input.startLine,endLine:input.endLine,text,contentSha256:hash(text)};
  return {snapshotId:'s',revision:'head',generationId:'g',status:'ok',items:name==='locate_entity'?[root]:[root,caller],edges:[edge]};
 }});service.setRecorder(e=>events.push(e));
 const trigger={routeId:'route',routeType:'CALLER_CHECK',targetHint:'work',reason:'signature_change',path:'app.py',toolCallId:'t',toolName:'read_diff'};
 return {service,trigger,operations,promoted,events};
}
test('host source eligibility waits for exact serialized provider package and explicit selection remains external',async()=>{
 const f=setup(),pack=await f.service.dispatch(f.trigger);
 assert.equal(pack.terminal,'context_returned');assert.equal(f.promoted.length,0);
 f.service.queued(pack);assert.equal(f.service.hasPending(),true);
 f.service.providerPayload({messages:[{content:pack.requestId}]});assert.equal(f.promoted.length,0);
 f.service.providerPayload({messages:[{content:packageText(pack)}]});assert.equal(f.promoted.length,1);assert.equal(f.service.hasPending(),false);
 assert.deepEqual(f.operations.map(x=>x[0]),['locate_entity','traverse_graph','read_source']);
 assert.equal(await f.service.dispatch(f.trigger),undefined);assert.equal(f.operations.length,3);
 assert.equal(f.events.filter(e=>e.type==='context_delivered').length,1);
});
test('whole omitted source never gains eligibility or retains a sliced hash',async()=>{
 const f=setup({text:'x'.repeat(24000)}),pack=await f.service.dispatch(f.trigger);
 assert.equal(pack.sources.length,0);assert.ok(pack.omitted.some(x=>x.includes('byte limit')));assert.ok(Buffer.byteLength(packageText(pack))<=24576);
 f.service.queued(pack);f.service.providerPayload({content:packageText(pack)});assert.equal(f.promoted.length,0);
});
test('cancelled dispatch starts zero operations and duplicate retries stay deduplicated',async()=>{
 const abort=new AbortController();abort.abort(Error('cancelled'));const f=setup({signal:abort.signal});
 const pack=await f.service.dispatch(f.trigger);assert.equal(pack.terminal,'cancelled');assert.equal(f.operations.length,0);
 assert.equal(await f.service.dispatch(f.trigger),undefined);
});
test('structural cap has a terminal and forbids traversal after admitted locate',async()=>{
 const f=setup({budget:{maxStructuralCallsPerEpisode:1}}),pack=await f.service.dispatch(f.trigger);
 assert.equal(pack.terminal,'budget_exhausted');assert.equal(f.operations.length,1);
});
test('failed delivery persistence cannot promote evidence',async()=>{
 const f=setup(),pack=await f.service.dispatch(f.trigger);f.service.queued(pack);
 f.service.setRecorder(()=>{throw Error('disk failure')});
 assert.throws(()=>f.service.providerPayload({content:packageText(pack)}),/persistence failed/);assert.equal(f.promoted.length,0);
 f.service.setRecorder(()=>{});assert.throws(()=>f.service.providerPayload({content:packageText(pack)}),/persistence failed/);
});
test('two episodes are admitted and a third returns an explicit terminal without new operations',async()=>{
 const f=setup();await f.service.dispatch(f.trigger);
 await f.service.dispatch({...f.trigger,routeId:'second'});
 const third=await f.service.dispatch({...f.trigger,routeId:'third'});
 assert.equal(third.terminal,'budget_exhausted');assert.equal(f.operations.length,6);
});
test('a reduced run-wide structural cap stops the next episode after locating',async()=>{
 const f=setup({budget:{maxStructuralCallsTotal:3}});await f.service.dispatch(f.trigger);
 const pack=await f.service.dispatch({...f.trigger,routeId:'second'});
 assert.equal(pack.terminal,'budget_exhausted');assert.equal(f.operations.length,4);
 assert.equal(f.service.metrics.structuralOperations,3);
});
test('budget configuration cannot expand frozen caps',()=>{
 assert.throws(()=>setup({budget:{maxRouteEpisodes:3}}),/Invalid dispatch budget/);
});
