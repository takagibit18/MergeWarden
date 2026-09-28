import type { SymbolFact } from '../graph/contracts.ts';
import type { ChangeHint, ChangeUnit } from './investigation-contracts.ts';
import { mergeRanges, stableId } from './investigation-focus.ts';

export const dispatchEntity = (s: SymbolFact) => ({ entityId: s.id, snapshotId: s.snapshotId, path: s.path,
  name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, startLine: s.startLine, endLine: s.endLine });

/** Exact file/scope/range resolution. No search ranking or global same-name fallback. */
export function resolveChangeHints(symbols: readonly SymbolFact[], snapshotId: string, anchors: readonly ChangeHint[]) {
  if (!Array.isArray(anchors) || !anchors.length || anchors.length > 32) throw Error('Expected 1..32 change ranges');
  const resolutions = anchors.map((hint, inputIndex) => {
    if (!hint.path || (hint.startLine !== undefined && (!Number.isSafeInteger(hint.startLine) || hint.startLine < 1
      || !Number.isSafeInteger(hint.endLine ?? hint.startLine) || (hint.endLine ?? hint.startLine) < hint.startLine))) throw Error('Invalid change hint');
    if (hint.deleted) return { inputIndex, status: 'deleted_head_unsupported' as const, items: [] };
    let matches = symbols.filter(s => s.snapshotId === snapshotId && s.path === hint.path
      && (hint.kind ? s.kind === hint.kind : ['function', 'class'].includes(s.kind))
      && (!hint.name || s.name === hint.name) && (!hint.qualifiedName || s.qualifiedName === hint.qualifiedName)
      && (hint.startLine === undefined || s.startLine <= hint.startLine && s.endLine >= (hint.endLine ?? hint.startLine)));
    if (hint.startLine !== undefined && matches.length) {
      const width = Math.min(...matches.map(s => s.endLine - s.startLine));
      matches = matches.filter(s => s.endLine - s.startLine === width);
    }
    // A merged range may cross disjoint declarations. Each exact declaration is
    // a separate unit; overlapping scopes without a unique owner remain ambiguous.
    if (!matches.length && !hint.name && !hint.qualifiedName && !hint.kind && hint.startLine !== undefined) {
      const overlapping = symbols.filter(s => s.snapshotId === snapshotId && s.path === hint.path
        && ['function', 'class'].includes(s.kind) && s.endLine >= hint.startLine! && s.startLine <= (hint.endLine ?? hint.startLine!));
      matches = overlapping.filter(s => !overlapping.some(p => p.id !== s.id && p.startLine <= s.startLine && p.endLine >= s.endLine
        && (p.startLine < s.startLine || p.endLine > s.endLine)));
      matches.sort((a, b) => a.startLine - b.startLine || a.id.localeCompare(b.id));
      if (matches.length && matches.every((s, i) => !i || matches[i - 1]!.endLine < s.startLine))
        return { inputIndex, status: 'resolved' as const, items: matches.slice(0, 32).map(dispatchEntity), omittedItems: Math.max(0, matches.length - 32) };
      if (!matches.length) matches = symbols.filter(s => s.snapshotId === snapshotId && s.path === hint.path && s.kind === 'file'
        && s.startLine <= hint.startLine! && s.endLine >= (hint.endLine ?? hint.startLine!));
    }
    // A coalesced replacement range can be wider than the exact named target.
    // Restrict by BOTH exact path/name and interval overlap; never widen to another file.
    if (!matches.length && hint.startLine !== undefined && (hint.name || hint.qualifiedName)) matches = symbols.filter(s =>
      s.snapshotId === snapshotId && s.path === hint.path && (!hint.kind || s.kind === hint.kind)
      && (!hint.name || s.name === hint.name) && (!hint.qualifiedName || s.qualifiedName === hint.qualifiedName)
      && s.endLine >= hint.startLine! && s.startLine <= (hint.endLine ?? hint.startLine!));
    return { inputIndex, status: matches.length === 1 ? 'resolved' as const : matches.length ? 'ambiguous' as const : 'missing' as const,
      items: matches.slice(0, 32).map(dispatchEntity) };
  });
  const admitted = new Set<string>();
  return resolutions.map(r => {
    if (r.status !== 'resolved') return r;
    const items = r.items.filter(e => { if (admitted.has(e.entityId)) return true; if (admitted.size >= 32) return false; admitted.add(e.entityId); return true; });
    const omittedItems = (r.omittedItems ?? 0) + r.items.length - items.length;
    return { ...r, items, omittedItems, status: items.length ? 'resolved' as const : 'coverage_limited' as const };
  });
}

export function changeUnits(snapshotId: string, anchors: readonly ChangeHint[], resolutions: ReturnType<typeof resolveChangeHints>): ChangeUnit[] {
  const units = new Map<string, ChangeUnit>();
  if (resolutions.length !== anchors.length || new Set(resolutions.map(r => r.inputIndex)).size !== anchors.length) throw Error('Incomplete per-hint resolution');
  for (const r of resolutions) {
    const hint = anchors[r.inputIndex]; if (!hint) throw Error('Unknown resolution input');
    const entities = r.status === 'resolved' ? r.items : [undefined];
    if (r.status === 'resolved' && 'omittedItems' in r && r.omittedItems) {
      const id = stableId('change_', [snapshotId, hint, 'omitted']);
      units.set(id, { changeUnitId: id, snapshotId, path: hint.path, kind: 'file', changedRanges: [], resolution: 'coverage_limited',
        provenance: { inputIndices: [r.inputIndex], source: 'immutable_head_diff', omittedEntityCount: r.omittedItems } });
    }
    if (!entities.length) throw Error('Resolved hint has no entity');
    for (const entity of entities) {
      if (entity && (entity.snapshotId !== snapshotId || entity.path !== hint.path)) throw Error('Cross-snapshot/path resolution');
      const id = stableId('change_', [snapshotId, entity?.entityId ?? [hint, r.status]]);
      const unit: ChangeUnit = units.get(id) ?? { changeUnitId: id, snapshotId, path: hint.path,
        kind: (entity?.kind ?? hint.kind ?? 'file') as ChangeUnit['kind'], changedRanges: [],
        ...(entity ? { entity } : {}), resolution: r.status, provenance: { inputIndices: [], source: 'immutable_head_diff' as const,
          ...('omittedItems' in r && r.omittedItems ? { omittedEntityCount: r.omittedItems } : {}) } };
      if (hint.startLine !== undefined) unit.changedRanges = mergeRanges([...unit.changedRanges,
        { startLine: hint.startLine, endLine: hint.endLine ?? hint.startLine }]);
      unit.provenance.inputIndices.push(r.inputIndex); units.set(id, unit);
    }
  }
  return [...units.values()];
}
