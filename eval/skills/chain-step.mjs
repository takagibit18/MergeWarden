// Sandboxed chain worker (review | learn); launched by chain.mjs with private labels unreadable.
import assert from 'node:assert/strict';
import {readFile,readdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ReviewEngine} from '../../src/engine/review.ts';
import {readRun,readReport} from '../../src/engine/reports.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {registerRun,feedback,learnPending} from '../../src/skills/learning.ts';
import {SkillBank} from '../../src/skills/bank.ts';
import {createOAuthModelRuntime,createPiRuntime} from '../../integrations/pi/src/runtime.ts';
import {runPiLearning} from '../../integrations/pi/src/learning.ts';
import {sha256,writeJson} from '../../src/infrastructure/files.ts';
const [dir,auth,action,...rest]=process.argv.slice(2).map((v,i)=>i<2?resolve(v):v),read=async p=>JSON.parse(await readFile(p,'utf8'));
const ex=await read(join(dir,'experiment.json')),repo=resolve(import.meta.dirname,'../..');
assert(process.permission);assert.equal(process.permission.has('fs.read',join(dir,'private')),false,'Private labels must stay unreadable');
// eval/real holds the hidden corpus, so the parent verifies those receipts and the worker cannot read them.
// Relearned banks (B2, B3, ...) run under the code locked when that bank was learned.
const lockedBank=action==='relearn'?rest[0]:action==='review'&&/^B[0-9]+$/.test(rest[0])?rest[0]:null;
const receipt=lockedBank?(await read(join(dir,'relearn',lockedBank,'lock.json'))).code:ex.code;
for(const f of receipt.filter(f=>!f.path.startsWith('eval/real/')))assert.equal(sha256(await readFile(join(repo,f.path))),f.sha256,'Code drift: '+f.path);
const caseOf=id=>{const c=ex.cases.find(c=>c.caseId===id);assert(c,'Unknown case '+id);return c;};
if(action==='check'){for(const c of ex.cases)for(const arm of ['A','B'])assert.equal(sha256(await readFile(await publishedGraphPath(join(dir,arm),c.snapshotId))),c.graphSha256);console.log('PASS: code, graphs and private-label denial');process.exit(0);}
const modelRuntime=await createOAuthModelRuntime(ex.model.provider,auth);
if(action==='review'){
 // A result file exists only for a review outcome. Provider/runtime failures go to failed/ so a resume repeats the step.
 const [arm,caseId,tag,replayOf]=rest,c=caseOf(caseId),state=join(dir,arm),path=join(dir,'reviews',`${caseId}-${arm}-${tag}.json`),failed=join(dir,'failed',`${caseId}-${arm}-${tag}-${Date.now()}.json`);
 await assert.rejects(readFile(path),{code:'ENOENT'},'Review result already exists');
 const started=performance.now();
 try{
  assert.equal(sha256(await readFile(await publishedGraphPath(state,c.snapshotId))),c.graphSha256);
  const skills=arm==='A'?'off':replayOf?'replay':'auto';
  const result=await new ReviewEngine(options=>createPiRuntime(options,modelRuntime,{extensions:[],firstAttemptOnly:true,preserveRouting:true})).run({repositoryPath:c.repositoryPath,stateDir:state,rerunId:replayOf??c.seedId,model:ex.model,inference:ex.inference,timeoutMs:ex.timeoutMs,maxToolCalls:ex.maxToolCalls,skills,learn:'off',skillRepositoryKey:c.skillRepositoryKey,evaluation:{...ex.evaluation,contextCwd:join(dir,'context')}});
  assert.equal(result.kind,'report');assert.equal(result.report.snapshot.id,c.snapshotId);
  const manifest=await readRun(state,result.runId);await readReport(state,result.runId);const store=await SnapshotStore.load(state,c.snapshotId);
  for(const f of result.report.findings)for(const ev of f.evidence)assert.equal((await store.read(ev)).actualSha256,ev.contentSha256);
  let reads=[];try{reads=await read(join(state,'runs',result.runId,'skill-reads.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const record={caseId,arm,tag,replayOf:replayOf??null,status:result.report.status,termination:manifest.termination??null,runId:result.runId,elapsedMs:performance.now()-started,skills:manifest.skills??null,skillReads:reads,manifest,report:result.report};
  // Budget/time endings are review outcomes; a runtime error (quota, auth, transport) is not.
  if(manifest.termination?.reason==='runtime_error'){
   // The provider reason (quota, expired token) is only in the native session; keep the last one for the stop decision.
   let provider=null;try{for(const line of (await readFile(join(state,'runs',result.runId,'session.jsonl'),'utf8')).split('\n'))if(line.includes('"errorMessage"'))provider=JSON.parse(line).message?.errorMessage??provider;}catch{}
   const error=(manifest.error??provider??'').slice(0,2000);await writeJson(failed,{...record,status:'runtime_error',error});console.error('RUNTIME_ERROR '+error.slice(0,300));process.exitCode=5;}
  else {await writeJson(path,record);console.log(JSON.stringify({event:'review',caseId,arm,tag,status:result.report.status,termination:manifest.termination?.reason,findings:result.report.findings.length,skillsVisible:manifest.skills?.available?.length??0,skillReads:reads.length}));}
 }catch(e){await writeJson(failed,{caseId,arm,tag,status:'execution_error',error:e.message,elapsedMs:performance.now()-started});console.error('EXECUTION_ERROR '+e.message);process.exitCode=5;}
}
else if(action==='learn'){
 // Source registration is idempotent (same digest); a provider failure leaves no result, so a resume retries it.
 const [caseId]=rest,c=caseOf(caseId),state=join(dir,'B'),out=join(dir,'learning',caseId+'.json'),resume=rest.includes('--resume');
 await assert.rejects(readFile(out),{code:'ENOENT'},'Learning result already exists');
 const review=await read(join(dir,'reviews',`${caseId}-B-r0.json`));assert(review.runId&&review.status==='completed');
 const comments=await read(join(dir,'feedback',caseId+'.json'));assert(['VALIDATED','EMPTY'].includes(comments.status));
 const sources=[await registerRun(state,review.runId)];
 for(const f of comments.comments)sources.push((await feedback(state,{runId:review.runId,comment:f.comment,findingId:f.findingId,range:f.range,verdict:f.verdict,eventId:f.eventId},{simulated:true,trustedProjectReviewer:true})).job);
 const learner=runPiLearning(modelRuntime,true),records=[];
 const mine=new Set(sources.map(j=>j.id));
 for(let i=0;i<ex.learningCallsPerCase;i++){
  const jobs=await learnPending(state,learner,{model:ex.model,inference:ex.inference,maxJobs:1,repositoryKey:c.skillRepositoryKey,approval:'auto',retryFailed:resume&&i===0});if(!jobs.length)break;records.push(...jobs);
  console.log(JSON.stringify({event:'learn',caseId,jobs:jobs.map(j=>({id:j.id,status:j.status,error:j.error}))}));
  // Semantic rejections are learning outcomes; an opaque failure is a provider/runtime fault: stop without a result.
  const fault=jobs.find(j=>j.status==='failed'&&j.error==='Learning failed; inspect preserved attempt');
  if(fault){
   let provider='';const attempt=join(state,'skills/attempts',fault.id,String(fault.attempts));
   try{for(const n of await readdir(attempt))if(n.endsWith('.jsonl'))for(const line of (await readFile(join(attempt,n),'utf8')).split('\n'))if(line.includes('"errorMessage"'))provider=JSON.parse(line).message?.errorMessage??provider;}catch{}
   await writeJson(join(dir,'failed',`learn-${caseId}-${Date.now()}.json`),{caseId,status:'learning_runtime_error',job:fault.id,error:provider||fault.error});
   console.error('LEARNING_RUNTIME_FAILURE '+fault.id+' '+provider.slice(0,300));process.exit(5);}
 }
 const leftover=[];for(const id of mine){const j=await read(join(state,'skills/jobs',id+'.json'));if(['pending','running'].includes(j.status))leftover.push(id);}
 if(leftover.length){console.error('LEARNING_INCOMPLETE '+leftover.join(','));process.exit(6);}
 const bank=new SkillBank(state),current=await bank.current();
 await writeJson(out,{caseId,status:'completed',sources:sources.map(j=>j.id),records,bankSnapshotId:current.id,proposals:await bank.proposals(current.snapshot),skills:(await bank.skills(current.snapshot)).filter(s=>s.repositoryKey===c.skillRepositoryKey),at:new Date().toISOString()});
}
else if(action==='relearn'){
 // Offline re-extraction: the same delivered runs and validated feedback, learned again with the current prompt into a fresh bank.
 const [stateName,caseId]=rest,c=caseOf(caseId),state=join(dir,stateName),out=join(dir,'relearn',stateName,caseId+'.json');
 await assert.rejects(readFile(out),{code:'ENOENT'},'Relearning result already exists');
 const review=await read(join(dir,'reviews',`${caseId}-B-r0.json`)),comments=await read(join(dir,'feedback',caseId+'.json'));
 const sources=[await registerRun(state,review.runId)];
 for(const f of comments.comments)sources.push((await feedback(state,{runId:review.runId,comment:f.comment,findingId:f.findingId,range:f.range,verdict:f.verdict,eventId:f.eventId},{simulated:true,trustedProjectReviewer:true})).job);
 const learner=runPiLearning(modelRuntime,true),records=[];
 for(let i=0;i<ex.learningCallsPerCase;i++){
  const jobs=await learnPending(state,learner,{model:ex.model,inference:ex.inference,maxJobs:1,repositoryKey:c.skillRepositoryKey,approval:'auto',retryFailed:rest.includes('--resume')&&i===0});if(!jobs.length)break;records.push(...jobs);
  console.log(JSON.stringify({event:'relearn',caseId,jobs:jobs.map(j=>({id:j.id,status:j.status,error:j.error}))}));
  const fault=jobs.find(j=>j.status==='failed'&&j.error==='Learning failed; inspect preserved attempt');
  if(fault){await writeJson(join(dir,'failed',`relearn-${caseId}-${Date.now()}.json`),{caseId,status:'learning_runtime_error',job:fault.id,error:fault.error});process.exit(5);}
 }
 const bank=new SkillBank(state),current=await bank.current();
 await writeJson(out,{caseId,status:'completed',sources:sources.map(j=>j.id),records,bankSnapshotId:current.id,skills:(await bank.skills(current.snapshot)).filter(s=>s.repositoryKey===c.skillRepositoryKey),at:new Date().toISOString()});
}
else throw Error('Unknown action '+action);
