import type { Advice, DecisionAdvisor, DecisionRequest } from "./contracts.ts";
export class NoopAdvisor implements DecisionAdvisor {
  async advise(request: DecisionRequest, _signal: AbortSignal): Promise<Advice> {
    return { requestId: request.id, snapshotId: request.snapshotId, stateVersion: request.stateVersion,
      catalogVersion: request.catalogVersion, provider: "noop", selected: [], abstain: true };
  }
}
