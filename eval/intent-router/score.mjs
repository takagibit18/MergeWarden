import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {read,save,identity,checkIdentities,hash} from '../candidate-dataset-context.mjs';


import {targetReached,diagnose,primaryMetrics,pairKey} from './scoring.mjs';
const out=resolve(process.argv[2]),actionability=await read(join(out,'phase-c-private/structural-actionability.json'));
assert.equal(actionability.privateGate,'PASS','STOP: Private actionability gate failed');
for(const path of ['phase-a/generation-freeze.json','phase-b/prediction-freeze.json','phase-c-private/oracle-freeze.json','phase-d/execution-freeze.json'])await checkIdentities((await read(join(out,path))).files);
const universe=await read(join(out,'universe.json')),predictions=await read(join(out,'phase-b/parsed-predictions.json')),targets=await read(join(out,'phase-c-private/necessary-targets.json')),rows=[],files=[];
for(const c of universe.primary.filter(c=>c.status==='PUBLIC_ADMITTED')){
  const pred=predictions.find(p=>p.caseId===c.alias);assert(pred);
  const dest=join(out,'phase-d/predicted-execution',c.alias+'.json'),execution=await read(dest);files.push(await identity(dest));
  // Target-free execution is already frozen. Scoring cannot change its plans.
  const frozenOracle=actionability.rows.find(r=>r.alias===c.alias);
  for(const plan of execution.plans){const recorded=frozenOracle?.results?.find(r=>pairKey(r.pair)===pairKey(plan.pair));
    if(recorded&&plan.status!=='B0_BUDGET_EXHAUSTED')assert.equal(hash(plan.catalog),recorded.catalogHash,'STOP — ORACLE/PREDICTION EXECUTION DRIFT');
  }
  const oracle=actionability.rows.find(r=>r.alias===c.alias),target=targets.cases.find(t=>t.alias===c.alias),reached=target?targetReached(execution.union.map(u=>u.candidate),target.targets??[],c.snapshotId):null;
  const predictedPairs=pred.prediction?.investigations??[],success=oracle?.oracleSuccessfulPairs??[];
  rows.push({alias:c.alias,caseId:c.caseId,group:c.group,actionable:oracle?.actionable??false,oracleStatus:oracle?.status??null,oracleSuccessfulPairs:success,predictedPairs,predictionStatus:pred.status,planCount:pred.status==='OK'?predictedPairs.length:null,acceptedPlanCount:predictedPairs.length,reached,
    failureClass:c.group==='clean'?(pred.status==='OK'?'CLEAN_COST_ONLY':pred.status):diagnose({actionable:oracle?.actionable,oraclePairs:success,prediction:pred,execution,reached}),
    changeUnitMatchedOracle:predictedPairs.some(p=>success.some(o=>o.changeUnitId===p.changeUnitId)),intentMatchedOracle:predictedPairs.some(p=>success.some(o=>pairKey(o)===pairKey(p))),
    predictedPairReachedTarget:execution.plans.map(p=>({pair:p.pair,reached:target?targetReached(p.catalog,target.targets??[],c.snapshotId):null})),targetReachedByAlternativePredictedPlan:reached===true&&!predictedPairs.some(p=>success.some(o=>pairKey(o)===pairKey(p))),metrics:execution.metrics});
  console.log(JSON.stringify({caseId:c.alias,plans:predictedPairs.length,status:rows.at(-1).failureClass}));
}
const failures={format:predictions.filter(p=>p.status==='FORMAT_FAILURE').length,provider:predictions.filter(p=>p.status==='PROVIDER_FAILURE').length};
const metrics=primaryMetrics(rows.filter(r=>r.group==='defect'),rows.filter(r=>r.group==='clean'&&r.predictionStatus==='OK'),failures);
metrics.clean.admittedCases=rows.filter(r=>r.group==='clean').length;metrics.clean.unknownPlanCountCases=rows.filter(r=>r.group==='clean'&&r.predictionStatus!=='OK').length;metrics.clean.costDenominator='Format/provider-success clean cases; failed predictions remain in primary failure counts, never labelled zero-plan model choices.';
const actionableRows=rows.filter(r=>r.group==='defect'&&r.actionable),totalPlans=actionableRows.reduce((n,r)=>n+r.predictedPairs.length,0),successfulPlans=actionableRows.reduce((n,r)=>n+r.predictedPairReachedTarget.filter(p=>p.reached).length,0);
metrics.UsefulPlanRate={successfulPlans,totalPredictedActionableDefectPlans:totalPlans,rate:totalPlans?successfulPlans/totalPlans:null};
const histogram={};for(const r of rows)histogram[r.failureClass]=(histogram[r.failureClass]??0)+1;
if(metrics.clean.MeanInvestigationsPerClean>0.5||metrics.clean.CleanCasesWithTwoInvestigations>1)histogram.COST_OVERTRIGGER=1;
const hardDefects=universe.fastPath.filter(c=>c.group!=='CLEAN_CONTROL'),hardClean=universe.fastPath.filter(c=>c.group==='CLEAN_CONTROL'),semanticDefects=rows.filter(r=>r.group==='defect'&&r.planCount>0),semanticClean=rows.filter(r=>r.group==='clean');
const hybrid={secondary:true,defects:{all:universe.primary.filter(c=>c.group==='defect').length+hardDefects.length,deterministicRouteHitCases:hardDefects.length,noRouteCases:universe.primary.filter(c=>c.group==='defect').length,publicAdmitted:rows.filter(r=>r.group==='defect').length,actionable:metrics.ActionableDefectCount,semanticInvestigationCases:semanticDefects.length,semanticPredictedPlans:semanticDefects.reduce((n,r)=>n+r.planCount,0),semanticRecoveredOpportunities:metrics.RecoveredActionableDefects,totalStructuralInvestigationCases:hardDefects.length+semanticDefects.length},clean:{all:universe.primary.filter(c=>c.group==='clean').length+hardClean.length,deterministicRouteHitCases:hardClean.length,noRouteCases:universe.primary.filter(c=>c.group==='clean').length,semanticInvestigationCases:semanticClean.filter(r=>r.planCount>0).length,semanticInvestigationEpisodes:semanticClean.reduce((n,r)=>n+r.planCount,0),totalInvestigationEpisodes:hardClean.reduce((n,c)=>n+c.summary.triggered,0)+semanticClean.reduce((n,r)=>n+r.planCount,0)},warning:'Route triggers, target reach and final Review quality are distinct; no finding experiment ran.'};
for(const [name,value] of [['phase-d/candidate-reach',rows],['metrics',metrics],['failure-taxonomy',histogram],['hybrid-shadow',hybrid],['gate',{status:failures.provider?'INCONCLUSIVE — RUNTIME / PROVIDER FAILURE':metrics.pass?'SEMANTIC INTENT ROUTER CAPABILITY = PROMISING':'SEMANTIC INTENT ROUTER CAPABILITY NOT PROVEN',passed:metrics.pass,criteria:metrics}]]){const path=join(out,name+'.json');await save(path,value);files.push(await identity(path));}
await save(join(out,'phase-d/scoring-freeze.json'),{files,modelCalls:0,replays:2});console.log(JSON.stringify({gate:metrics.pass?'PASS':'FAIL',metrics}));
