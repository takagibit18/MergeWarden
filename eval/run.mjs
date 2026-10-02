import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewEngine } from '../src/engine/review.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { readRun } from '../src/engine/reports.ts';
import { isolatedState, sha256, writeJson } from '../src/infrastructure/files.ts';
import { BASE_SYSTEM_PROMPT, GRAPH_CAPABILITY_PROMPT, NAVIGATION_POLICY_PROMPT } from '../src/engine/prompt.ts';
import { score } from '../src/eval/metrics.ts';
import { materializeCase } from './materialize.mjs';
import { loadCorpus } from './corpus.mjs';
import { implementationFingerprint } from './fingerprint.mjs';
const args=process.argv.slice(2);const get=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const {bytes,corpus}=await loadCorpus(get('--corpus'));
const config=JSON.parse(await readFile(new URL('./experiment.json',import.meta.url),'utf8'));
if(!get('--output'))throw Error('Use --output OUTSIDE_CHECKOUT plus --offline or --live, optionally --cases ID,ID and --repeats N. Score using --score and --mapping FILE.');
const output=resolve(get('--output'));
if(args.includes('--score')){
 const raw=JSON.parse(await readFile(join(output,'raw.json'),'utf8'));const mappings=JSON.parse(await readFile(resolve(get('--mapping')??join(output,'mapping.json')),'utf8'));
 if(raw.corpusSha256!==sha256(bytes))throw Error('Result corpus mismatch; select the original frozen directory with --corpus');
 if(raw.sourceUnchanged!==true||!raw.pairAudits?.every(p=>p.verified))throw Error('A/B implementation/configuration freeze was not verified');
 await writeJson(join(output,'metrics.json'),score(corpus.cases,raw.runs,mappings));console.log('Saved adjudicated metrics.');
}else{
 const live=args.includes('--live');if(live===args.includes('--offline'))throw Error('Select exactly one --live or --offline');
 const key=live?process.env[config.apiKeyEnvironment]:undefined;if(live&&!key)throw Error(`Explicit key variable ${config.apiKeyEnvironment} is unavailable`);
 const selected=args.includes('--all')?corpus.cases.map(c=>c.id):get('--cases')?.split(',')??config.defaultSmokeCases;const cases=selected.map(id=>{const c=corpus.cases.find(c=>c.id===id);if(!c)throw Error(`Unknown case ${id}`);return c;});if(new Set(selected).size!==cases.length)throw Error('Duplicate case');
 const repeats=Number(get('--repeats')??1);if(!Number.isInteger(repeats)||repeats<1||repeats>20)throw Error('repeats must be 1..20');
 const root=fileURLToPath(new URL('../',import.meta.url));await isolatedState(output,root);
 const claim=await import('node:fs/promises');const marker=await claim.open(join(output,'experiment.lock'),'wx');await marker.close();
 const {createPiRuntimeFactory,createPiRuntime}=await import('../integrations/pi/src/runtime.ts');
 const model=live?{provider:config.provider,modelId:config.modelId}:{provider:'fixture',modelId:'offline'};
 const state=join(output,'state');const raw={schemaVersion:1,kind:live?'live-model':'scripted-offline',corpusSha256:sha256(bytes),config,model,selected,repeats,baselinePromptSha256:sha256(BASE_SYSTEM_PROMPT),navigationPolicySha256:sha256(NAVIGATION_POLICY_PROMPT),graphCapabilitySha256:sha256(GRAPH_CAPABILITY_PROMPT),locks:{},runs:[],pairAudits:[]};
 raw.implementationFingerprint=await implementationFingerprint();raw.sourceUnchanged=false;
 for(const p of ['package-lock.json','integrations/pi/package-lock.json','integrations/tree-sitter/package-lock.json'])raw.locks[p]=sha256(await readFile(new URL('../'+p,import.meta.url)));
 await writeJson(join(output,'raw.json'),raw);
 for(const item of cases){
  const repository=join(output,'repositories',item.id);await materializeCase(item,repository);
  const input={kind:'commits',base:item.baseSha,head:item.headSha};
  const store=await SnapshotStore.freeze({repositoryPath:repository,stateDir:state,input,configuration:{provider:model.provider,modelId:model.modelId,policy:'final_only',promptVersion:1}});
  for(let repeat=0;repeat<repeats;repeat++){
   const pair=[];for(const arm of repeat%2?['text+graph','text-only']:['text-only','text+graph']){
    const runKey=`${item.id}/${repeat}/${arm}`;console.error(`Running ${runKey} (${raw.kind})`);const started=performance.now();
    let entry={runKey,caseId:item.id,arm,repeat,kind:raw.kind,snapshotId:store.manifest.identity.id,status:'failed',delivered:false,findings:[],elapsedMs:0};
    try{
     let factory;if(live)factory=createPiRuntimeFactory(key);else{const {offlineProvider}=await import('./offline-provider.mjs');const runtime=await offlineProvider(store.manifest.changedPaths,item.relevantLocation.path.replace(/\.py$/,'').replaceAll('/','.'));factory=o=>createPiRuntime(o,runtime);}
     const result=await new ReviewEngine(factory).run({repositoryPath:repository,stateDir:state,input,model,timeoutMs:config.timeoutMs,maxToolCalls:config.maxToolCalls,evaluation:{tools:arm}});
     if(result.kind!=='report')throw Error('Golden case unexpectedly has no change');
     if(result.report.snapshot.id!==store.manifest.identity.id)throw Error('Snapshot drift across evaluation arms');
     entry={...entry,status:result.report.status,delivered:true,findings:result.report.findings,manifest:await readRun(state,result.runId),report:result.report,elapsedMs:performance.now()-started};
    }catch(error){if(!live)console.error(error);entry.error='Review setup/runtime/delivery failed; inspect this case state. No clean result inferred.';entry.elapsedMs=performance.now()-started;}
    raw.runs.push(entry);pair.push(entry);await writeJson(join(output,'raw.json'),raw);
   }
   const normalized=pair.map(r=>r.manifest?.runtimeConfiguration?{...r.manifest.runtimeConfiguration,systemPrompt:r.manifest.runtimeConfiguration.systemPrompt.replace('\n'+NAVIGATION_POLICY_PROMPT+'\n'+GRAPH_CAPABILITY_PROMPT,'')}:null);
   const verified=normalized.every(Boolean)&&JSON.stringify(normalized[0])===JSON.stringify(normalized[1]);
   raw.pairAudits.push({caseId:item.id,repeat,snapshotId:store.manifest.identity.id,verified,normalizedConfigurationSha256:verified?sha256(JSON.stringify(normalized[0])):null});await writeJson(join(output,'raw.json'),raw);
   if(normalized.every(Boolean)&&!verified)throw Error('A/B effective configuration drift; results cannot be compared');
  }
 }
 raw.sourceUnchanged=raw.implementationFingerprint===await implementationFingerprint();await writeJson(join(output,'raw.json'),raw);
 if(!raw.sourceUnchanged)throw Error('Implementation changed during the experiment; do not compare these results');
 const mapping=raw.runs.map(r=>({runKey:r.runKey,status:r.findings.length?'pending':'complete',reviewer:r.findings.length?'':'No predictions to adjudicate',predictions:r.findings.map(f=>({predictionId:f.id,goldenId:null,rationale:''}))}));
 await writeJson(join(output,'mapping.json'),mapping);
 if(raw.runs.every(r=>!r.findings.length))await writeJson(join(output,'metrics.json'),score(corpus.cases,raw.runs,mapping));
 console.log(JSON.stringify({output,kind:raw.kind,runs:raw.runs.length,completed:raw.runs.filter(r=>r.delivered&&r.status==='completed').length,adjudicationPending:mapping.some(m=>m.status==='pending')},null,2));
}
