import assert from 'node:assert/strict';
import {readFile,copyFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {zstdDecompressSync} from 'node:zlib';
import {ReviewEngine} from '../../src/engine/review.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {createOAuthModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {microRuntime} from '../microeval/runtime.mjs';
import {read,save,hash} from '../microeval/common.mjs';
const out=resolve(process.argv[2]),authPath=resolve(process.argv[3]),offline=process.argv.includes('--offline'),destination=offline?join(out,'preflight'):join(out,'live');
const config=await read(join(out,'run-config.json')),freeze=await read(join(out,'input-freeze.json'));
assert(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);
async function checkFreeze(){for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256,'Frozen input drift: '+f.path);}
await checkFreeze();
if(offline){const access=`e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline'}})).toString('base64')}.offline`;await save(authPath,{'openai-codex':{type:'oauth',access,refresh:'offline',expires:Date.now()+3600000}});}
else {const gate=await read(join(out,'mechanical-preflight.json'));assert.equal(gate.status,'PASS');assert.equal(gate.inputFreezeHash,hash(freeze));}
const catalog=await createOAuthModelRuntime(config.model.provider,authPath),originalFetch=globalThis.fetch,originalSocket=globalThis.WebSocket;
assert.equal(catalog.getModel(config.model.provider,config.model.modelId).api,'openai-codex-responses');
const completed=[];await save(join(destination,'started.json'),{at:new Date().toISOString(),offline});
for(const job of config.runOrder){
 await checkFreeze();const input=await read(config.cases.find(c=>c.id===job.id).path),c=input.case,raw=join(destination,job.id+'-'+job.arm);
 await save(join(raw,'attempt.json'),{...job,attempt:1,at:new Date().toISOString(),offline});
 const started=performance.now(),calls=[],payloads=[],extensionErrors=[];let result,error,runDir,pack,offlineTurn=0;
 const emit=event=>console.log(JSON.stringify({...job,offline,...event}));emit({event:'started'});
 if(offline){
  globalThis.WebSocket=undefined;
  const store=await SnapshotStore.load(c.state,c.snapshotId),diffs=[];
  for(const path of c.changedPaths){let cursor=0;do{const page=await store.diff(path,cursor,200);diffs.push({name:'read_diff',args:{path,cursor,limit:200}});if(!page.truncated)break;cursor=page.nextCursor;}while(true);}
  globalThis.fetch=async(url,init)=>{
   const req=new Request(url,init);assert.equal(req.url,'https://chatgpt.com/backend-api/codex/responses');
   const bytes=Buffer.from(await req.arrayBuffer()),body=JSON.parse((req.headers.get('content-encoding')==='zstd'?zstdDecompressSync(bytes):bytes).toString());assert.equal(body.reasoning.effort,'high');
   offlineTurn++;const selected=pack?.investigations.flatMap(i=>i.candidateCatalog).find(card=>card.candidateRefId!==pack.sources[0]?.candidateRefId);
   const actions=offlineTurn===1?diffs:offlineTurn===2?[job.arm==='B'&&selected?{name:'expand_structural_candidate',args:{candidateRefId:selected.candidateRefId}}:{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}]:offlineTurn===3?[{name:'submit_review',args:{summary:'SYNTHETIC PROTOCOL PREFLIGHT ONLY',reviewedPaths:c.changedPaths,findings:[]}}]:[];
   const output=actions.map((a,i)=>({type:'function_call',id:`fc_${offlineTurn}_${i}`,call_id:`call_${offlineTurn}_${i}`,name:a.name,arguments:JSON.stringify(a.args),status:'completed'}));
   if(!output.length)output.push({type:'message',id:'msg_done',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done.',annotations:[]}]});
   const events=output.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item},{type:'response.output_item.done',output_index,item}]);events.push({type:'response.completed',response:{id:`resp_${offlineTurn}`,status:'completed',output,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
   return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  };
 }
 try{
  const engine=new ReviewEngine(async options=>{
   runDir=options.runDir;
   const tools=options.tools.map(tool=>({...tool,async execute(args){const row={ordinal:calls.length+1,name:tool.name,startedMs:performance.now()-started,status:'running'};calls.push(row);emit({event:'tool',name:tool.name,ordinal:row.ordinal});
    try{const value=await tool.execute(args);row.status=value?.status==='error'?'error':'returned';return value;}catch(e){row.status='threw';throw e;}finally{row.endedMs=performance.now()-started;}}}));
   const runtime=await microRuntime({...options,tools},catalog,{...input,arm:job.arm,config,onPackage:async p=>{pack=p;await save(join(raw,'context-package.json'),p);},
    validatePayload(p,names){assert.equal(p.reasoning.effort,'high');assert.deepEqual(p.tools.map(t=>t.name).sort(),names);assert.equal(p.temperature,undefined);assert.equal(p.top_p,undefined);},
    onPayload:async p=>{payloads.push({ordinal:payloads.length+1,sha256:hash(p),atMs:performance.now()-started});await save(join(raw,`request-${payloads.length}.json`),p);emit({event:'request',ordinal:payloads.length});},onExtensionError:()=>extensionErrors.push('Pi extension error; inspect native session')});
   const configuration=runtime.configuration;return {...runtime,configuration:()=>({...configuration(),authentication:{type:'oauth'}})};
  });
  result=await engine.run({repositoryPath:c.repositoryPath,stateDir:c.state,rerunId:c.seedId,model:config.model,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,
   evaluation:job.arm==='B'?{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}:{tools:'text-only'}});
 }catch{error='Run failed; inspect native session if present';}finally{globalThis.fetch=originalFetch;globalThis.WebSocket=originalSocket;}
 let manifest=null,rows=[];if(runDir){manifest=await read(join(runDir,'run.json'));const log=await readFile(join(runDir,'session.jsonl'),'utf8');rows=log.trim().split(/\r?\n/).map(JSON.parse);await mkdir(raw,{recursive:true});await copyFile(join(runDir,'session.jsonl'),join(raw,'session.jsonl'));}
 const audits=rows.filter(r=>r.customType==='mergewarden.provider-request.v1').map(r=>r.data),messages=rows.filter(r=>r.type==='message').map(r=>r.message),assistants=messages.filter(m=>m.role==='assistant');
 const auditMatches=audits.length===payloads.length&&audits.every((a,i)=>a.sha256===payloads[i].sha256);
 const usageComplete=assistants.length===payloads.length&&assistants.every(m=>m.stopReason!=='error'&&m.stopReason!=='aborted'&&m.usage?.totalTokens>0);
 const errors=messages.filter(m=>m.role==='toolResult'&&m.isError);
 const metric={...job,offline,runId:manifest?.runId,status:result?.report?.status??'failed',latencyMs:performance.now()-started,requests:payloads.length,toolCalls:manifest?.metrics?.toolExecuted??null,hostObservedCalls:calls.length,findings:result?.report?.findings.length??0,usage:manifest?.usage??null,usageComplete,nativeToolErrors:errors.length,requestAuditMatches:auditMatches,packagesDelivered:manifest?.metrics?.dispatch?.packagesDelivered??0,extensionErrors,outputTokenLimitEnforced:false};
 metric.mechanicalBlocker=!!error||extensionErrors.length>0||!auditMatches||metric.toolCalls!==calls.length||manifest?.status!=='delivered'||metric.status==='failed'||(job.arm==='B'&&metric.packagesDelivered!==1);
 await save(join(raw,'result.json'),{result,error,manifest});await save(join(raw,'metrics.json'),metric);await save(join(raw,'observations.json'),{calls,payloads});
 completed.push(metric);emit({event:'finished',...metric});if(metric.mechanicalBlocker)break;
}
await checkFreeze();await save(join(destination,'completed.json'),{completed,at:new Date().toISOString(),inputFreezeVerified:true});
if(offline){assert.equal(completed.length,3);assert(completed.every(m=>m.status==='completed'&&!m.mechanicalBlocker&&m.usageComplete));await save(join(out,'mechanical-preflight.json'),{status:'PASS',inputFreezeHash:hash(freeze),realProviderRequests:0});}
