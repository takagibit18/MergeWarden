import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createModelRuntime} from '../src/runtime.ts';
import {ReviewEngine} from '../../../src/engine/review.ts';
import {SnapshotStore} from '../../../src/snapshot/store.ts';
import {SqliteCodeGraph} from '../../../src/graph/sqlite-store.ts';
import {repositoryFixture} from '../../../tests/repository-fixture.mjs';
import {buildUnits} from '../../../eval/intent-router/input.mjs';
import {microRuntime} from '../../../eval/microeval/runtime.mjs';
import {publicPrompt,publicPrefix} from '../../../eval/microeval/common.mjs';
import {analyzeInvestigation} from '../../../src/eval/provenance/investigation.ts';
const model={provider:'bigmodel',modelId:'glm-5.3-flash'},config={model,temperature:0,top_p:1,thinking:{type:'enabled',clear_thinking:false},maxTokens:8192};
const parse=body=>body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
const strings=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
for(const arm of ['A','B','failure','isolated'])test('pre-registered Pi main loop: '+arm,async t=>{
 const f=await repositoryFixture(t,{'app.py':'def work(value):\n    return value\n','caller.py':'from app import work\ndef caller():\n    return work(1)\n','second.py':'from app import work\ndef second():\n    return work(2)\n'});
 await f.write('app.py','def work(value, mode):\n    return value\n');const head=await f.commit();
 const store=await SnapshotStore.freeze({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},configuration:{...model,policy:'final_only',promptVersion:1}}),graph=await SqliteCodeGraph.open(store);
 const prefix=publicPrefix({snapshotId:store.manifest.identity.id,changedPaths:['app.py'],observations:[{toolName:'read_diff',input:{path:'app.py'},result:await store.diff('app.py')}]});
 graph.graph.close();
 // Resolve through the prepared LocAgent view, exactly as admission does.
 const {DatabaseSync}=await import('node:sqlite'),{publishedGraphPath,readGraphEntities}=await import('../../../src/graph/sqlite-store.ts');
 const db=new DatabaseSync(await publishedGraphPath(f.state,store.manifest.identity.id),{readOnly:true}),entities=readGraphEntities(db,store.manifest.identity.id);db.close();
 const unit=buildUnits(prefix,entities).units[0],c={id:'fixture',snapshotId:store.manifest.identity.id,generationId:graph.graph.generationId,changedPaths:['app.py'],unit,intent:'CALLER_CHECK'};
 // generation is read from the immutable graph publication, not guessed.
 const {graphPublishPath}=await import('../../../src/graph/sqlite-store.ts');c.generationId=JSON.parse(await readFile(graphPublishPath(f.state,c.snapshotId),'utf8')).generationId;
 if(arm==='isolated'){
  const seed='00000000-0000-4000-8000-000000000001';await mkdir(join(f.state,'runs',seed),{recursive:true});await writeFile(join(f.state,'runs',seed,'run.json'),JSON.stringify({schemaVersion:1,runId:seed,snapshotId:c.snapshotId,referenceOnly:true}));
  const file=join(f.state,'isolated-input.json');await writeFile(file,JSON.stringify({case:c,prefix,prompt:publicPrompt(c,prefix),config,deniedAncestor:dirname(f.state),options:{repositoryPath:f.repository,stateDir:f.state,rerunId:seed,maxToolCalls:30}}));
  const repo=resolve(import.meta.dirname,'../../..'),child=spawnSync(process.execPath,['--experimental-strip-types','--permission','--allow-worker','--allow-fs-read='+repo,'--allow-fs-read='+f.state,'--allow-fs-read='+f.repository,'--allow-fs-write='+f.state,join(import.meta.dirname,'fixtures/isolated-microeval.mjs'),file],{encoding:'utf8'});
  assert.equal(child.status,0,child.stdout+child.stderr);assert.equal(JSON.parse(await readFile(join(f.state,'isolated-result.json'),'utf8')).status,'PASS');return;
 }
 let requests=0,runDir,pack,selected;const prior=globalThis.fetch;globalThis.fetch=async(url,init)=>{
  const body=await new Request(url,init).json();requests++;assert.equal(body.temperature,0);assert.equal(body.top_p,1);
  if(arm==='failure')return new Response(JSON.stringify({error:{message:'fixture failure'}}),{status:500,headers:{'Content-Type':'application/json'}});
  const call=(name,args)=>({name,args});let actions=[];
  if(requests===1){assert(strings(body.messages).some(s=>s.includes('Frozen public observations')));
   if(arm==='B'){assert(pack);assert(strings(body.messages).some(s=>s.includes(JSON.stringify(pack))));selected=pack.investigations[0].candidateCatalog.find(c=>c.candidateRefId!==pack.sources[0].candidateRefId);assert(selected);}
   actions=[call('read_diff',{path:'app.py'})];
  }else if(requests===2)actions=[arm==='B'?call('expand_structural_candidate',{candidateRefId:selected.candidateRefId}):call('read_source',{revision:'head',path:'caller.py',startLine:2,endLine:3})];
  else if(requests===3)actions=[call('read_source',{revision:'head',path:'app.py',startLine:1,endLine:2})];
  else if(requests===4)actions=[call('submit_review',{summary:'Offline mechanical fixture',reviewedPaths:['app.py'],findings:[{id:'f',title:'Missing required argument',claim:'Caller supplies one argument',trigger:'caller()',impact:'TypeError',severity:'high',evidence:parse(body).filter(r=>r._mergewarden?.evidenceRefId).map(r=>({evidenceRefId:r._mergewarden.evidenceRefId}))}]})];
  const delta=actions.length?{role:'assistant',tool_calls:actions.map((a,i)=>({index:i,id:`micro_${requests}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Done'};
  return new Response(`data: ${JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:model.modelId,choices:[{index:0,delta,finish_reason:actions.length?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 };t.after(()=>globalThis.fetch=prior);
 const catalog=await createModelRuntime(model.provider,'offline-key'),actualArm=arm==='B'?'B':'A';
 const engine=new ReviewEngine(async options=>{runDir=options.runDir;return microRuntime(options,catalog,{case:c,prefix,prompt:publicPrompt(c,prefix),arm:actualArm,config,onPackage:p=>{pack=p;},onExtensionError:e=>console.error(e)});});
 const result=await engine.run({repositoryPath:f.repository,stateDir:f.state,input:{kind:'commits',base:f.base,head},model,maxToolCalls:30,evaluation:actualArm==='B'?{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}:{tools:'text-only'}});
 if(requests===0)assert.fail((await readFile(join(runDir,'session.jsonl'),'utf8')).slice(-5000));
 if(arm==='failure'){assert.equal(requests,1);assert.equal(result.report.status,'failed');return;}
 assert.equal(result.report.status,'completed',(await readFile(join(runDir,'session.jsonl'),'utf8')).slice(-2000));const manifest=JSON.parse(await readFile(join(runDir,'run.json'),'utf8'));assert.equal(manifest.metrics.graphToolCalls,0);assert.equal(manifest.metrics.routing,undefined);
 if(arm==='B'){const jsonl=await readFile(join(runDir,'session.jsonl'),'utf8'),a=analyzeInvestigation({runId:result.runId,snapshotId:c.snapshotId,findings:result.report.findings,jsonl});assert.equal(a.packagesDelivered,1);assert.equal(a.model_expanded_structural_assistance,1);}
 else assert.equal(manifest.metrics.dispatch,undefined);
});
