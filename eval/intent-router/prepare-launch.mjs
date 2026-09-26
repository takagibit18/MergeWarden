import {mkdir,readdir,readFile} from 'node:fs/promises';
import {join,resolve,toNamespacedPath} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {publishedGraphPath} from '../../src/graph/sqlite-store.ts';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {EXPERIMENT,GATE,MODEL_CONFIG,OUTPUT_SCHEMA} from './contracts.mjs';
const out=resolve(process.argv[2]),history=resolve(process.argv[3]),repo=resolve(import.meta.dirname,'../..'),outputs=resolve(out,'..');
assert.equal((await read(join(out,'baseline.json'))).exitCode,0);assert.equal((await readFile(join(out,'baseline-exit.txt'),'utf8')).trim(),'0');
await mkdir(join(out,'phase-a'));
const universe=await read(join(history,'universe.json')),oldFreeze=await read(join(history,'phase-a-v2/diagnostic-freeze.json')),replay=await read(join(history,'phase-a-v2/route-replay.json'));
const relocate=p=>{const s=p.replaceAll('\\','/').split('/output/')[1];assert(s,'Expected registered historical output path');return join(outputs,s);};
const oldFiles=oldFreeze.files.map(f=>({...f,path:relocate(f.path)}));await checkIdentities(oldFiles);
const seen=new Set(),cases=[],fastPath=[],duplicates=[];
for(const p of universe.plans){const key=JSON.stringify([p.repository,p.baseSha,p.reviewedSha]);if(seen.has(key)){duplicates.push(p.caseId);continue;}seen.add(key);
  const r=replay.find(r=>r.caseId===p.caseId);assert(r);if(r.routeTriggered){fastPath.push({caseId:p.caseId,group:p.group,summary:r.summary});continue;}
  const prefixPath=join(history,'phase-a-v2/route-prefixes',p.caseId+'.json'),frozen=oldFiles.find(f=>f.path===prefixPath);assert(frozen);await checkIdentities([frozen]);
  const state=relocate(p.state),snapshotPath=join(state,'snapshots',p.snapshotId+'.json');let graphPath=null,availability=null;
  try{graphPath=await publishedGraphPath(state,p.snapshotId);}catch(e){availability=String(e.message);}
  const snapshotIdentity=await identity(snapshotPath);const expected=p.snapshotSha256??p.historicalArtifactIdentity?.snapshot?.sha256;if(expected)assert.equal(snapshotIdentity.sha256,expected);
  const graphIdentity=graphPath?await identity(graphPath):null;if(p.graphSha256&&graphIdentity)assert.equal(graphIdentity.sha256,p.graphSha256);
  cases.push({caseId:p.caseId,group:p.group==='CLEAN_CONTROL'?'clean':'defect',repo:p.repository,baseSha:p.baseSha,reviewedSha:p.reviewedSha,snapshotId:p.snapshotId,generationId:p.generationId,changedPaths:p.changedPaths,state,prefixPath,prefixHash:frozen.sha256,snapshotPath,snapshotIdentity,graphPath,graphIdentity,availability,expectedSummary:r.summary});
}
cases.sort((a,b)=>hash(EXPERIMENT+a.caseId).localeCompare(hash(EXPERIMENT+b.caseId)));cases.forEach((p,i)=>p.alias='SR'+String(i+1).padStart(2,'0'));
const files=[...oldFiles.filter(f=>f.path.includes('route-prefixes')||f.path.endsWith('route-replay.json')),await identity(join(history,'universe.json')),await identity(join(history,'phase-a-v2/diagnostic-freeze.json'))];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(await identity(p));}}
await walk(join(repo,'src'));await walk(join(repo,'integrations/pi/src'));await walk(import.meta.dirname);files.push(await identity(join(repo,'eval/candidate-dataset-context.mjs')));
for(const c of cases){files.push(c.snapshotIdentity);if(c.graphIdentity)files.push(c.graphIdentity);}
const denied=[join(outputs,'realgolden40-closure/corpus-v1-final/hidden/gold.jsonl'),join(history,'phase-b'),join(outputs,'semantic-router-shadow-20260925'),join(outputs,'semantic-router-seven-case-reassessment-20260925'),join(out,'phase-c-private')];
await save(join(out,'protocol.json'),{identity:EXPERIMENT,baseline:'e60aa3715cebf3c9007e66948fe5d98cd304505f',gate:GATE,model:MODEL_CONFIG,schema:OUTPUT_SCHEMA,primary:'Every unique frozen no-route case; exact historical public prefix; no post-result case selection',checkpoint:'Capability at frozen diagnostic checkpoint, not product invocation timing',phases:'A public admission/input freeze -> B independent first-attempt predictions/freeze -> C private target and legal intent oracle -> D frozen plan execution and scoring',oracle:{maxPlans:32,order:'resolved ChangeUnit order then declared intent order; no target-aware ordering',classCaller:'Supported by existing PythonResolver CALLS targets for classes; no per-case relation query in Phase A'},execution:{singleInvestigation:{nodes:30,edges:200,states:200,predecessors:2},maxEpisodes:2,maxStructuralCallsPerEpisode:4,maxStructuralCallsTotal:6,sourceWindow:80,packageBytes:24576},firstAttempt:{retry:false,repair:false,repeat:false,independentSessions:true},forbidden:['product changes','candidate chooser','small model','Jev','Review E2E','private inputs before prediction freeze'],priorKnowledge:'Development corpus with prior conversation familiarity; isolation is process/data-flow protection, not an independent holdout.'});
await save(join(out,'public-preparation-freeze.json'),{identity:EXPERIMENT,cases,fastPath,duplicates,files:[...new Map(files.map(f=>[f.path,f])).values()],denied});
await save(join(out,'known-mechanical-limitations.json'),{cases:['RG2-4a160b6ffdca','RG2-d90aec196340'],reason:'Existing deterministic route-hit cases with scope ambiguity; outside semantic fallback primary; resolver unchanged.'});
const allowed=[import.meta.dirname,join(repo,'eval/candidate-dataset-context.mjs'),join(repo,'src'),join(repo,'integrations/pi/src'),join(repo,'integrations/pi/package.json'),join(repo,'package.json'),join(out,'public-preparation-freeze.json'),join(out,'phase-a'),join(history,'phase-a-v2/route-prefixes'),...cases.map(c=>c.snapshotPath),...cases.flatMap(c=>c.graphPath?[c.graphPath]:[])];
const paths=[...new Set(allowed.flatMap(p=>[p,toNamespacedPath(p)]))];await save(join(out,'phase-a-access-policy.json'),{read:paths,write:[join(out,'phase-a')],denied,child:false,modelCalls:0,graphTraversal:false,graphRead:'Immutable symbols for exact ChangeUnit resolution only'});
const child=spawnSync(process.execPath,['--experimental-strip-types','--permission',...paths.map(p=>'--allow-fs-read='+p),'--allow-fs-write='+join(out,'phase-a'),join(import.meta.dirname,'prepare.mjs'),out],{cwd:repo,encoding:'utf8',maxBuffer:2e6});
process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');await save(join(out,'public-preparation-exit.json'),{exit:child.status,error:child.error?.message??null});assert.equal(child.status,0);await checkIdentities(files);
for(const name of ['universe','public-admission','case-order'])await save(join(out,name+'.json'),await read(join(out,'phase-a',name+'.json')));
