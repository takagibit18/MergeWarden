const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function formatDate(value: string, full = false): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间不可用' : (full ? fullDateFormatter : dateFormatter).format(date);
}

export function shortId(value: string, length = 12): string {
  return value.length > length ? value.slice(0, length) : value;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '未记录';
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** The verified summary title, or a scope-and-time title the browser formats in the viewer's locale. */
export function reviewTitle(item: HistoryItem): string {
  if (item.title?.trim()) return item.title.trim();
  const scope = item.scope === 'commits' ? '提交审查' : item.scope === 'staged' ? '暂存区审查' : item.scope === 'worktree' ? '工作区审查' : '代码审查';
  return `${scope} · ${formatDate(item.createdAt, true)}`;
}
import type { HistoryItem } from '@mergewarden/contracts';
