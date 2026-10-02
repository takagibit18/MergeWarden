export type DecisionPoint = "retrieval_strategy" | "tool_shortlist" | "skill_selection" | "context_ranking" | "escalation" | "model_tier" | "candidate_relation";
export type AdvisorMode = "off" | "shadow" | "advisory";
export interface DecisionRequest {
  id: string; runId: string; snapshotId: string; stateVersion: number; point: DecisionPoint;
  catalogVersion: string; allowedOptions: string[]; facts: Record<string, unknown>;
}
export interface Advice {
  requestId: string; snapshotId: string; stateVersion: number; catalogVersion: string;
  provider: string; selected: string[]; abstain: boolean; confidence?: number;
}
export interface DecisionAdvisor {
  advise(request: DecisionRequest, signal: AbortSignal): Promise<Advice>;
}
export interface DecisionObservation {
  requestId: string; provider: string; mode: AdvisorMode;
  outcome: "accepted" | "abstained" | "stale" | "invalid" | "unavailable";
  durationMs: number; advice?: Advice;
}
