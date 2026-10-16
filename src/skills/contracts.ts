import type { InferenceOptions, ModelSelection } from '../engine/contracts.ts';
export const SKILL_POLICY = 'review-skills-2';
/** Write approval, novelty comparison, normalization/near-duplicate gates and usage-based curation. */
export const SKILL_GOVERNANCE_POLICY = 'skill-governance-1';
export type ApprovalMode = 'required' | 'auto';
export const SKILL_LIMITS = Object.freeze({ catalog: 8, bodies: 3, trial: 1, bodyBytes: 6000, inputBytes: 40000, operations: 3, timeoutMs: 60000 });
export type SkillState = 'trial' | 'active' | 'quarantined' | 'retired';
export interface SkillContent {
  scopeType?: 'repository_fact' | 'review_method';
  symbols?: string[];
  type: 'review_procedure' | 'repo_contract' | 'tool_usage';
  title: string; conditions: string[]; steps: string[]; counterexamples: string[]; stopConditions: string[];
  paths: string[]; languages: string[]; keywords: string[];
  dependencies: Array<{ path: string; hash: string }>;
}
export interface Skill extends SkillContent {
  id: string; revision: number; contentSha256: string; owner: 'learner' | 'external'; repositoryKey: string;
  state: SkillState; sources: string[]; createdAt: string;
}
export interface SkillSource {
  id: string; eventId: string; version: number; repositoryKey: string; runId: string; snapshotId: string; reportSha256: string;
  kind: 'run' | 'feedback'; identity: 'review_runtime' | 'local_user' | 'simulation';
  /** Repeated runs of the same source change are observations, not independent support. */
  independenceKey: string;
  trust: 'observed' | 'trusted'; simulated: boolean; withdrawn: boolean;
  comment?: string; findingId?: string; range?: { path: string; startLine: number; endLine: number };
  verdict?: 'correction' | 'missed_defect' | 'contract' | 'uncertain'; createdAt: string;
  relationToReview?: 'supports' | 'contradicts' | 'adds_missing_issue' | 'adds_context';
  feedbackMetadata?: SimulatedFeedback;
}
export interface SimulatedFeedback {
  feedbackId: string; sourceRunId: string; targetFindingId?: string; missedIssueAnchor?: SkillSource['range'];
  relationToReview: NonNullable<SkillSource['relationToReview']>; comment: string;
  simulation: true; humanReviewed: false; generator: string; promptHash: string; sourceReportHash: string;
  referenceProvenance: string[]; createdAt: string;
}
export interface BankSnapshot {
  version: 1; parent: string | null; skills: Record<string, string>; sources: Record<string, string>;
  applied: Record<string, { outcome: 'applied' | 'noop' | 'proposed' | 'rejected'; operations: string[]; proposalId?: string }>;
  /** Staged learning changesets, keyed by proposal ID. Absent in banks written before write approval. */
  proposals?: Record<string, string>;
  /** Skills excluded from curation recommendations. Governance metadata, not knowledge content. */
  pins?: Record<string, { at: string; note?: string }>;
}
/** Layer 1: the learner's explicit judgement of each existing Skill it was shown. */
export type ComparisonRelation = 'same' | 'overlaps' | 'distinct';
export interface ComparisonEntry { id: string; revision: number; relation: ComparisonRelation; note: string }
export interface ApprovalDecision { by: 'local_user' | 'host_auto'; at: string; note?: string }
export interface ProposedChange {
  op: 'add' | 'revise' | 'attach_source' | 'retire'; id: string; expectedRevision: number; reason: string;
  /** Object ref of the Skill revision this change would publish. */
  candidate: string;
  /** Object ref of the revision being replaced; absent for add. */
  previous?: string;
}
export interface Proposal {
  schemaVersion: 1; id: string; origin: 'learning' | 'curation'; status: 'pending' | 'approved' | 'rejected' | 'stale';
  jobId?: string; sourceRef?: string; baseSnapshotId: string; repositoryKey: string;
  changes: ProposedChange[]; comparison: ComparisonEntry[];
  /** Layer 2 findings that did not block staging, shown to the approver. */
  warnings: string[]; createdAt: string; decision?: ApprovalDecision;
}
export interface LearningInput {
  policy: string; source: SkillSource; report: unknown; sourcePages: unknown[]; toolEvents: unknown[];
  relevantSkills: Skill[]; fixedRules: string; bankSnapshotId: string;
  /** Learning-only knowledge coverage. Catalog entries do not grant mutation authority. */
  existingSkills?: LearningContext;
}
export interface LearningCatalogEntry {
  id: string; revision: number; title: string; conditions: string[]; summaryTruncated: boolean;
  scopeType?: SkillContent['scopeType']; type: SkillContent['type']; state: SkillState; owner: Skill['owner'];
  bodyProvided: boolean; readOnly: boolean; score: number; selectionReason: string;
  support: { currentSource: boolean; sameSnapshot: boolean; sameIndependenceKey: boolean };
  dependenciesAvailable: boolean;
}
export interface LearningContext {
  version: string; policySha256: string;
  limits: { catalog: number; bodies: number; contextBytes: number };
  bankCount: number; candidateCount: number; rankedCount: number;
  catalogOmittedCount: number; bodyOmittedCount: number;
  catalog: LearningCatalogEntry[];
}
export type LearningOperation = { op: 'noop'; reason: string } | {
  op: 'add' | 'revise' | 'attach_source' | 'retire'; id: string; expectedRevision: number;
  sourceIds: string[]; reason: string; content?: SkillContent; conflict?: boolean;
  /** Required whenever the learning input carried an existing-knowledge catalog. */
  comparison?: ComparisonEntry[];
};
export interface LearningResult { operations: LearningOperation[] }
export type Learner = (input: LearningInput, options: { directory: string; model: ModelSelection; inference?: InferenceOptions; signal: AbortSignal; timeoutMs?: number }) => Promise<{
  result: unknown; usage: { input: number; output: number; total: number } | null; requests: number | null;
}>;
export interface LearningJob {
  id: string; sourceId: string; status: 'pending' | 'running' | 'proposed' | 'applied' | 'noop' | 'rejected' | 'failed';
  proposalId?: string;
  attempts: number; pid?: number; inputSha256?: string; snapshotId?: string; error?: string;
  usage?: { input: number; output: number; total: number } | null; requests?: number | null; latencyMs?: number;
}
export interface SkillPackage {
  mode: 'off' | 'auto' | 'replay'; bankSnapshotId: string; selectionPolicyVersion: string; repositoryKey: string;
  limits: typeof SKILL_LIMITS; eligible: number; selected: Array<{ skill: Skill; reason: string; freshness: 'current' | 'recheck' }>;
  degraded?: string;
}
export interface SkillBinding {
  mode: 'off' | 'auto' | 'replay'; bankSnapshotId: string; selectionPolicyVersion: string; catalogSha256: string; packageSha256: string;
  repositoryKey: string; available: Array<{ id: string; revision: number; contentSha256: string }>;
  eligible: number; degraded?: string;
}
