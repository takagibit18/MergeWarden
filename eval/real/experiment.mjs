import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {verifyBundle} from './admission.mjs';
import {digest} from './open-label.mjs';
import {implementationFingerprint} from '../fingerprint.mjs';
import {BASE_SYSTEM_PROMPT,GRAPH_CAPABILITY_PROMPT,NAVIGATION_POLICY_PROMPT} from '../../src/engine/prompt.ts';
import {LOCAGENT_CAPABILITY_PROMPT} from '../../src/experiments/locagent/contracts.ts';
import {sha256} from '../../src/infrastructure/files.ts';
import {readGraphPreparation} from './graph-preparation.mjs';
export const armPrompts={T0:BASE_SYSTEM_PROMPT,G0:BASE_SYSTEM_PROMPT+'\n'+NAVIGATION_POLICY_PROMPT+'\n'+GRAPH_CAPABILITY_PROMPT,G1:BASE_SYSTEM_PROMPT+'\n'+NAVIGATION_POLICY_PROMPT+'\n'+LOCAGENT_CAPABILITY_PROMPT};
export const effectivePrompt=(arm,output)=>armPrompts[arm]+'\nCurrent working directory: '+join(resolve(output),'state').replaceAll('\\','/');
export function validateRuntime(configuration,experiment,arm){
 if((configuration.providerReasoningEffort??'provider-default')!==(experiment.providerReasoningEffort??'provider-default'))throw Error('Effective provider reasoning configuration drift');
 if(configuration.systemPrompt!==effectivePrompt(arm,experiment.outputDirectory)||configuration.modelMaxTokens!==experiment.maxTokens||configuration.thinkingLevel!==experiment.thinkingLevel||configuration.modelApi!==experiment.modelApi||configuration.modelBaseUrl!==experiment.modelBaseUrl)throw Error('Effective runtime configuration drift');
}
export function quantiles(values){const s=values.filter(Number.isFinite).sort((a,b)=>a-b),q=p=>s.length?s[Math.max(0,Math.ceil(s.length*p)-1)]:null;return {count:s.length,p50:q(.5),p75:q(.75),p90:q(.9),max:s.at(-1)??null};}
export function pilotStatistics(runs){
 const timeouts=runs.filter(r=>/time budget exhausted|timed out|timeout/i.test(r.report?.summary??'')).length;
 const nav=runs.filter(r=>r.arm!=='T0'),attempted=nav.filter(r=>r.manifest?.metrics?.navigation?.attempted),degraded=nav.filter(r=>r.manifest?.metrics?.navigation?.degraded);
 const summarize=rows=>({
  runs:rows.length,
  completed:rows.filter(r=>r.delivered&&r.status==='completed').length,
  toolCalls:rows.reduce((n,r)=>n+(r.manifest?.metrics?.toolCalls??0),0),
  graphCalls:rows.reduce((n,r)=>n+(r.manifest?.metrics?.graphToolCalls??r.trace?.metrics?.graphCalls??0),0),
  novelPaths:rows.reduce((n,r)=>n+(r.trace?.metrics?.novelPaths??0),0),
  novelToSource:rows.reduce((n,r)=>n+(r.trace?.metrics?.novelEntityToSource??0),0),
 });
 return {runs:runs.length,completed:runs.filter(r=>r.delivered&&r.status==='completed').length,completionRate:runs.length?runs.filter(r=>r.delivered&&r.status==='completed').length/runs.length:null,latencyMs:quantiles(runs.map(r=>r.elapsedMs)),toolCalls:quantiles(runs.map(r=>r.manifest?.metrics?.toolCalls)),inputTokens:quantiles(runs.map(r=>r.manifest?.usage?.input)),outputTokens:quantiles(runs.map(r=>r.manifest?.usage?.output)),timeouts,timeoutRate:runs.length?timeouts/runs.length:null,navigation:{eligibleRuns:nav.length,attemptedRuns:attempted.length,attemptRate:nav.length?attempted.length/nav.length:null,degradedRuns:degraded.length,failureRate:attempted.length?degraded.length/attempted.length:null,availabilityRate:attempted.length?(attempted.length-degraded.length)/attempted.length:null,errors:nav.reduce((n,r)=>n+(r.manifest?.metrics?.navigation?.errors??0),0)},byArm:Object.fromEntries(['T0','G0','G1'].map(arm=>[arm,summarize(runs.filter(r=>r.arm===arm))])),qualityMeasured:false};
}
export function validatePilot(result,batch,lock){
 if(batch.identitySha256!==digest(batch.identity)||batch.planSha256!==digest(batch.plan)||result.identitySha256!==batch.identitySha256||batch.identity.kind!=='reserve'||batch.identity.attemptPolicy!=='operational_retry'||batch.identity.corpusSha256!==lock.corpusSha256||batch.identity.provider!=='bigmodel'||batch.identity.model!=='glm-5.3-flash')throw Error('Pilot identity mismatch');
 const ids=new Set(result.runs.map(r=>r.caseId));if(ids.size!==6||[...ids].some(id=>!lock.reserveIds.includes(id))||result.runs.length!==18)throw Error('Pilot must use exactly six reserve tasks and 18 arm runs');
 if(new Set(result.runs.map(r=>r.runKey)).size!==result.runs.length)throw Error('Duplicate pilot attempt');
 const snapshots=new Map();
 for(const r of result.runs){const job=batch.plan.find(j=>j.runKey===r.runKey);if(!job||r.identitySha256!==batch.identitySha256||r.taskSha256!==digest(job.task)||digest(r.task)!==r.taskSha256||r.arm!==job.arm||r.caseId!==job.task.case_id||r.repeat!==job.repeat)throw Error('Pilot task/attempt identity mismatch');
  if(r.manifest?.status!=='delivered'||r.manifest.snapshotId!==r.snapshotId||r.report?.snapshot?.id!==r.snapshotId||r.manifest.model.provider!==batch.identity.provider||r.manifest.model.modelId!==batch.identity.model||r.manifest.limits.timeoutMs!==batch.identity.timeoutMs||r.manifest.limits.maxToolCalls!==batch.identity.maxTools)throw Error('Pilot native identity mismatch');
  if(r.arm!=='T0'){
   const graph=r.manifest.metrics?.graph,prepared=r.graphPreparation;
   if(!graph||!prepared||graph.buildMs!==0||graph.extractedFiles!==0||graph.resolvedFiles!==0||graph.resumedFiles!==0||graph.resumedResolutionFiles!==0||graph.coldRequestMs?.length||graph.generationId&&graph.generationId!==prepared.generationId)throw Error('Pilot violated prepared-only Hot Graph protocol');
  }
  validateRuntime(r.manifest.runtimeConfiguration,batch.identity,r.arm);
  if(snapshots.has(r.caseId)&&snapshots.get(r.caseId)!==r.snapshotId)throw Error('Pilot arms reviewed different snapshots');snapshots.set(r.caseId,r.snapshotId);
 }
 for(const id of ids)for(const arm of ['T0','G0','G1'])if(!result.runs.some(r=>r.caseId===id&&r.arm===arm&&r.delivered&&r.status==='completed'))throw Error('Operational pilot incomplete for a reserve case/arm');
}
export async function createExperimentLock({corpusDirectory,output,kind,timeoutMs,maxTools,maxTokens=8192,providerReasoningEffort='low',pilotDirectory,runOutput,graphPreparationPath}) {
 if(!runOutput||!['reserve','formal'].includes(kind)||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>3600000||!Number.isInteger(maxTools)||maxTools<1||maxTools>1000)throw Error('Invalid experiment limits/output');
 if(!Number.isInteger(maxTokens)||maxTokens<8192||maxTokens>32768||!['low','high','max'].includes(providerReasoningEffort))throw Error('Invalid evaluation model budget');
 const {lock,data}=await verifyBundle(corpusDirectory,{publicOnly:kind==='reserve'});
 const graphPreparation=await readGraphPreparation(graphPreparationPath);
 if(graphPreparation.selectionKind!==kind)throw Error('Graph preparation selection does not match experiment kind');
 const expectedIds=kind==='reserve'?lock.reserveIds:lock.formalIds;
 if(graphPreparation.entries.length!==expectedIds.length||graphPreparation.entries.some(row=>!expectedIds.includes(row.caseId)))throw Error('Graph preparation case set does not match experiment');
 const coverage=kind==='formal'?quantiles(data['audit/receipts.jsonl'].filter(c=>lock.formalIds.includes(c.id)).map(c=>c.profile.minimumCoverageToolCalls)):null;
 if(coverage&&maxTools<Math.max(coverage.max+20,coverage.p90*2))throw Error('No investigation headroom above complete diff coverage');
 let pilot=null;
 if(kind==='formal'){
  if(!pilotDirectory)throw Error('Reserve model pilot required');
  const bytes=await readFile(join(pilotDirectory,'latest.json')),result=JSON.parse(bytes),batch=JSON.parse(await readFile(join(pilotDirectory,'batch.json'),'utf8'));
  await verifyExperiment(batch.identity,lock);validatePilot(result,batch,lock);
  if(maxTokens!==batch.identity.maxTokens||providerReasoningEffort!==(batch.identity.providerReasoningEffort??'provider-default'))throw Error('Formal model budget must match the reserve pilot');
  for(const r of result.runs){
   if(!/^[A-Za-z0-9_-]+$/.test(r.runId))throw Error('Invalid native run ID');
   const directory=join(pilotDirectory,'state','runs',r.runId),manifest=JSON.parse(await readFile(join(directory,'run.json'),'utf8'));
   if(digest(manifest)!==digest(r.manifest)||sha256(await readFile(join(directory,'report.json')))!==manifest.reportSha256)throw Error('Pilot native delivery drift');
  }
  pilot={resultSha256:sha256(bytes),statistics:pilotStatistics(result.runs)};
  if(timeoutMs<pilot.statistics.latencyMs.p90||maxTools<=pilot.statistics.toolCalls.p90)throw Error('Formal budget below observed pilot needs');
 }
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const experiment={schemaVersion:1,kind,attemptPolicy:kind==='formal'?'first_attempt':'operational_retry',provider:'bigmodel',model:'glm-5.3-flash',modelApi:'openai-completions',modelBaseUrl:'https://open.bigmodel.cn/api/paas/v4/',piVersion:'0.84.1',outputDirectory:resolve(runOutput),systemPromptSha256:sha256(BASE_SYSTEM_PROMPT),navigationPolicySha256:sha256(NAVIGATION_POLICY_PROMPT),timeoutMs,maxTools,maxTokens,providerReasoningEffort,thinkingLevel:providerReasoningEffort,corpusId:lock.corpusId,corpusSha256:lock.corpusSha256,runtimeCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),implementationFingerprint:await implementationFingerprint(),graphMode:'prepared_only',graphPreparationSha256:graphPreparation.graphPreparationSha256,graphPreparationPath:resolve(graphPreparationPath),arms:Object.fromEntries(Object.entries(armPrompts).map(([k,p])=>[k,{systemPromptSha256:sha256(p),effectiveSystemPromptSha256:sha256(effectivePrompt(k,runOutput))}])),coverage,pilot,readiness:kind==='formal'?'READY':'RESERVE_PILOT_ONLY'};
 experiment.experimentSha256=digest(experiment);await writeFile(output,JSON.stringify(experiment,null,2)+'\n',{flag:'wx'});return experiment;
}
export async function verifyExperiment(experiment,corpusLock){const copy={...experiment};delete copy.experimentSha256;const root=fileURLToPath(new URL('../../',import.meta.url));if(digest(copy)!==experiment.experimentSha256||experiment.corpusSha256!==corpusLock.corpusSha256||experiment.systemPromptSha256!==sha256(BASE_SYSTEM_PROMPT)||experiment.navigationPolicySha256!==sha256(NAVIGATION_POLICY_PROMPT)||experiment.implementationFingerprint!==await implementationFingerprint()||experiment.runtimeCommit!==execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim())throw Error('Frozen experiment drift');
 const preparation=await readGraphPreparation(experiment.graphPreparationPath);if(experiment.graphMode!=='prepared_only'||preparation.graphPreparationSha256!==experiment.graphPreparationSha256||preparation.runtimeCommit!==experiment.runtimeCommit)throw Error('Frozen graph preparation drift');
 for(const [arm,p] of Object.entries(armPrompts))if(experiment.arms?.[arm]?.systemPromptSha256!==sha256(p)||experiment.arms[arm].effectiveSystemPromptSha256!==sha256(effectivePrompt(arm,experiment.outputDirectory)))throw Error('Frozen arm prompt drift');
 if(experiment.provider!=='bigmodel'||experiment.model!=='glm-5.3-flash'||!['reserve','formal'].includes(experiment.kind)||experiment.attemptPolicy!==(experiment.kind==='formal'?'first_attempt':'operational_retry'))throw Error('Unsupported frozen experiment');if(experiment.kind==='formal'&&(experiment.readiness!=='READY'||!experiment.pilot))throw Error('Formal experiment not admitted');}
