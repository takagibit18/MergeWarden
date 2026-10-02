import type { Advice, DecisionAdvisor, DecisionRequest } from "./contracts.ts";
/** Transparent baseline; never interprets arbitrary source code or grants permissions. */
export class RuleAdvisor implements DecisionAdvisor {
  async advise(request: DecisionRequest, _signal: AbortSignal): Promise<Advice> {
    const preferred = request.facts["evidenceNeed"] === "callers" ? "TRACE_CALLERS" :
      request.facts["evidenceNeed"] === "literal" ? "SEARCH_LITERAL" : undefined;
    const selected = preferred && request.allowedOptions.includes(preferred) ? [preferred] : [];
    return { requestId: request.id, snapshotId: request.snapshotId, stateVersion: request.stateVersion,
      catalogVersion: request.catalogVersion, provider: "rules-v1", selected, abstain: selected.length === 0 };
  }
}
