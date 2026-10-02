import type { ReviewEvent } from "../domain/contracts.ts";
import type { SessionJournal } from "../ports/journal.ts";
/** Offline tests/demo only. Never wire this into a real durable review service. */
export class MemoryJournal implements SessionJournal {
  private entries: ReviewEvent[] = [];
  async append(event: ReviewEvent): Promise<void> { this.entries.push(structuredClone(event)); }
  async readActiveBranch(): Promise<ReviewEvent[]> { return structuredClone(this.entries); }
}
