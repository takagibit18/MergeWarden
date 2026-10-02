import type { ReviewEvent, ReviewState } from "./contracts.ts";
import { assertCandidate, assertSnapshot, requireCondition, requireText } from "./validation.ts";
/** Pure state transitions. Shape checks do NOT prove a bug is semantically real. */
export function reduceEvent(previous: ReviewState | undefined, event: ReviewEvent): ReviewState {
  requireCondition(event.schemaVersion === 1, "unsupported event schema");
  requireText(event.id, "event.id"); requireText(event.runId, "event.runId");
  requireText(event.at, "event.at");
  requireCondition(Number.isInteger(event.sequence), "invalid event sequence");
  if (event.payload.type === "run.started") {
    requireCondition(!previous, "run already started");
    requireCondition(event.sequence === 1, "first sequence must be one");
    assertSnapshot(event.payload.snapshot);
    requireCondition(event.snapshotId === event.payload.snapshot.id, "start snapshot mismatch");
    requireCondition(["final_only", "incremental_candidates"].includes(event.payload.deliveryPolicy), "invalid delivery policy");
    requireCondition(Array.isArray(event.payload.units) && event.payload.units.length > 0, "explicit review scope required");
    for (const id of event.payload.units) requireText(id, "unit id");
    requireCondition(new Set(event.payload.units).size === event.payload.units.length, "duplicate unit ids");
    return { runId: event.runId, snapshot: structuredClone(event.payload.snapshot), deliveryPolicy: event.payload.deliveryPolicy,
      sequence: 1, status: "reviewing", units: Object.fromEntries(event.payload.units.map((id) => [id, "pending"])), candidates: {}, finalBatchSubmitted: false };
  }
  requireCondition(previous, "run not started");
  requireCondition(previous.status === "reviewing", "run is terminal");
  requireCondition(event.runId === previous.runId && event.snapshotId === previous.snapshot.id, "event identity mismatch");
  requireCondition(event.sequence === previous.sequence + 1, "non-contiguous event sequence");
  const state = structuredClone(previous);
  const payload = event.payload;
  switch (payload.type) {
    case "final_batch.accepted": {
      requireCondition(state.deliveryPolicy === "final_only", "atomic final batch requires final_only");
      requireCondition(!state.finalBatchSubmitted, "final batch already submitted");
      requireCondition(Array.isArray(payload.candidates) && Array.isArray(payload.reviewedPaths), "invalid final batch");
      requireText(payload.reason, "acceptance reason");
      requireCondition(new Set(payload.reviewedPaths).size === payload.reviewedPaths.length, "duplicate reviewed paths");
      for (const path of payload.reviewedPaths) requireCondition(Object.hasOwn(state.units, path), "unknown review unit");
      for (const candidate of payload.candidates) {
        assertCandidate(candidate, state.snapshot.id);
        requireCondition(!Object.hasOwn(state.candidates, candidate.id), "duplicate candidate id");
        Object.defineProperty(state.candidates, candidate.id, { value: { candidate: structuredClone(candidate), disposition: "accepted", reason: payload.reason }, enumerable: true, writable: true, configurable: true });
      }
      for (const path of payload.reviewedPaths) state.units[path] = "done";
      state.finalBatchSubmitted = true;
      break;
    }
    case "candidates.submitted": {
      requireCondition(payload.channel === state.deliveryPolicy, "delivery channel disabled for this experiment");
      requireCondition(Array.isArray(payload.candidates), "candidate batch must be an array");
      if (payload.channel === "final_only") {
        requireCondition(!state.finalBatchSubmitted, "final batch already submitted");
        state.finalBatchSubmitted = true;
      }
      for (const candidate of payload.candidates) {
        assertCandidate(candidate, state.snapshot.id);
        requireCondition(!Object.hasOwn(state.candidates, candidate.id), "duplicate candidate id");
        Object.defineProperty(state.candidates, candidate.id, { value: { candidate: structuredClone(candidate), disposition: "pending" }, enumerable: true, writable: true, configurable: true });
      }
      break;
    }
    case "candidate.decided": {
      const record = Object.hasOwn(state.candidates, payload.candidateId) ? state.candidates[payload.candidateId] : undefined;
      requireCondition(record, "unknown candidate");
      requireCondition(payload.disposition === "accepted" || payload.disposition === "rejected", "invalid disposition");
      requireText(payload.reason, "decision reason");
      record.disposition = payload.disposition;
      record.reason = payload.reason; // Rejection can retract an earlier acceptance before completion.
      break;
    }
    case "unit.finished":
      requireCondition(Object.hasOwn(state.units, payload.unitId), "unknown review unit");
      requireCondition(payload.outcome === "done" || payload.outcome === "failed", "invalid unit outcome");
      state.units[payload.unitId] = payload.outcome;
      break;
    case "run.finished":
      requireText(payload.summary, "summary");
      requireCondition(["completed", "partial", "failed", "cancelled"].includes(payload.outcome), "invalid terminal outcome");
      if (payload.outcome === "completed") {
        requireCondition(state.deliveryPolicy !== "final_only" || state.finalBatchSubmitted, "final batch is missing");
        requireCondition(Object.values(state.units).every((item) => item === "done"), "incomplete coverage cannot complete");
        requireCondition(Object.values(state.candidates).every((item) => item.disposition !== "pending"), "unresolved candidates cannot complete");
      }
      state.status = payload.outcome;
      state.summary = payload.summary;
      break;
    default:
      throw new Error("unknown event type");
  }
  state.sequence = event.sequence;
  return state;
}
