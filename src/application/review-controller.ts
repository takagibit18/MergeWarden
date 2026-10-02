import { randomUUID } from "node:crypto";
import type { DeliveryPolicy, EventPayload, ReviewReport, ReviewState, SnapshotIdentity } from "../domain/contracts.ts";
import { reduceEvent } from "../domain/reducer.ts";
import { requireCondition } from "../domain/validation.ts";
import type { SessionJournal } from "../ports/journal.ts";
import { PersistenceFailure } from "../ports/journal.ts";
export class ReviewController {
  private stateValue: ReviewState | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private journal: SessionJournal;
  private runId: string;
  private snapshot: SnapshotIdentity;
  private persistenceFailure: PersistenceFailure | undefined;
  constructor(journal: SessionJournal, runId: string, snapshot: SnapshotIdentity) {
    this.journal = journal; this.runId = runId; this.snapshot = structuredClone(snapshot);
  }
  get state(): ReviewState | undefined { return this.stateValue ? structuredClone(this.stateValue) : undefined; }
  start(policy: DeliveryPolicy, units: string[]): Promise<void> {
    return this.dispatch({ type: "run.started", snapshot: this.snapshot, deliveryPolicy: policy, units });
  }
  dispatch(payload: EventPayload): Promise<void> {
    const captured = structuredClone(payload);
    const job = this.queue.then(async () => {
      if (this.persistenceFailure) throw this.persistenceFailure;
      const event = { schemaVersion: 1 as const, id: randomUUID(), runId: this.runId, snapshotId: this.snapshot.id,
        sequence: (this.stateValue?.sequence ?? 0) + 1, at: new Date().toISOString(), payload: captured };
      const next = reduceEvent(this.stateValue, event);
      try { await this.journal.append(event); } // State changes only after a confirmed durable write.
      catch { this.persistenceFailure = new PersistenceFailure(); throw this.persistenceFailure; }
      this.stateValue = next;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
  /** Call only before exposing the controller to concurrent clients. */
  async restore(): Promise<void> {
    requireCondition(!this.stateValue, "cannot restore an active controller");
    let recovered: ReviewState | undefined;
    for (const event of await this.journal.readActiveBranch()) recovered = reduceEvent(recovered, event);
    if (recovered) {
      requireCondition(recovered.runId === this.runId && recovered.snapshot.id === this.snapshot.id &&
        recovered.snapshot.repositoryId === this.snapshot.repositoryId &&
        JSON.stringify(recovered.snapshot.baseVersion) === JSON.stringify(this.snapshot.baseVersion) &&
        JSON.stringify(recovered.snapshot.headVersion) === JSON.stringify(this.snapshot.headVersion) &&
        recovered.snapshot.baseCommit === this.snapshot.baseCommit && recovered.snapshot.headCommit === this.snapshot.headCommit &&
        recovered.snapshot.inputFingerprint === this.snapshot.inputFingerprint &&
        recovered.snapshot.configurationFingerprint === this.snapshot.configurationFingerprint, "resume identity mismatch");
    }
    this.stateValue = recovered;
  }
  report(): ReviewReport {
    const state = this.stateValue;
    requireCondition(state && ["completed", "partial", "failed", "cancelled"].includes(state.status), "report requires explicit termination");
    return { schemaVersion: 1, runId: state.runId, snapshot: structuredClone(state.snapshot),
      status: state.status as ReviewReport["status"], summary: state.summary ?? "",
      findings: Object.values(state.candidates).filter((item) => item.disposition === "accepted").map((item) => structuredClone(item.candidate)),
      coverage: structuredClone(state.units), publication: "not_requested" };
  }
}
