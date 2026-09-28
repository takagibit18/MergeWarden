/** Shared host policy; Pi still owns every model/tool turn. */
export const BUDGET_POLICY_VERSION = 'review-closeout-1';
export class BudgetClosingError extends Error {
  constructor() { super('BUDGET_CLOSING: Investigation is closed; only submit_review may execute. Use existing evidence and omit unchecked paths.'); }
}
export interface BudgetState {
  version: typeof BUDGET_POLICY_VERSION;
  phase: 'investigating' | 'warning' | 'closing' | 'submitted';
  reason?: 'operations' | 'time';
  operationLimit: number; operationsUsed: number; operationsRemaining: number; submissionReserve: number;
  timeRemainingMs: number; closingTimeReserveMs: number;
}
export class ReviewBudget {
  private phase: BudgetState['phase'] = 'investigating';
  private reason?: BudgetState['reason'];
  readonly submissionReserve: number;
  readonly closingTimeReserveMs: number;
  private options: { limit: number; timeoutMs: number; started: number; used(): number; now?(): number };
  constructor(options: ReviewBudget['options']) {
    this.options = options;
    this.submissionReserve = options.limit > 1 ? Math.min(10, Math.max(1, Math.floor(options.limit / 10))) : 0;
    this.closingTimeReserveMs = Math.min(90_000, Math.floor(options.timeoutMs * .15));
  }
  submitted() { this.phase = 'submitted'; }
  state(): BudgetState {
    const used = this.options.used(), remaining = Math.max(0, this.options.limit - used);
    const time = Math.max(0, Math.ceil(this.options.timeoutMs - ((this.options.now?.() ?? performance.now()) - this.options.started)));
    if (this.phase !== 'submitted' && this.phase !== 'closing') {
      if (remaining <= this.submissionReserve || time <= this.closingTimeReserveMs) {
        this.phase = 'closing'; this.reason = remaining <= this.submissionReserve ? 'operations' : 'time';
      } else if (remaining <= this.submissionReserve * 2 || time <= this.closingTimeReserveMs * 2) this.phase = 'warning';
    }
    return { version: BUDGET_POLICY_VERSION, phase: this.phase, ...(this.reason ? { reason: this.reason } : {}),
      operationLimit: this.options.limit, operationsUsed: used, operationsRemaining: remaining, submissionReserve: this.submissionReserve,
      timeRemainingMs: time, closingTimeReserveMs: this.closingTimeReserveMs };
  }
}
export function budgetGuidance(state: BudgetState): string {
  return '[Host review budget]\n' + JSON.stringify(state) + '\n' + (state.phase === 'submitted'
    ? 'Final submission accepted. End the response; do not call more tools.'
    : state.phase === 'closing'
      ? 'Investigation is closed. Only submit_review may execute. Submit supported findings using already-read evidence, or none. Include only fully read diff paths; omit unchecked paths and explain the limitation. If submission validation fails, correct or remove the unsupported item; do not invent references or claim unchecked coverage. No new reads, searches or structural expansion are allowed.'
      : state.phase === 'warning'
        ? 'Budget is approaching closeout. Stop broad exploration, resolve only essential gaps, and prepare submit_review. The submission reserve cannot fund new investigation. Model tools and host retrieval share the operation limit.'
        : 'Model tools and host retrieval share this limit. Prepare to submit before the closing phase; elapsed time and remaining operations are both bounded.');
}
