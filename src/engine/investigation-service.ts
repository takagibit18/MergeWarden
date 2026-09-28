import { createHash } from 'node:crypto';
import { BudgetClosingError } from './budget.ts';
import { PersistenceFailure } from '../ports/journal.ts';
import { DISPATCH_LIMITS } from './dispatch-contracts.ts';
import type { DispatchObservation, DispatchTrigger } from './dispatch-contracts.ts';
import type { DispatchOperation } from './dispatch-retrieval.ts';
import type { RoutingBudget } from './routing-contracts.ts';
import { InvestigationFocus, stableId } from './investigation-focus.ts';
import { changeUnits } from './change-resolution.ts';
import type { resolveChangeHints } from './change-resolution.ts';
import { INVESTIGATION_VERSION } from './investigation-contracts.ts';
import type { CandidateCard, CandidateSource, ChangeUnit, ContextPackageV2, Investigation } from './investigation-contracts.ts';
import { candidateCard, candidateSource, packageBytes, packInvestigation, sourceWindow } from './candidate-catalog.ts';
import type { hostStructuralInvestigation } from '../experiments/locagent/host-investigation.ts';
import { isObject } from './tool-result.ts';

interface Options {
  runId: string; snapshotId: string; changedPaths: string[]; signal: AbortSignal;
  operation: DispatchOperation; source: (path: string, startLine: number, endLine: number) => Promise<Record<string, unknown>>;
  promote(source: CandidateSource): void; budget?: Partial<RoutingBudget>; onPersistenceFailure?(error: PersistenceFailure): void;
}
const contains = (payload: unknown, text: string): boolean => typeof payload === 'string' ? payload.includes(text)
  : Array.isArray(payload) ? payload.some(v => contains(v, text)) : isObject(payload) ? Object.values(payload).some(v => contains(v, text)) : false;
class BudgetStop extends Error {}

export class ProgressiveInvestigation {
  readonly version = INVESTIGATION_VERSION;
  private options: Options; private focus: InvestigationFocus;
  private requested = new Set<string>();
  private built = new Map<string, string>();
  private pending = new Map<string, { pack: ContextPackageV2; text: string }>();
  private delivered = new Map<string, { card: CandidateCard; requestId: string; generationId: string }>();
  private cache = new Map<string, CandidateSource>();
  private visible: { path: string; startLine: number; endLine: number }[] = [];
  private recorder: (event: Record<string, unknown>) => void = () => {};
  private poison: PersistenceFailure | undefined;
  readonly metrics = { requests: 0, terminals: {} as Record<string, number>, structuralOperations: 0, sourceReads: 0,
    packagesQueued: 0, packagesDelivered: 0, contextBytes: 0, latencyMs: 0,
    candidateExpansionRequests: 0, candidateExpansionReads: 0, candidateExpansionBytes: 0,
    rootsResolved: 0, rootsExplored: 0, rootsOmittedByBudget: 0, edgeInspections: 0, expandedStates: 0, visitedNodes: 0 };
  constructor(options: Options) {
    this.options = options; this.focus = new InvestigationFocus(options.snapshotId, options.changedPaths);
    for (const [key, value] of Object.entries(options.budget ?? {})) if (!Number.isInteger(value) || value < 1 || value > DISPATCH_LIMITS[key as keyof RoutingBudget]) throw Error('Invalid dispatch budget: ' + key);
  }
  setRecorder(record: (event: Record<string, unknown>) => void) { this.recorder = record; }
  private record(event: Record<string, unknown>) {
    if (this.poison) throw this.poison;
    try { this.recorder(structuredClone({ version: INVESTIGATION_VERSION, origin: 'host_dispatch', runId: this.options.runId, snapshotId: this.options.snapshotId, ...event })); }
    catch { this.poison = new PersistenceFailure(); this.options.onPersistenceFailure?.(this.poison); throw this.poison; }
  }
  observe(event: DispatchObservation) {
    if (event.isError || event.result.snapshotId !== this.options.snapshotId) return;
    this.focus.observe(event);
    if (['read_source', 'expand_structural_candidate'].includes(event.toolName) && event.result.status === 'ok' && event.result.revision === 'head')
      this.visible.push({ path: String(event.result.path), startLine: Number(event.result.startLine), endLine: Number(event.result.endLine) });
  }
  hasPending() { return this.pending.size > 0; }
  /** Explicit eval entry point; execution, budgets, delivery and evidence remain shared. */
  dispatchRegistered(trigger: DispatchTrigger, unit: ChangeUnit) {
    this.focus.register(trigger, unit);
    return this.dispatch(trigger);
  }
  queued(pack: ContextPackageV2) {
    this.options.signal.throwIfAborted();
    const text = JSON.stringify(pack);
    if (this.built.get(pack.requestId) !== text) throw Error('Unknown or mutated investigation package');
    if (this.pending.has(pack.requestId)) return;
    this.record({ type: 'context_queued', requestId: pack.requestId });
    this.pending.set(pack.requestId, { pack: structuredClone(pack), text }); this.metrics.packagesQueued++;
  }
  providerPayload(payload: unknown) {
    this.options.signal.throwIfAborted(); if (this.poison) throw this.poison;
    for (const [requestId, pending] of this.pending) {
      if (!contains(payload, pending.text)) continue;
      this.record({ type: 'context_delivered', requestId, generationId: pending.pack.generationId,
        packageSha256: createHash('sha256').update(pending.text).digest('hex'), evidenceRefIds: pending.pack.sources.map(s => s.evidenceRefId) });
      for (const inv of pending.pack.investigations) for (const card of inv.candidateCatalog) {
        if (!pending.pack.generationId) throw Error('Delivered candidate missing generation');
        this.delivered.set(card.candidateRefId, { card: structuredClone(card), requestId, generationId: pending.pack.generationId });
      }
      for (const source of pending.pack.sources) { this.options.promote(source); this.visible.push(source); this.cache.set(source.candidateRefId, source); }
      this.pending.delete(requestId); this.metrics.packagesDelivered++; this.metrics.contextBytes += Buffer.byteLength(pending.text);
    }
  }
  /** Already inside the model OperationGate. Do not enqueue another operation here. */
  async expand(candidateRefId: string) {
    this.metrics.candidateExpansionRequests++; this.options.signal.throwIfAborted(); if (this.poison) throw this.poison;
    const entry = this.delivered.get(candidateRefId); if (!entry) throw Error('Unknown or undelivered candidate reference for this run/snapshot');
    let source = this.cache.get(candidateRefId), cached = !!source;
    if (!source) {
      const window = sourceWindow(entry.card);
      const page = await this.options.source(entry.card.entity.path, window.startLine, window.endLine);
      this.options.signal.throwIfAborted(); source = candidateSource(page, entry.card, this.options.snapshotId);
      this.metrics.candidateExpansionReads++; this.metrics.candidateExpansionBytes += Buffer.byteLength(source.text);
    }
    this.record({ type: 'candidate_expanded', requestId: entry.requestId, generationId: entry.generationId, candidateRefId, source, cached });
    this.options.promote(source); this.cache.set(candidateRefId, source);
    return { ...structuredClone(source), status: 'ok', cached, requestId: entry.requestId, generationId: entry.generationId,
      _mergewarden: { schemaVersion: 1, evidenceRefId: source.evidenceRefId, candidateRefId, requestId: entry.requestId, generationId: entry.generationId } };
  }
  async dispatch(trigger: DispatchTrigger): Promise<ContextPackageV2 | undefined> {
    const requestId = stableId('dispatch2_', [this.options.runId, this.options.snapshotId, trigger.routeId]);
    if (this.requested.has(requestId)) return; this.requested.add(requestId);
    const started = performance.now(), focus = this.focus.freeze(trigger), limits = { ...DISPATCH_LIMITS, ...this.options.budget };
    const inv: Investigation = { investigationId: stableId('investigation_', [requestId]), routeId: trigger.routeId, routeType: trigger.routeType,
      reason: trigger.reason, snapshotId: this.options.snapshotId, changeUnits: [], status: 'planned', candidateCatalog: [], prefetchedSourceRefs: [],
      limitations: [], rootsResolved: 0, rootsExplored: 0, rootsOmittedByBudget: 0 };
    const pack: ContextPackageV2 = { version: INVESTIGATION_VERSION, origin: 'host_dispatch', requestId, runId: this.options.runId,
      snapshotId: this.options.snapshotId, route: { routeType: trigger.routeType, reason: trigger.reason }, investigations: [inv], sources: [],
      omitted: [], omittedCandidateCount: 0, limitations: ['Candidates and declaration previews are exploration only. Execution is not a finding or proof of absence.'], terminal: 'no_definite_relation' };
    this.metrics.requests++; this.record({ type: 'investigation_requested', requestId, trigger, focus, investigationId: inv.investigationId });
    let structural = 0;
    const operation: DispatchOperation = async (name, input) => {
      this.options.signal.throwIfAborted();
      if (this.metrics.requests > limits.maxRouteEpisodes || name !== 'read_source' && (structural >= limits.maxStructuralCallsPerEpisode || this.metrics.structuralOperations >= limits.maxStructuralCallsTotal)) throw new BudgetStop('Frozen structural budget exhausted');
      if (name !== 'read_source') { structural++; this.metrics.structuralOperations++; } else this.metrics.sourceReads++;
      this.record({ type: 'operation_requested', requestId, name, input });
      const result = await this.options.operation(name, input); this.record({ type: 'operation_result', requestId, name, result }); return result;
    };
    const validate = (r: Record<string, unknown>) => {
      if (!['ok', 'partial', 'parse_incomplete', 'unsupported'].includes(String(r.status)) || r.snapshotId !== pack.snapshotId
        || r.revision !== 'head' || typeof r.generationId !== 'string' || pack.generationId && pack.generationId !== r.generationId) throw Error('Graph identity or availability mismatch');
      pack.generationId = r.generationId; inv.generationId = r.generationId;
      if (r.status !== 'ok') inv.limitations.push('Graph coverage: ' + r.status);
    };
    try {
      if (focus.omitted.length) { inv.limitations.push(`${focus.omitted.length} changed ranges omitted by resolver bound`); pack.omitted.push(...focus.omitted.slice(0, 8).map(h => JSON.stringify(h)));
        if (focus.omitted.length > 8) pack.omitted.push(`${focus.omitted.length - 8} further omitted ranges retained in host request telemetry`); }
      if (!focus.anchors.length) pack.terminal = 'anchor_missing';
      else {
        inv.status = 'resolving'; const resolved = await operation('resolve_change_units', { anchors: focus.anchors }); validate(resolved);
        inv.changeUnits = changeUnits(pack.snapshotId, focus.anchors, resolved.resolutions as ReturnType<typeof resolveChangeHints>);
        const roots = inv.changeUnits.filter(u => u.resolution === 'resolved' && u.entity);
        inv.rootsResolved = roots.length; this.metrics.rootsResolved += roots.length;
        for (const u of inv.changeUnits) if (u.resolution !== 'resolved') inv.limitations.push(`${u.changeUnitId}: ${u.resolution}`);
        if (!roots.length) pack.terminal = inv.changeUnits.some(u => u.resolution === 'ambiguous') ? 'anchor_ambiguous' : 'anchor_missing';
        const remaining = { maxVisitedNodes: 30, maxVisitedEdges: 200, maxExpandedStates: 200 };
        const cards = new Map<string, CandidateCard>();
        for (let offset = 0; offset < roots.length; offset += 5) {
          const batch = roots.slice(offset, offset + Math.min(5, remaining.maxVisitedNodes));
          if (!batch.length || remaining.maxVisitedEdges < 1 || remaining.maxExpandedStates < 1) break;
          inv.status = 'exploring';
          const raw = await operation('host_structural_investigation', { roots: batch.map(u => u.entity!.entityId), route: trigger.routeType, budget: { ...remaining },
            context: { snapshotId: pack.snapshotId, generationId: pack.generationId, route: trigger.routeType, changedPaths: this.options.changedPaths, visibleRanges: this.visible } }); validate(raw);
          const result = raw as unknown as ReturnType<typeof hostStructuralInvestigation> & { previews?: Record<string, string> };
          inv.rootsExplored += batch.length;
          remaining.maxVisitedNodes -= result.metrics.visitedNodes; remaining.maxVisitedEdges -= result.metrics.edgeInspections; remaining.maxExpandedStates -= result.metrics.expandedStates;
          if (Object.values(remaining).some(n => n < 0)) throw Error('Shared graph budget violation');
          this.metrics.edgeInspections += result.metrics.edgeInspections; this.metrics.expandedStates += result.metrics.expandedStates; this.metrics.visitedNodes += result.metrics.visitedNodes;
          if (result.coverageLimited) inv.limitations.push('Traversal stopped: ' + result.metrics.stopReason);
          for (const id of result.priority) {
            const candidate = result.pool.eligible.find(c => c.terminalEntityId === id); if (!candidate) throw Error('Unknown priority candidate');
            const card = candidateCard(requestId, candidate, roots, result.previews?.[id]); if (!cards.has(id)) cards.set(id, card);
          }
          inv.candidateCatalog = [...cards.values()];
        }
        if (inv.candidateCatalog.length) {
          const card = inv.candidateCatalog[0]!, window = sourceWindow(card);
          const page = await operation('read_source', { revision: 'head', path: card.entity.path, ...window });
          const source = candidateSource(page, card, pack.snapshotId); pack.sources.push(source); inv.prefetchedSourceRefs.push(source.evidenceRefId);
          pack.terminal = 'context_returned';
        }
      }
    } catch (error) {
      if (error instanceof PersistenceFailure) throw error;
      pack.terminal = this.options.signal.aborted ? (/budget/i.test(String(this.options.signal.reason)) ? 'budget_exhausted' : 'cancelled') : error instanceof BudgetStop || error instanceof BudgetClosingError ? 'budget_exhausted' : 'error';
      inv.limitations.push(String(error).slice(0, 512));
    }
    inv.rootsOmittedByBudget = inv.rootsResolved - inv.rootsExplored;
    this.metrics.rootsExplored += inv.rootsExplored; this.metrics.rootsOmittedByBudget += inv.rootsOmittedByBudget;
    if (inv.rootsOmittedByBudget) inv.limitations.push(`${inv.rootsOmittedByBudget} roots omitted by shared budget`);
    if (inv.limitations.length && ['context_returned', 'no_definite_relation'].includes(pack.terminal)) pack.terminal = 'coverage_limited';
    inv.status = ['context_returned', 'no_definite_relation'].includes(pack.terminal) ? 'context_ready' : pack.terminal === 'budget_exhausted' ? 'exhausted' : 'degraded';
    packInvestigation(pack);
    this.metrics.terminals[pack.terminal] = (this.metrics.terminals[pack.terminal] ?? 0) + 1; this.metrics.latencyMs += performance.now() - started;
    this.record({ type: 'investigation_terminal', requestId, terminal: pack.terminal, investigation: inv, packageBytes: packageBytes(pack) });
    this.built.set(requestId, JSON.stringify(pack)); return pack;
  }
}
