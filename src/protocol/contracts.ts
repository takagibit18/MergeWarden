import type { ReviewReport, SnapshotIdentity } from "../domain/contracts.ts";
/** Transport-neutral. This is NOT an MCP, ACP, or JSON-RPC implementation. */
export interface StartReviewRequest { protocolVersion: 1; requestId: string; snapshot: SnapshotIdentity }
export type EngineEvent =
  | { protocolVersion: 1; type: "run.progress"; runId: string; snapshotId: string; phase: string }
  | { protocolVersion: 1; type: "run.result"; runId: string; report: ReviewReport }
  | { protocolVersion: 1; type: "run.error"; runId: string; code: string; message: string };
export interface ReviewEngine {
  start(request: StartReviewRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
}
