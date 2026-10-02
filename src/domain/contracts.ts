/** Domain contracts are independent of Pi, IDE APIs, and model providers. */
export type DeliveryPolicy = "final_only" | "incremental_candidates";
export type RunStatus = "preparing" | "reviewing" | "completed" | "partial" | "failed" | "cancelled";
export type Severity = "critical" | "high" | "medium" | "low";
export interface SnapshotIdentity {
  readonly id: string;
  readonly repositoryId: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly baseVersion?: { kind: "commit" | "content" | "empty"; id: string };
  readonly headVersion?: { kind: "commit" | "content" | "empty"; id: string };
  readonly inputFingerprint: string;
  readonly configurationFingerprint: string;
}
export interface EvidenceRef {
  readonly snapshotId: string;
  readonly revision: "base" | "head";
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentSha256: string;
}
/** A reviewable claim, not a scratchpad thought and not yet a public finding. */
export interface FindingCandidate {
  readonly id: string;
  readonly title: string;
  readonly claim: string;
  readonly trigger: string;
  readonly impact: string;
  readonly severity: Severity;
  readonly evidence: readonly EvidenceRef[];
}
export interface CandidateRecord {
  readonly candidate: FindingCandidate;
  disposition: "pending" | "accepted" | "rejected";
  reason?: string;
}
export interface ReviewState {
  runId: string;
  snapshot: SnapshotIdentity;
  deliveryPolicy: DeliveryPolicy;
  status: RunStatus;
  sequence: number;
  units: Record<string, "pending" | "done" | "failed">;
  candidates: Record<string, CandidateRecord>;
  finalBatchSubmitted: boolean;
  summary?: string;
}
export interface ReviewReport {
  schemaVersion: 1;
  runId: string;
  snapshot: SnapshotIdentity;
  status: "completed" | "partial" | "failed" | "cancelled";
  summary: string;
  findings: FindingCandidate[];
  coverage: Record<string, "pending" | "done" | "failed">;
  /** No publisher is implemented by the scaffold. */
  publication: "not_requested";
}
export type EventPayload =
  | { type: "run.started"; snapshot: SnapshotIdentity; deliveryPolicy: DeliveryPolicy; units: string[] }
  | { type: "candidates.submitted"; channel: DeliveryPolicy; candidates: FindingCandidate[] }
  | { type: "final_batch.accepted"; candidates: FindingCandidate[]; reviewedPaths: string[]; reason: string }
  | { type: "candidate.decided"; candidateId: string; disposition: "accepted" | "rejected"; reason: string }
  | { type: "unit.finished"; unitId: string; outcome: "done" | "failed" }
  | { type: "run.finished"; outcome: "completed" | "partial" | "failed" | "cancelled"; summary: string };
export interface ReviewEvent {
  schemaVersion: 1;
  id: string;
  runId: string;
  snapshotId: string;
  sequence: number;
  at: string;
  payload: EventPayload;
}
