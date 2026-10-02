import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewEngine } from '../src/engine/review.ts';
import { SnapshotStore } from '../src/snapshot/store.ts';
import { SqliteCodeGraph, GRAPH_SCHEMA_VERSION, DEFAULT_GRAPH_BUDGET, PARSER_VERSION, GRAPH_POLICY_VERSION } from '../src/graph/sqlite-store.ts';
import { RESOLVER_VERSION } from '../src/graph/python-resolver.ts';
import { ROUTING_THRESHOLDS, ROUTING_VERSION } from '../src/engine/routing-contracts.ts';
import { analyzeRetrieval } from '../src/experiments/locagent/traces.ts';
import { implementationFingerprint } from './fingerprint.mjs';
import { createEvaluationRuntimeFactory } from './real/runtime.mjs';
import { sha256 } from '../src/infrastructure/files.ts';
import { BASE_SYSTEM_PROMPT, NAVIGATION_POLICY_PROMPT, GRAPH_CAPABILITY_PROMPT } from '../src/engine/prompt.ts';
import { LOCAGENT_CAPABILITY_PROMPT } from '../src/experiments/locagent/contracts.ts';
import { graphNovelSourceChains } from './structural-routing-funnel.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const [action,outputArg,caseId,group]=process.argv.slice(2);
if(!outputArg) throw Error('Usage: structural-routing.mjs prepare|run|analyze OUTSIDE_CHECKOUT [CASE A|B]');
const root=resolve(outputArg),rel=relative(project,root);
if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw Error('Output must be outside checkout');
const stateDir=join(root,'state');
const model={provider:'bigmodel',modelId:'glm-5.3-flash'};
const budget={timeoutMs:450000,maxTools:100,maxTokens:16384,providerReasoningEffort:'low',thinkingLevel:'medium'};
const configuration={...model,policy:'final_only',promptVersion:1};
const specs=[
 {id:'P1-signature-caller',positive:true,intent:'caller',initial:{'core.py':'def normalize_key(key):\n    return key.strip().lower()\n','cache.py':'from core import normalize_key\nCACHE = {"ready": 1}\ndef lookup(key):\n    return CACHE[normalize_key(key)]\n'},path:'core.py',changed:'def normalize_key(key, mode):\n    return key.strip().lower() if mode else key\n',sanity:'Untouched lookup calls normalize_key with one argument and now raises TypeError.'},
 {id:'P2-inheritance',positive:true,intent:'inheritance',initial:{'base.py':'class Reader:\n    def read(self):\n        return "data"\n\nclass Marker:\n    pass\n','service.py':'from base import Reader, Marker\nclass Service(Reader):\n    pass\n','client.py':'from service import Service\ndef load():\n    return Service().read()\n'},path:'service.py',changed:'from base import Reader, Marker\nclass Service(Marker):\n    pass\n',sanity:'Service loses Reader.read; client.load raises AttributeError.'},
 {id:'P3-multihop',positive:true,intent:'multi-hop caller',initial:{'core.py':'def encode(value):\n    return str(value)\n','adapter.py':'from core import encode\ndef serialize(value):\n    return encode(value)\n','api.py':'from adapter import serialize\ndef response(value):\n    return serialize(value)\n'},path:'core.py',changed:'def encode(value, format):\n    return str(value) if format == "text" else bytes(value)\n',sanity:'serialize still calls encode with one argument; API response transitively fails.'},
 {id:'P4-return-search-pressure',positive:true,intent:'weak return-shape / retrieval feedback opportunity',initial:{'core.py':'def normalize_key(key):\n    return key.strip().lower()\n','cache.py':'from core import normalize_key\nCACHE = {"ready": 1}\ndef lookup(key):\n    normalized = normalize_key(key)\n    return CACHE.get(normalized, 0)\n','batch.py':'from cache import lookup\ndef total(keys):\n    return sum(lookup(key) for key in keys)\n'},path:'core.py',changed:'def normalize_key(key):\n    return [key.strip().lower()]\n',sanity:'normalize_key returns an unhashable list; cache.lookup raises TypeError. A direct text/source solution is valid; do not force searches.'},
 {id:'N1-local-defect',positive:false,intent:'local-only defect',initial:{'app.py':'def ratio(total, count):\n    return total / max(count, 1)\n'},path:'app.py',changed:'def ratio(total, count):\n    return total / count\n',sanity:'count=0 raises ZeroDivisionError; entirely local.'},
 {id:'N2-clean-local',positive:false,intent:'clean local change',initial:{'app.py':'def add(a,b):\n    return a + b\n'},path:'app.py',changed:'def add(a,b):\n    # Addition is commutative for these numeric inputs.\n    return a + b\n',sanity:'Comment-only change, no introduced defect.'},
 {id:'N3-exact-text-sufficient',positive:false,intent:'text exact search already sufficient',initial:{'settings.py':'DEFAULT_TIMEOUT = 10\n','worker.py':'from settings import DEFAULT_TIMEOUT\ndef timeout():\n    return DEFAULT_TIMEOUT\n'},path:'settings.py',changed:'DEFAULT_TIMEOUT = 20\n',sanity:'Positive timeout default changes from 10 to 20; no specified contract violated. Exact name search reveals sole consumer.'},
 {id:'N4-crossfile-looking-local',positive:false,intent:'cross-file appearance without relationship risk',initial:{'app.py':'from helpers import increment\ndef calculate(value):\n    return increment(value)\n','helpers.py':'def increment(value):\n    return value + 1\n'},path:'app.py',changed:'from helpers import increment\ndef calculate(value):\n    result = increment(value)\n    return result\n',sanity:'Equivalent local variable extraction; no introduced defect.'},
];
const read=async name=>JSON.parse(await readFile(join(root,name),'utf8'));
const write=async(name,value,exclusive=false)=>writeFile(join(root,name),JSON.stringify(value,null,2)+'\n',exclusive?{flag:'wx'}:{});
const git=(cwd,...args)=>execFileSync('git',['-c','commit.gpgsign=false','-c','core.autocrlf=false','-c','core.hooksPath=/dev/null','-c','user.name=Routing Fixture','-c','user.email=fixture@example.invalid','-C',cwd,...args],{encoding:'utf8',windowsHide:true}).trim();
if(action==='prepare'){
 await mkdir(root,{recursive:true});await mkdir(stateDir,{recursive:true});
 const protocol={kind:'structural-routing-v1-development',holdout:false,formal:false,repeat:1,implementationCommit:git(project,'rev-parse','HEAD'),implementationFingerprint:await implementationFingerprint(),model,budget,routingVersion:ROUTING_VERSION,routeThresholds:ROUTING_THRESHOLDS,graph:{schema:GRAPH_SCHEMA_VERSION,parser:PARSER_VERSION,resolver:RESOLVER_VERSION,policy:GRAPH_POLICY_VERSION,budget:DEFAULT_GRAPH_BUDGET,mode:'prepared_only'},prompts:{baseline:BASE_SYSTEM_PROMPT,A:BASE_SYSTEM_PROMPT+'\n'+NAVIGATION_POLICY_PROMPT+'\n'+LOCAGENT_CAPABILITY_PROMPT,B:BASE_SYSTEM_PROMPT},cases:[],order:[],acceptance:{positiveTriggered:3,negativeUnnecessaryMax:1,positiveNovelSourceMin:2},findingScoring:'sanity only; no F1'};
 for(const [index,s] of specs.entries()){
  const repositoryPath=join(root,'cases',s.id);await mkdir(repositoryPath,{recursive:true});git(repositoryPath,'init');
  for(const [path,content] of Object.entries(s.initial)){await mkdir(resolve(repositoryPath,path,'..'),{recursive:true});await writeFile(join(repositoryPath,path),content);}
  git(repositoryPath,'add','.');git(repositoryPath,'commit','-m','synthetic base');const base=git(repositoryPath,'rev-parse','HEAD');
  await writeFile(join(repositoryPath,s.path),s.changed);git(repositoryPath,'add','.');git(repositoryPath,'commit','-m','synthetic change');const head=git(repositoryPath,'rev-parse','HEAD');
  const store=await SnapshotStore.freeze({repositoryPath,stateDir,input:{kind:'commits',base,head},configuration});
  const built=await SqliteCodeGraph.open(store);built.graph.close();const published=await SqliteCodeGraph.openPublishedOnly(store);published.graph.close();
  protocol.cases.push({id:s.id,positive:s.positive,intent:s.intent,synthetic:true,repositoryPath,base,head,snapshotId:store.manifest.identity.id,changedPaths:store.manifest.changedPaths,generationId:published.manifest.generationId,sanity:s.sanity});
  for(const group of index%2?['B','A']:['A','B'])protocol.order.push({caseId:s.id,group});
 }
 protocol.identity=sha256(JSON.stringify(protocol));await write('protocol.json',protocol,true);await write('live-results.json',{protocolIdentity:protocol.identity,runs:[]},true);
 console.log(JSON.stringify({prepared:8,protocolIdentity:protocol.identity}));
}else if(action==='run'){
 const protocol=await read('protocol.json');const results=await read('live-results.json');const spec=protocol.cases.find(c=>c.id===caseId);
 if(!spec||!['A','B'].includes(group))throw Error('Unknown preselected case/group');
 if(protocol.implementationCommit!==git(project,'rev-parse','HEAD')||protocol.implementationFingerprint!==await implementationFingerprint())throw Error('Implementation drift');
 const offline=await read('offline-results.json');if(offline.status!=='passed'||offline.failed!==0||offline.skipped!==0||offline.implementationFingerprint!==protocol.implementationFingerprint)throw Error('Deterministic acceptance gate not met');
 const next=protocol.order[results.runs.length];if(next?.caseId!==caseId||next?.group!==group)throw Error('First-attempt order/duplicate violation');
 if(results.runs.filter(r=>r.group==='B'&&!protocol.cases.find(c=>c.id===r.caseId).positive&&r.manifest?.metrics?.routing?.activated>0).length>1)throw Error('Negative overactivation stop rule');
 const key=process.env.MERGEWARDEN_API_KEY;if(!key?.trim())throw Error('Explicit MERGEWARDEN_API_KEY unavailable');
 const store=await SnapshotStore.load(stateDir,spec.snapshotId);const published=await SqliteCodeGraph.openPublishedOnly(store);published.graph.close();if(published.manifest.generationId!==spec.generationId)throw Error('Graph generation drift');
 const row={caseId,group,status:'started',startedAt:new Date().toISOString()};results.runs.push(row);await write('live-results.json',results);
 try{
  const runtimeFactory=createEvaluationRuntimeFactory(key,budget);
  const result=await new ReviewEngine(runtimeFactory).run({repositoryPath:spec.repositoryPath,stateDir,input:{kind:'commits',base:spec.base,head:spec.head},model,timeoutMs:budget.timeoutMs,maxToolCalls:budget.maxTools,evaluation:{tools:'text+locagent',graphMode:'prepared_only',routing:group==='A'?'none':'pi_structural_v1'}});
  if(result.kind!=='report'||result.report.snapshot.id!==spec.snapshotId)throw Error('Snapshot drift');
  const manifest=JSON.parse(await readFile(join(stateDir,'runs',result.runId,'run.json'),'utf8'));const jsonl=await readFile(join(stateDir,'runs',result.runId,'session.jsonl'),'utf8');
  const trace=analyzeRetrieval({runKey:`${caseId}/${group}`,snapshotId:spec.snapshotId,findings:result.report.findings,changedPaths:Object.keys(result.report.coverage),jsonl});
  const g=manifest.metrics.graph;if(g.buildMs!==0||g.extractedFiles!==0||g.resolvedFiles!==0||(g.generationId&&g.generationId!==spec.generationId))throw Error('Prepared-only violation');
  const expected=protocol.prompts[group]+`\nCurrent working directory: ${stateDir.replaceAll('\\','/')}`;
  if(manifest.runtimeConfiguration.systemPrompt!==expected||manifest.runtimeConfiguration.modelMaxTokens!==budget.maxTokens||manifest.runtimeConfiguration.thinkingLevel!==budget.thinkingLevel)throw Error('Runtime configuration drift');
  Object.assign(row,{status:result.report.status,runId:result.runId,manifest,trace,graphNovelSourceChains:graphNovelSourceChains(trace,spec.snapshotId,spec.changedPaths),findings:result.report.findings,summary:result.report.summary,findingSanity:result.report.findings.length?'uncertain':'none',finishedAt:new Date().toISOString()});
 }catch(error){Object.assign(row,{status:'failed',error:String(error),finishedAt:new Date().toISOString()});}
 await write('live-results.json',results);console.log(JSON.stringify({caseId,group,status:row.status,routing:row.manifest?.metrics?.routing,graphCalls:row.trace?.metrics.graphCalls,novelToSource:row.trace?.metrics.novelEntityToSource}));
}else if(action==='analyze'){
 const protocol=await read('protocol.json'),results=await read('live-results.json');
 const rows=results.runs.map(r=>{const routing=r.manifest?.metrics?.routing,m=r.trace?.metrics;return {caseId:r.caseId,group:r.group,positive:protocol.cases.find(c=>c.id===r.caseId).positive,status:r.status,triggered:routing?.triggered??0,activated:routing?.activated??0,suppressed:routing?.suppressed??0,navigationAttempted:r.manifest?.metrics?.navigation?.attempted??false,graphCalls:m?.graphCalls??0,novelEntities:m?.novelEntities??0,novelSourceVerification:r.graphNovelSourceChains?.length??0,strictTraversalNovelSource:m?.novelEntityToSource??0,routeVerified:routing?.verified??0,graphAssistedFindings:m?.graphAssistedFindings??0,triggerWithoutUse:(routing?.activated??0)>0&&!(r.manifest?.metrics?.navigation?.attempted),graphWithoutNovelVerification:(m?.graphCalls??0)>0&&!r.graphNovelSourceChains?.length,findingSanity:r.findingSanity??'uncertain'};});
 const b=rows.filter(r=>r.group==='B');const gates={allCompleted:rows.length===16&&rows.every(r=>r.status==='completed'),positiveTriggered:b.filter(r=>r.positive&&r.triggered>0).length,negativeActivated:b.filter(r=>!r.positive&&r.activated>0).length,positiveNovelSource:b.filter(r=>r.positive&&r.novelSourceVerification>0).length};
 await write('routing-analysis.json',{kind:protocol.kind,protocolIdentity:protocol.identity,implementationCommit:protocol.implementationCommit,implementationFingerprint:protocol.implementationFingerprint,gates,developmentMechanismPass:gates.allCompleted&&gates.positiveTriggered>=3&&gates.negativeActivated<=1&&gates.positiveNovelSource>=2,rows,limitations:['Eight synthetic development cases, not holdout or formal benchmark.','One first attempt per arm; no statistical quality claim.','Model may solve weak-return cases directly through text; no forced Graph.','Finding semantic labels require source review; never inferred from routing.']});
 console.log(JSON.stringify(gates));
}else throw Error('Unknown action');
