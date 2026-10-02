import {readFile,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hostname,platform,arch} from 'node:os';
import {ReviewEngine} from '../../src/engine/review.ts';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {readRun} from '../../src/engine/reports.ts';
import {isolatedState,sha256,writeJson} from '../../src/infrastructure/files.ts';
import {BASE_SYSTEM_PROMPT,GRAPH_CAPABILITY_PROMPT,NAVIGATION_POLICY_PROMPT} from '../../src/engine/prompt.ts';
import {LOCAGENT_CAPABILITY_PROMPT} from '../../src/experiments/locagent/contracts.ts';
import {analyzeRetrieval} from '../../src/experiments/locagent/traces.ts';
import {materializeCase} from '../materialize.mjs';
import {loadCorpus} from '../corpus.mjs';
import {implementationFingerprint} from '../fingerprint.mjs';
import {assertFrozen} from './freeze.mjs';
const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
if(!args.includes('--live')||!get('--output'))throw Error('Use --live --output OUTSIDE_CHECKOUT [--full --challenge CHALLENGE_OUTPUT]. Offline Stage B is integrations/pi/tests/locagent.test.mjs.');
const config=JSON.parse(await readFile(new URL('./protocol.json',import.meta.url))),{bytes,corpus}=await loadCorpus();
await assertFrozen();
if(sha256(bytes)!==config.corpusSha256)throw Error('Frozen corpus drift');
const key=process.env[config.apiKeyEnvironment];if(!key)throw Error('Configured credential environment is unavailable');
const root=fileURLToPath(new URL('../../',import.meta.url)),output=resolve(get('--output'));
if(args.includes('--full')){const gate=JSON.parse(await readFile(join(resolve(get('--challenge')??''),'summary.json')));if(gate.stageDAllowed!==true)throw Error('Stage C mechanism gate not met');}
await isolatedState(output,root);const lock=await open(join(output,'experiment.lock'),'wx');await lock.close();
const selected=args.includes('--full')?corpus.cases.map(c=>c.id):config.challenge,cases=selected.map(id=>{const c=corpus.cases.find(c=>c.id===id);if(!c)throw Error('Unknown frozen case: '+id);return c;});
const {createPiRuntimeFactory}=await import('../../integrations/pi/src/runtime.ts');
const model={provider:config.provider,modelId:config.modelId},state=join(output,'state');
const raw={schemaVersion:1,kind:'live-model',stage:args.includes('--full')?'D':'C',runStartedAt:new Date().toISOString(),hostContext:{hostname:hostname(),platform:platform(),arch:arch(),node:process.version},implementationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),implementationFingerprint:await implementationFingerprint(),config,protocolSha256:sha256(await readFile(new URL('./protocol.json',import.meta.url))),corpusSha256:sha256(bytes),selected,model,baseSystemPromptSha256:sha256(BASE_SYSTEM_PROMPT),sourceUnchanged:false,runs:[],armAudits:[]};
await writeJson(join(output,'raw.json'),raw);
for(const [caseIndex,item] of cases.entries()){
 const repository=join(output,'repositories',item.id);await materializeCase(item,repository);
 const input={kind:'commits',base:item.baseSha,head:item.headSha},store=await SnapshotStore.freeze({repositoryPath:repository,stateDir:state,input,configuration:{...model,policy:'final_only',promptVersion:1}});
 const armOrder=config.armOrders[caseIndex%3],group=[];
 for(const arm of armOrder){
  if(raw.implementationFingerprint!==await implementationFingerprint())throw Error('Source drift: stopping without replacing attempts');
  const runKey=`${item.id}/0/${arm}`,started=performance.now();console.error(`Running ${runKey}`);
  let entry={runKey,caseId:item.id,arm,repeat:0,kind:'live-model',armOrder,runStartedAt:new Date().toISOString(),snapshotId:store.manifest.identity.id,status:'failed',delivered:false,findings:[],elapsedMs:0};
  try{
   const result=await new ReviewEngine(createPiRuntimeFactory(key)).run({repositoryPath:repository,stateDir:state,input,model,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,evaluation:{tools:{T0:'text-only',G0:'text+graph',G1:'text+locagent'}[arm]}});
   if(result.kind!=='report'||result.report.snapshot.id!==store.manifest.identity.id)throw Error('Snapshot/result drift');
   entry={...entry,status:result.report.status,delivered:true,findings:result.report.findings,report:result.report,manifest:await readRun(state,result.runId)};
   const jsonl=await readFile(join(state,'runs',result.runId,'session.jsonl'),'utf8');
   entry.trace=analyzeRetrieval({runKey,snapshotId:entry.snapshotId,findings:entry.findings,changedPaths:Object.keys(result.report.coverage),jsonl});
  }catch{entry.error='Runtime, delivery, or trace extraction failed; preserve state and do not infer clean.';}
  entry.elapsedMs=performance.now()-started;raw.runs.push(entry);group.push(entry);await writeJson(join(output,'raw.json'),raw);
 }
 const normalized=group.map(r=>r.manifest?.runtimeConfiguration?{...r.manifest.runtimeConfiguration,systemPrompt:r.manifest.runtimeConfiguration.systemPrompt.replace('\n'+NAVIGATION_POLICY_PROMPT+'\n'+GRAPH_CAPABILITY_PROMPT,'').replace('\n'+NAVIGATION_POLICY_PROMPT+'\n'+LOCAGENT_CAPABILITY_PROMPT,'')}:null);
 const verified=normalized.every(Boolean)&&normalized.every(n=>JSON.stringify(n)===JSON.stringify(normalized[0]));
 raw.armAudits.push({caseId:item.id,verified,systemPromptHashes:group.map(r=>({arm:r.arm,sha256:r.manifest?.runtimeConfiguration?sha256(r.manifest.runtimeConfiguration.systemPrompt):null})),normalizedConfiguration:normalized[0]});await writeJson(join(output,'raw.json'),raw);
 if(normalized.every(Boolean)&&!verified)throw Error('Effective arm configuration drift');
}
raw.sourceUnchanged=raw.implementationFingerprint===await implementationFingerprint();await writeJson(join(output,'raw.json'),raw);
await writeJson(join(output,'mapping.json'),raw.runs.map(r=>({runKey:r.runKey,status:r.findings.length?'pending':'complete',reviewer:r.findings.length?'':'No predictions to adjudicate',predictions:r.findings.map(f=>({predictionId:f.id,goldenId:null,rationale:''}))})));
console.log(JSON.stringify({output,runs:raw.runs.length,completed:raw.runs.filter(r=>r.delivered&&r.status==='completed').length,sourceUnchanged:raw.sourceUnchanged}));
