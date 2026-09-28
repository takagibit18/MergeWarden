import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createModelRuntime,createPiRuntime} from '../src/runtime.ts';
import {ReviewEngine} from '../../../src/engine/review.ts';
import {SnapshotStore} from '../../../src/snapshot/store.ts';
import {SqliteCodeGraph} from '../../../src/graph/sqlite-store.ts';
import {repositoryFixture} from '../../../tests/repository-fixture.mjs';
import {analyzeInvestigation} from '../../../src/eval/provenance/investigation.ts';
const model={provider:'bigmodel',modelId:'glm-5.3-flash'};
const strings=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
const packages=body=>strings(body.messages).flatMap(s=>{const i=s.indexOf('{"version":"structural-dispatch-2"');if(i<0)return [];try{return [JSON.parse(s.slice(i,s.lastIndexOf('}')+1))]}catch{return []}});
const results=body=>body.messages.filter(m=>m.role==='tool').flatMap(m=>{try{return [JSON.parse(m.content)]}catch{return []}});
for(const mode of ['expanded','early-batch','forged','expansion-persistence']) test('v2 native Pi HTTP / Engine evidence boundary: '+mode,async t=>{
 const f=await repositoryFixture(t,{'app.py':'def work(value):\n    return value\n','caller.py':'from app import work\ndef caller():\n    return work(1)\n','second.py':'from app import work\ndef second():\n    return work(2)\n'});
 await f.write('app.py','def work(value, mode):\n    return value\n');const head=await f.commit();
 const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{...model,policy:'final_only',promptVersion:1}});
 const graph=await SqliteCodeGraph.open(store);graph.graph.close();
 const requests=[],prior=globalThis.fetch;let selected,runDir;
 globalThis.fetch=async(url,init)=>{
  const body=await new Request(url,init).json();requests.push(body);const turn=requests.length;
  const names=body.tools.map(t=>t.function.name);assert.ok(names.includes('expand_structural_candidate'));assert.ok(!names.includes('search_entity'));assert.ok(!names.includes('traverse_graph'));
  let actions=[];
  const call=(name,args)=>({name,args});const empty=()=>call('submit_review',{summary:'Offline fixture',reviewedPaths:['app.py'],findings:[]});
  if(turn===1)actions=[call('read_diff',{path:'app.py'}),...(mode==='early-batch'?[empty()]:[])];
  if(turn===2){
   const pack=packages(body)[0];assert.ok(pack);assert.equal(pack.sources.length,1);assert.equal(pack.investigations[0].candidateCatalog.length,2);
   if(mode==='early-batch')assert.ok(results(body).some(r=>r.message?.includes('CONTEXT_PENDING')));
   selected=pack.investigations[0].candidateCatalog.find(c=>c.candidateRefId!==pack.sources[0].candidateRefId);
   actions=[call('expand_structural_candidate',{candidateRefId:mode==='forged'?'cand_forged':selected.candidateRefId})];
  }
  if(turn===3){
   if(mode==='forged'){assert.ok(results(body).some(r=>r.message?.includes('Unknown or undelivered')));actions=[empty()];}
   else {assert.ok(results(body).some(r=>r.path===selected.entity.path&&r._mergewarden?.evidenceRefId));actions=[call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2})];}
  }
  if(turn===4&&mode!=='forged'){
   const evidence=results(body).filter(r=>r._mergewarden?.evidenceRefId).map(r=>({evidenceRefId:r._mergewarden.evidenceRefId}));
   actions=[call('submit_review',{summary:'Offline mechanical evidence fixture',reviewedPaths:['app.py'],findings:[{id:'f',title:'Missing argument',claim:'Caller supplies one argument',trigger:'second()',impact:'TypeError',severity:'high',evidence}]})];
  }
  const delta=actions.length?{role:'assistant',tool_calls:actions.map((a,i)=>({index:i,id:`v2_${turn}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Done'};
  return new Response(`data: ${JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:model.modelId,choices:[{index:0,delta,finish_reason:actions.length?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 };t.after(()=>globalThis.fetch=prior);
 const catalog=await createModelRuntime(model.provider,'offline-key');
 const engine=new ReviewEngine(async options=>{runDir=options.runDir;
  if(mode==='expansion-persistence'){const service=options.routing.dispatch,original=service.setRecorder.bind(service);service.setRecorder=record=>original(e=>{if(e.type==='candidate_expanded')throw Error('disk fault');record(e)});}
  return createPiRuntime(options,catalog);
 });
 const options={repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model,maxToolCalls:30,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}};
 if(mode==='expansion-persistence'){await assert.rejects(engine.run(options),/persistence failed/);return;}
 const result=await engine.run(options),manifest=JSON.parse(await readFile(join(runDir,'run.json'),'utf8'));
 assert.equal(result.report.status,'completed');assert.equal(manifest.metrics.dispatch.packagesDelivered,1);
 assert.equal(manifest.metrics.dispatch.candidateExpansionReads,mode==='forged'?0:1);assert.equal(manifest.metrics.graphToolCalls,0);
 if(mode!=='forged')assert.ok(result.report.findings[0].evidence.some(e=>e.path===selected.entity.path));
 const jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');
 const attributed=analyzeInvestigation({runId:result.runId,snapshotId:store.manifest.identity.id,findings:result.report.findings,jsonl});
 assert.equal(attributed.model_expanded_structural_assistance,mode==='forged'?0:1);assert.equal(attributed.host_prefetched_structural_assistance,0);
 const corrupt=jsonl.replaceAll('return work(2)','return work(3)');
 if(mode!=='forged')assert.equal(analyzeInvestigation({runId:result.runId,snapshotId:store.manifest.identity.id,findings:result.report.findings,jsonl:corrupt}).model_expanded_structural_assistance,0);
});
