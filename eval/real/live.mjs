import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBundle} from './admission.mjs';
import {verifyExperiment,validateRuntime,pilotStatistics} from './experiment.mjs';
import {planBatch,executeBatch,arms} from './batch.mjs';
import {RealCorpusAdapter} from './cache.mjs';
import {ReviewEngine} from '../../src/engine/review.ts';
import {readRun} from '../../src/engine/reports.ts';
import {isolatedState,writeJson} from '../../src/infrastructure/files.ts';
import {analyzeRetrieval} from '../../src/experiments/locagent/traces.ts';
import {readGraphPreparation,verifyPreparedCases} from './graph-preparation.mjs';
const argv=process.argv.slice(2),get=k=>{const i=argv.indexOf(k);return i<0?undefined:argv[i+1];};
const booleanFlags=new Set(['--live','--resume']),valueFlags=new Set(['--corpus','--experiment','--output','--cache','--subset','--arms','--repeat','--timeout-ms','--max-tools','--api-key-env']),seenFlags=new Set();
for(let i=0;i<argv.length;i++){const flag=argv[i];if(seenFlags.has(flag)||(!booleanFlags.has(flag)&&!valueFlags.has(flag)))throw Error('Unknown/duplicate live option');seenFlags.add(flag);if(valueFlags.has(flag)&&(!argv[++i]||argv[i].startsWith('--')))throw Error('Missing live option value');}
if(!argv.includes('--live')||!get('--corpus')||!get('--experiment')||!get('--output')||!get('--cache'))throw Error('Use --live --corpus DIR --experiment LOCK --cache DIR --output DIR [--subset IDs --arms T0,G0,G1 --repeat N --resume --timeout-ms N --max-tools N]');
const {lock,data}=await verifyBundle(resolve(get('--corpus')),{publicOnly:true}); // Never opens hidden gold or audit text.
const experiment=JSON.parse(await readFile(resolve(get('--experiment')),'utf8'));await verifyExperiment(experiment,lock);
if(resolve(get('--output'))!==experiment.outputDirectory)throw Error('Output/state cwd must match the frozen prompt');
for(const [flag,k] of [['--timeout-ms','timeoutMs'],['--max-tools','maxTools']])if(get(flag)&&Number(get(flag))!==experiment[k])throw Error('Budget flags must match frozen experiment; create a new reserve experiment for tuning');
const taskFile=experiment.kind==='reserve'?'reserve/tasks.jsonl':'public/tasks.jsonl';
const plan=planBatch(data[taskFile],{selected:get('--subset')?.split(','),armNames:get('--arms')?.split(',')??['T0','G0','G1'],repeats:Number(get('--repeat')??1)});
const key=process.env[get('--api-key-env')??'MERGEWARDEN_API_KEY'];if(!key?.trim())throw Error('Explicit credential environment unavailable');
const root=fileURLToPath(new URL('../../',import.meta.url)),output=await isolatedState(resolve(get('--output')),root),state=join(output,'state');
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
const model={provider:experiment.provider,modelId:experiment.model},adapter=new RealCorpusAdapter({cache:resolve(get('--cache')),stateDir:state,configuration:{...model,policy:'final_only',promptVersion:1}});
// All selected task snapshots must materialize before the first model call. No fetch.
const prepared=new Map();for(const job of plan)if(!prepared.has(job.task.case_id))prepared.set(job.task.case_id,await adapter.materialize(job.task,{offline:true,signal:controller.signal}));
const preparation=await readGraphPreparation(experiment.graphPreparationPath);
const preparedCases=[...prepared.entries()].map(([caseId,value])=>({caseId,repository:plan.find(job=>job.task.case_id===caseId).task.repository,store:value.store}));
await verifyPreparedCases(preparation,preparedCases,{kind:experiment.kind,runtimeCommit:experiment.runtimeCommit});
await writeJson(join(output,'graph-preparation.json'),preparation);
const {createEvaluationRuntimeFactory}=await import('./runtime.mjs');
const factory=createEvaluationRuntimeFactory(key,experiment);
const runs=await executeBatch({output,plan,identity:experiment,resume:argv.includes('--resume'),signal:controller.signal,execute:async job=>{
 await verifyExperiment(experiment,lock);
 const {repositoryPath,store}=prepared.get(job.task.case_id);
 const guardedFactory=async options=>{const runtime=await factory(options);try{validateRuntime(runtime.configuration(),experiment,job.arm);}catch(e){runtime.dispose();throw e;}return runtime;};
 console.error('Running reserve/formal task',job.runKey);
 const result=await new ReviewEngine(guardedFactory).run({repositoryPath,stateDir:state,input:{kind:'commits',base:job.task.base_sha,head:job.task.reviewed_sha},model,timeoutMs:experiment.timeoutMs,maxToolCalls:experiment.maxTools,signal:controller.signal,evaluation:{tools:arms[job.arm],graphMode:'prepared_only'}});
 if(result.kind!=='report'||result.report.snapshot.id!==store.manifest.identity.id)throw Error('Snapshot/result drift');
 const manifest=await readRun(state,result.runId),jsonl=await readFile(join(state,'runs',result.runId,'session.jsonl'),'utf8');
 const graph=manifest.metrics?.graph??{},receipt=preparation.entries.find(row=>row.caseId===job.task.case_id);
 if(job.arm!=='T0'){
  const violation=graph.buildMs!==0||graph.extractedFiles!==0||graph.resolvedFiles!==0||graph.resumedFiles!==0||graph.resumedResolutionFiles!==0||graph.coldRequestMs?.length>0||(graph.calls>0&&graph.warmRequestMs?.length<1)||(graph.generationId&&graph.generationId!==receipt.generationId);
  if(violation){const error=Error('Hot Graph experiment protocol violation');error.code='EXPERIMENT_PROTOCOL_VIOLATION';throw error;}
 }
 return {caseId:job.task.case_id,snapshotId:store.manifest.identity.id,runId:result.runId,status:result.report.status,delivered:true,findings:result.report.findings,report:result.report,manifest,graphPreparation:{generationId:receipt.generationId,generationState:receipt.generationState,scope:receipt.scope,budget:receipt.budget,coverage:receipt.coverage},trace:analyzeRetrieval({runKey:job.runKey,snapshotId:store.manifest.identity.id,findings:result.report.findings,changedPaths:Object.keys(result.report.coverage),jsonl})};
}});
await writeJson(join(output,'operations.json'),pilotStatistics(runs));
console.log(JSON.stringify({output,kind:experiment.kind,runs:runs.length,completed:runs.filter(r=>r.status==='completed'&&r.delivered).length,qualityMeasured:false}));
