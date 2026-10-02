import assert from 'node:assert/strict';
import {readFile,readdir,cp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {registerRun,learnPending,feedback} from '../../src/skills/learning.ts';
import {SkillBank} from '../../src/skills/bank.ts';
import {createOAuthModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {runPiLearning} from '../../integrations/pi/src/learning.ts';
import {writeJson,sha256} from '../../src/infrastructure/files.ts';
const root=resolve(process.argv[2]),auth=resolve(process.argv[3]),phase=process.argv[4],dir=join(root,'execution'),read=async p=>JSON.parse(await readFile(p,'utf8')),ex=await read(join(dir,'experiment.json'));
assert(['B','C'].includes(phase));const target=join(dir,phase);const reviews=await Promise.all((await readdir(join(dir,'reviews'))).filter(f=>f.endsWith('-A.json')).map(f=>read(join(dir,'reviews',f))));const sources=reviews.filter(r=>r.phase==='source');assert.equal(sources.length,6);assert(sources.every(r=>r.runId));
assert(process.permission);assert.equal(process.permission.has('fs.read',join(root,'corpus/private/gold.jsonl')),false);if(phase==='B')assert.equal(process.permission.has('fs.read',join(root,'evaluation/comments-validated.json')),false);
if(phase==='B'){for(const r of sources){await cp(join(dir,'A/runs',r.runId),join(target,'runs',r.runId),{recursive:true});await registerRun(target,r.runId);}}
else {assert.equal((await read(join(dir,'B-frozen.json'))).status,'FROZEN');try{await readFile(join(target,'skills/current.json'));}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(join(target,'skills'),{recursive:true});for(const name of ['objects','current.json'])await cp(join(dir,'B/skills',name),join(target,'skills',name),{recursive:true});}
for(const r of sources)await cp(join(dir,'A/runs',r.runId),join(target,'runs',r.runId),{recursive:true});
const approved=await read(join(root,'evaluation/comments-validated.json'));assert.equal(approved.status,'VALIDATED');for(const c of approved.comments)await feedback(target,{runId:c.runId,comment:c.comment,findingId:c.findingId,range:c.range,verdict:c.verdict,eventId:c.eventId},{simulated:true,trustedProjectReviewer:true});}
const catalog=await createOAuthModelRuntime(ex.model.provider,auth),learner=runPiLearning(catalog,true),records=[];
for(let i=0;i<(phase==='B'?6:12);i++){
 let consumed=ex.learningCallsPrior;for(const arm of ['B','C']){try{for(const f of await readdir(join(dir,arm,'skills/jobs'))){const j=await read(join(dir,arm,'skills/jobs',f));consumed+=j.attempts;}}catch(e){if(e.code!=='ENOENT')throw e;}}
 assert(consumed<ex.learningCallsMax,'Learning allowance exhausted');const jobs=await learnPending(target,learner,{model:ex.model,inference:ex.inference,maxJobs:1,feedbackOnly:phase==='C'});if(!jobs.length)break;records.push(...jobs);console.log(JSON.stringify({arm:phase,jobs}));
}
const bank=new SkillBank(target),current=await bank.current();await writeJson(join(dir,phase+'-frozen.json'),{status:'FROZEN',bankSnapshotId:current.id,skills:await bank.skills(),records,at:new Date().toISOString()});
if(phase==='C')await writeJson(join(dir,'learning-frozen.json'),{status:'FROZEN',B:await read(join(dir,'B-frozen.json')),C:await read(join(dir,'C-frozen.json'))});
