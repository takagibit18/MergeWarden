import type { GraphPage, Relation, RelationFact, SymbolFact } from "../graph/contracts.ts";
import type { DispatchEntity } from "./dispatch-contracts.ts";
import type { ContextPackageV2 } from "./investigation-contracts.ts";
import { NAVIGATION_LIMITS, NAVIGATION_VERSION } from "./navigation-contracts.ts";
import type { NavigationCandidate, NavigationEntity, NavigationInvestigation, NavigationOperation, NavigationOrigin, NavigationRecord, NavigationRelation, NavigationStep } from "./navigation-contracts.ts";

const RELATIONS = new Set<Relation>(["CONTAINS", "IMPORTS", "CALLS", "INHERITS"]);
const KINDS = new Set(["directory", "file", "class", "function"]);
const INPUT_KEYS = ["query", "symbolId", "relation", "direction", "limit", "candidateRefId"] as const;
const bounded = (value: string, max = 256) => value.length > max ? value.slice(0, max) : value;

/**
 * Collects a run's structural navigation for the read-only navigation view.
 * Every public method copies what it is given and never throws: recording must not
 * alter tool results, the model loop or delivery. An internal fault makes the whole
 * record unavailable instead of half-written.
 */
export class NavigationRecorder {
  private readonly runId: string; private readonly snapshotId: string;
  private readonly toolExposure: NavigationRecord["toolExposure"];
  private readonly limits: typeof NAVIGATION_LIMITS;
  private readonly steps: NavigationStep[] = [];
  private readonly entities = new Map<string, NavigationEntity>();
  private readonly relations = new Map<string, NavigationRelation>();
  private readonly referenced = new Set<string>();
  private readonly candidates = new Map<string, NavigationCandidate>();
  private readonly generations = new Set<string>();
  private truncated = false; private fault: string | undefined; private seq = 0;
  private readonly limitations: string[];

  constructor(options: { runId: string; snapshotId: string; toolExposure: NavigationRecord["toolExposure"]; limits?: Partial<typeof NAVIGATION_LIMITS> }) {
    this.runId = options.runId; this.snapshotId = options.snapshotId; this.toolExposure = options.toolExposure;
    this.limitations = options.toolExposure === "text+locagent" ? ["Model LocAgent retrieval calls (search_entity, traverse_graph) are not recorded; only host investigations and candidate expansions are."] : [];
    this.limits = Object.freeze({ ...NAVIGATION_LIMITS, ...options.limits });
  }

  get failure(): string | undefined { return this.fault; }

  /** A model graph tool returned a page. */
  graphPage(op: "graph_lookup" | "graph_neighbors", input: Record<string, unknown>, page: GraphPage<unknown>): void {
    this.guard(() => {
      const entityIds: string[] = [], relationIds: string[] = [];
      if (page.snapshotId !== this.snapshotId) throw new Error("Navigation page belongs to another snapshot");
      for (const item of page.items) {
        if (op === "graph_lookup") { const id = this.entity(item as SymbolFact); if (id) entityIds.push(id); }
        else { const id = this.relation(item as RelationFact); if (id) relationIds.push(id); }
      }
      if (page.generationId) this.generations.add(page.generationId);
      this.step({ origin: "model_tool", op, input: this.input(input), status: page.status, pageTruncated: page.truncated,
        coverageLimited: page.status !== "ok" || page.generationState === "partial", entityIds: [...new Set(entityIds)], relationIds: [...new Set(relationIds)],
        ...(page.generationId ? { generationId: page.generationId } : {}) });
    });
  }

  /** A model graph tool failed. The failure is recorded; it never establishes absence. */
  graphError(op: "graph_lookup" | "graph_neighbors", input: Record<string, unknown>, error: unknown): void {
    this.guard(() => this.step({ origin: "model_tool", op, input: this.input(input), status: "error", pageTruncated: false, coverageLimited: true,
      entityIds: [], relationIds: [], error: bounded(error instanceof Error ? error.message : "Graph tool failed", 512) }));
  }

  /** A host investigation package reached the provider request (dispatch_v2). */
  investigationDelivered(pack: ContextPackageV2): void {
    this.guard(() => {
      if (pack.snapshotId !== this.snapshotId || pack.runId !== this.runId) throw new Error("Navigation package belongs to another run");
      const entityIds = new Set<string>(), relationIds = new Set<string>(); const investigations: NavigationInvestigation[] = [];
      for (const inv of pack.investigations) {
        const changeUnits = inv.changeUnits.map(unit => {
          if (unit.entity) entityIds.add(this.dispatchEntity(unit.entity));
          return { changeUnitId: unit.changeUnitId, path: unit.path, kind: unit.kind, resolution: unit.resolution, ...(unit.entity ? { entityId: unit.entity.entityId } : {}) };
        });
        for (const card of inv.candidateCatalog) {
          entityIds.add(this.dispatchEntity(card.entity));
          this.candidates.set(card.candidateRefId, { candidateRefId: card.candidateRefId, entityId: card.entity.entityId,
            rootChangeUnitIds: card.roots.map(root => root.changeUnitId).sort(), depth: card.depth, requestId: pack.requestId });
          for (const path of card.structuralPaths) for (const id of this.pathRelations(path)) relationIds.add(id);
        }
        investigations.push({ investigationId: inv.investigationId, routeType: inv.routeType, status: inv.status, changeUnits,
          candidateRefIds: inv.candidateCatalog.map(card => card.candidateRefId), limitations: inv.limitations.map(item => bounded(item, 512)) });
      }
      if (pack.generationId) this.generations.add(pack.generationId);
      this.step({ origin: "host_dispatch", op: "investigation_delivered", input: { routeType: pack.route.routeType }, status: pack.terminal,
        terminal: pack.terminal, requestId: pack.requestId, pageTruncated: pack.omittedCandidateCount > 0,
        coverageLimited: pack.terminal === "coverage_limited" || pack.terminal === "budget_exhausted", entityIds: [...entityIds].sort(), relationIds: [...relationIds].sort(),
        investigations, ...(pack.generationId ? { generationId: pack.generationId } : {}) });
    });
  }

  /** The model expanded a delivered candidate into source. */
  candidateExpanded(candidateRefId: string, entity: DispatchEntity, requestId: string, generationId?: string): void {
    this.guard(() => {
      const id = this.dispatchEntity(entity);
      this.step({ origin: "model_tool", op: "candidate_expanded", input: { candidateRefId: bounded(candidateRefId, 80) }, status: "ok", pageTruncated: false,
        coverageLimited: false, entityIds: [id], relationIds: [], candidateRefId: bounded(candidateRefId, 80), requestId,
        ...(generationId ? { generationId } : {}) });
    });
  }

  /** Entity ids referenced by recorded relations whose facts are not yet known. */
  missingEntityIds(): string[] { return this.fault ? [] : [...this.referenced].filter(id => !this.entities.has(id)).sort(); }

  /** Facts described from the published graph after the model loop ended. */
  describe(facts: SymbolFact[]): void { this.guard(() => { for (const fact of facts) this.entity(fact); }); }

  /** Deterministic, self-contained record, or undefined after an internal fault. */
  finish(): NavigationRecord | undefined {
    if (this.fault) return undefined;
    const byId = <T extends { id: string }>(values: Iterable<T>) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return structuredClone({ version: NAVIGATION_VERSION, runId: this.runId, snapshotId: this.snapshotId, toolExposure: this.toolExposure,
      generationIds: [...this.generations].sort(), steps: this.steps, entities: byId(this.entities.values()), relations: byId(this.relations.values()),
      candidates: [...this.candidates.values()].sort((a, b) => a.candidateRefId < b.candidateRefId ? -1 : 1),
      truncated: this.truncated, entityFactsComplete: this.missingEntityIds().length === 0, limitations: [...this.limitations] });
  }

  private guard(action: () => void): void {
    if (this.fault) return;
    try { action(); } catch (error) { this.fault = bounded(error instanceof Error ? error.message : "Navigation recording failed", 512); }
  }

  private step(value: Omit<NavigationStep, "seq">): void {
    if (this.steps.length >= this.limits.maxSteps) { this.truncated = true; return; }
    this.steps.push(structuredClone({ seq: ++this.seq, ...value }));
  }

  private input(input: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of INPUT_KEYS) {
      const value = input[key];
      if (typeof value === "string") result[key] = bounded(value);
      else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
    if (input.cursor !== undefined) result.paged = true;
    return Buffer.byteLength(JSON.stringify(result)) > this.limits.maxInputBytes ? { truncatedInput: true } : result;
  }

  private entity(fact: SymbolFact): string | undefined {
    if (!fact || typeof fact.id !== "string" || fact.snapshotId !== this.snapshotId || !KINDS.has(fact.kind)) return undefined;
    if (!this.entities.has(fact.id)) {
      if (this.entities.size >= this.limits.maxEntities) { this.truncated = true; return undefined; }
      this.entities.set(fact.id, { id: fact.id, kind: fact.kind, ...(fact.functionKind ? { functionKind: fact.functionKind } : {}),
        path: fact.path, qualifiedName: fact.qualifiedName, name: fact.name, startLine: fact.startLine, endLine: fact.endLine });
    }
    return fact.id;
  }

  private dispatchEntity(entity: DispatchEntity): string {
    if (entity.snapshotId !== this.snapshotId) throw new Error("Navigation entity belongs to another snapshot");
    if (!this.entities.has(entity.entityId) && KINDS.has(entity.kind)) {
      if (this.entities.size >= this.limits.maxEntities) { this.truncated = true; return entity.entityId; }
      this.entities.set(entity.entityId, { id: entity.entityId, kind: entity.kind as NavigationEntity["kind"], path: entity.path,
        qualifiedName: entity.qualifiedName, name: entity.name, startLine: entity.startLine, endLine: entity.endLine });
    }
    return entity.entityId;
  }

  private relation(fact: RelationFact): string | undefined {
    if (!fact || fact.snapshotId !== this.snapshotId || !RELATIONS.has(fact.relation)) return undefined;
    return this.edge({ id: fact.id, fromId: fact.fromId, toId: fact.toId, relation: fact.relation, resolution: fact.resolution, origin: "graph_neighbors",
      sourcePath: fact.sourcePath, sourceLine: fact.sourceLine, sourceEndLine: fact.sourceEndLine });
  }

  /** Reconstruct definite edges of a rooted path; upstream steps follow an incoming edge. */
  private pathRelations(path: { relationSequence: string[]; directionSequence: string[]; entityIds?: string[]; edgeIds?: string[] }): string[] {
    const ids: string[] = []; const entities = path.entityIds ?? [];
    for (let i = 1; i < entities.length; i++) {
      const relation = path.relationSequence[i - 1] as Relation, direction = path.directionSequence[i - 1];
      if (!RELATIONS.has(relation) || !["upstream", "downstream"].includes(direction ?? "")) continue;
      const up = direction === "upstream"; const fromId = up ? entities[i]! : entities[i - 1]!, toId = up ? entities[i - 1]! : entities[i]!;
      const id = path.edgeIds?.[i - 1] ?? `${fromId}:${relation}:${toId}`;
      const recorded = this.edge({ id, fromId, toId, relation, resolution: "definite", origin: "host_investigation" });
      if (recorded) ids.push(recorded);
    }
    return ids;
  }

  private edge(edge: NavigationRelation): string | undefined {
    const existing = this.relations.get(edge.id);
    if (!existing) {
      if (this.relations.size >= this.limits.maxRelations) { this.truncated = true; return undefined; }
      this.relations.set(edge.id, edge);
    } else if (existing.resolution === "definite" && edge.resolution !== "definite") this.relations.set(edge.id, { ...edge, origin: existing.origin });
    this.referenced.add(edge.fromId); this.referenced.add(edge.toId);
    return edge.id;
  }
}
