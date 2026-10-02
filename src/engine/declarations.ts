import { createHash } from 'node:crypto';
import type { LineRange } from './investigation-contracts.ts';
export const CHANGE_VERSION = 'declaration-change-1';
export interface Declaration {
  path: string; scope: string; kind: 'function'|'method'|'class'|'import'|'from_import'; name: string;
  role: 'none'|'getter'|'setter'|'deleter'; async: boolean; range: LineRange; definitionLine: number;
  identity: string; signature: string; decorators: string; body: string; structure: string;
  segments?: {hash:string;range:LineRange;part:'signature'|'decorator'|'body'|'import'}[];
  importItem?: { module: string; importedName?: string; localBinding: string; relativeLevel: number; reexport: boolean; uncertain: boolean };
}
export interface DeclarationChange {
  id: string; path: string; identity: string; base?: Declaration; head?: Declaration;
  changeType: 'added'|'deleted'|'signature_changed'|'decorator_changed'|'body_changed'|'import_changed'|'moved_or_relocated'|'unknown';
  match: 'matched'|'ambiguous'|'unresolved'; changedPortion: { base: LineRange[]; head: LineRange[] };
}
export const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Identity never crosses lexical scope or accessor role. Duplicate declarations
 * require unique structural evidence; source order is never a silent tie-break. */
export function matchDeclarations(base: Declaration[], head: Declaration[], snapshotId: string, parseComplete = true): DeclarationChange[] {
  const changes: DeclarationChange[] = [];
  const portions=(d:Declaration|undefined,other:Declaration|undefined):LineRange[]=>!d?[]:!d.segments?[d.range]:d.segments.filter(s=>
    d.segments!.filter(x=>x.part===s.part&&x.hash===s.hash).length !== (other?.segments??[]).filter(x=>x.part===s.part&&x.hash===s.hash).length).map(s=>s.range);
  const emit = (a: Declaration|undefined, b: Declaration|undefined, ambiguous = false) => {
    if (!a && !b) return;
    const d = b ?? a!;
    let changeType: DeclarationChange['changeType'] = !parseComplete || ambiguous ? 'unknown' : !a ? 'added' : !b ? 'deleted'
      : a.signature !== b.signature ? 'signature_changed' : a.decorators !== b.decorators ? 'decorator_changed'
      : a.body !== b.body ? 'body_changed' : a.range.startLine !== b.range.startLine ? 'moved_or_relocated' : 'unknown';
    if (a && b && changeType === 'unknown' && parseComplete && !ambiguous) return;
    if (d.importItem && changeType !== 'moved_or_relocated' && changeType !== 'unknown') changeType = 'import_changed';
    changes.push({ id: digest([snapshotId, d.identity, a?.range, b?.range, changeType]), path: d.path, identity: d.identity,
      ...(a ? {base:a}:{}), ...(b ? {head:b}:{}), changeType, match: !parseComplete ? 'unresolved' : ambiguous ? 'ambiguous' : 'matched',
      changedPortion: {base:portions(a,b),head:portions(b,a)} });
  };
  for (const key of new Set([...base,...head].map(d=>d.identity))) {
    const old=base.filter(d=>d.identity===key), next=head.filter(d=>d.identity===key);
    if(old.length<=1 && next.length<=1) {emit(old[0],next[0]);continue;}
    const used=new Set<Declaration>();
    for(const a of old) {
      const candidates=next.filter(b=>!used.has(b) && a.signature===b.signature && a.body===b.body && a.decorators===b.decorators);
      if(candidates.length===1 && old.filter(x=>x.signature===a.signature && x.body===a.body && x.decorators===a.decorators).length===1) {used.add(candidates[0]!);emit(a,candidates[0]);}
      else emit(a,undefined,true);
    }
    for(const b of next) if(!used.has(b)) emit(undefined,b,true);
  }
  return changes;
}
export function declarationSignals(changes: readonly DeclarationChange[]) {
  return changes.filter(c=>!((c.head??c.base)?.kind==='class' && c.changeType==='body_changed')).filter(c=>c.match==='matched' && !['unknown','moved_or_relocated'].includes(c.changeType)).map(change=>{
    const d=change.head??change.base!;
    const routeType = d.importItem ? 'IMPORT_CHECK' as const : d.kind==='class' ? 'INHERITANCE_CHECK' as const : 'CALLER_CHECK' as const;
    return {routeType,targetHint:d.name,relationHint:d.importItem?'import binding':d.kind==='class'?'INHERITS':'incoming CALLS',
      reason:change.changeType,strength:'high' as const,change};
  });
}
