import type { ReviewEvent } from "../domain/contracts.ts";
/** An uncertain durable write cannot be retried as a model input correction. */
export class PersistenceFailure extends Error {
  readonly code = "PERSISTENCE_FAILURE";
  constructor() { super("Session persistence failed; this run cannot continue or retry submission"); this.name = "PersistenceFailure"; }
}
/** SessionJournal is a business-event projection over Pi, not a second harness.
 * Production append must be durable and fail closed; MemoryJournal is test-only.
 * No implementation claims exactly-once. See ADR-0012. */
export interface SessionJournal {
  append(event: ReviewEvent): Promise<void>;
  readActiveBranch(): Promise<ReviewEvent[]>;
}
