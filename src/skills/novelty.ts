import type { ComparisonEntry, LearningOperation } from './contracts.ts';

/**
 * Layer 1 (before extraction): the learner must state, for every existing Skill it was shown,
 * whether the proposed experience is the same, overlaps or is distinct. The host cannot judge
 * meaning, but it can require that the comparison is complete and consistent with the operation.
 */
const RELATIONS = new Set(['same', 'overlaps', 'distinct']);

export function checkComparison(op: Exclude<LearningOperation, { op: 'noop' }>, shown: ReadonlyArray<{ id: string; revision: number }>): ComparisonEntry[] {
  const comparison = op.comparison;
  if (!shown.length && (comparison === undefined || (Array.isArray(comparison) && !comparison.length))) return [];
  if (!Array.isArray(comparison)) throw Error('Novelty comparison required: compare against every existing Skill shown');
  const seen = new Set<string>();
  for (const entry of comparison) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !['id', 'revision', 'relation', 'note'].includes(k))) throw Error('Invalid novelty comparison entry');
    if (!RELATIONS.has(entry.relation)) throw Error('Novelty relation must be same, overlaps or distinct');
    if (typeof entry.note !== 'string' || !entry.note.trim() || entry.note.length > 600) throw Error('Novelty comparison needs a 1..600 character note');
    const known = shown.find(s => s.id === entry.id);
    if (!known || known.revision !== entry.revision) throw Error('Novelty comparison names a Skill that was not shown');
    if (seen.has(entry.id)) throw Error('Duplicate novelty comparison entry');
    seen.add(entry.id);
  }
  if (seen.size !== shown.length) throw Error(`Novelty comparison incomplete: ${shown.length - seen.size} shown Skill(s) not compared`);
  const same = comparison.filter(c => c.relation === 'same');
  if (op.op === 'add' && same.length) throw Error(`Same experience as ${same.map(c => c.id).join(', ')}: use attach_source, revise or noop instead of add`);
  if (op.op !== 'add' && !comparison.some(c => c.id === op.id && c.relation !== 'distinct')) throw Error('Target of revise, attach_source or retire must be compared as same or overlaps');
  return comparison.map(c => ({ id: c.id, revision: c.revision, relation: c.relation, note: c.note.trim() }));
}
