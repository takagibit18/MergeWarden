import type { Advice, AdvisorMode, DecisionAdvisor, DecisionObservation, DecisionRequest } from "./contracts.ts";
/** No dependency on the Agent's tool registry. Shadow output is never returned to it. */
export async function consultAdvisor(options: {
  mode: AdvisorMode; provider: DecisionAdvisor; request: DecisionRequest; timeoutMs: number;
  currentStateVersion: () => number; observe: (item: DecisionObservation) => void;
}): Promise<Advice | undefined> {
  if (options.mode === "off") return undefined;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error("invalid advisor timeout");
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observation: DecisionObservation = { requestId: options.request.id, provider: "unknown", mode: options.mode, outcome: "unavailable", durationMs: 0 };
  let accepted: Advice | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("advisor timeout")); }, options.timeoutMs);
    });
    const advice = await Promise.race([options.provider.advise(structuredClone(options.request), controller.signal), timeout]);
    observation.provider = advice.provider;
    const request = options.request;
    const shapeOk = Array.isArray(advice.selected) && typeof advice.abstain === "boolean" &&
      typeof advice.provider === "string" && (advice.confidence === undefined ||
        (Number.isFinite(advice.confidence) && advice.confidence >= 0 && advice.confidence <= 1));
    if (!shapeOk || advice.requestId !== request.id || advice.catalogVersion !== request.catalogVersion ||
      advice.snapshotId !== request.snapshotId || !advice.selected.every((id) => request.allowedOptions.includes(id)) ||
      new Set(advice.selected).size !== advice.selected.length || (advice.abstain && advice.selected.length > 0) ||
      (!advice.abstain && advice.selected.length === 0)) {
      observation.outcome = "invalid";
    } else if (advice.stateVersion !== request.stateVersion || request.stateVersion !== options.currentStateVersion()) {
      observation.outcome = "stale";
    } else {
      observation.advice = structuredClone(advice);
      observation.outcome = advice.abstain ? "abstained" : "accepted";
      if (!advice.abstain) accepted = advice;
    }
  } catch { observation.outcome = "unavailable"; }
  finally {
    if (timer) clearTimeout(timer);
    observation.durationMs = Date.now() - started;
    try { options.observe(observation); } catch { /* Optional telemetry must not block a review. */ }
  }
  return options.mode === "advisory" ? accepted : undefined;
}
