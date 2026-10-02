import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {publishedGraphPath} from '../src/graph/sqlite-store.ts';
import {identity,save,read,projectPrefix} from './candidate-dataset-context.mjs';

const out=resolve(process.argv[2]), workspace=resolve(out,'../..'), repo=resolve(import.meta.dirname,'..');
const old=join(workspace,'output'), formal=join(old,'mergewarden2-v02-closeout-20260923/formal'), complex=join(old,'complex-graph-value-20260924'), corpus=join(old,'realgolden40-closure/corpus-v1-final');
const runtimeCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const evidence=[];
const frozen=async p=>{evidence.push(await identity(p));return read(p);};
const tasksPath=join(corpus,'public/tasks.jsonl'), stratumPath=join(corpus,'hidden/gold.jsonl');
evidence.push(await identity(tasksPath),await identity(stratumPath));
const tasks=(await readFile(tasksPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
// Pre-generation universe registration ONLY: project the historical stratum IDs.
// No target/range/finding is returned, saved or used by this process.
const ids=(await readFile(stratumPath,'utf8')).trim().split(/\r?\n/).map(line=>{
  const {id,label,navigationRequirement}=JSON.parse(line);return {id,label,navigationRequirement};
}).filter(r=>r.label==='defect'&&['untouched_1hop','multi_hop','project_invariant'].includes(r.navigationRequirement)).map(r=>r.id).sort();
assert.equal(ids.length,12);
const graphs=await frozen(join(formal,'graph-preparation.json')), complexCases=await frozen(join(complex,'cases.json'));
const plans=ids.map(id=>{const t=tasks.find(t=>t.case_id===id),g=graphs.entries.find(g=>g.caseId===id);assert.ok(t&&g);return {sourceCaseId:id,phase:1,repository:t.repository,baseSha:t.base_sha,reviewedSha:t.reviewed_sha,state:join(formal,'state'),snapshotId:g.snapshotId,generationId:g.generationId};});
for(const c of complexCases.filter(c=>['D3-xarray-multihop','D4-inheritance','D6-real-local'].includes(c.id)||c.id.startsWith('D6-'))) {
  plans.push({sourceCaseId:c.id,underlyingSourceCaseId:c.sourceId,phase:2,repository:c.sourceId?tasks.find(t=>t.case_id===c.sourceId)?.repository:'authored-controlled/'+c.id,baseSha:c.base,reviewedSha:c.head,state:join(complex,'state'),snapshotId:c.snapshotId,generationId:c.generationId,provenance:c.provenance});
}
// Fixed catalog order, then native run identity; no success/target filtering.
const sessions=[];
for(const state of [join(formal,'state'),join(complex,'state')]) {
  for(const id of (await readdir(join(state,'runs'))).sort()) {
    const manifest=join(state,'runs',id,'run.json');let text;try{text=await readFile(manifest,'utf8');}catch{continue;}
    const snapshotId=/"snapshotId"\s*:\s*"([a-f0-9]{64})"/.exec(text)?.[1];
    if(plans.some(p=>p.snapshotId===snapshotId)) sessions.push({snapshotId,path:join(state,'runs',id,'session.jsonl'),manifest});
  }
}
const seen=new Set();
for(const p of plans) {
  p.caseId='derived-'+p.sourceCaseId;
  const underlying=JSON.stringify([p.repository,p.baseSha,p.reviewedSha]);p.duplicate=seen.has(underlying);seen.add(underlying);
  const snapshotPath=join(p.state,'snapshots',p.snapshotId+'.json'),snapshot=await frozen(snapshotPath);
  p.snapshotSha256=evidence.at(-1).sha256;p.changedPaths=snapshot.changedPaths;
  const graphPath=await publishedGraphPath(p.state,p.snapshotId);evidence.push(await identity(graphPath));p.graphSha256=evidence.at(-1).sha256;p.graphPath=graphPath;
  p.actions=[];p.prefixSource=null;p.historyAttempts=[];
  for(const s of sessions.filter(s=>s.snapshotId===p.snapshotId)) {
    try{evidence.push(await identity(s.manifest),await identity(s.path));const prefix=await projectPrefix(s.path);p.historyAttempts.push({path:s.path,completedPrefixTools:prefix.actions.length,stoppedAt:prefix.stoppedAt});if(prefix.actions.length){p.actions=prefix.actions;p.prefixSource=s.path;break;}}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  p.prefixKind=p.actions.length?'historical_tool_sequence_replayed':'derived_immutable_diff_only';
}
const selector=await identity(join(repo,'src/experiments/locagent/candidate-set.ts'));
const protocol={identity:'full-context-candidate-dataset-1',runtimeCommit,registeredAt:new Date().toISOString(),universeRule:'All 12 pre-existing RealGolden untouched-context defect IDs; membership projected before Phase A using historical stratum metadata only. No new candidate outcomes exist.',phase2Rule:'Pre-registered D3, D4 (explicit user exception), D6. Activate only if Phase 1 blind upper bound (context + route + anchor + pool 4..30) is below 6; duplicates stay in denominator ledger but cannot count twice.',prefixPolicy:'First nonempty completed text-tool prefix in formal then Complex native sessions, each ordered lexically by run ID; stop before first structural call, dispatch or submit. Replay calls on same snapshot. If none, complete diff pages in manifest order only. Stop at first actual dispatch; do not search to manufacture pressure. No semantic summary.',pipeline:'Actual routing extension callbacks + dispatchAdapter + ObservedAnchors + retrieveStructure structural segment. Dataset stops before source delivery. No ReviewEngine, provider, ModelRuntime or source replay.',selector:{version:'candidate-set/Gate-2B',commit:'0d6e905f976559370c507bb7267b37dcdb2e2e5f',...selector,slots:3,reason:'Stable selector paired with frozen Gate 2B stack; later path coverage and Hybrid were failed experiments.'},bounds:{beamWidth:4,maxVisitedNodes:30,maxVisitedEdges:200,maxExpandedStates:200,maxAlternativePredecessors:2,poolMin:4,poolMax:30},repeats:2,admission:{valid:4,miss:2,hit:1,recommended:{valid:6,miss:2,hit:2}},privateScoring:'Only after whole activated universe Phase A freeze. RealGolden contextEvidence ranges, all required locations must be contained by a reached/retained/eligible terminal entity; no mere file match. Complex D4 uses its historical audit requiredUntouched source ranges. No new targets.',sourceAccess:'Preselection observed tools only; no terminal-candidate previews, delivery source windows or source-fact replay.',forbidden:['model calls','credentials','LLM prompt','Graph build','production code changes','V3','private target in Phase A'],generationInputAccess:'Phase A separate Node permission process: registered public plans, snapshot manifests/blobs, prepared databases, implementation sources only. Private scoring files are not readable.'};
await save(join(out,'protocol.json'),protocol);await save(join(out,'universe.json'),{plans});await save(join(out,'frozen-inputs.json'),[...new Map(evidence.map(e=>[e.path,e])).values()]);
console.log(JSON.stringify({phase1:plans.filter(p=>p.phase===1).length,phase2:plans.filter(p=>p.phase===2).map(p=>({id:p.sourceCaseId,duplicate:p.duplicate})),prefixes:plans.map(p=>({id:p.sourceCaseId,kind:p.prefixKind,actions:p.actions.length}))},null,2));
