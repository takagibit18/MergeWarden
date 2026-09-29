import { digest, contentOf } from './bank.ts';
import type { LearningInput, LearningResult, SkillContent } from './contracts.ts';

/** Per-input capability names: the model selects names; only this host binds identities. */
export function learningIdentity(input: LearningInput) {
  const frozen = structuredClone(input), inputHash = digest(frozen), scope = inputHash.slice(0, 16);
  const sourceRef = `src_${scope}_001`;
  const skills = new Map(frozen.relevantSkills.map((s, i) => [`skill_${scope}_${i + 1}`, s]));
  const pages = new Map((frozen.sourcePages as Array<Record<string, unknown>>).map((p, i) => [`evidence_${scope}_${i + 1}`, p]));
  const newTargets = Array.from({length: 3}, (_, i) => `new_${scope}_${i + 1}`);
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['snapshotId','runId','contentSha256','fileHash','hash','reportSha256','sources','eventId','feedbackMetadata'].includes(k)).map(([k,v]) => [k,strip(v)]));
    return value;
  };
  const visible = {
    policy: frozen.policy, source: {...strip(frozen.source) as object, id: sourceRef, ref: sourceRef},
    report: strip(frozen.report), sourcePages: [...pages].map(([ref,p]) => ({...strip(p) as object,ref})),
    relevantSkills: [...skills].map(([ref,s]) => ({ref, state:s.state, ...strip(contentOf(s)) as object, dependencies: s.dependencies.map(d => ({path:d.path, historical:true}))})),
    newTargets, toolEvents: strip(frozen.toolEvents), fixedRules:frozen.fixedRules,
  };
  return { visible, inputHash, resolve(output: unknown, currentInput = input): LearningResult {
    if (digest(currentInput) !== inputHash) throw Error('Learning host hash mismatch or stale revision');
    if (!output || typeof output !== 'object' || Object.keys(output).join() !== 'operations') throw Error('Invalid identity output');
    const ops = (output as {operations: Array<Record<string, unknown>>}).operations;
    if (!Array.isArray(ops) || !ops.length || ops.length > 3) throw Error('Invalid identity operations');
    const touched = new Set<string>();
    return {operations: ops.map(op => {
      if (op.op === 'noop') {
        if (ops.length !== 1 || Object.keys(op).some(k => !['op','reason'].includes(k))) throw Error('Invalid noop');
        return {op:'noop' as const,reason:op.reason as string};
      }
      if (Object.keys(op).some(k => !['op','targetRef','sourceRefs','reason','content','conflict'].includes(k))) throw Error('Invalid raw identity field');
      if (!['add','revise','attach_source','retire'].includes(op.op as string)) throw Error('Invalid identity operation');
      if (!Array.isArray(op.sourceRefs) || op.sourceRefs.length !== 1 || op.sourceRefs[0] !== sourceRef) throw Error('Unknown or duplicate source ref');
      const target = op.targetRef as string, old = skills.get(target);
      if (touched.has(target)) throw Error('Duplicate target ref'); touched.add(target);
      if (op.op === 'add' ? !newTargets.includes(target) : !old) throw Error('Unknown or cross-input target ref');
      let content: SkillContent | undefined;
      if (op.content) {
        const c = op.content as Record<string, unknown>;
        if ('dependencies' in c || !Array.isArray(c.dependencyRefs)) throw Error('Invalid raw dependency hash; use dependencyRefs');
        if (new Set(c.dependencyRefs).size !== c.dependencyRefs.length) throw Error('Duplicate dependency ref');
        const {dependencyRefs,...body} = c;
        content = {...body,dependencies: (dependencyRefs as string[]).map(ref => {
          const page = pages.get(ref);
          if (!page) throw Error('Unknown or cross-input evidence ref');
          if (typeof page.fileHash !== 'string' || !/^[a-f0-9]{64}$/.test(page.fileHash)) throw Error('Learning host hash mismatch');
          return {path:page.path as string,hash:page.fileHash};
        })} as unknown as SkillContent;
      }
      return {op:op.op as 'add'|'revise'|'attach_source'|'retire',id:old?.id ?? `sk_${scope}_${newTargets.indexOf(target)+1}`,expectedRevision:old?.revision ?? 0,sourceIds:[frozen.source.id],reason:op.reason as string,...(content ? {content}:{}),...(op.conflict !== undefined ? {conflict:op.conflict as boolean}:{})};
    })};
  }};
}
