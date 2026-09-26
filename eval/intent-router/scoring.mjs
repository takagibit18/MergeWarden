import {GATE} from './contracts.mjs';
export const pairKey=p=>JSON.stringify([p.changeUnitId,p.intent]);
export function targetReached(catalog,targets,snapshotId) {
  return targets.some(t=>t.snapshotId===snapshotId&&Number.isSafeInteger(t.startLine)&&Number.isSafeInteger(t.endLine)&&t.startLine>=1&&t.endLine>=t.startLine
    &&catalog.some(c=>c.entity.snapshotId===snapshotId&&c.entity.path===t.path&&c.entity.startLine<=t.startLine&&c.entity.endLine>=t.endLine));
}
export function diagnose({actionable,oraclePairs,prediction,execution,reached}) {
  if(prediction.status!=='OK')return prediction.status;
  if(reached)return 'SUCCESS_CANDIDATE_REACHED';
  if(!actionable)return 'NOT_STRUCTURALLY_ACTIONABLE_UNDER_V2';
  const pairs=prediction.prediction.investigations;if(!pairs.length)return 'SR0_NONE';
  if(execution.plans.some(p=>p.status==='I1_RESOLUTION_FAILURE'))return 'I1_RESOLUTION_FAILURE';
  if(execution.plans.some(p=>p.status==='B0_BUDGET_EXHAUSTED'))return 'B0_BUDGET_EXHAUSTED';
  if(!pairs.some(p=>oraclePairs.some(o=>o.changeUnitId===p.changeUnitId)))return 'SR1_WRONG_CHANGE_UNIT';
  if(!pairs.some(p=>oraclePairs.some(o=>pairKey(o)===pairKey(p))))return 'SR2_WRONG_INTENT';
  return 'G0_TARGET_NOT_REACHED';
}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
export function cleanCost(rows) {
  const plans=rows.map(r=>r.planCount),sorted=[...plans].sort((a,b)=>a-b);
  return {cases:rows.length,zeroPlans:plans.filter(n=>n===0).length,onePlan:plans.filter(n=>n===1).length,twoPlans:plans.filter(n=>n===2).length,
    CleanInvestigationRate:mean(plans.map(n=>Number(n>0))),MeanInvestigationsPerClean:mean(plans),P95InvestigationsPerClean:sorted[Math.ceil(sorted.length*.95)-1]??null,CleanCasesWithTwoInvestigations:plans.filter(n=>n===2).length,
    MeanGraphOpsPerClean:mean(rows.map(r=>r.metrics.structuralOps)),MeanEdgeInspectionsPerClean:mean(rows.map(r=>r.metrics.edgeInspections)),MeanCatalogItemsPerClean:mean(rows.map(r=>r.metrics.catalogItems)),MeanCatalogBytesPerClean:mean(rows.map(r=>r.metrics.catalogBytes)),MeanPrefetchedSourcesPerClean:mean(rows.map(r=>r.metrics.sourceReads))};
}
export function primaryMetrics(defects,cleans,failures) {
  const actionable=defects.filter(d=>d.actionable),recovered=actionable.filter(d=>d.reached).length,cost=cleanCost(cleans),denominator=actionable.length;
  const recall=denominator?recovered/denominator:null;
  return {ActionableDefectCount:denominator,RecoveredActionableDefects:recovered,OpportunityRecall:recall,clean:cost,failures,
    pass:denominator>=GATE.actionableDefects&&cost.cases>=GATE.publicClean&&failures.format===0&&failures.provider===0&&recall>=GATE.opportunityRecall&&recovered>=GATE.recoveredDefects&&cost.MeanInvestigationsPerClean<=GATE.meanCleanPlans&&cost.CleanCasesWithTwoInvestigations<=GATE.cleanTwoPlans};
}
