import {join,resolve} from 'node:path';import {readdir,readFile,mkdir} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
import {publishedGraphPath} from '../src/graph/sqlite-store.ts';
import {read,save,identity,hash} from './candidate-dataset-context.mjs';
import {TEXT_POLICY} from './route-utility-text.mjs';import {GRAPH_POLICY} from './route-utility-graph.mjs';
const out=resolve(process.argv[2]),old=resolve(out,'..'),repo=resolve(import.meta.dirname,'..'),prior=join(old,'real-route-recall-diagnostic-20260925');
const primary=['RG2-839ef2d1d5e7','RG2-a9c1aeef17ff','RG2-596759970761','RG2-9c055717e08c','RG2-1f682ac2d7bb','RG2-5630e88a4931','RG2-9f0808408a1d'];
const {plans:historical}=await read(join(prior,'universe.json')),route=await read(join(prior,'phase-a-v2/route-replay.json'));
const registrations=[],plans=[],exclusions=[],seen=new Set(),inputs=[];
for(const p of historical.filter(p=>p.group==='DEFECT_ROUTE_MISS'||p.group==='CLEAN_CONTROL').sort((a,b)=>a.caseId.localeCompare(b.caseId))){
 const key=JSON.stringify([p.repository,p.baseSha,p.reviewedSha]),idx=primary.indexOf(p.caseId),alias=idx<0?'S'+String(registrations.filter(r=>!r.primary).length+1).padStart(2,'0'):'R0'+(idx+1);
 if(seen.has(key)){exclusions.push({caseId:p.caseId,reason:'DUPLICATE_UNDERLYING_CASE'});continue;}seen.add(key);
 try{
   const prefixPath=join(prior,'phase-a-v2/route-prefixes',p.caseId+'.json'),prefix=await read(prefixPath),graphPath=await publishedGraphPath(p.state,p.snapshotId),snapshotPath=join(p.state,'snapshots',p.snapshotId+'.json');
   assert.equal(prefix.snapshotId,p.snapshotId);const db=new DatabaseSync(graphPath,{readOnly:true});try{assert.equal(db.prepare('SELECT generation_id FROM graph_snapshots WHERE snapshot_id=?').get(p.snapshotId).generation_id,p.generationId);}finally{db.close();}
   const graphId=await identity(graphPath),snapshotId=await identity(snapshotPath);if(p.graphSha256)assert.equal(graphId.sha256,p.graphSha256);if(p.snapshotSha256)assert.equal(snapshotId.sha256,p.snapshotSha256);
   // Project public observations, never carry group/private diagnosis into workers.
   const input={caseId:p.caseId,snapshotId:p.snapshotId,changedPaths:prefix.changedPaths,prefixKind:prefix.prefixKind,boundary:prefix.boundary,observations:prefix.observations.map(e=>({ordinal:e.ordinal,toolName:e.toolName,toolCallId:e.toolCallId,input:e.input,result:e.result,isError:e.isError??false}))};
   const dest=join(out,'phase-a/pre-route-inputs',p.caseId+'.json');await save(dest,input);inputs.push(await identity(dest));
   plans.push({caseId:p.caseId,alias,state:p.state,snapshotId:p.snapshotId,generationId:p.generationId,graphPath,graphSha256:graphId.sha256,snapshotSha256:snapshotId.sha256,inputPath:dest,inputSha256:inputs.at(-1).sha256});
   registrations.push({caseId:p.caseId,alias,primary:idx>=0,group:p.group,repository:p.repository,baseSha:p.baseSha,reviewedSha:p.reviewedSha,snapshotId:p.snapshotId,generationId:p.generationId,prefixKind:prefix.prefixKind,deterministicRouteTriggered:route.find(r=>r.caseId===p.caseId)?.routeTriggered??null,originalPrefix:await identity(prefixPath),snapshot:snapshotId,graph:graphId,sourceUniverse:'real-route-recall-diagnostic-1',privateAuditAvailability:'Original diagnosis complete; content deliberately not opened during registration.'});
 }catch(e){exclusions.push({caseId:p.caseId,reason:String(e)});}
}
assert.equal(registrations.filter(p=>p.primary).length,7,'All primary cases required');
await save(join(out,'universe.json'),{primary,registrations,exclusions,inclusion:'All existing 8 defect misses and 16 clean controls; no outcome-based exclusions'});
await save(join(out,'phase-a/plans.json'),{plans});
const policy={identity:'graph-vs-text-route-utility-1',registeredAt:new Date().toISOString(),baselineCommit:'5111495eef3d2d92594c68b9d21598ebf1c9441e',implementationCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),text:TEXT_POLICY,graph:GRAPH_POLICY,replays:2,
 textQueryPolicy:'Unique historical queries in ordinal order; visible Python def/class names; visible exact callee spelling; visible import spelling. Within tier: production Python > other paths, stable path and lexical position. No full-source AST access for seeds. Counterfactual read follow-up lexical seeds appended at priority 3 (defs), 4 (calls), 5 (imports); existing seeds retain priority. String/comment bodies excluded lexically; partial diff fragments may limit extraction. No semantic inference.',
 textReadPolicy:'One source read per query if a not-yet-observed match exists. Production source > untouched file > exact identifier boundary > shared directory components > stable path/line. Start at match minus 10; at most 80 lines. Full search responses and whole delivered source pages share 24 KiB packet; raw audit files separate. Actual read may be omitted when packet full; record both.',
 graphAnchorPolicy:'Force one STRUCTURAL_ESCALATION at END of original prefix, feed ALL observations unmodified to existing ObservedAnchors. No choosing production anchor, earlier time, alternate root, or repair for ambiguous/missing/overflow anchor. This may expose limitations of no-hard-match dispatch completion.',
 graphStack:'Exact locate/retrieveStructure; Gate2B deferred scheduler and cap2 retention; candidate-set.ts selectCandidateSet (same accepted selector as full-context dataset, not failed later hybrid/coverage selectors). Source replay uses unchanged StructuralDispatch with selected frozen responses and actual SnapshotStore. Adapter graph replays are not extra backend operations. No model exposure.',
 independence:'T and G start with same public prefix; neither sees the other result. Workers deny private data and predictions. Implementing agent already knows old findings from conversation; this is access-isolated deterministic development re-adjudication, not independent blind holdout. No claims that author knowledge was erased.',
 phaseOrder:'All T/G outputs and implementation hashes freeze before B. B writes own directory only. Utility labels freeze before C reads old model predictions.',
 stops:'No model calls, provider, ReviewEngine, Graph build, production edits, prompt changes, new selector, target-aware reads, V3 or old result rewrite.',
 labelBoundaryGate:{clearGraph:2,clearNonGraph:3,clearTotal:5,uncertainMustNotBeMajority:true},confidence:'Deterministic text miss does not prove LLM text-hard. Any advantage depending on this comparator miss capped MEDIUM. Undelivered graph opportunity normally UNCERTAIN.',history:'Old labels, predictions, prompt and FAIL always remain frozen; C exploratory only.'};
await save(join(out,'protocol.json'),policy);
const originals=[];async function freezeTree(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await freezeTree(p);else originals.push(await identity(p));}}
for(const dir of ['semantic-router-shadow-20260925','semantic-router-seven-case-reassessment-20260925'])await freezeTree(join(old,dir));
for(const f of ['universe.json','phase-a-v2/diagnostic-freeze.json','phase-b/private-labels.json','phase-b/private-material.json'])originals.push(await identity(join(prior,f)));
await save(join(out,'historical-identities.json'),originals);await save(join(out,'phase-a/input-freeze.json'),{files:inputs,protocol:await identity(join(out,'protocol.json'))});
console.log(JSON.stringify({included:plans.length,primary:7,excluded:exclusions.length,historyFiles:originals.length}));
