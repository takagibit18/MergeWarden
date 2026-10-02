import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {SnapshotStore} from '../../src/snapshot/store.ts';
import {graphData} from '../frontier-data.mjs';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';
import {executionSession} from './execute.mjs';
import {legalPlans,GATE} from './contracts.mjs';
import {targetReached} from './scoring.mjs';
export async function executionOptions(out,c) {
  const stored=await read(join(out,'phase-a/change-units',c.alias+'.json')),prefix=await read(join(out,'phase-a/prefixes',c.alias+'.json'));
  assert.equal(hash(stored.units),c.changeUnitHash);assert.equal(stored.snapshotId,c.snapshotId);assert.equal(stored.generationId,c.generationId);
  const data=await graphData({state:c.state,snapshotId:c.snapshotId,generationId:c.generationId,graphSha256:c.graphIdentity.sha256,snapshotSha256:c.snapshotIdentity.sha256});
  const store=await SnapshotStore.load(c.state,c.snapshotId),visibleRanges=prefix.observations.filter(o=>o.toolName==='read_source'&&!o.isError&&o.result.status==='ok'&&o.result.revision==='head').map(o=>({path:o.result.path,startLine:o.result.startLine,endLine:o.result.endLine}));
  return {caseId:c.alias,snapshotId:c.snapshotId,generationId:c.generationId,changedPaths:c.changedPaths,visibleRanges,units:stored.units,data,store};
}
export async function runOracle(out) {
  const predictions=await read(join(out,'phase-b/prediction-freeze.json'));assert.equal(predictions.allFirstAttemptsFinished,true);await checkIdentities(predictions.files);
  const generated=await read(join(out,'phase-a/generation-freeze.json'));await checkIdentities(generated.files);
  const universe=await read(join(out,'universe.json')),targets=await read(join(out,'phase-c-private/necessary-targets.json')),rows=[],plans=[],files=[];
  for(const c of universe.primary.filter(c=>c.group==='defect'&&c.status==='PUBLIC_ADMITTED')){
    const target=targets.cases.find(t=>t.alias===c.alias);assert(target);assert.equal(target.snapshotId,c.snapshotId);
    if(target.status!=='TARGET_FROZEN'){rows.push({alias:c.alias,caseId:c.caseId,status:'PRIVATE_TARGET_INSUFFICIENT',actionable:false,oracleSuccessfulPairs:[],reason:target.reason});continue;}
    const options=await executionOptions(out,c),legal=legalPlans(options.units);plans.push({caseId:c.alias,...legal});
    const results=[];for(const [i,pair] of legal.plans.entries()){
      const a=await executionSession(options).execute(pair),b=await executionSession(options).execute(pair);assert.equal(hash(a),hash(b),'STOP — MECHANICAL NONDETERMINISM');
      const reached=targetReached(a.catalog,target.targets,c.snapshotId);assert.equal(reached,targetReached(b.catalog,target.targets,c.snapshotId));
      const path=join(out,'phase-c-private/oracle-execution',c.alias,String(i+1).padStart(2,'0')+'.json');await save(path,{pair,execution:a,reached,replays:2,executionHash:hash(a)});files.push(await identity(path));
      results.push({pair,reached,status:a.status,catalogItems:a.catalog.length,catalogHash:hash(a.catalog),roots:a.roots??[],executionFile:path});
    }
    const success=results.filter(r=>r.reached).map(r=>r.pair);rows.push({alias:c.alias,caseId:c.caseId,status:success.length?'STRUCTURALLY_ACTIONABLE':'NOT_STRUCTURALLY_ACTIONABLE_UNDER_V2',actionable:success.length>0,oracleSuccessfulPairs:success,oraclePlansOmitted:legal.oraclePlansOmitted,confidence:legal.confidence,results,reason:success.length?'A legal frozen plan reaches an exact necessary candidate.':'No enumerated legal plan reaches a necessary candidate under frozen v2 bounds; omitted plans, if any, limit confidence.'});
    console.log(JSON.stringify({caseId:c.alias,oraclePlans:results.length,successfulPairs:success.length,omitted:legal.oraclePlansOmitted}));
  }
  const actionable=rows.filter(r=>r.actionable).length,insufficient=rows.filter(r=>r.status==='PRIVATE_TARGET_INSUFFICIENT').length;
  await save(join(out,'phase-c-private/oracle-plans.json'),plans);await save(join(out,'phase-c-private/structural-actionability.json'),{rows,actionable,notActionable:rows.length-actionable-insufficient,privateTargetInsufficient:insufficient,privateGate:actionable>=GATE.actionableDefects?'PASS':'INSUFFICIENT_STRUCTURALLY_ACTIONABLE_ROUTE_MISSES',oracleCostExcludedFromProduct:true});
  for(const name of ['necessary-targets','oracle-plans','structural-actionability'])files.push(await identity(join(out,'phase-c-private',name+'.json')));
  await save(join(out,'phase-c-private/oracle-freeze.json'),{files,replays:2,privateAfterPredictionFreeze:true});console.log(JSON.stringify({actionable,privateGate:actionable>=GATE.actionableDefects?'PASS':'STOP'}));
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))await runOracle(resolve(process.argv[2]));
