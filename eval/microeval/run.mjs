import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFile,copyFile,mkdir} from 'node:fs/promises';
import {ReviewEngine} from '../../src/engine/review.ts';
import {createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {decodePiTrace} from '../../src/eval/provenance/decode.ts';
import {analyzeInvestigation} from '../../src/eval/provenance/investigation.ts';
import {read,save,hash,identity} from './common.mjs';
import {microRuntime} from './runtime.mjs';
const out=resolve(process.argv[2]),freeze=await read(join(out,'input-freeze.json')),config=await read(join(out,'run-config.json'));
assert(process.permission,'Public runner requires filesystem isolation');
for(const p of freeze.denied)assert.equal(process.permission.has('fs.read',p),false,'Private path accessible');
for(const f of freeze.files)assert.equal(hash(await readFile(f.path)),f.sha256,'Frozen input drift: '+f.path);
if(process.argv.includes('--preflight')){console.log(JSON.stringify({preflight:'PASS',filesVerified:freeze.files.length,privateReadsDenied:freeze.denied.length,modelRequests:0}));process.exit(0);}
const key=process.env.MERGEWARDEN_API_KEY;assert(key?.trim(),'Explicit API key missing');
const modelRuntime=await createModelRuntime(config.model.provider,key),originalFetch=globalThis.fetch,completed=[];
await save(join(out,'run-started.json'),{startedAt:new Date().toISOString(),runCount:config.runOrder.length,firstAttemptOnly:true});
for(const job of config.runOrder){
 const entry=config.cases.find(c=>c.id===job.id),input=await read(entry.path),armDir=join(out,job.arm==='A'?'arm-a-text':'arm-b-graph'),rawDir=join(armDir,'raw',job.id);
 await mkdir(rawDir,{recursive:true});await save(join(rawDir,'attempt.json'),{...job,attempt:1,startedAt:new Date().toISOString()});
 let runDir,pack,requests=0,payloads=0,error=null,result=null,lastRequestHash,fetchFailed=false;const responses=[],transport=[];
 const started=performance.now(),extensionErrors=[];
 globalThis.fetch=async(url,init)=>{
  assert.equal(fetchFailed,false,'Retry after transport failure forbidden');
  const request=new Request(url,init);assert.equal(request.url,config.endpoint);const body=await request.clone().json(),h=hash(body);
  assert.notEqual(h,lastRequestHash,'Duplicate provider request / retry forbidden');lastRequestHash=h;
  const ordinal=++requests;assert(ordinal<=config.maxToolCalls+3);assert.equal(payloads,requests);
  await save(join(rawDir,`request-${String(ordinal).padStart(3,'0')}.json`),body);
  const t=performance.now();try{
   const response=await originalFetch(url,init);transport.push({ordinal,status:response.status,headersReceivedMs:performance.now()-t});
   if(!response.ok)fetchFailed=true;
   responses.push(response.clone().text().then(async text=>{assert(!text.includes(key),'Credential unexpectedly returned by provider');await save(join(rawDir,`response-${String(ordinal).padStart(3,'0')}.json`),{ordinal,status:response.status,body:text,elapsedMs:performance.now()-t});}).catch(async e=>{await save(join(rawDir,`response-error-${ordinal}.json`),{error:String(e.message).split(key).join('[REDACTED]')});}));
   return response;
  }catch(e){fetchFailed=true;transport.push({ordinal,error:String(e.message).split(key).join('[REDACTED]'),elapsedMs:performance.now()-t});throw e;}
 };
 try{
  const engine=new ReviewEngine(async options=>{runDir=options.runDir;return microRuntime(options,modelRuntime,{...input,arm:job.arm,config,onPackage:async p=>{pack=p;await save(join(armDir,'context-packages',job.id+'.json'),p);await save(join(armDir,'candidate-catalogs',job.id+'.json'),p.investigations.flatMap(i=>i.candidateCatalog));},onPayload:async()=>{payloads++;},onExtensionError:e=>extensionErrors.push(JSON.parse(JSON.stringify(e).split(key).join('[REDACTED]')))});});
  result=await engine.run({repositoryPath:input.case.repositoryPath,stateDir:input.case.state,rerunId:input.case.seedId,model:config.model,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,evaluation:job.arm==='A'?{tools:'text-only'}:{tools:'text+locagent',graphMode:'prepared_only',routing:'pi_structural_v1',executionStrategy:'dispatch_v2'}});
  assert.equal(result.kind,'report');assert.equal(result.report.snapshot.id,input.case.snapshotId);
 }catch(e){error=String(e.stack??e).split(key).join('[REDACTED]');}
 finally{globalThis.fetch=originalFetch;await Promise.allSettled(responses);}
 let manifest=null,jsonl='',trace=null,attribution=null;
 if(runDir){manifest=await read(join(runDir,'run.json'));try{jsonl=await readFile(join(runDir,'session.jsonl'),'utf8');}catch{}
  if(jsonl){await mkdir(join(armDir,'traces'),{recursive:true});await copyFile(join(runDir,'session.jsonl'),join(armDir,'traces',job.id+'.jsonl'));trace=decodePiTrace(jsonl);attribution=analyzeInvestigation({runId:manifest.runId,snapshotId:input.case.snapshotId,findings:result?.report?.findings??[],jsonl});}
 }
 const mechanical=job.arm==='B'&&(error!==null||extensionErrors.length>0||!pack||manifest?.metrics?.dispatch?.packagesDelivered!==1||trace?.calls.some(c=>c.name==='expand_structural_candidate'&&c.isError&&pack.investigations.some(i=>i.candidateCatalog.some(card=>card.candidateRefId===c.args.candidateRefId))));
 const row={...job,attempt:1,result,error,extensionErrors,manifest,requests,transport,latencyMs:performance.now()-started,mechanicalBlocker:!!mechanical,attribution};
 await save(join(armDir,'submissions',job.id+'.json'),{status:result?.report?.status??'FAILED',submissions:trace?.calls.filter(c=>c.name==='submit_review')??[],findings:result?.report?.findings??[]});
 await save(join(rawDir,'result.json'),row);if(trace)await save(join(armDir,'traces',job.id+'.json'),trace);
 completed.push({id:job.id,arm:job.arm,path:join(rawDir,'result.json'),status:result?.report?.status??'FAILED',mechanicalBlocker:!!mechanical});
 console.log(JSON.stringify(completed.at(-1)));
}
await save(join(out,'runs-completed.json'),{completed,allFirstAttemptsFinished:true,completedAt:new Date().toISOString()});
