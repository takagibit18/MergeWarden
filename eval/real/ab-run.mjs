import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {executeBatch} from './batch.mjs';
import {ReviewEngine} from '../../src/engine/review.ts';
import {readRun} from '../../src/engine/reports.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {SqliteCodeGraph,publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {writeJson,sha256} from '../../src/infrastructure/files.ts';
import {analyzeInvestigation} from '../../src/eval/provenance/investigation.ts';
import {createOAuthModelRuntime,createModelRuntime} from '../../integrations/pi/src/runtime.ts';
import {abRuntime} from './ab-runtime.mjs';
import {classifyRequests,shouldPause} from './ab-observation.mjs';
import {resumeLimit} from './ab-checkpoint.mjs';
import {read,model,verifyLock,evaluationFor} from './ab-contract.mjs';
const output=resolve(process.argv[2]),authPath=resolve(process.argv[3]),resume=process.argv.includes('--resume'),checkOnly=process.argv.includes('--check-only');
const experiment=await read(join(output,'experiment.json'));await verifyLock(experiment,output);
assert(process.permission,'Use isolated ab-launch.mjs');assert.equal(process.permission.has('fs.read',join(import.meta.dirname,'corpora/mergewarden-real-python40-v1/hidden/gold.jsonl')),false);
if(!checkOnly){const gate=await read(join(output,'preflight.json'));assert.equal(gate.status,'PASS');assert.equal(gate.experimentSha256,experiment.experimentSha256);}
const maxJobs=resume?resumeLimit(experiment,(await read(join(output,'latest.json'))).runs,await read(join(output,'checkpoint-review.json'))):experiment.checkpointPairs*2;
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
const prepared=new Map(experiment.cases.map(c=>[c.caseId,c]));
// Validate every prepared generation without building in either arm.
for(const c of experiment.cases){assert.equal((await readRun(join(output,'state'),c.seedId)).snapshotId,c.snapshotId);assert.equal(sha256(await readFile(await publishedGraphPath(join(output,'state'),c.snapshotId))),c.graphSha256);const store=await SnapshotStore.load(join(output,'state'),c.snapshotId),hot=await SqliteCodeGraph.openPublishedOnly(store,{scope:'core'});hot.graph.close();assert.equal(hot.manifest.generationId,c.generationId);}
if(checkOnly){const catalog=await createModelRuntime();assert.equal(sha256(JSON.stringify(catalog.getModel(model.provider,model.modelId))),experiment.modelCapability.modelSha256);await writeJson(join(output,'preflight.json'),{status:'PASS',experimentSha256:experiment.experimentSha256,privateGoldDenied:true,preparedCases:experiment.cases.length,realProviderRequests:0,at:new Date().toISOString()});console.log('PASS: frozen code, prepared snapshots/graphs, model identity, hidden-label isolation; zero provider requests');process.exit(0);}
const catalog=await createOAuthModelRuntime(model.provider,authPath);
let mechanicalFaults=0;
const stopPolicy=experiment.changeAware ? r=>{
 const o=r.observation;
 const unsafe=!r.delivered || !o || !o.requestAuditMatches || o.hotViolation || o.extensionErrors?.length || !o.requestOrderValid || o.unmatchedAssistantMessages;
 if(unsafe)mechanicalFaults++;
 return mechanicalFaults>=2;
} : shouldPause;
const runs=await executeBatch({output,plan:experiment.plan,identity:experiment,resume,signal:controller.signal,maxJobs,shouldStop:stopPolicy,execute:async job=>{
 await verifyLock(experiment,output);const c=prepared.get(job.task.case_id),raw=join(output,'observations',job.task.case_id,job.arm),payloads=[],calls=[],extensionErrors=[];let runDir;
 const emit=data=>console.log(JSON.stringify({caseId:job.task.case_id,arm:job.arm,...data}));emit({event:'started'});
 const started=performance.now();
 const engine=new ReviewEngine(async options=>{
  runDir=options.runDir;
  const tools=options.tools.map(tool=>({...tool,async execute(args){const row={name:tool.name,ordinal:calls.length+1,startMs:performance.now()-started};calls.push(row);emit({event:'tool',name:tool.name,ordinal:row.ordinal});try{return await tool.execute(args);}finally{row.endMs=performance.now()-started;}}}));
  return abRuntime({...options,tools},catalog,{arm:job.arm,onPayload:async p=>{payloads.push({ordinal:payloads.length+1,sha256:sha256(JSON.stringify(p)),atMs:performance.now()-started});await writeJson(join(raw,`request-${payloads.length}.json`),p);emit({event:'request',ordinal:payloads.length});},onExtensionError:()=>extensionErrors.push('extension_error')});
 });
 let result;try{result=await engine.run({repositoryPath:c.repositoryPath,stateDir:join(output,'state'),rerunId:c.seedId,model,timeoutMs:experiment.timeoutMs,maxToolCalls:experiment.maxTools,signal:controller.signal,evaluation:evaluationFor(job.arm,experiment)});}
 finally{await writeJson(join(raw,'observations.json'),{payloads,calls,extensionErrors,runDir});}
 assert.equal(result.kind,'report');assert.equal(result.report.snapshot.id,c.snapshotId);
 const manifest=await read(join(runDir,'run.json')),jsonl=await readFile(join(runDir,'session.jsonl'),'utf8'),entries=jsonl.trim().split(/\r?\n/).map(JSON.parse),messages=entries.filter(e=>e.type==='message').map(e=>e.message);
 const audits=entries.filter(e=>e.customType==='mergewarden.provider-request.v1').map(e=>e.data);
 const auditMatches=audits.length===payloads.length&&audits.every((a,i)=>a.sha256===payloads[i].sha256);
 const schemaErrors=messages.filter(m=>m.role==='toolResult'&&m.isError&&m.content.some(c=>c.text?.startsWith('Validation failed for tool'))).length;
 const classification=classifyRequests(entries,{termination:manifest.termination,report:result.report});
 const graph=manifest.metrics.graph??{},dispatch=manifest.metrics.dispatch??{};
 const hotViolation=!!(graph.buildMs||graph.extractedFiles||graph.resolvedFiles||graph.coldRequestMs?.length||(graph.generationId&&graph.generationId!==c.generationId));
 const deliveredIds=new Set(entries.filter(e=>e.customType==='mergewarden-host-dispatch-v2'&&e.data.type==='context_delivered').map(e=>e.data.requestId));
 const deliveredPackages=entries.filter(e=>e.type==='custom_message'&&e.customType==='mergewarden-structural-context-v2').map(e=>JSON.parse(e.content)).filter(p=>deliveredIds.has(p.requestId));
 const observation={candidatePackagesDelivered:deliveredPackages.filter(p=>p.investigations.some(i=>i.candidateCatalog.length)).length,
 hostPrefetchDelivered:deliveredPackages.reduce((n,p)=>n+p.sources.length,0),...classification,formalToolCalls:manifest.metrics.toolExecuted,observedHostRequests:calls.length,schemaRejectedAttempts:schemaErrors,requestAuditMatches:auditMatches,extensionErrors,hotViolation,packagesDelivered:dispatch.packagesDelivered??0,routeTriggers:manifest.metrics.routing?.triggered??0};
 observation.mechanicalBlocker=!auditMatches||extensionErrors.length>0||hotViolation||classification.providerErrors>0||!classification.usageComplete||manifest.status!=='delivered'||result.report.status==='failed';
 observation.reviewRequired=result.report.status!=='completed';
 assert.equal(sha256(await readFile(result.reportPath)),manifest.reportSha256);assert.equal(sha256(await readFile(result.markdownPath)),manifest.markdownSha256);
 const store=await SnapshotStore.load(join(output,'state'),c.snapshotId);for(const f of result.report.findings)for(const ev of f.evidence)assert.equal((await store.read(ev)).actualSha256,ev.contentSha256);
 const trace=analyzeInvestigation({runId:result.runId,snapshotId:c.snapshotId,findings:result.report.findings,jsonl});
 await writeJson(join(raw,'metrics.json'),observation);emit({event:'finished',status:result.report.status,findings:result.report.findings.length,...observation});
 return {caseId:c.caseId,snapshotId:c.snapshotId,runId:result.runId,status:result.report.status,delivered:manifest.status==='delivered',findings:result.report.findings,report:result.report,manifest,observation,trace};
}});
await verifyLock(experiment,output);
await writeJson(join(output,'checkpoint.json'),{experimentSha256:experiment.experimentSha256,runs:runs.length,pairs:Math.floor(runs.length/2),status:runs.some(r=>!r.delivered||r.observation?.mechanicalBlocker)?'BLOCKED':runs.length===experiment.plan.length&&!runs.some(shouldPause)?'COMPLETED':'AWAITING_REVIEW',at:new Date().toISOString()});
console.log(JSON.stringify({event:'batch_stopped',runs:runs.length,output}));
