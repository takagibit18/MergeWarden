/** Runtime vocabularies shared by the contracts, the core service and the browser. Dependency-free. */
export const REVIEW_SCOPES = ['staged', 'worktree', 'commits'] as const;
export const REVIEW_STATUSES = ['accepted', 'running', 'completed', 'partial', 'failed', 'cancelled', 'no_changes', 'delivery_failed', 'interrupted'] as const;
export const REPORT_STATUSES = ['completed', 'partial', 'failed', 'cancelled'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
