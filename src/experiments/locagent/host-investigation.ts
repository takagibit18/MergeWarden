import type { RelationFact, SymbolFact } from '../../graph/contracts.ts';
import type { DispatchRoute } from '../../engine/dispatch-contracts.ts';
import type { ExplorationBudget } from './contracts.ts';
import { deferredWalk } from './deferred-frontier.ts';
import { STRUCTURAL_PATTERNS } from './patterns.ts';
import type { PatternDiscovery, ProgressiveObservation, TraversalPattern, TraversalStep } from './patterns.ts';
import { explanationStateId, retainStructuralPaths } from './path-retention.ts';
import { candidateUnits } from './path-candidates.ts';
import { describeCandidates, selectCandidateSet } from './candidate-set.ts';
import type { SelectionContext } from './candidate-set.ts';

export const INVESTIGATION_BOUNDS = Object.freeze({ maxVisitedNodes: 30, maxVisitedEdges: 200, maxExpandedStates: 200 });
export interface InvestigationAccess {
  entity(id: string): SymbolFact | undefined;
  neighbors(id: string, direction: TraversalStep['direction']): readonly RelationFact[];
  compare(a: SymbolFact, b: SymbolFact): number;
}
const step = (relation: 'CONTAINS' | 'CALLS' | 'IMPORTS' | 'INHERITS', direction: TraversalStep['direction']): TraversalStep => ({ relations: [relation], direction });
function routePatterns(route: DispatchRoute): readonly TraversalPattern[] {
  if (route === 'STRUCTURAL_ESCALATION') return STRUCTURAL_PATTERNS;
  if (route === 'CALLER_CHECK') return [{ id: 'CALLER_CHECK/upstream', steps: [step('CALLS', 'upstream')] }];
  if (route === 'INHERITANCE_CHECK') return ['upstream', 'downstream'].map(direction => ({ id: 'INHERITANCE_CHECK/' + direction, steps: [step('INHERITS', direction as TraversalStep['direction'])] }));
  return [{ id: 'IMPORT_CHECK/exports-consumers', steps: [step('IMPORTS', 'downstream'), step('IMPORTS', 'upstream')] },
    { id: 'IMPORT_CHECK/consumers', steps: [step('IMPORTS', 'upstream')] }];
}

/** Shared product/eval implementation. Receives only public context and immutable graph access. */
export function hostStructuralInvestigation(input: { roots: string[]; context: SelectionContext; route: DispatchRoute;
  changeAware?: boolean; budget?: ExplorationBudget }, access: InvestigationAccess, signal?: AbortSignal) {
  const budget = input.budget ?? INVESTIGATION_BOUNDS;
  for (const key of ['maxVisitedNodes', 'maxVisitedEdges', 'maxExpandedStates'] as const)
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1 || budget[key] > INVESTIGATION_BOUNDS[key]) throw Error('Invalid shared investigation budget');
  if (!input.roots.length || input.roots.length > 5 || new Set(input.roots).size !== input.roots.length) throw Error('Expected 1..5 exact roots');
  const roots = input.roots.map(id => { const s = access.entity(id); if (!s || s.snapshotId !== input.context.snapshotId) throw Error('Unknown/cross-snapshot root'); return s; });
  const constructors=new Set(roots.filter(s=>s.name==='__init__' && s.functionKind==='method').map(s=>s.id));
  const patterns: readonly TraversalPattern[] = input.changeAware && constructors.size ? [
    ...routePatterns(input.route),
    ...(['CALLS','INHERITS'] as const).flatMap(relation=>(relation==='CALLS'?['upstream']:['upstream','downstream']).map(direction=>({
      id:'constructor-owner/'+relation+'/'+direction,steps:[step('CONTAINS','upstream'),step(relation,direction as TraversalStep['direction'])]})))
  ] : input.changeAware && input.route==='IMPORT_CHECK' ? [
    {id:'binding/consumers',steps:[step('IMPORTS','upstream')]},
    {id:'binding/callers',steps:[step('CALLS','upstream')]}
  ] : routePatterns(input.route);
  const observations: ProgressiveObservation[] = [];
  // IMPORT_CHECK expands consumers of at most four export targets, as in v1.
  // All direct export targets remain candidates; only the second hop is capped.
  const importTargets = new Set<string>();
  const rootIds = new Set(input.roots);
  const boundedAccess = input.route !== 'IMPORT_CHECK' ? access : { ...access,
    neighbors: (id: string, direction: TraversalStep['direction']) => direction === 'upstream' && !rootIds.has(id) && !importTargets.has(id) ? [] : access.neighbors(id, direction) };
  const typedAccess=!input.changeAware ? boundedAccess : {...boundedAccess,neighbors:(id:string,direction:TraversalStep['direction'])=>
    boundedAccess.neighbors(id,direction).filter(edge=>edge.relation!=='CONTAINS' || direction==='upstream' && constructors.has(id)
      && access.entity(edge.fromId)?.kind==='class' && access.entity(id)?.parentSymbolId===edge.fromId)};
  const search = deferredWalk(roots, patterns, budget, 4, typedAccess, signal, e => {
    observations.push(e);
    if (input.route === 'IMPORT_CHECK' && e.decision === 'REACHED' && e.state.depth === 1 && e.state.direction === 'downstream' && importTargets.size < 4) importTargets.add(e.state.entity.id);
  });
  const explanation = (d: PatternDiscovery) => { const p = patterns.find(p => p.id === d.patternId)!;
    return { entity: d.entity, rootEntityId: d.rootEntityId, patternId: d.patternId, stepIndex: d.depth, direction: (p.steps[d.depth] ?? p.steps.at(-1))!.direction }; };
  const states = search.discoveries.map(explanation), known = new Map(states.map(s => [explanationStateId(s), s]));
  const links = [];
  for (const e of observations) {
    if (e.decision !== 'INSPECTED' || !e.edge) continue;
    const prior = explanation(e.state), rule = patterns.find(p => p.id === e.state.patternId)!.steps[e.stepIndex]!;
    if (!rule.relations.includes(e.edge.relation) || !['resolved_scoped', 'resolved_import_alias'].includes(e.edge.resolution)) continue;
    const next = [...known.values()].find(s => s.entity.id === (e.direction === 'upstream' ? e.edge!.fromId : e.edge!.toId)
      && s.rootEntityId === prior.rootEntityId && s.patternId === prior.patternId && s.stepIndex === prior.stepIndex + 1);
    if (next) links.push({ previousStateId: explanationStateId(prior), stateId: explanationStateId(next), edge: e.edge, direction: e.direction });
  }
  const retained = retainStructuralPaths({ snapshotId: input.context.snapshotId, generationId: input.context.generationId, states, links });
  const pool = describeCandidates(candidateUnits(retained), retained, input.context);
  const importOrder = search.discoveries.filter(d => d.depth > 0).map(d => d.entity.id);
  const selection = selectCandidateSet(pool.eligible, input.context, importOrder);
  if(input.changeAware) pool.eligible=pool.eligible.filter(c=>!c.relationSequences.every(seq=>seq.every(r=>r==='CONTAINS')));
  const compatible=(c:typeof pool.eligible[number])=>c.relationSequences.some(seq=>seq.some(r=>input.route==='CALLER_CHECK'?r==='CALLS'||r==='INHERITS':input.route==='IMPORT_CHECK'?r==='IMPORTS'||r==='CALLS':input.route==='INHERITANCE_CHECK'?r==='INHERITS':true));
  const priority = input.changeAware ? [...pool.eligible].sort((a,b)=>Number(!compatible(a))-Number(!compatible(b))
    ||a.depth-b.depth||Number(a.alreadyVisible)-Number(b.alreadyVisible)||Number(a.changed)-Number(b.changed)
    ||Number(a.classification!=='production')-Number(b.classification!=='production')||access.compare(a.terminalEntity,b.terminalEntity)).map(c=>c.terminalEntityId)
    : [...selection.selected.map(s => s.candidate.terminalEntityId), ...selection.omitted];
  return { roots, retained, pool, priority, metrics: { visitedNodes: search.visitedNodes, edgeInspections: search.visitedEdges,
    expandedStates: search.expandedStates, queueSize: search.schedulerMetrics.maxDeferredQueueSize,
    queueBytes: search.schedulerMetrics.peakDeferredQueueBytes, stopReason: search.stopReason },
    coverageLimited: search.coverageLimited, inspectionTrace: observations.filter(e => e.decision === 'INSPECTED').map(e => ({
      rootEntityId: e.state.rootEntityId, entityId: e.state.entity.id, patternId: e.state.patternId, stepIndex: e.stepIndex,
      direction: e.direction, edge: e.edge, inspectionOrdinal: e.inspectionOrdinal })) };
}
