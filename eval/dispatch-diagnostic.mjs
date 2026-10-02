/** No live provider, labels or audit input. Replay a frozen observation prefix through real Pi/Engine. */
import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {ReviewEngine} from '../src/engine/review.ts';
import {createPiRuntime,createModelRuntime} from '../integrations/pi/src/runtime.ts';
import {graphCacheDir,graphPublishPath,publishedGraphPath} from '../src/graph/sqlite-store.ts';
import {decodePiTrace} from '../src/eval/provenance/decode.ts';
import {DISPATCH_LIMITS} from '../src/engine/dispatch-contracts.ts';
const [datasetArg,outputArg,...ids]=process.argv.slice(2);
if(!datasetArg||!outputArg||!ids.length)throw Error('Usage: dispatch-diagnostic.mjs DATASET EXTERNAL_OUTPUT CASE_ID...');
const dataset=resolve(datasetArg),output=resolve(outputArg),sourceState=join(dataset,'state'),state=join(output,'state');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const save=async(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const copy=async(from,to)=>{await mkdir(dirname(to),{recursive:true});await copyFile(from,to)};
await mkdir(output,{recursive:true});
const cases=await read(join(dataset,'cases.json')),files=await readdir(join(dataset,'raw-runs')),plan=[];
for(const id of ids){
 const c=cases.find(c=>c.id===id);if(!c)throw Error('Unknown fixed case '+id);
 const file=files.find(n=>n.endsWith(`-${id}-C.result.json`));if(!file)throw Error('Missing historical routed run');
 const previous=await read(join(dataset,'raw-runs',file)),runRoot=join(sourceState,'runs',previous.runId);
 const native=await readFile(join(runRoot,'session.jsonl'),'utf8'),rows=native.trim().split('\n').map(JSON.parse),trace=decodePiTrace(native);
 if(trace.issues.some(x=>x.severity==='fatal'))throw Error('Invalid prefix timeline');
 const activation=rows.find(r=>r.customType==='mergewarden-structural-routing-v1'&&r.data?.metrics?.activated)?.data.ordinal;
 const actions=trace.calls.slice(0,activation).filter(c=>['read_diff','read_source','search_text'].includes(c.name)).map(c=>({name:c.name,args:c.args}));
 const snapshotPath=join(sourceState,'snapshots',c.snapshotId+'.json'),snapshot=await read(snapshotPath),database=await publishedGraphPath(sourceState,c.snapshotId),published=graphPublishPath(sourceState,c.snapshotId);
 if(digest(await readFile(snapshotPath))!==c.snapshotManifestSha256||digest(await readFile(database))!==c.graphDatabaseSha256)throw Error('Frozen snapshot/graph drift');
 await copy(snapshotPath,join(state,'snapshots',c.snapshotId+'.json'));
 const hashes=[...new Set([...Object.values(snapshot.base),...Object.values(snapshot.head)].filter(f=>f.status==='text').map(f=>f.hash))];
 for(let i=0;i<hashes.length;i+=32)await Promise.all(hashes.slice(i,i+32).map(h=>copy(join(sourceState,'blobs',h),join(state,'blobs',h))));
 await copy(published,graphPublishPath(state,c.snapshotId));await copy(database,join(graphCacheDir(state,c.snapshotId),relative(graphCacheDir(sourceState,c.snapshotId),database)));
 await copy(join(runRoot,'run.json'),join(state,'runs',previous.runId,'run.json'));
 const manifest=await read(join(runRoot,'run.json'));
 plan.push({id,repositoryPath:c.repositoryPath,snapshotId:c.snapshotId,generationId:c.generationId,base:c.base,head:c.head,
  previousRunId:previous.runId,model:manifest.model,prefixSha256:digest(JSON.stringify(actions)),nativeSha256:digest(native),actions,
  expectedFirstActivation:activation??null,graphSha256:c.graphDatabaseSha256,snapshotSha256:c.snapshotManifestSha256});
}
await save('protocol.json',{version:'dispatch-diagnostic-1',kind:'offline-scripted-http-no-model',limits:DISPATCH_LIMITS,
 routing:'pi_structural_v2_investigate',arms:['advisory','dispatch_v1'],liveCalls:0,selection:'Existing C observation prefix through first activation; all read-only observations for untriggered controls. No audit or target paths.',cases:plan});
const all=[];
for(const c of plan)for(const strategy of ['advisory','dispatch_v1']){
 const requests=[],prior=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  const body=await new Request(url,init).json();requests.push(body);const action=c.actions[requests.length-1];
  const delta=action?{role:'assistant',tool_calls:[{index:0,id:'prefix_'+requests.length,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]}:{role:'assistant',content:'Offline prefix replay ends here; no semantic judgment or final submission.'};
  return new Response(`data: ${JSON.stringify({id:'scripted',object:'chat.completion.chunk',created:1,model:c.model.modelId,choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 };
 let record;
 try{
  const catalog=await createModelRuntime(c.model.provider,'offline-scripted-key');
  const review=await new ReviewEngine(o=>createPiRuntime(o,catalog)).run({repositoryPath:c.repositoryPath,stateDir:state,rerunId:c.previousRunId,model:c.model,maxToolCalls:100,
   evaluation:{tools:'text+locagent',routing:'pi_structural_v2_investigate',executionStrategy:strategy,graphMode:'prepared_only'}});
  const runRoot=join(state,'runs',review.runId),manifest=await read(join(runRoot,'run.json')),native=await readFile(join(runRoot,'session.jsonl'),'utf8'),rows=native.trim().split('\n').map(JSON.parse);
  const packages=rows.filter(r=>r.type==='custom_message'&&r.customType==='mergewarden-structural-context-v1').map(r=>JSON.parse(r.content));
  record={caseId:c.id,strategy,runId:review.runId,snapshotId:c.snapshotId,generationId:c.generationId,metrics:manifest.metrics,packages,
   providerRequests:requests.length,semanticJudgment:'not_run',liveCalls:0,reviewStatus:review.report.status,
   operations:rows.filter(r=>r.type==='custom'&&r.customType==='mergewarden-host-dispatch-v1').map(r=>r.data)};
  await save(`${c.id}-${strategy}-provider-requests.json`,requests);
 }catch(error){record={caseId:c.id,strategy,error:String(error),liveCalls:0};}
 finally{globalThis.fetch=prior;}
 all.push(record);await save(`${c.id}-${strategy}.json`,record);
 console.log(JSON.stringify({caseId:c.id,strategy,triggered:record.metrics?.routing?.triggered,terminals:record.metrics?.dispatch?.terminals,error:record.error}));
}
await save('results.json',all);
for(const c of plan){
 if(digest(await readFile(await publishedGraphPath(sourceState,c.snapshotId)))!==c.graphSha256||digest(await readFile(join(sourceState,'snapshots',c.snapshotId+'.json')))!==c.snapshotSha256)throw Error('Original frozen artifacts mutated');
}
await save('frozen-artifact-check.json',{unchanged:true,cases:plan.map(c=>c.id)});
