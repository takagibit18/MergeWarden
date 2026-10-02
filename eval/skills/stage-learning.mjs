// No provider calls: stage validated delivered sources while an external quota blocks sampling.
import {readFile,readdir,cp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {registerRun,buildInput} from '../../src/skills/learning.ts';
import {SkillBank} from '../../src/skills/bank.ts';
import {writeJson} from '../../src/infrastructure/files.ts';
const root=resolve(process.argv[2]),dir=join(root,'execution'),state=join(dir,'B'),records=[];
await mkdir(join(root,'summary/learning-preflight'),{recursive:true});
for(const n of await readdir(join(dir,'reviews'))){if(!n.endsWith('-A.json'))continue;const r=JSON.parse(await readFile(join(dir,'reviews',n),'utf8'));if(r.phase!=='source'||!r.runId)continue;
await cp(join(dir,'A/runs',r.runId),join(state,'runs',r.runId),{recursive:true});const job=await registerRun(state,r.runId),input=await buildInput(state,job.sourceId);await writeJson(join(root,'summary/learning-preflight',job.id+'.json'),input);records.push({caseId:r.caseId,runId:r.runId,reportStatus:r.status,jobId:job.id,status:job.status,inputBytes:Buffer.byteLength(JSON.stringify(input)),semanticCorrectnessNotAssumed:true});}
await writeJson(join(root,'summary/learning-preflight.json'),{status:'PENDING_NOT_TRAINED',providerCalls:0,records,publishedSkills:(await new SkillBank(state).skills()).length});console.log(JSON.stringify(records));
