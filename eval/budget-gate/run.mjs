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
import {budgetPayload,canonicalPackage} from './contracts.mjs';
const out=resolve(process.argv[2]),offline=process.argv.includes('--offline'),destination=offline?join(out,'preflight'):out;
const config=await read(join(out,'run-config.json')),freeze=await read(join(out,'input-freeze.json')),input=await read(join(out,'public/D1.json')),c=input.case,priorPack=await read(join(out,'public/prior-package.json'));
assert(process.permission);for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false);for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256);
assert.deepEqual(config.runOrder,[{id:'D1',arm:'A'},{id:'D1',arm:'B'}]);assert.equal(config.maxTokens,32768);
if(!offline){const preflight=await read(join(out,'mechanical-preflight.json'));assert.equal(preflight.status,'PASS');assert.equal(preflight.realProviderRequests,0);}
const key=offline?'offline-preflight-key':process.env.MERGEWARDEN_API_KEY;assert(key?.trim());const model=await createModelRuntime(config.model.provider,key),originalFetch=globalThis.fetch,completed=[];
await save(join(destination,'run-started.json'),{experiment:config.identity,execution:config.execution,startedAt:new Date().toISOString(),firstAttemptOnly:true,offline});
for(const job of config.runOrder){
 const arm=join(destination,job.arm==='A'?'arm-a-text':'arm-b-graph'),raw=join(arm,'raw/D1'),expected=await read(join(out,'public',`prior-request-${job.arm}.json`));
 await save(join(raw,'attempt.json'),{...job,attempt:1,startedAt:new Date().toISOString(),offline});
 const started=performance.now(),transport=[],observers=[],toolExecutions=[],extensionErrors=[],requestInvariants=[];let requests=0,payloads=0,runDir,pack,result=null,error=null,lastRequestHash,fetchFailed=false;
 const redact=e=>String(e?.stack??e).split(key).join('[REDACTED]');
 const now=()=>performance.now()-started;
 // Observe a cloned response. Never alter the bytes or stream consumed by Pi.
 async function observe(response,ordinal){
  const reader=response.body?.getReader(),decoder=new TextDecoder(),timing={ordinal,firstToolDelta:null,finishEvents:[],usageEvents:[],streamComplete:false},chunks=[];let pending='',streamError=null;
  const inspect=line=>{if(!line.startsWith('data: ')||line==='data: [DONE]')return;try{const v=JSON.parse(line.slice(6)),elapsedMs=now();for(const ch of v.choices??[]){if(ch.delta?.tool_calls?.length&&!timing.firstToolDelta)timing.firstToolDelta={elapsedMs,toolName:ch.delta.tool_calls[0].function?.name??null};if(ch.finish_reason)timing.finishEvents.push({elapsedMs,finish_reason:ch.finish_reason});}if(v.usage)timing.usageEvents.push({elapsedMs,usage:v.usage});}catch{}};
  try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;const text=decoder.decode(value,{stream:true});chunks.push(text);pending+=text;let i;while((i=pending.indexOf('\n'))>=0){inspect(pending.slice(0,i).replace(/\r$/,''));pending=pending.slice(i+1);}}const end=decoder.decode();chunks.push(end);pending+=end;if(pending)inspect(pending);timing.streamComplete=true;}catch(e){streamError=redact(e);}
  const body=chunks.join('');assert(!body.includes(key));const suffix=String(ordinal).padStart(3,'0');await save(join(raw,`response-${suffix}.json`),{ordinal,status:response.status,body,elapsedMs:now(),streamError});await save(join(raw,`stream-timing-${suffix}.json`),timing);
 }
 let offlineTurn=0;const store=offline?await SnapshotStore.load(c.state,c.snapshotId):null,offlineDiffs=[];
 if(offline)for(const path of c.changedPaths){let cursor=0;do{const p=await store.diff(path,cursor,200);offlineDiffs.push({name:'read_diff',args:{path,cursor,limit:200}});if(!p.truncated)break;cursor=p.nextCursor;}while(true);}
 async function scripted(body){
  offlineTurn++;let calls=[];if(offlineTurn===1)calls=offlineDiffs;
  if(offlineTurn===2)calls=job.arm==='B'?[{name:'expand_structural_candidate',args:{candidateRefId:pack.investigations[0].candidateCatalog.find(card=>card.candidateRefId!==pack.sources[0]?.candidateRefId).candidateRefId}}]:[{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}];
  if(offlineTurn===3)calls=[{name:'read_source',args:{revision:'head',path:c.changedPaths[0],startLine:1,endLine:2}}];
  if(offlineTurn===4){const refs=body.messages.filter(m=>m.role==='tool').flatMap(m=>{try{const r=JSON.parse(m.content);return r._mergewarden?.evidenceRefId?[{evidenceRefId:r._mergewarden.evidenceRefId}]:[];}catch{return [];}});const evidence=[...new Map(refs.map(r=>[r.evidenceRefId,r])).values()];assert(evidence.length);calls=[{name:'submit_review',args:{summary:'SYNTHETIC MECHANICAL PREFLIGHT ONLY',reviewedPaths:c.changedPaths,findings:[{id:'synthetic-only',title:'Synthetic evidence assertion',claim:'Not a semantic assessment',trigger:'Offline preflight',impact:'No defect claim',severity:'low',evidence}]}}];}
  const delta=calls.length?{role:'assistant',tool_calls:calls.map((a,i)=>({index:i,id:`offline_${offlineTurn}_${i}`,type:'function',function:{name:a.name,arguments:JSON.stringify(a.args)}}))}:{role:'assistant',content:'Offline preflight complete.'};
  return new Response(`data: ${JSON.stringify({id:'offline',object:'chat.completion.chunk',created:1,model:config.model.modelId,choices:[{index:0,delta,finish_reason:calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
 }
 globalThis.fetch=async(url,init)=>{
  assert(!fetchFailed,'Frozen zero-retry policy');const req=new Request(url,init);assert.equal(req.url,config.endpoint);const body=await req.clone().json(),fingerprint=hash(body);assert.notEqual(fingerprint,lastRequestHash);lastRequestHash=fingerprint;
  const ordinal=++requests;assert.equal(payloads,requests);assert(ordinal<=config.maxToolCalls+3);await save(join(raw,`request-${String(ordinal).padStart(3,'0')}.json`),body);
  try{const response=offline?await scripted(body):await originalFetch(url,init);transport.push({ordinal,status:response.status,headersReceivedMs:now()});if(!response.ok)fetchFailed=true;observers.push(observe(response.clone(),ordinal));return response;}catch(e){fetchFailed=true;transport.push({ordinal,error:redact(e),elapsedMs:now()});throw e;}
 };
 try{
  const engine=new ReviewEngine(async options=>{
   runDir=options.runDir;
   const tools=options.tools.map(tool=>({...tool,async execute(...args){const event={toolName:tool.name,args:args[0],requestIndex:requests,turnIndex:requests,elapsedMs:now()};toolExecutions.push(event);if(toolExecutions.length===1)console.log(JSON.stringify({arm:job.arm,event:'first_tool_execution',tool:tool.name,latencyMs:event.elapsedMs,offline}));return tool.execute(...args);}}));
   return microRuntime({...options,tools},model,{...input,arm:job.arm,config:{...config,maxTokens:8192},onPackage:async p=>{assert.deepEqual(canonicalPackage(p),canonicalPackage(priorPack));pack=p;await save(join(arm,'context-packages/D1.json'),p);await save(join(arm,'candidate-catalogs/D1.json'),p.investigations.flatMap(i=>i.candidateCatalog));},onPayload:async payload=>{requestInvariants.push(budgetPayload(payload,{expected,pack,priorPack,state:c.state,previousState:config.previousState,first:payloads===0}));payloads++;},onExtensionError:e=>extensionErrors.push(redact(e))});
  });
  result=await engine.run({repositoryPath:c.repositoryPath,stateDir:c.state,rerunId:c.seedId,model:config.model,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,evaluation:job.arm==='A'?{tools:'text-only'}:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}});
 }catch(e){error=redact(e);}finally{globalThis.fetch=originalFetch;const observed=await Promise.allSettled(observers);for(const o of observed)if(o.status==='rejected')error=redact(o.reason);}
 let manifest=null,trace=null,attribution=null;if(runDir){manifest=await read(join(runDir,'run.json'));let jsonl;try{jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');}catch{}
  if(jsonl){await mkdir(join(arm,'traces'),{recursive:true});await copyFile(join(runDir,'session.jsonl'),join(arm,'traces/D1.jsonl'));trace=decodePiTrace(jsonl);await save(join(arm,'traces/D1.json'),trace);attribution=analyzeInvestigation({runId:manifest.runId,snapshotId:c.snapshotId,findings:result?.report?.findings??[],jsonl});}}
 const mechanicalBlocker=!!(error||extensionErrors.length||transport.some(t=>t.error||t.status!==200)||trace?.issues.some(i=>i.severity==='fatal')||(job.arm==='B'&&(!pack||manifest?.metrics?.dispatch?.packagesDelivered!==1)));
 await save(join(raw,'instrumentation.json'),{toolExecutions,requestInvariants,offline});await save(join(raw,'result.json'),{...job,attempt:1,result,error,extensionErrors,manifest,requests,transport,latencyMs:now(),mechanicalBlocker,attribution,offline});
 await save(join(arm,'submissions/D1.json'),{status:result?.report?.status??'FAILED',submissions:trace?.calls.filter(c=>c.name==='submit_review')??[],findings:result?.report?.findings??[]});
 const row={...job,status:result?.report?.status??'FAILED',path:join(raw,'result.json'),mechanicalBlocker,requests,runId:manifest?.runId};completed.push(row);console.log(JSON.stringify(row));
 if(offline){assert.equal(mechanicalBlocker,false);assert.equal(result.report.status,'completed');assert.equal(requests,5);if(job.arm==='B')assert.equal(attribution.model_expanded_structural_assistance,1);}
 if(mechanicalBlocker)break;
}
await save(join(destination,'runs-completed.json'),{completed,allFirstAttemptsFinished:true,notRun:config.runOrder.filter(j=>!completed.some(c=>c.id===j.id&&c.arm===j.arm)),completedAt:new Date().toISOString(),offline});
if(offline){assert.equal(completed.length,2);await save(join(out,'mechanical-preflight.json'),{status:'PASS',realProviderRequests:0,rows:completed,observerOnly:true,firstRequestsComparedWithPredecessor:true});}
