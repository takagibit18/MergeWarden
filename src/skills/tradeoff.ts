import { sha256 } from '../infrastructure/files.ts';
import type { EvidenceRef, Severity } from '../domain/contracts.ts';
import type { SkillPackageEntry, TradeoffAnchor } from './contracts.ts';

/** Same line split as SnapshotStore.source, so a feedback range hash equals its page contentSha256. */
const sourceLines = (text: string) => { const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };

/** First window of the head file whose exact lines hash to the anchor; survives edits elsewhere and moved code. */
export function locateAnchor(text: string, anchor: TradeoffAnchor): { path: string; startLine: number; endLine: number } | undefined {
  const lines = sourceLines(text);
  for (let start = 0; start + anchor.lineCount <= lines.length; start++) {
    if (sha256(lines.slice(start, start + anchor.lineCount).join('\n')) === anchor.sha256) return { path: anchor.path, startLine: start + 1, endLine: start + anchor.lineCount };
  }
  return undefined;
}

export interface TradeoffCitation { skillId: string; note: string }
export type TradeoffDecision = { kind: 'folded'; skillId: string; revision: number; note: string } | { kind: 'rejected'; reason: string };
interface Cited { severity: Severity; evidence: readonly EvidenceRef[] }

const within = (path: string, scope: readonly string[]) => scope.some(p => path === p || path.startsWith(p + '/'));
const overlaps = (e: EvidenceRef, a: NonNullable<SkillPackageEntry['anchor']>) => e.path === a.path && e.startLine <= a.endLine && a.startLine <= e.endLine;

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
    [!!entry?.anchor && candidate.evidence.some(e => e.revision === 'head' && e.snapshotId === snapshotId && overlaps(e, entry.anchor!)), `No head evidence overlaps the accepted lines of Skill ${id}`],
    [candidate.severity === 'low' || candidate.severity === 'medium', `Severity ${candidate.severity} is never folded`],
  ];
  const failed = gates.find(([ok]) => !ok);
  return failed ? { kind: 'rejected', reason: failed[1] } : { kind: 'folded', skillId: id, revision: entry!.skill.revision, note: citation.note };
}
