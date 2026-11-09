import type { EntityKind, Relation, Resolution } from "../graph/contracts.ts";

/**
 * Host-owned record of structural navigation in one run (ADR 0021).
 * It is a read-only projection for people: never evidence, never a business truth,
 * and never fed back into the model. It is self-contained so that historical runs
 * stay viewable after a graph cache is rebuilt, quarantined or pruned.
 */
export const NAVIGATION_VERSION = "mergewarden-navigation-1" as const;
export const NAVIGATION_FILE = "navigation.json";
export const NAVIGATION_LIMITS = Object.freeze({ maxSteps: 200, maxEntities: 2000, maxRelations: 5000, maxBytes: 8 * 1024 * 1024, maxInputBytes: 1024 });

export type NavigationOrigin = "model_tool" | "host_dispatch";
export type NavigationOperation = "graph_lookup" | "graph_neighbors" | "investigation_delivered" | "candidate_expanded";
/** Host investigation paths are definite rooted paths; the exact resolved rule is not part of the package. */
export type NavigationResolution = Resolution | "definite";

export interface NavigationEntity {
  id: string; kind: EntityKind; functionKind?: "function" | "method";
  path: string; qualifiedName: string; name: string; startLine: number; endLine: number;
}
export interface NavigationRelation {
  id: string; fromId: string; toId: string; relation: Relation; resolution: NavigationResolution;
  origin: "graph_neighbors" | "host_investigation";
  sourcePath?: string; sourceLine?: number; sourceEndLine?: number;
}
export interface NavigationChangeUnit {
  changeUnitId: string; path: string; kind: "file" | "class" | "function"; resolution: string; entityId?: string;
}
export interface NavigationInvestigation {
  investigationId: string; routeType: string; status: string;
  changeUnits: NavigationChangeUnit[]; candidateRefIds: string[]; limitations: string[];
}
export interface NavigationStep {
  seq: number; origin: NavigationOrigin; op: NavigationOperation;
  /** Normalised copy of the tool input, bounded to maxInputBytes. */
  input: Record<string, unknown>;
  status: string; coverageLimited: boolean; pageTruncated: boolean;
  entityIds: string[]; relationIds: string[];
  error?: string; generationId?: string;
  requestId?: string; candidateRefId?: string; terminal?: string;
  investigations?: NavigationInvestigation[];
}
export interface NavigationCandidate {
  candidateRefId: string; entityId: string; rootChangeUnitIds: string[]; depth: number; requestId: string;
}
export interface NavigationRecord {
  version: typeof NAVIGATION_VERSION; runId: string; snapshotId: string;
  toolExposure: "text-only" | "text+graph" | "text+locagent";
  generationIds: string[];
  steps: NavigationStep[]; entities: NavigationEntity[]; relations: NavigationRelation[];
  candidates: NavigationCandidate[];
  /** True when a step, entity or relation limit dropped data. */
  truncated: boolean;
  /** False when some referenced entity could not be described from the graph. */
  entityFactsComplete: boolean;
  /** What this record does not cover, stated rather than implied by absence. */
  limitations: string[];
}
export type NavigationState =
  | { state: "recorded"; sha256: string; steps: number; entities: number; relations: number; truncated: boolean }
  | { state: "unavailable"; reason: string };
