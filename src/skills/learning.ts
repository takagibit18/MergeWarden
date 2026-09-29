import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, SkillBank } from './bank.ts';
import { SKILL_LIMITS, SKILL_POLICY } from './contracts.ts';
import type { Learner, LearningInput, LearningJob, SkillSource } from './contracts.ts';
import type { InferenceOptions, ModelSelection } from '../engine/contracts.ts';
import { readReport, readRun, runPath } from '../engine/reports.ts';
import { SnapshotStore } from '../snapshot/store.ts';
import { writeJson } from '../infrastructure/files.ts';
import { BASE_SYSTEM_PROMPT } from '../engine/prompt.ts';
const jobId=(sourceId:string)=>digest([sourceId,SKILL_POLICY]);
export async function enqueue(state:string,sourceId:string):Promise<LearningJob> {
  const id=jobId(sourceId),path=join(state,'skills','jobs',id+'.json');
  return new SkillBank(state).locked(async()=>{
    await mkdir(join(state,'skills','jobs'),{recursive:true,mode:0o700});
    try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const job:LearningJob={id,sourceId,status:'pending',attempts:0};await writeJson(path,job);return job;
  });
}
export async function registerRun(state:string,runId:string):Promise<LearningJob> {
  const m=await readRun(state,runId); await readReport(state,runId);
  const store=await SnapshotStore.load(state,m.snapshotId);
  const source:SkillSource={id:'run:'+runId,eventId:'run:'+runId,version:1,repositoryKey:m.skills?.repositoryKey??store.manifest.identity.repositoryId,runId,snapshotId:m.snapshotId,reportSha256:m.reportSha256!,kind:'run',independenceKey:digest([m.skills?.repositoryKey??store.manifest.identity.repositoryId,store.manifest.identity.inputFingerprint]),identity:'review_runtime',trust:'observed',simulated:false,withdrawn:false,createdAt:m.createdAt};
  return enqueue(state,await new SkillBank(state).saveSource(source));
}
export interface FeedbackOptions {
  runId:string; comment:string; findingId?:string; range?:SkillSource['range']; verdict?:SkillSource['verdict']; relationToReview?:SkillSource['relationToReview']; feedbackMetadata?:SkillSource['feedbackMetadata']; eventId?:string; version?:number; withdrawn?:boolean;
}
export async function feedback(state:string,options:FeedbackOptions, evaluation?:{simulated:true;trustedProjectReviewer:boolean}):Promise<{source:SkillSource;job:LearningJob}> {
  const report=await readReport(state,options.runId),m=await readRun(state,options.runId),store=await SnapshotStore.load(state,m.snapshotId);
  if(typeof options.comment!=='string'||!options.comment.trim()||options.comment.length>6000)throw Error('Feedback must contain 1..6000 characters');
  if(options.findingId&&!report.findings.some(f=>f.id===options.findingId))throw Error('Unknown finding');
  if(options.verdict&&!['correction','missed_defect','contract','uncertain'].includes(options.verdict))throw Error('Invalid verdict');
  if(options.relationToReview&&!['supports','contradicts','adds_missing_issue','adds_context'].includes(options.relationToReview))throw Error('Invalid feedback relation');
  if(options.feedbackMetadata){const f=options.feedbackMetadata;if(!evaluation||f.simulation!==true||f.humanReviewed!==false||f.sourceRunId!==options.runId||f.sourceReportHash!==m.reportSha256||f.comment!==options.comment||f.relationToReview!==options.relationToReview||f.targetFindingId!==options.findingId||JSON.stringify(f.missedIssueAnchor)!==JSON.stringify(options.range)||!/^([a-f0-9]{64})$/.test(f.promptHash)||!f.generator||!f.referenceProvenance.length||!Number.isFinite(Date.parse(f.createdAt)))throw Error('Invalid simulated feedback provenance');}
  if(options.relationToReview==='adds_missing_issue'?!options.range:options.relationToReview&&!options.findingId&&!options.range)throw Error('Missing feedback anchor');
  if(options.range) {const r=options.range;if(!Number.isInteger(r.startLine)||!Number.isInteger(r.endLine)||r.startLine<1||r.endLine<r.startLine||r.endLine-r.startLine>=200)throw Error('Invalid feedback range');const p=await store.source('head',r.path,r.startLine,r.endLine);if(p.status!=='ok'||p.endLine!==r.endLine)throw Error('Feedback range outside frozen source');}
  const eventId=options.eventId??'fb-'+randomUUID();if(!/^fb-[a-zA-Z0-9-]{1,80}$/.test(eventId))throw Error('Invalid feedback identity');
  const version=options.version??1;const bank=new SkillBank(state),current=await bank.current();const previous=current.snapshot.sources[eventId];
  const source:SkillSource={id:eventId+':'+version,eventId,version,repositoryKey:m.skills?.repositoryKey??store.manifest.identity.repositoryId,runId:options.runId,snapshotId:m.snapshotId,reportSha256:m.reportSha256!,kind:'feedback',independenceKey:digest([store.manifest.identity.inputFingerprint,options.comment.trim(),options.findingId??null,options.range??null]),identity:evaluation?'simulation':'local_user',trust:!evaluation||evaluation.trustedProjectReviewer?'trusted':'observed',simulated:!!evaluation,withdrawn:options.withdrawn??false,comment:options.comment,...(options.findingId?{findingId:options.findingId}:{}),...(options.range?{range:options.range}:{}),...(options.verdict?{verdict:options.verdict}:{}),...(options.relationToReview?{relationToReview:options.relationToReview}:{}),...(options.feedbackMetadata?{feedbackMetadata:options.feedbackMetadata}:{}),createdAt:previous&&(await bank.source(previous)).version===version?(await bank.source(previous)).createdAt:new Date().toISOString()};
  return {source,job:await enqueue(state,await bank.saveSource(source))};
}
export async function recoverDelivered(state:string,limit=100):Promise<number> {
  let ids:string[];try {ids=(await readdir(join(state,'runs'))).sort().slice(-limit);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}
  let count=0;for(const id of ids) {try {const m=await readRun(state,id);if(m.status==='delivered'&&m.learningPolicy==='auto'){await registerRun(state,id);count++;}}catch{/* Damaged or incomplete delivery cannot become learning input. */}}return count;
}
export async function buildInput(state:string,ref:string):Promise<LearningInput> {
  const bank=new SkillBank(state),source=await bank.source(ref),current=await bank.current();
  if(current.snapshot.sources[source.eventId]!==ref||source.withdrawn)throw Error('Source superseded or withdrawn');
  const report=await readReport(state,source.runId),m=await readRun(state,source.runId);if(m.reportSha256!==source.reportSha256)throw Error('Source report changed');
  const store=await SnapshotStore.load(state,source.snapshotId);
  const ranges=source.range?[source.range]:source.findingId?report.findings.find(f=>f.id===source.findingId)!.evidence.filter(e=>e.revision==='head'):report.findings.flatMap(f=>f.evidence.filter(e=>e.revision==='head'));
  const targets=ranges.length?ranges:store.manifest.changedPaths.slice(0,3).map(path=>({path,startLine:1,endLine:60}));
  const sourcePages=[];let byteBudget=14000;
  for(const range of targets.slice(0,4)) {const page=await store.source('head',range.path,range.startLine,Math.min(range.endLine,range.startLine+59));const record={...page,fileHash:store.manifest.head[range.path]?.hash};const bytes=Buffer.byteLength(JSON.stringify(record));if(bytes<=byteBudget){sourcePages.push(record);byteBudget-=bytes;}}
  const relevantSkills=(await bank.skills(current.snapshot)).filter(s=>s.repositoryKey===source.repositoryKey&&(s.scopeType==='review_method'||s.paths.some(p=>targets.some(r=>r.path===p||r.path.startsWith(p+'/'))))).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,8);
  // Only bounded visible tool outcomes; no assistant thinking or arbitrary session replay.
  const toolEvents:unknown[]=[];
  try {const session=await open(join(runPath(state,source.runId),'session.jsonl'),'r');try {const b=Buffer.alloc(64000);const {bytesRead}=await session.read(b,0,b.length,0);const lines=b.subarray(0,bytesRead).toString('utf8').split('\n');lines.pop();for(const line of lines){try{const row=JSON.parse(line),msg=row.message;if(msg?.role==='toolResult'&&toolEvents.length<6)toolEvents.push({tool:msg.toolName,isError:msg.isError===true,observation:JSON.stringify(msg.content).slice(0,500)});}catch{/* partial row */}}}finally{await session.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const boundedReport={status:report.status,summary:report.summary.slice(0,2000),findings:report.findings.filter(f=>!source.findingId||f.id===source.findingId).slice(0,3)};
  const input:LearningInput={policy:SKILL_POLICY,source,report:boundedReport,sourcePages,toolEvents,relevantSkills,fixedRules:BASE_SYSTEM_PROMPT,bankSnapshotId:current.id};
  while(Buffer.byteLength(JSON.stringify(input))>SKILL_LIMITS.inputBytes&&input.relevantSkills.length)input.relevantSkills.pop();
  if(Buffer.byteLength(JSON.stringify(input))>SKILL_LIMITS.inputBytes)throw Error('Learning input exceeds bounded byte limit');return input;
}
export async function learnPending(state:string,learner:Learner,options:{model:ModelSelection;inference?:InferenceOptions;maxJobs?:number;retryFailed?:boolean;feedbackOnly?:boolean;repositoryKey?:string;timeoutMs?:number}):Promise<LearningJob[]> {
  const max=options.maxJobs??1;if(!Number.isInteger(max)||max<1||max>3)throw Error('Learning batch must contain 1..3 jobs');
  const timeout=options.timeoutMs??SKILL_LIMITS.timeoutMs;if(timeout<1||!Number.isInteger(timeout)||timeout>120000)throw Error('Invalid learning timeout');
  const bank=new SkillBank(state);await mkdir(join(bank.root,'jobs'),{recursive:true});
  const path=join(bank.root,'learning.lock');const claim=await open(path,'wx',0o600).catch(()=>{throw Error('Learning worker locked; inspect before recovery');});
  try {
    await claim.writeFile(JSON.stringify({pid:process.pid}));await claim.sync();
    for(const ref of Object.values((await bank.current()).snapshot.sources).slice(-100))await enqueue(state,ref);
    const jobs:LearningJob[]=[];for(const name of (await readdir(join(bank.root,'jobs'))).sort())if(/^[a-f0-9]{64}\.json$/.test(name))jobs.push(JSON.parse(await readFile(join(bank.root,'jobs',name),'utf8')));
    const candidates=[];for(const job of jobs) {const source=await bank.source(job.sourceId);if(options.repositoryKey&&source.repositoryKey!==options.repositoryKey||options.feedbackOnly&&source.kind!=='feedback')continue;if(['pending','running'].includes(job.status)||options.retryFailed&&job.status==='failed')candidates.push({job,source});}
    candidates.sort((a,b)=>Number(b.source.kind==='feedback')-Number(a.source.kind==='feedback')||a.source.createdAt.localeCompare(b.source.createdAt));
    const results:LearningJob[]=[];
    for(const {job,source} of candidates.slice(0,max)) {
      const jobPath=join(bank.root,'jobs',job.id+'.json');
      if(source.withdrawn){job.status='noop';await writeJson(jobPath,job);results.push(job);continue;}
      const applied=(await bank.current()).snapshot.applied[job.id];
      if(applied){job.status=applied.outcome;await writeJson(jobPath,job);results.push(job);continue;}
      if(job.status==='running'&&job.pid!==process.pid) {try{process.kill(job.pid!,0);continue;}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')continue;}}
      job.status='running';job.pid=process.pid;job.attempts++;delete job.error;await writeJson(jobPath,job);
      const directory=join(bank.root,'attempts',job.id,String(job.attempts));await mkdir(directory,{recursive:true});const started=performance.now();
      const abort=new AbortController();const timer=setTimeout(()=>abort.abort(Error('Learning deadline exceeded')),timeout);
      try {
        const input=await buildInput(state,job.sourceId);job.inputSha256=digest(input);await writeJson(join(directory,'input.json'),input);
        // Input preparation can consume the deadline before the listener exists.
        abort.signal.throwIfAborted();
        let stop:()=>void=()=>{};const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(Error('Learning deadline exceeded'));abort.signal.addEventListener('abort',stop,{once:true});});
        let result;try {result=await Promise.race([learner(input,{directory,model:options.model,...(options.inference?{inference:options.inference}:{}),signal:abort.signal,timeoutMs:timeout}),cancelled]);}finally{abort.signal.removeEventListener('abort',stop);}
        abort.signal.throwIfAborted();job.usage=result.usage;job.requests=result.requests;await writeJson(join(directory,'output.json'),result);
        const receipt=await bank.apply(job.id,input,result.result);job.status=receipt.outcome;job.snapshotId=receipt.snapshotId;await writeJson(join(directory,'receipt.json'),receipt);
      } catch(e) {job.status='failed';job.error=e instanceof Error&&/^(Source |Knowledge |Invalid |Skill |Learning |Expected |Unknown |Duplicate |Weak |Target |Retirement |Procedure |Conditional |Unexpected |Dependency |Operation |Missing |Repository )/.test(e.message)?e.message:'Learning failed; inspect preserved attempt';job.usage??=null;job.requests??=null;try{const metrics=JSON.parse(await readFile(join(directory,'metrics.json'),'utf8'));job.usage=metrics.usage;job.requests=metrics.requests;}catch{/* Unknown provider usage remains null. */}}
      finally {clearTimeout(timer);job.latencyMs=performance.now()-started;delete job.pid;await writeJson(jobPath,job);await writeJson(join(directory,'job.json'),job);}
      results.push(job);
    }
    return results;
  } finally {await claim.close();await rm(path);}
}
