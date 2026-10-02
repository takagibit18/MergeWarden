import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ReviewEngine } from '../src/engine/review.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { SqliteCodeGraph, publishedGraphPath, readGraphEntities, readGraphRelations, GRAPH_SCHEMA_VERSION, DEFAULT_GRAPH_BUDGET, PARSER_VERSION, GRAPH_POLICY_VERSION } from '../src/graph/sqlite-store.ts';
import { RESOLVER_VERSION } from '../src/graph/python-resolver.ts';
import { ROUTING_THRESHOLDS, ROUTING_VERSION } from '../src/engine/routing-contracts.ts';
import { analyzeRetrieval } from '../src/experiments/locagent/traces.ts';
import { implementationFingerprint } from './fingerprint.mjs';
import { createEvaluationRuntimeFactory } from './real/runtime.mjs';
import { sha256 } from '../src/infrastructure/files.ts';
import { BASE_SYSTEM_PROMPT } from '../src/engine/prompt.ts';
import { investigationGuidance, IMPACT_SYNTHESIS_CHECKPOINT } from '../integrations/pi/src/structural-guidance.ts';
import { discoverySummary, discoveryStop, analyzeConversion } from './structural-discovery-analysis.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const [action,outputArg,arg,arm]=process.argv.slice(2);
if(!outputArg)throw Error('Usage: structural-discovery.mjs certify|prepare|run|freeze|relevance-pack|freeze-relevance|finding-pack|analyze OUTSIDE_CHECKOUT [argument] [arm]');
const root=resolve(outputArg),rel=relative(project,root),stateDir=join(root,'state');
if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw Error('Output must be outside checkout');
const model={provider:'bigmodel',modelId:'glm-5.3-flash'};
const budget={timeoutMs:450000,maxTools:100,maxTokens:16384,providerReasoningEffort:'low',thinkingLevel:'medium'};
const variants={A:'pi_structural_v1',B:'pi_structural_v2_investigate',C:'pi_structural_v2_synthesize'};
const configuration={...model,policy:'final_only',promptVersion:1};
const read=async name=>JSON.parse(await readFile(join(root,name),'utf8'));
const write=async(name,value,exclusive=true)=>writeFile(join(root,name),JSON.stringify(value,null,2)+'\n',exclusive?{flag:'wx'}:{});
const exists=async name=>{try{await access(join(root,name));return true;}catch{return false;}};
const hash=async name=>sha256(await readFile(join(root,name)));
const git=(cwd,...args)=>execFileSync('git',['-c','commit.gpgsign=false','-c','core.autocrlf=false','-c','core.hooksPath=/dev/null','-c','user.name=Discovery Fixture','-c','user.email=fixture@example.invalid','-C',cwd,...args],{encoding:'utf8',windowsHide:true}).trim();
const protocol=async()=>{const p=await read('protocol.json');const {identity,...body}=p;if(identity!==sha256(JSON.stringify(body)))throw Error('Protocol digest mismatch');return p;};
async function assertImplementation(p){if(p.implementationCommit!==git(project,'rev-parse','HEAD')||p.implementationFingerprint!==await implementationFingerprint())throw Error('Implementation drift');}
async function assertFrozen(){const f=await read('prediction-freeze.json');for(const file of f.files)if(await hash(file.path)!==file.sha256)throw Error('Prediction drift: '+file.path);return f;}
async function assertRelevance(){await assertFrozen();const f=await read('relevance-freeze.json');if(f.sha256!==await hash('relevance-labels.json'))throw Error('Relevance labels drift');return read('relevance-labels.json');}

if(action==='certify'){
 await mkdir(root,{recursive:true});const log=await readFile(resolve(arg),'utf8');
 // npm verify includes three Node suites and the 20-test Python regression suite.
 const counts=[...log.matchAll(/(?:ℹ|#) tests (\d+)/g)].map(m=>Number(m[1]));
 if(counts.length!==3||[...log.matchAll(/(?:ℹ|#) (?:fail|skipped) (\d+)/g)].some(m=>Number(m[1])!==0)||!log.includes('Ran 20 tests')||!log.includes('OK'))throw Error('Incomplete or failing verify log');
 await write('offline-results.json',{status:'passed',nodeTests:counts,pythonTests:20,passed:counts.reduce((a,b)=>a+b,20),failed:0,skipped:0,implementationFingerprint:await implementationFingerprint(),log:resolve(arg),logSha256:sha256(log)});
 console.log('Offline verification certified');
}else if(action==='prepare'){
 await mkdir(join(root,'private'),{recursive:true});await mkdir(stateDir,{recursive:true});
 const offline=await read('offline-results.json');if(offline.status!=='passed'||offline.failed!==0||offline.skipped!==0||offline.implementationFingerprint!==await implementationFingerprint())throw Error('Verify current implementation first');
 const {cases}=await import('./structural-discovery-cases.mjs');
 const guidance=Object.fromEntries(['CALLER_CHECK','INHERITANCE_CHECK','IMPORT_CHECK','STRUCTURAL_ESCALATION'].map(routeType=>[routeType,investigationGuidance({routeType,targetHint:'<changed-entity>',strength:'high',reason:'frozen-template',relationHint:''})]));
 const p={kind:'structural-discovery-finding-conversion-abc-development',formal:false,holdout:false,synthetic:true,repeat:1,implementationCommit:git(project,'rev-parse','HEAD'),implementationFingerprint:await implementationFingerprint(),routingBaseVersion:ROUTING_VERSION,routingBaseCommit:'c8579410ddcd78ecad06ee9c37a2a341e10087d4',variants,model,budget,routeBudgets:ROUTING_THRESHOLDS,
   tools:['read_diff','read_source','search_text','submit_review','search_entity','traverse_graph'],graph:{mode:'prepared_only',scope:'core',schema:GRAPH_SCHEMA_VERSION,parser:PARSER_VERSION,resolver:RESOLVER_VERSION,policy:GRAPH_POLICY_VERSION,budget:DEFAULT_GRAPH_BUDGET,requiredBuildMs:0},
   prompts:{baselineSha256:sha256(BASE_SYSTEM_PROMPT),investigationGuidance:guidance,investigationGuidanceSha256:sha256(JSON.stringify(guidance)),guidanceModuleSha256:sha256(await readFile(join(project,'integrations/pi/src/structural-guidance.ts'))),synthesisCheckpoint:IMPACT_SYNTHESIS_CHECKPOINT,synthesisCheckpointSha256:sha256(IMPACT_SYNTHESIS_CHECKPOINT)},
   operationalRetry:'No experiment-level automatic retry. Every case/arm is reserved before dispatch and is never overwritten or rerun. Pi native provider retries remain unchanged and are retained in native sessions. Provider failures count as operational failures, never as semantic negatives.',
   stopRules:{discovery:'After first two positive cases complete ABC, stop if all four B/C arms have zero strict traversal-to-source. Do not open references to make this decision.',safety:'After prediction freeze, if C produces false conversion on both clean controls, reject C and do not expand.',unsupported:'After prediction freeze, repeated unsupported C findings where B verified relevant source reject C; no prompt tuning.'},
   metricDefinitions:{R0:'triggered (activation and suppression separately retained)',R1:'structural tool attempted, including hook-blocked attempts',R2:'relation traversal attempted, including hook-blocked attempts',R3:'first Graph exposure of an untouched path/entity',R4:'later successful head read_source covers discovered entity range',R5:'post-freeze source facts necessary to establish or exclude hypothesis; adjudicated without predictions',R6:'accepted finding evidence actually binds the novel read_source result',R7:'R6 plus semantic correctness. Traversal retains existing strict graph-assisted attribution; entity_search requires first Graph exposure, accepted exact evidence with every source reference verified, and no competing path exposure before verification. Modes remain separate.',RF:'clean route has verified novel source and an invalid final finding; broad safety count even without explicit source evidence',novel:'No prior read_diff/search_text/read_source/Graph path exposure, including base revision and Graph hints',strictTraversal:'Existing sourceLinks.strictNovel, additionally joined to route-owned first-exposure verification. Competing text exposure before verification disqualifies strict attribution.',conversion:'correct graph-assisted findings / activated routes with relevant novel source; also report defect-only rate. Null when denominator zero.',missed:'positive relevant novel source verified and no semantically correct finding',attributionGap:'Semantically correct finding without strict graph-assisted evidence is not a conversion and is recorded separately from wrong semantic claims.',falseConversion:'clean route + novel source verified + invalid finding; synthesis subset reported separately'},
   developmentGates:{discoveryRelevantPositiveUnionBC:3,discoveryStrictPositiveUnionBC:2,denominatorPositiveCases:4,conversionDefectRoutesMin:0.5,correctGraphAssistedTarget:2,CFalseConversion:0,cleanCases:2},cases:[],order:[]};
 const references=[];
 for(const [index,s] of cases.entries()){
  const repositoryPath=join(root,'cases',s.id);await mkdir(repositoryPath,{recursive:true});
  let base,head;
  if(s.reuse){const previous=resolve(root,'..','structural-routing-v1-development','cases',s.reuse);git(repositoryPath,'clone','--no-hardlinks',previous,'.');head=git(repositoryPath,'rev-parse','HEAD');base=git(repositoryPath,'rev-parse','HEAD^');}
  else{git(repositoryPath,'init');for(const [path,content] of Object.entries(s.initial))await writeFile(join(repositoryPath,path),content);git(repositoryPath,'add','.');git(repositoryPath,'commit','-m','diagnostic base');base=git(repositoryPath,'rev-parse','HEAD');await writeFile(join(repositoryPath,s.changedPath),s.changed);git(repositoryPath,'add','.');git(repositoryPath,'commit','-m','diagnostic contract change');head=git(repositoryPath,'rev-parse','HEAD');}
  const store=await SnapshotStore.freeze({repositoryPath,stateDir,input:{kind:'commits',base,head},configuration});
  const built=await SqliteCodeGraph.open(store);built.graph.close();const published=await SqliteCodeGraph.openPublishedOnly(store);published.graph.close();
  const db=new DatabaseSync(await publishedGraphPath(stateDir,store.manifest.identity.id),{readOnly:true});
  const entities=readGraphEntities(db,store.manifest.identity.id),relations=readGraphRelations(db,store.manifest.identity.id);db.close();
  const target=entities.find(e=>e.path===s.changedPath&&e.name===s.entity&&e.kind==='function');
  const edges=relations.filter(e=>e.toId===target?.id&&e.sourcePath===s.relevantPath&&e.relation==='CALLS'&&['resolved_scoped','resolved_import_alias'].includes(e.resolution));
  if(!edges.length||store.manifest.changedPaths.includes(s.relevantPath)||store.manifest.base[s.relevantPath]?.hash!==store.manifest.head[s.relevantPath]?.hash)throw Error('Static admission failed: '+s.id);
  const source={};for(const revision of ['base','head']){source[revision]={};for(const [path,file] of Object.entries(store.manifest[revision]))source[revision][path]=await readFile(join(stateDir,'blobs',file.hash),'utf8');}
  const probes={};for(const revision of ['base','head']){const dir=join(root,'private','probes',s.id,revision);await mkdir(dir,{recursive:true});for(const [path,content] of Object.entries(source[revision]))await writeFile(join(dir,path),content);
   const result=spawnSync('python',['-B','-c',s.probe],{cwd:dir,encoding:'utf8',windowsHide:true});probes[revision]={exitCode:result.status,stdout:result.stdout?.trim(),stderr:result.stderr?.trim()};
  }
  if(probes.base.exitCode!==0||probes.base.stdout!==s.baseOutput||(s.headError?probes.head.exitCode===0||!probes.head.stderr.includes(s.headError):probes.head.exitCode!==0||probes.head.stdout!==s.headOutput))throw Error('Reference reproduction failed: '+s.id);
  references.push({id:s.id,positive:s.positive,reference:s.reference,relevantPath:s.relevantPath,relation:'CALLS',direction:'upstream',target,edges,source,probes,base,head,snapshotId:store.manifest.identity.id});
  p.cases.push({id:s.id,positive:s.positive,provenance:s.reuse?'Previously used Routing v1 synthetic development case':'New synthetic diagnostic derivative; selected before live',repositoryPath,base,head,snapshotId:store.manifest.identity.id,changedPaths:store.manifest.changedPaths,generationId:published.manifest.generationId,graphManifestSha256:sha256(JSON.stringify(published.manifest)),admissionSha256:sha256(JSON.stringify(references.at(-1)))});
  for(const arm of [['A','B','C'],['B','C','A'],['C','A','B']][index%3])p.order.push({caseId:s.id,arm});
 }
 await write('private/dev-reference.json',references);p.referenceSha256=await hash('private/dev-reference.json');p.identity=sha256(JSON.stringify(p));await write('protocol.json',p);await write('live-results.json',{protocolIdentity:p.identity,runs:[]});
 console.log(JSON.stringify({cases:p.cases.length,admittedResolvedRelations:references.map(r=>({id:r.id,count:r.edges.length,direction:r.direction})),identity:p.identity}));
}else if(action==='run'){
 const p=await protocol();await assertImplementation(p);if(await exists('prediction-freeze.json'))throw Error('Predictions frozen');
 const results=await read('live-results.json');if(discoveryStop(results.runs))throw Error('Stop Rule 1 reached');
 const next=p.order[results.runs.length];if(next?.caseId!==arg||next?.arm!==arm)throw Error('Order or duplicate violation');
 const c=p.cases.find(c=>c.id===arg),key=process.env.MERGEWARDEN_API_KEY;if(!key?.trim())throw Error('MERGEWARDEN_API_KEY unavailable');
 const offline=await read('offline-results.json');if(offline.status!=='passed'||offline.failed||offline.skipped||offline.implementationFingerprint!==p.implementationFingerprint)throw Error('Offline gate failed');
 const store=await SnapshotStore.load(stateDir,c.snapshotId);const opened=await SqliteCodeGraph.openPublishedOnly(store);opened.graph.close();if(sha256(JSON.stringify(opened.manifest))!==c.graphManifestSha256)throw Error('Graph generation drift');
 const row={caseId:arg,arm,status:'started',startedAt:new Date().toISOString()};results.runs.push(row);await write('live-results.json',results,false);
 try{
  const result=await new ReviewEngine(createEvaluationRuntimeFactory(key,budget)).run({repositoryPath:c.repositoryPath,stateDir,input:{kind:'commits',base:c.base,head:c.head},model,timeoutMs:budget.timeoutMs,maxToolCalls:budget.maxTools,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:variants[arm]}});
  row.runId=result.runId;if(result.kind!=='report'||result.report.snapshot.id!==c.snapshotId)throw Error('Snapshot drift');
  const manifest=JSON.parse(await readFile(join(stateDir,'runs',result.runId,'run.json'),'utf8')),jsonl=await readFile(join(stateDir,'runs',result.runId,'session.jsonl'),'utf8');
  const trace=analyzeRetrieval({runKey:`${arg}/${arm}`,snapshotId:c.snapshotId,findings:result.report.findings,changedPaths:Object.keys(result.report.coverage),jsonl});
  const routingState=jsonl.trim().split('\n').map(JSON.parse).findLast(e=>e.customType==='mergewarden-structural-routing-v1')?.data;
  Object.assign(row,{status:result.report.status,manifest,trace,routingState,findings:result.report.findings,summary:result.report.summary});
  const g=manifest.metrics.graph;if(g.buildMs!==0||g.extractedFiles!==0||g.resolvedFiles!==0||(g.generationId&&g.generationId!==c.generationId))throw Error('Prepared-only violation');
  const expected=BASE_SYSTEM_PROMPT+`\nCurrent working directory: ${stateDir.replaceAll('\\','/')}`;
  if(manifest.runtimeConfiguration.systemPrompt!==expected||manifest.runtimeConfiguration.modelMaxTokens!==budget.maxTokens||manifest.runtimeConfiguration.thinkingLevel!==budget.thinkingLevel||manifest.runtimeConfiguration.providerReasoningEffort!==budget.providerReasoningEffort)throw Error('Runtime configuration drift');
 }catch(error){Object.assign(row,{status:'failed',error:String(error)});}
 row.finishedAt=new Date().toISOString();row.latencyMs=Date.parse(row.finishedAt)-Date.parse(row.startedAt);await write('live-results.json',results,false);
 // Only operational/discovery telemetry is printed before prediction freeze.
 console.log(JSON.stringify({caseId:arg,arm,status:row.status,error:row.error,activated:row.manifest?.metrics?.routing?.activated,strictTraversalSource:discoverySummary(row).strict.length,stopRule1:discoveryStop(results.runs),completedSlots:results.runs.length}));
}else if(action==='freeze'){
 const p=await protocol(),r=await read('live-results.json');await assertImplementation(p);
 if(r.runs.some(r=>r.status==='started')||r.runs.length!==18&&!discoveryStop(r.runs))throw Error('Incomplete experiment without registered stop');
 const paths=['protocol.json','offline-results.json','live-results.json'];
 async function walk(dir){for(const e of await readdir(join(root,dir),{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory())await walk(path);else paths.push(path);}}
 await walk('state/runs');const files=[];for(const path of paths.sort())files.push({path,sha256:await hash(path)});
 await write('prediction-freeze.json',{protocolIdentity:p.identity,frozenAt:new Date().toISOString(),runCount:r.runs.length,stopReason:discoveryStop(r.runs)?'stop_rule_1':null,files,digest:sha256(JSON.stringify(files))});console.log('Predictions and native sessions frozen');
}else if(action==='relevance-pack'){
 await assertFrozen();const p=await protocol();if(await hash('private/dev-reference.json')!==p.referenceSha256)throw Error('Reference drift');
 const refs=await read('private/dev-reference.json'),runs=(await read('live-results.json')).runs;
 const items=[];for(const r of runs){const ref=refs.find(c=>c.id===r.caseId);for(const s of discoverySummary(r).verified){const call=r.trace.calls.find(c=>c.id===s.sourceCallId);items.push({key:`${r.caseId}/${r.arm}`,routeId:s.routeId,path:s.path,sourceCallId:s.sourceCallId,discoveryMode:s.discoveryMode,verifiedSource:call.response,reference:ref.reference,changedSources:Object.fromEntries(['base','head'].map(v=>[v,Object.fromEntries(p.cases.find(c=>c.id===r.caseId).changedPaths.map(path=>[path,ref.source[v][path]]))]))});}}
 await write('relevance-pack.json',{instructions:'Judge source relevance independently of findings. No model findings or summaries are included.',items});console.log(JSON.stringify({relevanceItems:items.length}));
}else if(action==='freeze-relevance'){
 await assertFrozen();const pack=await read('relevance-pack.json'),labels=await read('relevance-labels.json');
 const key=x=>JSON.stringify([x.key,x.routeId,x.path,x.sourceCallId]);
 if(labels.length!==pack.items.length||new Set(labels.map(key)).size!==labels.length||pack.items.some(s=>!labels.some(l=>key(s)===key(l)&&typeof l.relevant==='boolean'&&typeof l.rationale==='string'&&l.rationale.length)))throw Error('Incomplete independent relevance labels');
 await write('relevance-freeze.json',{frozenAt:new Date().toISOString(),sha256:await hash('relevance-labels.json'),packSha256:await hash('relevance-pack.json')});console.log('Independent relevance labels frozen');
}else if(action==='finding-pack'){
 await assertRelevance();const refs=await read('private/dev-reference.json'),runs=(await read('live-results.json')).runs;
 await write('finding-pack.json',runs.map(r=>({key:`${r.caseId}/${r.arm}`,findings:r.findings??[],attribution:r.trace?.findings,reference:refs.find(c=>c.id===r.caseId)})));console.log('Finding adjudication pack prepared');
}else if(action==='analyze'){
 const relevance=await assertRelevance(),p=await protocol(),runs=(await read('live-results.json')).runs,labels=await read('finding-labels.json');
 const predictions=runs.flatMap(r=>(r.findings??[]).map(f=>({key:`${r.caseId}/${r.arm}`,findingId:f.id})));
 if(labels.length!==predictions.length||new Set(labels.map(l=>JSON.stringify([l.key,l.findingId]))).size!==labels.length||predictions.some(f=>!labels.some(l=>l.key===f.key&&l.findingId===f.findingId&&typeof l.correct==='boolean'&&l.rationale)))throw Error('Incomplete semantic labels');
 const rows=runs.map(r=>{const key=`${r.caseId}/${r.arm}`,positive=p.cases.find(c=>c.id===r.caseId).positive,d=discoverySummary(r),conversion=analyzeConversion(r,relevance.filter(l=>l.key===key),labels.filter(l=>l.key===key),positive);return {caseId:r.caseId,arm:r.arm,positive,status:r.status,triggered:r.manifest?.metrics.routing?.triggered??0,activated:r.manifest?.metrics.routing?.activated??0,structuralAttempt:d.episodes.some(e=>e.R1),traversal:d.episodes.some(e=>e.R2),novelEntities:d.discoveries.length,novelSource:d.verified.length,entitySearchSource:d.entitySearchToSource.length,traversalSource:d.traversalToSource.length,strictTraversalSource:d.strict.length,...conversion,costs:{...r.trace?.metrics,latencyMs:r.latencyMs}};});
 const byArm=Object.fromEntries(['A','B','C'].map(arm=>{const a=rows.filter(r=>r.arm===arm),activated=a.reduce((n,r)=>n+r.activated,0),eligible=a.flatMap(r=>r.episodes).filter(e=>e.R5).length,defectEligible=a.filter(r=>r.positive).flatMap(r=>r.episodes).filter(e=>e.R5).length,correct=a.reduce((n,r)=>n+r.correctGraphAssisted,0);return [arm,{runs:a.length,activatedRoutes:activated,relevantRoutes:eligible,relevantNovelSourceRate:activated?eligible/activated:null,strictPositiveCases:a.filter(r=>r.positive&&r.strictTraversalSource>0).length,correctGraphAssisted:correct,conversion:eligible?correct/eligible:null,defectConversion:defectEligible?correct/defectEligible:null,missedConversion:a.filter(r=>r.missedConversion).length,falseConversion:a.filter(r=>!r.positive&&r.falseConversion).length,cleanCases:a.filter(r=>!r.positive).length}];}));
 const bc=rows.filter(r=>r.positive&&['B','C'].includes(r.arm));const relevantUnion=new Set(bc.filter(r=>r.sourceCount).map(r=>r.caseId)).size,strictUnion=new Set(bc.filter(r=>r.strictTraversalSource).map(r=>r.caseId)).size;
 const denom=bc.flatMap(r=>r.episodes).filter(e=>e.R5).length,numerator=bc.reduce((n,r)=>n+r.correctGraphAssisted,0);
 const gates={discovery:{relevantPositiveUnion:relevantUnion,strictPositiveUnion:strictUnion,passed:relevantUnion>=3&&strictUnion>=2},conversion:{numerator,denominator:denom,rate:denom?numerator/denom:null,passed:denom>0&&numerator/denom>=0.5,targetMet:numerator>=2},safety:{falseConversion:byArm.C.falseConversion,cleanCases:byArm.C.cleanCases,passed:byArm.C.cleanCases===2&&byArm.C.falseConversion===0}};
 await write('diagnostic-analysis.json',{title:'Structural Discovery & Finding Conversion Diagnostic',protocolIdentity:p.identity,predictionDigest:(await read('prediction-freeze.json')).digest,relevanceSha256:await hash('relevance-labels.json'),findingLabelsSha256:await hash('finding-labels.json'),rows,byArm,gates,stopRule1:discoveryStop(runs),limitedTo:'Preselected synthetic development cases, one attempt per arm. No holdout, no formal evaluation, no causal or population-level recall claim.'});console.log(JSON.stringify({byArm,gates}));
}else throw Error('Unknown action');
