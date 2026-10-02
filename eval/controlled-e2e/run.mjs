import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile,mkdir,copyFile} from 'node:fs/promises';
import {ReviewEngine} from '../../src/engine/review.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {decodePiTrace} from '../../src/eval/provenance/decode.ts';
import {analyzeInvestigation} from '../../src/eval/provenance/investigation.ts';
import {microRuntime} from '../microeval/runtime.mjs';
import {read,save,hash} from '../microeval/common.mjs';
import {observeResponse,usageSummary,blockerReasons,errorDetails,reconcileRequests} from './observe.mjs';
const out=resolve(process.argv[2]),offline=process.argv.includes('--offline'),destination=offline?join(out,'preflight'):out;
const config=await read(join(out,'run-config.json')),freeze=await read(join(out,'input-freeze.json'));
assert(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);
async function checkFreeze(){for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256,'Frozen file changed: '+f.path);}
await checkFreeze();assert(config.runOrder.length>0&&config.runOrder.length<=6);assert.equal(config.runOrder.length,config.maxRuns);assert.equal(config.thinkingLevel,'low');
if(!offline){const preflight=await read(join(out,'mechanical-preflight.json'));assert.equal(preflight.status,'PASS');assert.equal(preflight.realProviderRequests,0);assert.equal(preflight.inputFreezeHash,hash(freeze));}
const key=offline?'offline-preflight-key':process.env.MERGEWARDEN_API_KEY;assert(key?.trim());
const model=await createModelRuntime(config.model.provider,key),originalFetch=globalThis.fetch,completed=[];
await save(join(destination,'run-started.json'),{startedAt:new Date().toISOString(),firstAttemptOnly:true,offline,inputFreezeHash:hash(freeze)});
for(const job of config.runOrder){
 await checkFreeze();const input=await read(config.cases.find(c=>c.id===job.id).path),c=input.case;
 const arm=join(destination,job.arm==='A'?'arm-a-text':'arm-b-graph'),raw=join(arm,'raw',job.id);
 await save(join(raw,'attempt.json'),{...job,attempt:1,startedAt:new Date().toISOString(),offline});
 const started=performance.now(),now=()=>performance.now()-started,transport=[],observers=[],responses=[],observerErrors=[],toolExecutions=[],extensionErrors=[],payloadHashes=[],wireHashes=[],observerAbort=new AbortController();
 const redact=e=>String(e?.stack??e).split(key).join('[REDACTED]');
 let requests=0,runDir,pack,result=null,error=null,fetchFailed=false;
 const emit=event=>console.log(JSON.stringify({...job,...event,offline}));emit({event:'run_started'});
 let offlineTurn=0;const offlineDiffs=[];
 if(offline){const store=await SnapshotStore.load(c.state,c.snapshotId);for(const path of c.changedPaths){let cursor=0;do{const p=await store.diff(path,cursor,200);offlineDiffs.push({name:'read_diff',args:{path,cursor,limit:200}});if(!p.truncated)break;cursor=p.nextCursor;}while(true);}}
 async function scripted(body){
  offlineTurn++;let calls=[];if(offlineTurn===1)calls=offlineDiffs;
  if(offlineTurn===2){const card=pack?.investigations.flatMap(i=>i.candidateCatalog).find(card=>card.candidateRefId!==pack.sources[0]?.candidateRefId);
   calls=job.arm==='B'&&card?[{name:'expand_structural_candidate',args:{candidateRefId:card.candidateRefId}}]:[{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}];}
  if(offlineTurn===3)calls=[{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}];
  if(offlineTurn===4){const refs=body.messages.filter(m=>m.role==='tool').flatMap(m=>{try{const r=JSON.parse(m.content);return r._mergewarden?.evidenceRefId?[{evidenceRefId:r._mergewarden.evidenceRefId}]:[];}catch{return [];}});const evidence=[...new Map(refs.map(r=>[r.evidenceRefId,r])).values()];assert(evidence.length);
   calls=[{name:'submit_review',args:{summary:'SYNTHETIC MECHANICAL PREFLIGHT ONLY',reviewedPaths:c.changedPaths,findings:[{id:'synthetic-only',title:'Synthetic evidence assertion',claim:'Not a semantic assessment',trigger:'Offline preflight',impact:'No defect claim',severity:'low',evidence}]}}];}
  const delta=calls.length?{role:'assistant',tool_calls:calls.map((a,i)=>({index:i,id:`offline_${offlineTurn}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Offline preflight complete.'};
  return new Response(`data: ${JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:config.model.modelId,choices:[{index:0,delta,finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,completion_tokens_details:{reasoning_tokens:0}}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 }
 globalThis.fetch=async(url,init)=>{
  assert(!fetchFailed,'Zero-retry policy');const req=new Request(url,init);assert.equal(req.url,config.endpoint);
  const body=await req.clone().json(),fingerprint=hash(body),ordinal=++requests,suffix=String(ordinal).padStart(3,'0');
  assert.equal(payloadHashes.length,requests);assert.equal(payloadHashes.at(-1),fingerprint);assert(!wireHashes.includes(fingerprint),'Duplicate request is forbidden');wireHashes.push(fingerprint);assert(ordinal<=config.maxToolCalls+3);
  const requestStartedMs=now();await save(join(raw,`request-${suffix}.json`),body);
  emit({event:'request_started',ordinal,elapsedMs:requestStartedMs});
  try{const response=offline?await scripted(body):await originalFetch(url,init);
   transport.push({ordinal,status:response.status,requestStartedMs,headersReceivedMs:now(),requestBytes:Buffer.byteLength(JSON.stringify(body)),historyMessages:body.messages.length,payloadHash:fingerprint});
   if(!response.ok)fetchFailed=true;
   observers.push(observeResponse(response.clone(),{ordinal,now,requestStartedMs,redact,signal:observerAbort.signal}).then(async r=>{
    assert(!r.body.includes(key));await save(join(raw,`response-${suffix}.json`),r);responses.push(r);
    emit({event:'response_observed',ordinal,firstToolDeltaMs:r.firstToolDeltaMs,finish:r.finishEvents.at(-1)?.reason??null,outputTokens:r.usageEvents.at(-1)?.usage?.completion_tokens??null,streamComplete:r.streamComplete});
   }).catch(e=>{observerErrors.push(redact(e));}));return response;
  }catch(e){fetchFailed=true;transport.push({ordinal,requestStartedMs,error:redact(e),errorDetails:errorDetails(e,redact),elapsedMs:now()});throw e;}
 };
 try{
  const engine=new ReviewEngine(async options=>{
   runDir=options.runDir;
   const tools=options.tools.map(tool=>({...tool,async execute(...args){const event={ordinal:toolExecutions.length+1,toolName:tool.name,args:args[0],requestIndex:requests,startedMs:now(),endedMs:null,status:'running'};toolExecutions.push(event);
    emit({event:'tool_started',tool:tool.name,ordinal:event.ordinal,elapsedMs:event.startedMs});
    try{const value=await tool.execute(...args);event.status=value?.status==='error'?'error':'returned';event.businessStatus=value?.status??null;event.outcome=value?.outcome??null;event.resultHash=hash(value);return value;}
    catch(e){event.status='threw';event.error=redact(e);throw e;}finally{event.endedMs=now();event.durationMs=event.endedMs-event.startedMs;}
   }}));
   return microRuntime({...options,tools},model,{...input,arm:job.arm,config,onPackage:async p=>{pack=p;await save(join(arm,'context-packages',job.id+'.json'),p);},onPayload:async p=>{assert.equal(p.reasoning_effort,'low');payloadHashes.push(hash(p));},onExtensionError:e=>extensionErrors.push(redact(e))});
  });
  result=await engine.run({repositoryPath:c.repositoryPath,stateDir:c.state,rerunId:c.seedId,model:config.model,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,evaluation:job.arm==='A'?{tools:'text-only'}:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}});
 }catch(e){error=redact(e);}finally{
  globalThis.fetch=originalFetch;const timer=setTimeout(()=>observerAbort.abort(),5000);await Promise.allSettled(observers);clearTimeout(timer);
 }
 let manifest=null,trace=null,attribution=null,audits=[],jsonl='';
 if(runDir){try{manifest=await read(join(runDir,'run.json'));jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');}catch(e){error??=redact(e);}
  if(jsonl){await mkdir(join(arm,'traces'),{recursive:true});await copyFile(join(runDir,'session.jsonl'),join(arm,'traces',job.id+'.jsonl'));trace=decodePiTrace(jsonl);await save(join(arm,'traces',job.id+'.json'),trace);
   attribution=analyzeInvestigation({runId:manifest?.runId,snapshotId:c.snapshotId,findings:result?.report?.findings??[],jsonl});audits=jsonl.trim().split(/\r?\n/).map(l=>JSON.parse(l)).filter(e=>e.type==='custom'&&e.customType==='mergewarden.provider-request.v1').map(e=>e.data);}}
 const requestReconciliation=reconcileRequests(audits,wireHashes),auditMatches=requestReconciliation.matches;
 const blockers=blockerReasons({error,extensionErrors,transport,responses,trace,arm:job.arm,manifest,pack,auditMatches,observerErrors});
 const budgetExpired=result?.report?.status==='partial'&&result.report.summary==='Review time budget exhausted';
 if(responses.some(r=>r.streamError)&&!budgetExpired)blockers.push('stream_interrupted');
 if(manifest?.status!=='delivered')blockers.push('report_not_delivered');
 if(responses.length!==transport.filter(t=>t.status).length)blockers.push('missing_response_observation');
 const calls=trace?.calls??[],executed=calls.filter(c=>c.resultEvent!==undefined),submissions=calls.filter(c=>c.name==='submit_review');
 const observer={requestAuditMatches:auditMatches,requestReconciliation,requestsCaptured:wireHashes.length,responsesCaptured:responses.length,toolExecutions:toolExecutions.length,nativeToolCalls:calls.length,nativeToolResults:executed.length,observerErrors};
 const metrics={...job,offline,status:result?.report?.status??'failed',summary:result?.report?.summary??error,runId:manifest?.runId,latencyMs:now(),requests,firstToolExecutionMs:toolExecutions[0]?.startedMs??null,firstToolDeltaMs:responses.map(r=>r.firstToolDeltaMs).filter(x=>x!==null).sort((a,b)=>a-b)[0]??null,
  toolCalls:calls.length,toolErrors:executed.filter(c=>c.isError||c.response?.status==='error').length,tools:Object.fromEntries([...new Set(calls.map(c=>c.name))].map(n=>[n,calls.filter(c=>c.name===n).length])),submitAttempts:submissions.length,submissionOutcomes:submissions.map(c=>({isError:c.isError,response:c.response})),findings:result?.report?.findings.length??0,reportDelivered:manifest?.status==='delivered',packagesDelivered:manifest?.metrics?.dispatch?.packagesDelivered??0,modelExpanded:attribution?.model_expanded_structural_assistance??0,usage:usageSummary(responses,requests),observer,mechanicalBlocker:blockers.length>0,blockers};
 await save(join(raw,'instrumentation.json'),{toolExecutions,transport,audits,payloadHashes,wireHashes,offline});
 await save(join(raw,'result.json'),{...job,attempt:1,result,error,extensionErrors,manifest,requests,transport,latencyMs:now(),attribution,offline});
 await save(join(raw,'metrics.json'),metrics);await save(join(arm,'submissions',job.id+'.json'),{status:metrics.status,submissions,findings:result?.report?.findings??[]});
 const row={...job,status:metrics.status,path:join(raw,'metrics.json'),mechanicalBlocker:metrics.mechanicalBlocker,blockers,requests,runId:manifest?.runId};completed.push(row);emit({event:'run_finished',...row,latencyMs:metrics.latencyMs,toolCalls:metrics.toolCalls});
 if(offline){assert.equal(metrics.mechanicalBlocker,false,JSON.stringify(blockers));assert.equal(metrics.status,'completed');assert.equal(requests,5);assert.equal(metrics.usage.complete,true);assert.equal(auditMatches,true);assert.equal(toolExecutions.length,calls.length);assert.equal(executed.length,calls.length);}
 if(metrics.mechanicalBlocker)break;
}
await checkFreeze();const notRun=config.runOrder.filter(j=>!completed.some(c=>c.id===j.id&&c.arm===j.arm));
await save(join(destination,'runs-completed.json'),{completed,allFirstAttemptsFinished:notRun.length===0,batchStopped:notRun.length>0,notRun,completedAt:new Date().toISOString(),offline,inputFreezeVerified:true});
if(offline){assert.equal(completed.length,config.runOrder.length);await save(join(out,'mechanical-preflight.json'),{status:'PASS',realProviderRequests:0,syntheticProviderResponses:completed.length*5,rows:completed,inputFreezeHash:hash(freeze)});}
