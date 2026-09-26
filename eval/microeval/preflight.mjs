import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {ReviewEngine} from '../../src/engine/review.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {analyzeInvestigation} from '../../src/eval/provenance/investigation.ts';
import {microRuntime} from './runtime.mjs';
import {read,save,hash} from './common.mjs';
const out=resolve(process.argv[2]),config=await read(join(out,'run-config.json')),freeze=await read(join(out,'input-freeze.json'));
assert(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);
for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256);
const model=await createModelRuntime(config.model.provider,'offline-preflight-key'),rows=[];
const strings=x=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
for(const job of config.runOrder){
 const input=await read(config.cases.find(c=>c.id===job.id).path),c=input.case,store=await SnapshotStore.load(c.state,c.snapshotId),actions=[];
 for(const path of c.changedPaths){let cursor=0;do{const p=await store.diff(path,cursor,200);actions.push({name:'read_diff',args:{path,cursor,limit:200}});if(!p.truncated)break;cursor=p.nextCursor;}while(true);}
 let pack,requests=0,runDir,selected;const errors=[];
 globalThis.fetch=async(url,init)=>{
  const body=await new Request(url,init).json();requests++;assert.equal(new URL(url).href,config.endpoint);assert.equal(body.temperature,config.temperature);assert.equal(body.top_p,config.top_p);
  if(job.arm==='B')assert(strings(body.messages).some(s=>s.includes(JSON.stringify(pack))));
  let calls=[];
  if(requests===1)calls=actions;
  if(requests===2){if(job.arm==='B'){selected=pack.investigations[0].candidateCatalog.find(card=>card.candidateRefId!==pack.sources[0]?.candidateRefId);assert(selected);calls=[{name:'expand_structural_candidate',args:{candidateRefId:selected.candidateRefId}}];}else calls=[{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}];}
  if(requests===3)calls=[{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}];
  if(requests===4){
   const refs=body.messages.filter(m=>m.role==='tool').flatMap(m=>{try{const r=JSON.parse(m.content);return r._mergewarden?.evidenceRefId?[{evidenceRefId:r._mergewarden.evidenceRefId}]:[];}catch{return [];}});
   const evidence=[...new Map(refs.map(r=>[r.evidenceRefId,r])).values()];assert(evidence.length>0);
   calls=[{name:'submit_review',args:{summary:'SYNTHETIC MECHANICAL PREFLIGHT ONLY — no semantic judgment.',reviewedPaths:c.changedPaths,findings:[{id:'mechanical-only',title:'Synthetic evidence transport assertion',claim:'Test payload, not a defect assessment',trigger:'Offline preflight',impact:'No semantic claim',severity:'low',evidence}]}}];
  }
  const delta=calls.length?{role:'assistant',tool_calls:calls.map((a,i)=>({index:i,id:`preflight_${requests}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Offline preflight complete.'};
  return new Response(`data: ${JSON.stringify({id:'offline-preflight',object:'chat.completion.chunk',created:1,model:config.model.modelId,choices:[{index:0,delta,finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 };
 const engine=new ReviewEngine(async options=>{runDir=options.runDir;return microRuntime(options,model,{...input,arm:job.arm,config,onPackage:p=>{pack=p;},onExtensionError:e=>errors.push(e)});});
 const result=await engine.run({repositoryPath:c.repositoryPath,stateDir:c.state,rerunId:c.seedId,model:config.model,timeoutMs:120000,maxToolCalls:100,evaluation:job.arm==='B'?{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}:{tools:'text-only'}});
 assert.deepEqual(errors,[]);assert.equal(result.report.status,'completed');assert.equal(requests,5);
 const jsonl=await readFile(join(runDir,'session.jsonl'),'utf8'),a=analyzeInvestigation({runId:result.runId,snapshotId:c.snapshotId,findings:result.report.findings,jsonl});
 if(job.arm==='B'){assert.equal(a.packagesDelivered,1);assert.equal(a.model_expanded_structural_assistance,1);}
 const runManifest=await read(join(runDir,'run.json'));assert.equal(runManifest.metrics.graphToolCalls,0);if(job.arm==='A')assert.equal(runManifest.metrics.graph.calls,0);
 rows.push({...job,status:'PASS',synthetic:true,realProviderRequests:0,runId:result.runId,runDir,requests,attribution:a,traceSha256:hash(jsonl)});
}
await save(join(out,'mechanical-preflight.json'),{status:'PASS',realProviderRequests:0,privateReadsDenied:true,rows});console.log(JSON.stringify({status:'PASS',arms:rows.length,realProviderRequests:0}));
