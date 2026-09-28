import {readFile,mkdir,open,readdir,unlink} from 'node:fs/promises';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {digest} from './open-label.mjs';
import {validateTask} from './adapter.mjs';
import {writeJson} from '../../src/infrastructure/files.ts';

export const arms={T0:'text-only',G0:'text+graph',G1:'text+locagent'};
export function planBatch(tasks,{selected,armNames=['T0','G0','G1'],repeats=1}) {
 tasks.forEach(validateTask);
 if(new Set(tasks.map(t=>t.case_id)).size!==tasks.length)throw Error('Duplicate public task ID');
 if(!Number.isInteger(repeats)||repeats<1||repeats>10||!armNames.length||new Set(armNames).size!==armNames.length||armNames.some(a=>!arms[a]))throw Error('Invalid arms/repeats');
 const ids=selected??tasks.map(t=>t.case_id);if(!ids.length||new Set(ids).size!==ids.length)throw Error('Invalid subset');
 const chosen=ids.map(id=>{const t=tasks.find(t=>t.case_id===id);if(!t)throw Error('Unknown task');return t;});
 const jobs=[];
 for(let r=0;r<repeats;r++)for(const [i,task] of chosen.entries()){
  const order=['T0','G0','G1'].map((_,j)=>['T0','G0','G1'][(i+r+j)%3]).filter(a=>armNames.includes(a));
  for(const arm of order)jobs.push({runKey:`${task.case_id}/${r}/${arm}`,task,taskSha256:digest(task),arm,repeat:r,armOrder:order});
 }
 return jobs;
}
/** Resume schedules new attempts; prior failures and crashes remain on disk.
 * Model state is never resumed and accepted findings from partial runs are retained.
 */
export async function executeBatch({output,plan,identity,resume=false,execute,signal,maxJobs=Infinity,shouldStop=()=>false}) {
 if(maxJobs!==Infinity&&(!Number.isSafeInteger(maxJobs)||maxJobs<1))throw Error('Invalid batch checkpoint');
 await mkdir(output,{recursive:true});
 const lockPath=join(output,'running.lock');let mutex;
 try{mutex=await open(lockPath,'wx');}catch(error){
  if(error.code!=='EEXIST'||!resume)throw error;
  const recoveryPath=join(output,'recovery.lock'),recovery=await open(recoveryPath,'wx');
  try{
   const stale=await readFile(lockPath,'utf8'),owner=JSON.parse(stale);
   if(owner.hostname!==hostname()||!Number.isInteger(owner.pid)||owner.pid<=0)throw Error('Cannot establish batch lock owner');
   try{process.kill(owner.pid,0);throw Error('Batch is still running');}catch(e){if(e.code!=='ESRCH')throw e;}
   if(await readFile(lockPath,'utf8')!==stale)throw Error('Batch lock changed');
   await unlink(lockPath);mutex=await open(lockPath,'wx');
  }finally{await recovery.close();await unlink(recoveryPath);}
 }
 await mutex.writeFile(JSON.stringify({pid:process.pid,hostname:hostname()}));await mutex.sync();
 try {
  const file=join(output,'batch.json');let batch;
  try {batch=JSON.parse(await readFile(file,'utf8'));if(!resume)throw Error('Output exists; explicit resume required');if(batch.identitySha256!==digest(identity)||batch.identitySha256!==digest(batch.identity)||batch.planSha256!==digest(plan)||batch.planSha256!==digest(batch.plan))throw Error('Resume identity/task/config drift');}
  catch(e){if(e.code!=='ENOENT')throw e;if(resume)throw Error('Cannot resume absent batch');batch={schemaVersion:1,identity,identitySha256:digest(identity),planSha256:digest(plan),plan,startedAt:new Date().toISOString()};await writeJson(file,batch);}
  const results=[];
  for(const job of plan){
   if(results.length>=maxJobs)break;
   signal?.throwIfAborted();const directory=join(output,'attempts',job.task.case_id,String(job.repeat),job.arm);await mkdir(directory,{recursive:true});
   const existing=(await readdir(directory)).filter(x=>/^\d+\.json$/.test(x)).sort((a,b)=>Number(a.split('.')[0])-Number(b.split('.')[0]));
   const attempts=await Promise.all(existing.map(x=>readFile(join(directory,x),'utf8').then(JSON.parse)));
   if(attempts.some(a=>a.taskSha256!==job.taskSha256||digest(a.task)!==job.taskSha256||a.runKey!==job.runKey||a.arm!==job.arm||a.repeat!==job.repeat||a.identitySha256!==batch.identitySha256))throw Error('Attempt identity drift');
   const firstAttempt=identity.attemptPolicy==='first_attempt'?attempts[0]:undefined;
   if(firstAttempt){results.push(firstAttempt);continue;}
   const complete=attempts.findLast(a=>a.status==='completed'&&a.delivered);
   if(complete){results.push(complete);continue;}
   const attempt=existing.length?Math.max(...existing.map(x=>Number(x.split('.')[0])))+1:1;
   const target=join(directory,attempt+'.json');
   let record={...job,caseId:job.task.case_id,identitySha256:batch.identitySha256,attempt,startedAt:new Date().toISOString(),status:'running',delivered:false,findings:[]};await writeJson(target,record);
   const started=performance.now();
   try {const result=await execute(job,attempt);for(const k of ['runKey','task','taskSha256','arm','repeat','identitySha256','attempt','caseId'])if(k in result&&digest(result[k])!==digest(record[k]))throw Error('Executor identity drift');record={...record,...result};}
   catch(error){record={...record,status:signal?.aborted?'cancelled':'failed',error:'Review/materialization/delivery failed; inspect retained native artifacts. '+(error.code??''),delivered:false};
    record.elapsedMs=performance.now()-started;record.finishedAt=new Date().toISOString();await writeJson(target,record);results.push(record);await writeJson(join(output,'latest.json'),{identitySha256:batch.identitySha256,runs:results});
    if(error?.code==='EXPERIMENT_PROTOCOL_VIOLATION')throw error;
    if(shouldStop(record))break;
    continue;
   }
   record.elapsedMs=performance.now()-started;record.finishedAt=new Date().toISOString();await writeJson(target,record);results.push(record);
   await writeJson(join(output,'latest.json'),{identitySha256:batch.identitySha256,runs:results});
   if(shouldStop(record))break;
  }
  await writeJson(join(output,'latest.json'),{identitySha256:batch.identitySha256,runs:results});return results;
 }finally{await mutex.close();await unlink(lockPath);}
}
