import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createModelRuntime,createPiRuntime} from '../src/runtime.ts';
import {ReviewEngine} from '../../../src/engine/review.ts';
import {SnapshotStore} from '../../../src/snapshot/store.ts';
import {SqliteCodeGraph} from '../../../src/graph/sqlite-store.ts';
import {repositoryFixture} from '../../../tests/repository-fixture.mjs';
import {analyzeDispatch} from '../../../src/eval/provenance/dispatch.ts';
import {decodePiTrace} from '../../../src/eval/provenance/decode.ts';
const model={provider:'bigmodel',modelId:'glm-5.3-flash'};
const strings=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
const packages=body=>strings(body.messages).flatMap(s=>{const i=s.indexOf('{"version":"structural-dispatch-1"');if(i<0)return [];try{return [JSON.parse(s.slice(i,s.lastIndexOf('}')+1))]}catch{return []}});
const results=body=>body.messages.filter(m=>m.role==='tool').flatMap(m=>{try{return [JSON.parse(m.content)]}catch{return []}});
const call=(name,args)=>({name,args});
const empty=()=>call('submit_review',{summary:'Offline plumbing fixture.',reviewedPaths:['app.py'],findings:[]});
async function run(t,mode){
 const initial={'app.py':'def work(value):\n    return value\n','caller.py':'from app import work\ndef caller():\n    return work(1)\n','other.py':'def work(value):\n    return value\n'};
 if(mode==='oversize')initial['caller.py']='from app import work\ndef caller():\n    value = "'+'x'.repeat(25000)+'"\n    return work(1)\n';
 const f=await repositoryFixture(t,initial);await f.write('app.py',mode==='no-trigger'?'def work(value):\n    return value + 1\n':'def work(value, mode):\n    return value\n');const head=await f.commit();
 const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{...model,policy:'final_only',promptVersion:1}});
 const graph=await SqliteCodeGraph.open(store);graph.graph.close();
 const requests=[],prior=globalThis.fetch;const abort=new AbortController();
 globalThis.fetch=async(url,init)=>{
  const body=await new Request(url,init).json();requests.push(body);const turn=requests.length;
  let actions=[];
  if(turn===1)actions=[call('read_diff',{path:'app.py'}),...(mode==='early-batch'?[empty()]:[])];
  if(turn===2){
   const packs=packages(body);
   if(!['advisory','no-trigger','budget','cancel'].includes(mode))assert.equal(packs.length,1,'actual next HTTP request contains package');
   if(mode==='early-batch')assert.ok(body.messages.some(m=>m.role==='tool'&&String(m.content).includes('CONTEXT_PENDING')));
   if(mode==='cancel')abort.abort(Error('cancelled'));
   actions=[call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2})];
  }
  if(turn===3){
   if(['no-trigger','advisory','oversize'].includes(mode))actions=[empty()];
   else {
    const app=results(body).findLast(r=>r.path==='app.py'&&r._mergewarden?.evidenceRefId),pack=packages(body)[0];
    assert.ok(app);assert.ok(pack.sources.some(s=>s.path==='caller.py'));
    const host=pack.sources.find(s=>s.path==='caller.py');
    actions=[call('submit_review',{summary:'Scripted evidence selection; no semantic benchmark.',reviewedPaths:['app.py'],findings:[{id:'f',title:'Missing required argument',claim:'caller passes one argument to the changed two-argument callable',trigger:'caller()',impact:'TypeError',severity:'high',evidence:[{evidenceRefId:app._mergewarden.evidenceRefId},...(mode==='omit'?[]:[{evidenceRefId:host.evidenceRefId}])]}]})];
   }
  }
  const delta=actions.length?{role:'assistant',tool_calls:actions.map((a,i)=>({index:i,id:`dispatch_${turn}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Done.'};
  return new Response(`data: ${JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:model.modelId,choices:[{index:0,delta,finish_reason:actions.length?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 };t.after(()=>globalThis.fetch=prior);
 const catalog=await createModelRuntime(model.provider,'offline-key');let runDir;
 const engine=new ReviewEngine(async options=>{
  runDir=options.runDir;
  if(mode==='host-persistence'){
   const dispatch=options.routing.dispatch,original=dispatch.setRecorder.bind(dispatch);
   dispatch.setRecorder=record=>original(e=>{if(e.type==='context_delivered')throw Error('disk fault');record(e)});
  }
  const runtime=await createPiRuntime(options,catalog);
  if(mode==='final-persistence'){const append=runtime.journal.append.bind(runtime.journal);runtime.journal.append=async e=>{if(e.payload.type==='final_batch.accepted')throw Error('disk fault');return append(e)}}
  return runtime;
 });
 const options={repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model,signal:abort.signal,maxToolCalls:mode==='budget'?2:30,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:mode==='advisory'?'advisory':'dispatch_v1'}};
 if(['final-persistence','host-persistence'].includes(mode)){await assert.rejects(engine.run(options),/persistence failed/);return;}
 const result=await engine.run(options),manifest=JSON.parse(await readFile(join(runDir,'run.json'),'utf8')),jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');
 const rows=jsonl.trim().split('\n').map(JSON.parse),trace=decodePiTrace(jsonl);
 assert.equal(manifest.metrics.graph.buildMs,0);assert.equal(manifest.metrics.graphToolCalls,0);
 assert.equal(trace.calls.filter(c=>['search_entity','traverse_graph'].includes(c.name)).length,0);
 if(['budget','cancel','host-persistence'].includes(mode)){assert.notEqual(result.report.status,'completed');return;}
 assert.equal(result.report.status,'completed');
 if(mode==='advisory'){assert.equal(manifest.metrics.dispatch,undefined);assert.equal(packages(requests[1]).length,0);return;}
 if(mode==='no-trigger'){assert.equal(manifest.metrics.dispatch.operations.executed,0);assert.equal(manifest.metrics.graph.calls,0);return;}
 assert.equal(manifest.metrics.dispatch.packagesDelivered,1);
 assert.equal(manifest.metrics.dispatch.graphBackendRequests,2);assert.equal(manifest.metrics.dispatch.sourceReads,1);
 assert.equal(rows.filter(r=>r.customType==='mergewarden-structural-context-v1').length,1);
 if(mode==='oversize'){assert.equal(packages(requests[1])[0].sources.length,0);return;}
 assert.deepEqual(result.report.findings[0].evidence.map(e=>e.path),mode==='omit'?['app.py']:['app.py','caller.py']);
 assert.ok(result.report.findings[0].evidence.every(e=>e.contentSha256));
 const analysis=analyzeDispatch({runId:result.runId,runKey:mode,snapshotId:store.manifest.identity.id,findings:result.report.findings,jsonl});
 assert.equal(analysis.host_dispatched_structural_assistance,mode==='omit'?0:1);assert.equal(analysis.model_selected_graph_assistance,0);
 if(mode==='normal'){
  const removed=rows.filter(r=>!(r.type==='custom_message'&&r.customType==='mergewarden-structural-context-v1'));
  const absent=analyzeDispatch({runId:result.runId,runKey:mode,snapshotId:store.manifest.identity.id,findings:result.report.findings,jsonl:removed.map(JSON.stringify).join('\n')});assert.equal(absent.host_dispatched_structural_assistance,0);
  const corrupt=structuredClone(rows);const message=corrupt.find(r=>r.type==='custom_message'&&r.customType==='mergewarden-structural-context-v1');message.content=message.content.replace('return work(1)','return work(2)');
  assert.equal(analyzeDispatch({runId:result.runId,runKey:mode,snapshotId:store.manifest.identity.id,findings:result.report.findings,jsonl:corrupt.map(JSON.stringify).join('\n')}).host_dispatched_structural_assistance,0);
 }
 if(mode==='early-batch')assert.equal(trace.calls.filter(c=>c.name==='submit_review').length,2);
}
for(const mode of ['normal','early-batch','no-trigger','advisory','omit','oversize','budget','cancel','host-persistence','final-persistence'])test('dispatch real Pi HTTP + Engine + prepared graph: '+mode,t=>run(t,mode));
