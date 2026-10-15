import type { HistoryItem } from '../../../packages/contracts/src/types.ts';

type Title = Pick<HistoryItem, 'title' | 'titleSource'>;

export function fallbackTitle(item: Pick<HistoryItem, 'scope' | 'createdAt'>): Title {
  const scope = item.scope === 'commits' ? '提交审查' : item.scope === 'staged' ? '暂存区审查' : item.scope === 'worktree' ? '工作区审查' : '代码审查';
  return { title: `${scope} · ${item.createdAt.slice(0, 16).replace('T', ' ')} UTC`, titleSource: 'fallback' };
}

/** A summary is used only after the native report has passed delivery verification. */
export function verifiedTitle(item: Pick<HistoryItem, 'scope' | 'createdAt'>, summary: string): Title {
  const line = summary.split(/\r?\n/).map(value => value.replace(/^[\s#>*-]+/, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return fallbackTitle(item);
  const title = line.slice(0, 160).replace(/[\uD800-\uDBFF]$/, '');
  return { title, titleSource: 'summary' };
}
