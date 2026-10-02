import { BudgetClosingError } from './budget.ts';
/** One admission queue for model tools and host retrieval. Jobs must not enqueue child jobs. */
export type OperationOrigin = "model" | "host_dispatch";
export class OperationGate {
  private queue: Promise<unknown> = Promise.resolve();
  private charged = 0;
  readonly counts = { model: { requested: 0, accepted: 0, executed: 0, rejected: 0 }, host_dispatch: { requested: 0, accepted: 0, executed: 0, rejected: 0 } };
  private options: { limit: number; signal: AbortSignal; available(): boolean; unavailableReason?(): string; exhausted(): void; closing?(): boolean };
  constructor(options: OperationGate["options"]) { this.options = options; }
  get used() { return this.charged; }
  private check() {
    this.options.signal.throwIfAborted();
    if (!this.options.available()) throw Error(this.options.unavailableReason?.() ?? "Run is not accepting operations");
  }
  blockedModelCall() {
    this.counts.model.requested++; this.counts.model.rejected++;
    if (this.options.signal.aborted || !this.options.available()) return;
    if (this.charged >= this.options.limit) this.options.exhausted(); else if (!this.options.closing?.()) this.charged++;
  }
  run<T>(origin: OperationOrigin, execute: () => Promise<T>, submission = false): Promise<T> {
    const count = this.counts[origin]; count.requested++;
    try {
      this.check();
      if (this.charged >= this.options.limit) { this.options.exhausted(); throw Error("Tool budget exhausted"); }
      if (!submission && this.options.closing?.()) throw new BudgetClosingError();
    } catch (error) { count.rejected++; return Promise.reject(error); }
    this.charged++; count.accepted++;
    const job = this.queue.then(async () => {
      this.check(); count.executed++;
      const result = await execute(); this.options.signal.throwIfAborted(); return result;
    });
    this.queue = job.catch(() => undefined); return job;
  }
  settled() { return this.queue; }
}
