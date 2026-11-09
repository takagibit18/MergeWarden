/** Runtime vocabularies shared by the contracts, the core service and the browser. Dependency-free. */
export const REVIEW_SCOPES = ['staged', 'worktree', 'commits'] as const;
export const REVIEW_STATUSES = ['accepted', 'running', 'completed', 'partial', 'failed', 'cancelled', 'no_changes', 'delivery_failed', 'interrupted'] as const;
export const REPORT_STATUSES = ['completed', 'partial', 'failed', 'cancelled'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Read-only navigation view (ADR 0021). */
export const NAVIGATION_STATES = ['recorded', 'unavailable', 'not_recorded'] as const;
export const NAVIGATION_ENTITY_KINDS = ['directory', 'file', 'class', 'function'] as const;
export const NAVIGATION_RELATIONS = ['CONTAINS', 'IMPORTS', 'CALLS', 'INHERITS'] as const;
export const NAVIGATION_RESOLUTIONS = ['resolved_scoped', 'resolved_import_alias', 'candidate', 'unresolved', 'definite'] as const;
export const NAVIGATION_OPERATIONS = ['graph_lookup', 'graph_neighbors', 'investigation_delivered', 'candidate_expanded'] as const;
export const NAVIGATION_NODE_ROLES = ['in_changed_file', 'change_root', 'visited', 'candidate', 'expanded', 'evidence_overlap'] as const;
