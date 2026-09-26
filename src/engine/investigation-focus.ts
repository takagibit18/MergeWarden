import { createHash } from 'node:crypto';
import type { DispatchObservation, DispatchTrigger } from './dispatch-contracts.ts';
import type { ChangeHint, LineRange } from './investigation-contracts.ts';

export const stableId = (prefix: string, value: unknown) => prefix + createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const result: LineRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)) {
    const previous = result.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
    else result.push({ ...range });
  }
  return result;
}

/** Only complete immutable diff observations establish focus. Reads/searches cannot replace it. */
export class InvestigationFocus {
  private pages = new Map<string, Map<number, string>>();
  private changes = new Map<string, ChangeHint[]>();
  private frozen = new Map<string, { anchors: ChangeHint[]; omitted: ChangeHint[] }>();
  private snapshotId: string;
  private changedPaths: readonly string[];
  constructor(snapshotId: string, changedPaths: readonly string[]) { this.snapshotId = snapshotId; this.changedPaths = changedPaths; }
  observe({ toolName, result: r, isError }: DispatchObservation) {
    if (isError || toolName !== 'read_diff' || r.status !== 'ok' || r.snapshotId !== this.snapshotId
      || typeof r.path !== 'string' || !this.changedPaths.includes(r.path) || !Array.isArray(r.lines)
      || !Number.isSafeInteger(r.offset) || Number(r.offset) < 0 || !Number.isSafeInteger(r.totalLines)) return;
    const pages = this.pages.get(r.path) ?? new Map<number, string>(); this.pages.set(r.path, pages);
    r.lines.forEach((line, i) => { if (typeof line === 'string') pages.set(Number(r.offset) + i, line); });
    if (pages.size !== r.totalLines || Array.from({ length: pages.size }, (_, i) => i).some(i => !pages.has(i))) return;
    let line = 0, deleted = false; const additions: LineRange[] = [];
    for (let i = 0; i < pages.size; i++) {
      const text = pages.get(i)!; const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) { line = Number(hunk[1]); continue; }
      if (/^(diff |index |---|\+\+\+|\\)/.test(text)) continue;
      if (text.startsWith('-')) deleted = true;
      if (line > 0 && text.startsWith('+')) additions.push({ startLine: line, endLine: line });
      if (text.startsWith('+') || text.startsWith(' ')) line++;
    }
    this.changes.set(r.path, additions.length ? mergeRanges(additions).map(range => ({ path: r.path as string, ...range }))
      : deleted ? [{ path: r.path, deleted: true }] : []);
  }
  freeze(trigger: DispatchTrigger) {
    const existing = this.frozen.get(trigger.routeId); if (existing) return structuredClone(existing);
    let hints: ChangeHint[];
    if (trigger.reason === 'callable_removal') hints = [{ path: trigger.path, kind: 'function', name: trigger.targetHint, deleted: true }];
    else if (trigger.routeType === 'IMPORT_CHECK') hints = [{ path: trigger.path, kind: 'file' }];
    else if (trigger.routeType === 'STRUCTURAL_ESCALATION') hints = [...this.changes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([, ranges]) => ranges);
    else hints = (this.changes.get(trigger.path) ?? [{ path: trigger.path }]).map(h => ({ ...h,
      kind: trigger.routeType === 'CALLER_CHECK' ? 'function' : 'class', name: trigger.targetHint }));
    // Keep the successful prefix; expose every omitted range in private request telemetry.
    const focus = { anchors: hints.slice(0, 32), omitted: hints.slice(32) };
    this.frozen.set(trigger.routeId, structuredClone(focus)); return structuredClone(focus);
  }
}
