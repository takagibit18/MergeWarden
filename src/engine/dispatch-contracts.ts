import type { EvidenceRef } from "../domain/contracts.ts";
import type { RelationFact } from "../graph/contracts.ts";
export type ExecutionStrategy = "advisory" | "dispatch_v1" | "dispatch_v2";
export const DISPATCH_VERSION = "structural-dispatch-1" as const;
export const DISPATCH_LIMITS = Object.freeze({ maxRouteEpisodes: 2, maxStructuralCallsPerEpisode: 4,
  maxStructuralCallsTotal: 6, maxSourceReadsPerEpisode: 3, maxPackageBytes: 24 * 1024,
  sourceWindowLines: 80, generalHops: 3, maxTraversalNodes: 30, maxTraversalBytes: 8192,
  maxImportTargets: 4, maxAnchorHints: 32 });
export type DispatchRoute = "CALLER_CHECK" | "INHERITANCE_CHECK" | "IMPORT_CHECK" | "STRUCTURAL_ESCALATION";
export interface DispatchTrigger { change?: import('./declarations.ts').DeclarationChange; routeId: string; routeType: DispatchRoute; targetHint: string; reason: string; path: string; toolCallId: string; toolName: string }
export interface AnchorHint { path: string; name?: string; qualifiedName?: string; kind?: "file" | "class" | "function"; startLine?: number; endLine?: number }
export interface InvestigationRequest extends DispatchTrigger {
  requestId: string; runId: string; snapshotId: string; generationId?: string;
  strategyVersion: typeof DISPATCH_VERSION; anchors: AnchorHint[]; changedPaths: string[];
  template: DispatchRoute; budget: { [K in keyof typeof DISPATCH_LIMITS]: number };
}
export interface DispatchEntity { entityId: string; snapshotId: string; path: string; name: string; qualifiedName: string; kind: string; startLine: number; endLine: number; depth?: number }
export type DispatchTerminal = "context_returned" | "no_definite_relation" | "anchor_missing" | "anchor_ambiguous" | "coverage_limited" | "budget_exhausted" | "cancelled" | "error";
export interface DispatchSource extends EvidenceRef { evidenceRefId: string; text: string; entity: DispatchEntity }
export interface ContextPackage {
  version: typeof DISPATCH_VERSION; origin: "host_dispatch"; requestId: string; runId: string; snapshotId: string;
  generationId?: string; template: DispatchRoute; anchor?: DispatchEntity;
  relations: RelationFact[]; sources: DispatchSource[]; limitations: string[]; omitted: string[]; terminal: DispatchTerminal;
}
export interface DispatchObservation { toolName: string; toolCallId: string; input: Record<string, unknown>; result: Record<string, unknown>; isError?: boolean }
export interface DispatchBridge {
  observe(event: DispatchObservation): void;
  dispatch(trigger: DispatchTrigger): Promise<ContextPackage | undefined>;
  queued(pack: ContextPackage): void;
  providerPayload(payload: unknown): void;
  setRecorder(record: (event: Record<string, unknown>) => void): void;
}
