import { createHash } from 'node:crypto';
import type { CandidateCard, CandidateSource, ChangeUnit, ContextPackageV2 } from './investigation-contracts.ts';
import type { PathCandidate } from '../experiments/locagent/candidate-set.ts';
import { dispatchEntity } from './change-resolution.ts';
import { stableId } from './investigation-focus.ts';
import { evidenceRefId, fullEvidence } from '../application/evidence-registry.ts';
import type { DispatchSource } from './dispatch-contracts.ts';

/** Display-only declaration prefix; stop at the declaration colon, never include an inline body. */
export function declarationPreview(text: string, startLine: number, kind: string): string | undefined {
  if (!['function', 'class'].includes(kind)) return;
  const lines = text.split('\n').slice(startLine - 1, startLine + 2);
  if (!/^\s*(?:async\s+def|def|class)\s/.test(lines[0] ?? '')) return;
  let value = '', depth = 0, quote = '', escaped = false;
  for (const ch of lines.join('\n')) {
    if (Buffer.byteLength(value + ch) > 512) break;
    value += ch;
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ':' && depth === 0) break;
  }
  return value || undefined;
}
export function candidateCard(requestId: string, candidate: PathCandidate, units: readonly ChangeUnit[], preview?: string): CandidateCard {
  return { candidateRefId: stableId('cand_', [requestId, candidate.terminalEntityId]), entity: dispatchEntity(candidate.terminalEntity),
    roots: candidate.rootEntityIds.map(id => { const u = units.find(u => u.entity?.entityId === id); if (!u?.entity) throw Error('Candidate has unknown investigation root');
      return { changeUnitId: u.changeUnitId, path: u.path, name: u.entity.name }; }), depth: candidate.depth,
    structuralPaths: candidate.retainedPaths.map((p, i) => ({ relationSequence: candidate.relationSequences[i]!, directionSequence: p.directions })),
    patternIds: candidate.patternIds, pathSupportCount: candidate.pathSupportCount, changed: candidate.changed,
    alreadyVisible: candidate.alreadyVisible, classification: candidate.classification, ...(preview ? { headerPreview: preview } : {}), explorationOnly: true };
}
export function sourceWindow(card: CandidateCard) { return { startLine: card.entity.startLine, endLine: Math.min(card.entity.endLine, card.entity.startLine + 79) }; }
export function candidateSource(page: Record<string, unknown>, card: CandidateCard, snapshotId: string): CandidateSource {
  const range = sourceWindow(card);
  if (page.status !== 'ok' || page.snapshotId !== snapshotId || page.revision !== 'head' || page.path !== card.entity.path
    || page.startLine !== range.startLine || !Number.isSafeInteger(page.endLine) || Number(page.endLine) < range.startLine || Number(page.endLine) > range.endLine || typeof page.text !== 'string'
    || createHash('sha256').update(page.text).digest('hex') !== page.contentSha256) throw Error('Candidate source integrity mismatch');
  const ref = fullEvidence(page as unknown as DispatchSource);
  return { ...ref, evidenceRefId: evidenceRefId(ref), text: page.text, entity: card.entity, candidateRefId: card.candidateRefId,
    entityRange: { startLine: card.entity.startLine, endLine: card.entity.endLine }, returnedRange: { startLine: ref.startLine, endLine: ref.endLine }, truncated: ref.endLine < card.entity.endLine };
}
export const packageBytes = (pack: ContextPackageV2) => Buffer.byteLength(JSON.stringify(pack));
export function packInvestigation(pack: ContextPackageV2) {
  const max = 24 * 1024, cards = pack.investigations.flatMap(i => i.candidateCatalog);
  for (const card of [...cards].reverse()) { if (packageBytes(pack) <= max) break; delete card.headerPreview; }
  if (packageBytes(pack) > max) for (const inv of pack.investigations) {
    const referenced = new Set(inv.candidateCatalog.flatMap(c => c.roots.map(r => r.changeUnitId)));
    let compacted = 0;
    for (const unit of [...inv.changeUnits].reverse()) {
      if (packageBytes(pack) <= max) break;
      if (unit.entity && !referenced.has(unit.changeUnitId)) { delete unit.entity; compacted++; }
    }
    if (compacted) { inv.limitations.push(`${compacted} non-catalog-root entity display records omitted; change-unit identity/ranges/status retained`); pack.terminal = 'coverage_limited'; }
  }
  if (packageBytes(pack) > max) for (const card of [...cards].reverse()) {
    if (packageBytes(pack) <= max) break;
    // Preserve reference identity, location, roots, and one actual relation summary.
    card.patternIds = []; card.structuralPaths = card.structuralPaths.slice(0, 1);
  }
  for (const inv of [...pack.investigations].reverse()) while (packageBytes(pack) > max && inv.candidateCatalog.length) {
    inv.candidateCatalog.pop(); pack.omittedCandidateCount++;
  }
  if (pack.omittedCandidateCount) { pack.omitted.push(`${pack.omittedCandidateCount} candidate cards omitted by package byte budget`); pack.terminal = 'coverage_limited'; }
  // A whole source is dropped only after display metadata. Never slice a hashed source.
  while (packageBytes(pack) > max && pack.sources.length) {
    const source = pack.sources.pop()!; pack.omitted.push(`Whole source omitted: ${source.candidateRefId}`); pack.terminal = 'coverage_limited';
  }
  for (const inv of pack.investigations) inv.prefetchedSourceRefs = pack.sources.map(s => s.evidenceRefId);
  // Pathological declaration metadata can itself exceed the package. Preserve
  // task identity and explicit omission counts rather than throwing after admission.
  if (packageBytes(pack) > max) for (const inv of pack.investigations) {
    let omitted = 0;
    while (packageBytes(pack) > max - 256 && inv.changeUnits.length) { inv.changeUnits.pop(); omitted++; }
    if (omitted) { inv.limitations.push(`${omitted} whole change-unit display records omitted by package budget; exact resolutions retained in host operation telemetry`); pack.terminal = 'coverage_limited'; }
  }
  if (packageBytes(pack) > max) throw Error('Required investigation identity exceeds package budget');
  return pack;
}
