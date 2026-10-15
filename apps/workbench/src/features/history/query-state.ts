import { historyQuerySchema } from '@mergewarden/contracts';
import type { HistoryQuery, ReviewScope, ReviewStatus } from '@mergewarden/contracts';

export const scopeLabels: Record<ReviewScope, string> = { commits: '提交对比', staged: '暂存区', worktree: '工作区' };

export interface HistoryFilterValues { workspaceId: string; status: ReviewStatus | ''; scope: ReviewScope | '' }

export function readHistoryQuery(params: URLSearchParams) {
  const input = Object.fromEntries(params.entries());
  return historyQuerySchema.safeParse(input);
}

export function historySearch(query: HistoryQuery): URLSearchParams {
  const valid = historyQuerySchema.parse(query);
  const params = new URLSearchParams();
  if (valid.workspaceId) params.set('workspaceId', valid.workspaceId);
  if (valid.status) params.set('status', valid.status);
  if (valid.scope) params.set('scope', valid.scope);
  if (valid.limit !== 20) params.set('limit', String(valid.limit));
  if (valid.cursor) params.set('cursor', valid.cursor);
  return params;
}

export function filtersToQuery(values: HistoryFilterValues, limit: number): HistoryQuery {
  return { ...(values.workspaceId ? { workspaceId: values.workspaceId } : {}), ...(values.status ? { status: values.status } : {}), ...(values.scope ? { scope: values.scope } : {}), limit };
}
