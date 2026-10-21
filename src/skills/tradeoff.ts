import { sha256 } from '../infrastructure/files.ts';
import type { EvidenceRef, Severity } from '../domain/contracts.ts';
import type { SkillPackageEntry, TradeoffAnchor } from './contracts.ts';

type LineRange = { startLine: number; endLine: number };

/**
 * The single window of the head file whose exact lines hash to the anchor; it survives edits elsewhere and moved code.
 * A second copy, or a window inside lines this snapshot added or modified, is not the accepted instance.
 * Lines split as in SnapshotStore.source, so a feedback range hash equals its page contentSha256.
 */
export function locateAnchor(text: string, anchor: TradeoffAnchor, changed?: LineRange): { path: string; startLine: number; endLine: number } | undefined {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  if (starts.at(-1) === text.length) starts.pop();
  const end = (line: number) => line + 1 < starts.length ? starts[line + 1]! - 1 : text.endsWith('\n') ? text.length - 1 : text.length;
  const found: number[] = [];
  for (let start = 0; start + anchor.lineCount <= starts.length && found.length < 2; start++) {
    if (sha256(text.slice(starts[start], end(start + anchor.lineCount - 1))) === anchor.sha256) found.push(start + 1);
  }
  if (found.length !== 1) return undefined;
  const located = { path: anchor.path, startLine: found[0]!, endLine: found[0]! + anchor.lineCount - 1 };
  return changed && changed.startLine <= located.endLine && located.startLine <= changed.endLine ? undefined : located;
}

export interface TradeoffCitation { skillId: string; note: string }
export type TradeoffDecision = { kind: 'folded'; skillId: string; revision: number; note: string } | { kind: 'rejected'; reason: string };
interface Cited { severity: Severity; evidence: readonly EvidenceRef[] }

const within = (path: string, scope: readonly string[]) => scope.some(p => path === p || path.startsWith(p + '/'));
const inside = (e: EvidenceRef, a: NonNullable<SkillPackageEntry['anchor']>) => e.path === a.path && e.startLine >= a.startLine && e.endLine <= a.endLine;

/** ADR 0020 item 5: deterministic fold gates in order; the first failing gate names the reason. */
export function decideAcceptedTradeoff(candidate: Cited, citation: TradeoffCitation, entry: SkillPackageEntry | undefined, readIds: ReadonlySet<string>, snapshotId: string): TradeoffDecision {
  const id = citation.skillId;
  const gates: Array<[boolean, string]> = [
    [!!entry, `Skill ${id} is not in this run's frozen catalog`],
    [entry?.skill.type === 'accepted_tradeoff', `Skill ${id} is not an accepted trade-off`],
    [entry?.skill.state === 'active', `Skill ${id} is not active`],
    [readIds.has(id), `Skill ${id} was not read in this run`],
    [entry?.freshness === 'current' && !!entry.anchor, `Skill ${id} anchor was not found in this head snapshot`],
    [!!entry && candidate.evidence.every(e => within(e.path, entry.skill.paths)), `Evidence lies outside Skill ${id} paths`],
    [!!entry?.anchor && candidate.evidence.every(e => e.path === entry.anchor!.path), `Evidence cites a file other than the accepted lines of Skill ${id}`],
    [!!entry?.anchor && candidate.evidence.some(e => e.revision === 'head') && candidate.evidence.every(e => e.revision !== 'head' || e.snapshotId === snapshotId && inside(e, entry.anchor!)), `Head evidence must lie inside the accepted lines of Skill ${id}`],
    [candidate.severity === 'low' || candidate.severity === 'medium', `Severity ${candidate.severity} is never folded`],
  ];
  const failed = gates.find(([ok]) => !ok);
  return failed ? { kind: 'rejected', reason: failed[1] } : { kind: 'folded', skillId: id, revision: entry!.skill.revision, note: citation.note };
}
