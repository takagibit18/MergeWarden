import assert from 'node:assert/strict';
import {DISPATCH_LIMITS} from '../../src/engine/dispatch-contracts.ts';
import {INVESTIGATION_BOUNDS} from '../../src/experiments/locagent/host-investigation.ts';
import {LocAgentRetrieval} from '../../src/experiments/locagent/retrieval.ts';
import {stableId} from '../../src/engine/investigation-focus.ts';
import {candidateCard,candidateSource,declarationPreview,sourceWindow,packInvestigation,packageBytes} from '../../src/engine/candidate-catalog.ts';
import {intentRoute,legalIntents} from './contracts.mjs';

/** Eval-only ChangeUnit/Intent adapter. All resolution, traversal, ordering,
 * card construction and packing use frozen product functions, not an eval algorithm.
 * No provider, EvidenceRegistry or active review session is created here. */
export function executionSession({caseId,snapshotId,generationId,changedPaths,visibleRanges=[],units,data,store,onOperation=()=>{}},budget={}) {
  const limits={...DISPATCH_LIMITS,...budget};for(const [key,value] of Object.entries(budget))assert.ok(value>=1&&value<=DISPATCH_LIMITS[key]);
  const retrieval=new LocAgentRetrieval(data),metrics={episodes:0,structuralOps:0,sourceReads:0,edgeInspections:0,visitedNodes:0,expandedStates:0,catalogItems:0,catalogBytes:0,packageBytes:0};
  return {metrics,async execute(pair){
    const selected=units.find(u=>u.changeUnitId===pair.changeUnitId);
    if(!selected||selected.resolution!=='resolved'||!legalIntents(selected.kind).includes(pair.intent))return {pair,status:'I1_RESOLUTION_FAILURE',reason:'Unknown, unresolved or kind-incompatible public ChangeUnit/Intent',catalog:[],metrics:{structuralOps:0,sourceReads:0}};
    if(metrics.episodes>=limits.maxRouteEpisodes||metrics.structuralOps+2>limits.maxStructuralCallsTotal||limits.maxStructuralCallsPerEpisode<2)return {pair,status:'B0_BUDGET_EXHAUSTED',catalog:[],metrics:{structuralOps:0,sourceReads:0}};
    metrics.episodes++;const root={...structuredClone(selected),changeUnitId:selected.hostChangeUnitId??selected.changeUnitId};delete root.hostChangeUnitId;
    assert.equal(root.snapshotId,snapshotId);assert.equal(root.entity.snapshotId,snapshotId);
    const route=intentRoute(pair.intent),routeId=JSON.stringify([pair.changeUnitId,pair.intent]),requestId=stableId('dispatch2_',[caseId,snapshotId,routeId]),investigationId=stableId('investigation_',[requestId]);
    const anchor={path:root.path,kind:root.kind,name:root.entity.name,qualifiedName:root.entity.qualifiedName,startLine:root.entity.startLine,endLine:root.entity.endLine};
    onOperation('resolve_change_units');metrics.structuralOps++;const resolved=retrieval.resolveChangeUnits({anchors:[anchor]});
    assert.equal(resolved.snapshotId,snapshotId);assert.equal(resolved.generationId,generationId);
    if(resolved.resolutions[0].status!=='resolved'||resolved.resolutions[0].items.length!==1||resolved.resolutions[0].items[0].entityId!==root.entity.entityId)return {pair,status:'I1_RESOLUTION_FAILURE',catalog:[],resolution:resolved,metrics:{structuralOps:1,sourceReads:0}};
    onOperation('host_structural_investigation');metrics.structuralOps++;
    const result=retrieval.investigate({roots:[root.entity.entityId],route,budget:{...INVESTIGATION_BOUNDS},context:{snapshotId,generationId,route,changedPaths,visibleRanges}});
    assert.equal(result.snapshotId,snapshotId);assert.equal(result.generationId,generationId);
    const cards=[];for(const id of result.priority){const c=result.pool.eligible.find(c=>c.terminalEntityId===id);assert(c);const preview=declarationPreview(await store.text('head',c.terminalPath),c.terminalEntity.startLine,c.entityKind);cards.push(candidateCard(requestId,c,[root],preview));}
    const inv={investigationId,routeId,routeType:route,reason:'shadow_semantic_intent',snapshotId,generationId,changeUnits:[root],status:'context_ready',candidateCatalog:cards,prefetchedSourceRefs:[],limitations:[],rootsResolved:1,rootsExplored:1,rootsOmittedByBudget:0};
    const pack={version:'structural-dispatch-2',origin:'host_dispatch',requestId,runId:caseId,snapshotId,generationId,route:{routeType:route,reason:'shadow_semantic_intent'},investigations:[inv],sources:[],omitted:[],omittedCandidateCount:0,limitations:['Shadow catalog execution; no provider exposure or evidence promotion.'],terminal:cards.length?'context_returned':'no_definite_relation'};
    if(result.coverageLimited||result.status!=='ok'){inv.limitations.push('Frozen graph/traversal coverage limited: '+result.metrics.stopReason);pack.terminal='coverage_limited';}
    let reads=0;if(cards.length){const card=cards[0],window=sourceWindow(card);onOperation('read_source');const page=await store.source('head',card.entity.path,window.startLine,window.endLine);const source=candidateSource(page,card,snapshotId);pack.sources.push(source);inv.prefetchedSourceRefs.push(source.evidenceRefId);metrics.sourceReads++;reads++;}
    packInvestigation(pack);assert.ok(packageBytes(pack)<=limits.maxPackageBytes);assert.ok(reads<=limits.maxSourceReadsPerEpisode);
    const catalog=pack.investigations[0].candidateCatalog,stats={structuralOps:2,sourceReads:reads,edgeInspections:result.metrics.edgeInspections,visitedNodes:result.metrics.visitedNodes,expandedStates:result.metrics.expandedStates,catalogItems:catalog.length,catalogBytes:Buffer.byteLength(JSON.stringify(catalog)),packageBytes:packageBytes(pack)};
    for(const key of ['edgeInspections','visitedNodes','expandedStates','catalogItems','catalogBytes','packageBytes'])metrics[key]+=stats[key];
    return {pair,status:result.coverageLimited?'B0_BUDGET_LIMITED':'EXECUTED',requestId,investigationId,roots:result.roots.map(r=>r.id),catalog,pack,metrics:stats,sharedImplementation:'LocAgentRetrieval.investigate -> hostStructuralInvestigation'};
  }};
}
export async function executePrediction(options,prediction,budget) {
  assert.ok(prediction.investigations.length<=2);const session=executionSession(options,budget),plans=[];
  for(const pair of prediction.investigations)plans.push(await session.execute(pair));
  const union=plans.flatMap(p=>p.catalog.map(c=>({candidate:c,changeUnitId:p.pair.changeUnitId,intent:p.pair.intent,investigationId:p.investigationId})));
  return {plans,union,metrics:{...session.metrics}};
}
