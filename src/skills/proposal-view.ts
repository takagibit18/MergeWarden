import type { SkillBank } from './bank.ts';
import type { ComparisonEntry, Proposal, Skill } from './contracts.ts';

type FieldChange = { field: string; before: string; after: string } | { field: string; removed: string[]; added: string[] };
export interface ChangeView {
  op: string; id: string; reason: string;
  revision: { from: number; to: number }; state: { from: string | null; to: string };
  title: string; fields: FieldChange[]; sourcesAdded: number; sourcesRemoved: number;
}
export interface ProposalView {
  id: string; status: Proposal['status']; origin: Proposal['origin']; createdAt: string; repositoryKey: string;
  decision?: Proposal['decision']; comparison: ComparisonEntry[]; warnings: string[]; changes: ChangeView[];
}

const LIST_FIELDS = ['conditions', 'steps', 'counterexamples', 'stopConditions', 'paths', 'languages', 'keywords', 'symbols'] as const;
const TEXT_FIELDS = ['name', 'description', 'title', 'type', 'scopeType'] as const;

function fields(before: Skill | undefined, after: Skill): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of TEXT_FIELDS) {
    const a = String(before?.[field] ?? ''), b = String(after[field] ?? '');
    if (a !== b) out.push({ field, before: a, after: b });
  }
  for (const field of LIST_FIELDS) {
    const a = before?.[field] ?? [], b = after[field] ?? [];
    const removed = a.filter(v => !b.includes(v)), added = b.filter(v => !a.includes(v));
    if (removed.length || added.length) out.push({ field, removed, added });
  }
  const refs = (s?: Skill) => Object.entries(s?.references ?? {}).map(([k, v]) => `${k} (${Buffer.byteLength(v)} bytes)`);
  const ra = refs(before), rb = refs(after);
  if (ra.join() !== rb.join()) out.push({ field: 'references', removed: ra.filter(v => !rb.includes(v)), added: rb.filter(v => !ra.includes(v)) });
  const deps = (s?: Skill) => (s?.dependencies ?? []).map(d => `${d.path}@${d.hash.slice(0, 12)}`);
  const a = deps(before), b = deps(after);
  if (a.join() !== b.join()) out.push({ field: 'dependencies', removed: a.filter(v => !b.includes(v)), added: b.filter(v => !a.includes(v)) });
  return out;
}

/** What an approver needs: per-field changes, state transitions, the learner's comparison and Layer 2 warnings. */
export async function viewProposal(bank: SkillBank, proposal: Proposal): Promise<ProposalView> {
  const changes = await Promise.all(proposal.changes.map(async change => {
    const after = await bank.object<Skill>(change.candidate);
    const before = change.previous ? await bank.object<Skill>(change.previous) : undefined;
    return { op: change.op, id: change.id, reason: change.reason,
      revision: { from: before?.revision ?? 0, to: after.revision }, state: { from: before?.state ?? null, to: after.state },
      title: after.title, fields: fields(before, after),
      sourcesAdded: after.sources.filter(s => !before?.sources.includes(s)).length,
      sourcesRemoved: (before?.sources ?? []).filter(s => !after.sources.includes(s)).length };
  }));
  return { id: proposal.id, status: proposal.status, origin: proposal.origin, createdAt: proposal.createdAt, repositoryKey: proposal.repositoryKey,
    ...(proposal.decision ? { decision: proposal.decision } : {}), comparison: proposal.comparison, warnings: proposal.warnings, changes };
}

/** Plain-text rendering for the terminal. */
export function formatProposal(view: ProposalView): string {
  const lines = [`Proposal ${view.id} · ${view.status} · ${view.origin} · ${view.createdAt}`];
  if (view.decision) lines.push(`Decision: ${view.decision.by} at ${view.decision.at}${view.decision.note ? ` · ${view.decision.note}` : ''}`);
  for (const c of view.changes) {
    lines.push('', `${c.op.toUpperCase()} ${c.id}  r${c.revision.from} → r${c.revision.to}  state ${c.state.from ?? '(new)'} → ${c.state.to}`, `  ${c.title}`, `  Reason: ${c.reason}`);
    if (c.sourcesAdded || c.sourcesRemoved) lines.push(`  Sources: +${c.sourcesAdded} −${c.sourcesRemoved}`);
    for (const f of c.fields) {
      if ('before' in f) lines.push(`  ${f.field}:`, `    - ${f.before || '(empty)'}`, `    + ${f.after || '(empty)'}`);
      else { lines.push(`  ${f.field}:`); for (const v of f.removed) lines.push(`    - ${v}`); for (const v of f.added) lines.push(`    + ${v}`); }
    }
  }
  if (view.comparison.length) {
    lines.push('', 'Learner comparison with existing Skills:');
    for (const c of view.comparison) lines.push(`  ${c.relation.padEnd(8)} ${c.id} r${c.revision}: ${c.note}`);
  }
  if (view.warnings.length) { lines.push('', 'Similarity warnings:'); for (const w of view.warnings) lines.push(`  ! ${w}`); }
  return lines.join('\n');
}
