import assert from 'node:assert/strict';
import {readFile,readdir,copyFile,stat,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {registerRun,learnPending,feedback,enqueue} from '../../src/skills/learning.ts';
import {SkillBank} from '../../src/skills/bank.ts';
import {createOAuthModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {runPiLearning} from '../../integrations/pi/src/learning.ts';
import {writeJson,sha256} from '../../src/infrastructure/files.ts';
async function cp(src,dst){const info=await stat(src);if(info.isDirectory()){await mkdir(dst,{recursive:true});for(const name of await readdir(src))await cp(join(src,name),join(dst,name));}else await copyFile(src,dst);}
const root=resolve(process.argv[2]),auth=resolve(process.argv[3]),phase=process.argv[4],dir=join(root,'execution'),read=async p=>JSON.parse(await readFile(p,'utf8')),ex=await read(join(dir,'experiment.json'));
assert(['B','C'].includes(phase));const target=join(dir,phase);const reviews=await Promise.all((await readdir(join(dir,'reviews'))).filter(f=>f.endsWith('-A.json')).map(f=>read(join(dir,'reviews',f))));const sources=reviews.filter(r=>r.phase==='source'&&r.status==='completed'&&r.manifest.termination.finalSubmission);assert(sources.every(r=>r.runId));
assert(process.permission);assert.equal(process.permission.has('fs.read',join(root,'corpus/private/gold.jsonl')),false);if(phase==='B')assert.equal(process.permission.has('fs.read',join(root,'evaluation/comments-validated.json')),false);
if(phase==='B'){const bank=new SkillBank(target);for(const name of await readdir(join(target,'skills/jobs'))){const path=join(target,'skills/jobs',name),job=await read(path),source=await bank.source(job.sourceId);if(!sources.some(r=>r.runId===source.runId)){assert.equal(job.attempts,0);job.status='ineligible_source';job.eligibilityReason='Source not completed; excluded by recovery protocol';await writeJson(path,job);}}for(const r of sources){await cp(join(dir,'A/runs',r.runId),join(target,'runs',r.runId),{recursive:true});await registerRun(target,r.runId);}}
else {assert.equal((await read(join(dir,'B-frozen.json'))).status,'FROZEN');try{await readFile(join(target,'skills/current.json'));}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(join(target,'skills'),{recursive:true});for(const name of ['objects','current.json'])await cp(join(dir,'B/skills',name),join(target,'skills',name),{recursive:true});}
for(const r of sources)await cp(join(dir,'A/runs',r.runId),join(target,'runs',r.runId),{recursive:true});
const inheritedBank=new SkillBank(target);for(const sourceId of Object.values((await inheritedBank.current()).snapshot.sources)){const source=await inheritedBank.source(sourceId);if(source.kind==='run'){const job=await enqueue(target,sourceId);if(job.attempts===0){job.status=sources.some(r=>r.runId===source.runId)?'inherited_run_no_reextraction':'ineligible_source';await writeJson(join(target,'skills/jobs',job.id+'.json'),job);}}}
const approved=await read(join(root,'evaluation/comments-validated.json'));assert.equal(approved.status,'VALIDATED');for(const c of approved.comments)await feedback(target,{runId:c.runId,comment:c.comment,findingId:c.findingId,range:c.range,verdict:c.verdict,eventId:c.eventId},{simulated:true,trustedProjectReviewer:true});}
const catalog=await createOAuthModelRuntime(ex.model.provider,auth),learner=runPiLearning(catalog,true),records=[];
for(let i=0;i<(phase==='B'?sources.length:12);i++){
 let consumed=ex.learningCallsPrior;for(const arm of ['B','C']){try{for(const f of await readdir(join(dir,arm,'skills/jobs'))){const j=await read(join(dir,arm,'skills/jobs',f));consumed+=j.attempts;}}catch(e){if(e.code!=='ENOENT')throw e;}}
 assert(consumed<ex.learningCallsMax,'Learning allowance exhausted');const jobs=await learnPending(target,learner,{model:ex.model,inference:ex.inference,maxJobs:1,feedbackOnly:phase==='C'});if(!jobs.length)break;records.push(...jobs);console.log(JSON.stringify({arm:phase,jobs}));for(const j of jobs){const session=await readFile(join(target,'skills/attempts',j.id,String(j.attempts),'session.jsonl'),'utf8').catch(()=> '');if(session.includes('The usage limit has been reached')){await writeJson(join(dir,'recovery-stop.json'),{reason:'provider_quota_still_blocked',phase,jobId:j.id});process.exit(2);}}
}
console.log(JSON.stringify({phase,status:'LEARNING_FINISHED_PENDING_HOST_FREEZE'}));
