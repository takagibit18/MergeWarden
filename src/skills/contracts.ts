import type { InferenceOptions, ModelSelection } from '../engine/contracts.ts';
export const SKILL_POLICY = 'review-skills-3';
/** Learning job identity. Bumping it re-enqueues every historical source, so it moves only when extraction itself must rerun. */
export const SKILL_EXTRACTION_POLICY = 'review-skills-2';
/** Write approval, novelty comparison, normalization/near-duplicate gates and usage-based curation. */
export const SKILL_GOVERNANCE_POLICY = 'skill-governance-1';
export type ApprovalMode = 'required' | 'auto';
export const SKILL_LIMITS = Object.freeze({ catalog: 8, bodies: 3, trial: 1, bodyBytes: 6000, inputBytes: 40000, operations: 3, timeoutMs: 60000 });
export type SkillState = 'trial' | 'active' | 'quarantined' | 'retired';
export interface SkillContent {
  /** SKILL.md identity (skill-md-1). Absent on Skills learned before the Markdown format. */
  name?: string;
  /** Trigger-oriented summary shown in catalogs: what the check does and when to use it. */
  description?: string;
  /** Reference Markdown files opened on demand, e.g. the concrete incident behind a general method. */
  references?: Record<string, string>;
  scopeType?: 'repository_fact' | 'review_method';
  symbols?: string[];
  type: 'review_procedure' | 'repo_contract' | 'tool_usage' | 'accepted_tradeoff';
  title: string; conditions: string[]; steps: string[]; counterexamples: string[]; stopConditions: string[];
  /** accepted_tradeoff only (skill-md-2): when the same pattern is still a real defect. */
  stillReportWhen?: string[];
  /** accepted_tradeoff only: host-recorded from the feedback's frozen head lines, never learner-supplied. */
  anchor?: TradeoffAnchor;
  paths: string[]; languages: string[]; keywords: string[];
  dependencies: Array<{ path: string; hash: string }>;
}
export interface TradeoffAnchor { path: string; lineCount: number; sha256: string }
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
  verdict?: 'correction' | 'missed_defect' | 'contract' | 'uncertain' | 'accepted_tradeoff'; createdAt: string;
  /** accepted_tradeoff feedback: the exact frozen head lines of range. */
  anchor?: TradeoffAnchor;
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
  id: string; revision: number; title: string; description?: string; conditions: string[]; summaryTruncated: boolean;
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
  limits: typeof SKILL_LIMITS; eligible: number; selected: SkillPackageEntry[];
  degraded?: string;
}
export interface SkillPackageEntry {
  skill: Skill; reason: string; freshness: 'current' | 'recheck';
  /** accepted_tradeoff whose anchor lines were found in this head snapshot. */
  anchor?: { path: string; startLine: number; endLine: number };
}
export interface SkillBinding {
  mode: 'off' | 'auto' | 'replay'; bankSnapshotId: string; selectionPolicyVersion: string; catalogSha256: string; packageSha256: string;
  repositoryKey: string; available: Array<{ id: string; revision: number; contentSha256: string }>;
  /** SHA-256 of the Skill rules injected into the system prompt; absent when no Skill is selected and in pre-ADR 0020 runs. */
  rulesSha256?: string;
  eligible: number; degraded?: string;
}
