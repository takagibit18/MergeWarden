import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createModelRuntime,createPiRuntime} from '../src/runtime.ts';
import {ReviewEngine} from '../../../src/engine/review.ts';
import {SnapshotStore} from '../../../src/snapshot/store.ts';
import {SqliteCodeGraph} from '../../../src/graph/sqlite-store.ts';
import {repositoryFixture} from '../../../tests/repository-fixture.mjs';
import {analyzeRetrieval} from '../../../src/experiments/locagent/traces.ts';
import {readReport,history} from '../../../src/engine/reports.ts';
const {createAssistantMessageEventStream}=await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
const model={provider:'fixture',modelId:'offline'};
const tool=(name,args)=>({name,args});
const visible=context=>context.messages.filter(m=>m.role==='toolResult').flatMap(m=>{try{return [JSON.parse(m.content[0].text)];}catch{return [];}});
const source=path=>tool('read_source',{revision:'head',path,startLine:1,endLine:20});
async function fixture(t,mode){
 const f=await repositoryFixture(t,{'app.py':'def convert(value):\n    return value\n','caller.py':'from app import convert\ndef call():\n    return convert(1)\n'});
 await f.write('app.py',mode==='omit'?'def convert(value, mode=None):\n    return 1 / 0\n':'def convert(value, mode):\n    return value\n');const head=await f.commit();
 const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{...model,policy:'final_only',promptVersion:1}});
 const prepared=await SqliteCodeGraph.open(store);prepared.graph.close();
 const submission=(context,invalid=false)=>{
  const pages=visible(context),app=pages.findLast(p=>p.path==='app.py'&&p._mergewarden?.evidenceRefId),caller=pages.findLast(p=>p.path==='caller.py'&&p._mergewarden?.evidenceRefId);
  assert.ok(app);assert.ok(caller);
  const evidence=[{evidenceRefId:app._mergewarden.evidenceRefId},...(mode==='omit'?[]:[{evidenceRefId:invalid?'ev_'+'f'.repeat(64):caller._mergewarden.evidenceRefId}])];
  return tool('submit_review',{summary:'Scripted contract plumbing only; no quality estimate.',reviewedPaths:['app.py'],findings:[{id:'contract',title:mode==='omit'?'Unconditional division by zero':'Required argument breaks caller',claim:mode==='omit'?'The changed body divides by zero for every input.':'Untouched call() passes only value while convert now requires mode.',trigger:mode==='omit'?'convert(1)':'call()',impact:'exception',severity:'high',evidence}]});
 };
 const steps=[tool('read_diff',{path:'app.py'})];
 if(mode==='text-first')steps.push(tool('search_text',{revision:'head',query:'convert'}));
 steps.push(tool('search_entity',{searchTerms:['convert'],topK:1}),c=>{
  const root=visible(c).findLast(r=>r.items?.some(i=>i.name==='convert')).items.find(i=>i.name==='convert').entityId;
  return tool('traverse_graph',{startEntities:[root],direction:'upstream',maxHops:2,entityTypeFilter:['function'],relationTypeFilter:['CALLS'],maxNodes:10});
 });
 if(mode==='graph-error')steps.push(tool('search_text',{revision:'head',query:'convert'}));
 steps.push(source('caller.py'),source('app.py'));
 if(mode==='retry')steps.push(c=>submission(c,true));
 if(mode==='bad-args')steps.push(tool('submit_review',[]));
 steps.push(c=>submission(c));
 const catalog=await createModelRuntime('fixture','offline');let turn=0,atomicAttempts=0,runDir;
 catalog.registerProvider('fixture',{api:'openai-completions',baseUrl:'https://offline.invalid',apiKey:'offline',models:[{id:'offline',name:'offline',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:2048}],streamSimple(m,c){
  const step=steps[turn++],action=typeof step==='function'?step(c):step;
  const content=action?[{type:'toolCall',id:'contract-'+turn,name:action.name,arguments:action.args}]:[{type:'text',text:'Done'}];
  const message={role:'assistant',api:m.api,provider:m.provider,model:m.id,content,timestamp:Date.now(),stopReason:action?'toolUse':'stop',usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;
 }});
 const engine=new ReviewEngine(async options=>{
  runDir=options.runDir;
  const tools=options.tools.map(t=>t.name!=='traverse_graph'?t:{...t,async execute(input){
   if(mode==='graph-error')throw Error('Injected Graph query error');
   const r=await t.execute(input);return mode==='partial'?{...r,status:'partial',generationState:'partial',coverage:{...r.coverage,generationState:'partial'}}:r;
  }});
  const runtime=await createPiRuntime({...options,tools},catalog),append=runtime.journal.append.bind(runtime.journal);
  runtime.journal.append=async e=>{if(e.payload.type==='final_batch.accepted'){atomicAttempts++;if(mode==='persistence-before')throw Error('Injected persistence fault');if(mode==='persistence-after'){await append(e);throw Error('Injected acknowledgement fault');}}await append(e);};
  return runtime;
 });
 const options={repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v2_investigate'}};
 if(mode.startsWith('persistence')){
  await assert.rejects(engine.run(options),/persistence failed/);assert.equal(atomicAttempts,1);
  const rows=(await readFile(join(runDir,'session.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const accepted=rows.filter(r=>r.data?.payload?.type==='final_batch.accepted');assert.equal(accepted.length,mode==='persistence-after'?1:0);
  const [manifest]=await history(f.state);assert.equal(manifest.status,'delivery_failed');await assert.rejects(readReport(f.state,manifest.runId),/no confirmed/);return;
 }
 const result=await engine.run(options),jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');
 assert.equal(result.report.status,'completed');assert.equal(atomicAttempts,1);assert.deepEqual(await readReport(f.state,result.runId),result.report);
 const manifest=JSON.parse(await readFile(join(runDir,'run.json'),'utf8'));assert.equal(manifest.metrics.graph.buildMs,0);
 const analysis=analyzeRetrieval({runKey:mode,snapshotId:result.report.snapshot.id,findings:result.report.findings,jsonl});
 assert.equal(analysis.findings[0].discoveryPath,['omit','text-first','graph-error'].includes(mode)?'text_only':'graph_assisted');
 assert.equal(analysis.findings[0].coverageLimited,mode==='partial');
 assert.deepEqual(result.report.findings[0].evidence.map(e=>e.path),mode==='omit'?['app.py']:['app.py','caller.py']);
 assert.ok(result.report.findings[0].evidence.every(e=>/^[a-f0-9]{64}$/.test(e.contentSha256)));assert.doesNotMatch(JSON.stringify(result.report),/evidenceRefId/);
 assert.equal(analysis.metrics.submissionAttempts,['retry','bad-args'].includes(mode)?2:1);assert.equal(analysis.metrics.submissionValidationFailures,['retry','bad-args'].includes(mode)?1:0);
 const entries=jsonl.trim().split('\n').map(JSON.parse);assert.equal(entries.filter(r=>r.data?.payload?.type==='final_batch.accepted').length,1);
 assert.equal(entries.filter(r=>r.data?.payload?.type==='candidates.submitted').length,0);
 const acceptedCall=analysis.calls.find(c=>c.name==='submit_review'&&c.response?.accepted);assert.ok(acceptedCall.args.findings[0].evidence.every(e=>e.evidenceRefId));
 for(const call of analysis.calls.filter(c=>!c.isError&&c.response))assert.ok(JSON.parse(entries.find(r=>r.message?.toolCallId===call.id).message.content[0].text)._mergewarden);
}
for(const [name,mode] of [['E2E-1 selected IDs survive report and structural attribution','normal'],['E2E-2 unknown ID correction recovers without poisoned attribution','retry'],['E2E-3 unselected Graph source is never automatically attached','omit'],['E2E-4 earlier text discovery is not Graph novel','text-first'],['E2E-5 partial definite edge remains positive and coverage limited','partial'],['E2E-6 Graph error allows text fallback and business completion','graph-error'],['E2E-7 persistence before write prevents completed delivery','persistence-before'],['E2E-7 persistence after write prevents duplicate acceptance','persistence-after']])test(name,t=>fixture(t,mode));
test('E2E-8 malformed SDK argument shape recovers and preserves accepted attribution',t=>fixture(t,'bad-args'));
