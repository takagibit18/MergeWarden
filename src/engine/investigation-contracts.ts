import type { AnchorHint, DispatchEntity, DispatchRoute, DispatchSource, DispatchTerminal } from './dispatch-contracts.ts';

export const INVESTIGATION_VERSION = 'structural-dispatch-2' as const;
export const INVESTIGATION_MESSAGE = 'mergewarden-structural-context-v2';
export const INVESTIGATION_EVENT = 'mergewarden-host-dispatch-v2';
export interface LineRange { startLine: number; endLine: number }
export interface ChangeHint extends AnchorHint { deleted?: boolean }
export interface ChangeUnit {
  changeUnitId: string; snapshotId: string; path: string; kind: 'file' | 'class' | 'function';
  changedRanges: LineRange[]; entity?: DispatchEntity;
  resolution: 'resolved' | 'ambiguous' | 'missing' | 'deleted_head_unsupported' | 'coverage_limited';
  provenance: { inputIndices: number[]; source: 'immutable_head_diff' };
}
export interface CandidateCard {
  candidateRefId: string; entity: DispatchEntity;
  roots: { changeUnitId: string; path: string; name: string }[];
  depth: number; structuralPaths: { relationSequence: string[]; directionSequence: string[] }[];
  patternIds: string[]; pathSupportCount: number; changed: boolean; alreadyVisible: boolean;
  classification: string; headerPreview?: string; explorationOnly: true;
}
export interface Investigation {
  investigationId: string; routeId: string; routeType: DispatchRoute; reason: string;
  snapshotId: string; generationId?: string; changeUnits: ChangeUnit[];
  status: 'planned' | 'resolving' | 'exploring' | 'context_ready' | 'delivered' | 'exhausted' | 'degraded';
  candidateCatalog: CandidateCard[]; prefetchedSourceRefs: string[]; limitations: string[];
  rootsResolved: number; rootsExplored: number; rootsOmittedByBudget: number;
}
export interface CandidateSource extends DispatchSource {
  candidateRefId: string; entityRange: LineRange; returnedRange: LineRange; truncated: boolean;
}
export interface ContextPackageV2 {
  version: typeof INVESTIGATION_VERSION; origin: 'host_dispatch'; requestId: string; runId: string;
  snapshotId: string; generationId?: string; route: { routeType: DispatchRoute; reason: string };
  investigations: Investigation[]; sources: CandidateSource[]; omitted: string[];
  omittedCandidateCount: number; limitations: string[]; terminal: DispatchTerminal;
}
