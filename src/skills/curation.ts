import { join } from 'node:path';
import { writeJson } from '../infrastructure/files.ts';
import { SkillBank } from './bank.ts';
import type { ProposedChange, Skill } from './contracts.ts';
import { computeUsage } from './usage.ts';
import type { SkillUsage } from './usage.ts';

/**
 * Layer 3 (stored knowledge): periodic, usage-based recommendations. Curation never edits
 * knowledge itself. Retirements are staged in the same approval queue as learning; content
 * changes are only reported, because rewriting a Skill needs a person or a learning source.
 */
export const CURATION_POLICY = Object.freeze({
  version: 'skill-curation-1',
  /** A revision younger than this is never judged as unused. */
  minAgeDays: 30,
  /** A Skill last read longer ago than this is considered idle. */
  idleDays: 60,
  /** Exposed this often without a single read: its catalog conditions are not helping. */
  unreadAfterExposures: 5,
  /** Contradicting feedback on reading runs at least this often, and more than supporting feedback. */
  minContradictions: 2,
});
export type CurationPolicy = Omit<typeof CURATION_POLICY, 'version'>;

export interface Recommendation {
  id: string; revision: number; state: Skill['state'];
  kind: 'unused' | 'idle' | 'unread' | 'contradicted';
  action: 'retire' | 'review';
  reason: string;
  usage: Pick<SkillUsage, 'exposures' | 'reads' | 'lastExposedAt' | 'lastReadAt' | 'feedbackOnReadingRuns'>;
  revisionAgeDays: number;
}
export interface CurationReport {
  policy: string; generatedAt: string; usageComputedAt: string; bankSnapshotId: string;
  considered: number; skipped: { pinned: string[]; unmanaged: number; inactive: number; pendingProposal: string[] };
  recommendations: Recommendation[]; stagedProposals?: string[];
}

const DAY = 86_400_000;
const days = (from: string, now: Date) => Math.floor((now.getTime() - Date.parse(from)) / DAY);

function judge(skill: Skill, usage: SkillUsage, now: Date, policy: CurationPolicy): Omit<Recommendation, 'id' | 'revision' | 'state' | 'usage' | 'revisionAgeDays'> | undefined {
  const age = days(skill.createdAt, now), signals = usage.feedbackOnReadingRuns;
  if (signals.contradicts >= policy.minContradictions && signals.contradicts > signals.supports) {
    return { kind: 'contradicted', action: 'review', reason: `Contradicting feedback on ${signals.contradicts} reading run(s) outweighs ${signals.supports} supporting; narrow or retire it.` };
  }
  if (age < policy.minAgeDays) return undefined;
  if (usage.exposures === 0) return { kind: 'unused', action: 'retire', reason: `No review has listed it in ${age} days since revision ${skill.revision}.` };
  if (usage.reads === 0 && usage.exposures >= policy.unreadAfterExposures) {
    return { kind: 'unread', action: 'review', reason: `Listed in ${usage.exposures} reviews but never read; its conditions or title may not match real changes.` };
  }
  if (usage.lastReadAt && days(usage.lastReadAt, now) >= policy.idleDays) {
    return { kind: 'idle', action: 'retire', reason: `Last read ${days(usage.lastReadAt, now)} days ago.` };
  }
  return undefined;
}

export async function curate(state: string, options: { now?: Date; stage?: boolean; policy?: Partial<CurationPolicy> } = {}): Promise<CurationReport> {
  const now = options.now ?? new Date(), policy = { ...CURATION_POLICY, ...options.policy };
  const bank = new SkillBank(state), { id: bankSnapshotId, snapshot } = await bank.current();
  const usage = await computeUsage(state, now);
  const pending = new Set((await bank.proposals(snapshot)).filter(p => p.status === 'pending').flatMap(p => p.changes.map(c => c.id)));
  const report: CurationReport = { policy: CURATION_POLICY.version, generatedAt: now.toISOString(), usageComputedAt: usage.computedAt, bankSnapshotId,
    considered: 0, skipped: { pinned: [], unmanaged: 0, inactive: 0, pendingProposal: [] }, recommendations: [] };
  const skills = (await bank.skills(snapshot)).sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of skills) {
    if (skill.owner !== 'learner') { report.skipped.unmanaged++; continue; }
    if (!['trial', 'active'].includes(skill.state)) { report.skipped.inactive++; continue; }
    if (snapshot.pins?.[skill.id]) { report.skipped.pinned.push(skill.id); continue; }
    if (pending.has(skill.id)) { report.skipped.pendingProposal.push(skill.id); continue; }
    report.considered++;
    const u = usage.skills[skill.id]!, verdict = judge(skill, u, now, policy);
    if (!verdict) continue;
    report.recommendations.push({ id: skill.id, revision: skill.revision, state: skill.state, ...verdict, revisionAgeDays: days(skill.createdAt, now),
      usage: { exposures: u.exposures, reads: u.reads, lastExposedAt: u.lastExposedAt, lastReadAt: u.lastReadAt, feedbackOnReadingRuns: u.feedbackOnReadingRuns } });
  }
  const retire = report.recommendations.filter(r => r.action === 'retire');
  if (options.stage && retire.length) {
    // One proposal per repository, so each approval decision stays inside one knowledge scope.
    const byRepository = new Map<string, ProposedChange[]>();
    for (const r of retire) {
      const previous = snapshot.skills[r.id]!, old = await bank.object<Skill>(previous);
      const candidate = await bank.put({ ...old, revision: old.revision + 1, state: 'retired', createdAt: now.toISOString() } satisfies Skill);
      byRepository.set(old.repositoryKey, [...byRepository.get(old.repositoryKey) ?? [], { op: 'retire', id: r.id, expectedRevision: old.revision, reason: `${r.kind}: ${r.reason}`, candidate, previous }]);
    }
    report.stagedProposals = [];
    for (const [repositoryKey, changes] of byRepository) report.stagedProposals.push((await bank.stage({ origin: 'curation', repositoryKey, changes, comparison: [], warnings: [] })).id);
    await writeJson(join(bank.root, 'curation', `${now.toISOString().replace(/[:.]/g, '-')}.json`), report);
  }
  return report;
}
